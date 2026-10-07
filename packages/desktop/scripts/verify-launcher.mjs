import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, symlink, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const exec = promisify(execFile)
const root = resolve('../..')
const version = JSON.parse(await readFile(join(root, 'packages/desktop/package.json'), 'utf8')).version
const executable = join(root, `packages/desktop/dist/${version}/win-unpacked/BitsBytesChat.exe`)
const launcher = join(root, 'Start BitsBytesChat.cmd')
const profile = join(root, '.tools/qa/launcher-03-' + Date.now())
const report = { profile, checks: [] }
const ps = async code => (await exec(join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile', '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64')])).stdout.trim()
const processes = async () => JSON.parse(await ps("ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process -Filter \"Name = 'BitsBytesChat.exe'\" | ForEach-Object { $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; [pscustomobject]@{ id = $_.ProcessId; parent = $_.ParentProcessId; path = $_.ExecutablePath; command = $_.CommandLine; window = $p.MainWindowHandle.ToInt64() } })"))
const launch = async (env, answer = 'N', entry = launcher) => {
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${entry}""`], { cwd: tmpdir(), env, windowsHide: true, windowsVerbatimArguments: true, stdio: 'pipe' })
  let output = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { output += data })
  child.stdin.end(answer + '\r\n')
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
  return { code, output }
}
const check = text => { report.checks.push(text); console.log('PASS', text) }
const before = await processes()
const live = before.filter(process => process.command && !process.command.includes('--type='))
let fixture
let launchedID
try {
  if (live.length) {
    const decline = await launch(process.env)
    assert.equal(decline.code, 0, decline.output)
    assert.match(decline.output, /already running/)
    assert.match(decline.output, /left running/)
    const after = await processes()
    for (const process of live) assert.ok(after.some(item => item.id === process.id))
    check('Actual CMD explains the existing-copy conflict; declining keeps user processes alive')
  }
  await mkdir(join(profile, 'BitsBytesChat'), { recursive: true })
  await symlink(join(process.env.LOCALAPPDATA, 'BitsBytesChat/runtime'), join(profile, 'BitsBytesChat/runtime'), 'junction')
  const env = { ...process.env, LOCALAPPDATA: profile, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' }
  // This disposable headless Electron helper exercises recovery without touching the user's app.
  fixture = spawn(executable, ['-e', 'setInterval(() => {}, 1000)'], { env, windowsHide: true, stdio: 'ignore' })
  await new Promise(resolve => setTimeout(resolve, 1200))
  assert.equal(fixture.exitCode, null)
  const recovery = await launch(env, 'Y')
  assert.equal(recovery.code, 0, recovery.output)
  assert.match(recovery.output, /no visible window/)
  assert.ok(recovery.output.includes('Opening Bits & Bytes Chat v' + version))
  const after = await processes()
  assert.ok(!after.some(process => process.id === fixture.pid))
  const children = after.filter(process => process.command?.includes(join(profile, 'BitsBytesChat/desktop')))
  const main = after.find(process => children.some(child => child.parent === process.id) && process.path === executable)
  assert.ok(main, 'No isolated application process found')
  launchedID = main.id
  assert.ok(main.window > 0, 'No visible application window')
  check('Confirmed recovery closes only the disposable headless helper and launches a real ' + version + ' window')
  check('Actual CMD works from another folder and clears inherited Electron CLI/ASAR flags')
  const forward = await launch(env)
  assert.equal(forward.code, 0, forward.output)
  assert.ok((await processes()).some(process => process.id === main.id && process.window > 0))
  check('Reopening the CMD brings the same current-version window forward')
  const mobile = await launch(env, 'N', join(root, 'Start BitsBytes Mobile.cmd'))
  assert.equal(mobile.code, 0, mobile.output)
  assert.ok((await processes()).some(process => process.id === main.id && process.window > 0))
  check('Mobile CMD forwards to the same application instance and release')
  for (const process of live) assert.ok((await processes()).some(item => item.id === process.id))
  check('All original user app processes remain alive throughout testing')
} finally {
  // Only disposable QA processes created by this script can be cleaned up.
  if (fixture?.exitCode === null) fixture.kill()
  if (launchedID) {
    const current = await processes()
    assert.ok(current.some(process => process.parent === launchedID && process.command?.includes(join(profile, 'BitsBytesChat/desktop'))))
    await ps(`$process = Get-Process -Id ${launchedID} -ErrorAction SilentlyContinue; if ($process) { $process.CloseMainWindow() | Out-Null; $process.WaitForExit(8000) | Out-Null }`)
    if ((await processes()).some(process => process.id === launchedID)) {
      await exec(join(process.env.SystemRoot, 'System32/taskkill.exe'), ['/PID', String(launchedID), '/T', '/F']).catch(async error => {
        if ((await processes()).some(process => process.id === launchedID)) throw error
      })
    }
  }
  await mkdir(join(root, '.tools/qa/results'), { recursive: true })
  await writeFile(join(root, '.tools/qa/results/launcher-' + version.replaceAll('.', '') + '.json'), JSON.stringify(report, null, 2))
}
