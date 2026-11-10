// Test-only main-process observer. No inspector/CDP pause interferes with a new renderer.
const { app } = require("electron")
const { writeFile } = require("node:fs/promises")
const path = require("node:path")
let loads = 0
app.on("web-contents-created", (_event, contents) => {
  contents.on("did-finish-load", async () => {
    const index = ++loads
    const report = { loads: index, mainPid: process.pid, rendererPid: contents.getOSProcessId() }
    try {
      const state = await contents.executeJavaScript(`new Promise((resolve,reject)=>{
        let started=false
        const timeout=setTimeout(()=>reject(new Error('UI did not recover')),10000)
        const interval=setInterval(async()=>{
          if(!document.querySelector('aside'))return
          if(${index}===1&&!started){
            document.querySelector('.new-record-actions > button').click()
            document.querySelector('.ready-screen .primary').click()
            started=true
          }
          const reply=await window.api.snapshot()
          if(${index}===1&&(!reply.ok||!reply.value.activeId||reply.value.activeId==='starting'))return
          clearInterval(interval);clearTimeout(timeout);resolve(reply)
        },40)
      })`)
      report.state = state
      if (index > 1) {
        await new Promise(resolve => setTimeout(resolve, 200))
        // Windows may not expose an occluded display surface on CI. Recovery is
        // verified from the replacement renderer's actual IPC state, not capture.
        await contents.capturePage().then(screenshot => writeFile(process.env.BITSBYTES_NATIVE_SCREENSHOT, screenshot.toPNG())).catch(() => undefined)
      }
      await writeFile(path.join(process.env.BITSBYTES_TEST_DATA, "native-probe.json"), JSON.stringify(report))
    } catch (error) {
      await writeFile(path.join(process.env.BITSBYTES_TEST_DATA, "native-probe-error.json"), JSON.stringify({ ...report, error: error.message }))
    }
  })
})
