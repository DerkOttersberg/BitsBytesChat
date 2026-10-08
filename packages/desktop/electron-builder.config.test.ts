import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const channels = [
  { channel: "dev", appId: "nl.bitsbytes.chat" },
  { channel: "beta", appId: "nl.bitsbytes.chat" },
  { channel: "prod", appId: "nl.bitsbytes.chat" },
] as const

for (const channel of channels) {
  test(`uses the fork identity for ${channel.channel}`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    expect(config.productName).toBe("BitsBytesChat")
    expect(config.protocols).toEqual({ name: "BitsBytesChat", schemes: ["bitsbytes-chat"] })
    expect(config.publish).toBeNull()
  })
}

test("Windows executable, installer and runtime share the BitsBytes icon set", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.win?.icon).toBe("icons/bitsbytes/icon.ico")
  expect(config.nsis?.installerIcon).toBe(config.win?.icon)
  expect(config.nsis?.installerHeaderIcon).toBe(config.win?.icon)
  expect(config.extraResources).toContainEqual({ from: "icons/bitsbytes", to: "icons", filter: ["icon.ico", "icon.png"] })
  expect(await Bun.file("icons/bitsbytes/icon.ico").exists()).toBe(true)
})

test("bundles the CLI outside the dev app archive", async () => {
  const previous = process.env.OPENCODE_CHANNEL
  process.env.OPENCODE_CHANNEL = "dev"
  const module = await import("./electron-builder.config.ts?cli-resource")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.OPENCODE_CHANNEL
  else process.env.OPENCODE_CHANNEL = previous

  expect(config.files).toContain("!resources/opencode-cli*")
  expect(config.extraResources).toContainEqual({
    from: "resources/",
    to: "",
    filter: ["opencode-cli*"],
  })
})

for (const channel of ["beta", "prod"] as const) {
  test(`does not bundle the CLI in ${channel} builds`, async () => {
    const previous = process.env.OPENCODE_CHANNEL
    process.env.OPENCODE_CHANNEL = channel
    const module = await import(`./electron-builder.config.ts?no-cli-resource=${channel}`)
    const config = module.default as Configuration
    if (previous === undefined) delete process.env.OPENCODE_CHANNEL
    else process.env.OPENCODE_CHANNEL = previous

    expect(config.extraResources).not.toContainEqual({
      from: "resources/",
      to: "",
      filter: ["opencode-cli*"],
    })
  })
}
