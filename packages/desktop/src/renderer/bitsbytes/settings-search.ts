import { bbt } from "../../bitsbytes/copy"
import { mobileCopy } from "../../bitsbytes/mobile-copy"

/** Labels only: stored tokens, account data and live control values never enter search. */
export function nativeSettingsSearchEntries() {
  const rows = [
    ["audio", "audio-engine", "audioSettings", "transcriptionHint"],
    ["audio", "audio-microphone", "microphone"],
    ["audio", "audio-acceleration", "acceleration"],
    ["audio", "audio-worker", "localWorker", "setupHint"],
    ["audio", "audio-groq-key", "groqKey"],
    ["tools", "tools-mcp", "mcpTitle", "mcpHint"],
    ["tools", "tools-images", "imageGeneration.title", "imageGeneration.hint"],
    ["tools", "tools-image-key", "imageGeneration.key"],
    ["tools", "tools-image-model", "imageGeneration.model"],
    ["tools", "tools-image-test", "imageGeneration.verify", "imageGeneration.testHint"],
    ["tools", "tools-question-timer", "questionTimer", "questionTimerHint"],
    ["tools", "tools-artifacts", "artifactsRuntime", "artifactsHint"],
    ["tools", "tools-browser", "browserControl", "browserHint"],
    ["tools", "tools-computer", "computerControl", "computerHint"],
    ["providers", "chatgpt-connect", "chatgpt", "connect"],
    ["providers", "chatgpt-usage", "manageUsage"],
    ["providers", "chatgpt-models", "refreshModels"],
  ] as const
  return [
    ...rows.map(([tab, target, title, description]) => ({
      id: target,
      tab,
      title: bbt(title),
      description: description ? bbt(description) : undefined,
      target,
    })),
    ...(
      [
        ["mobile-enable", "enable", "hint"],
        ["mobile-port", "port"],
        ["mobile-pair", "pair", "expires"],
        ["mobile-devices", "devices"],
      ] as const
    ).map(([target, title, description]) => ({
      id: target,
      tab: "mobile",
      title: mobileCopy[title],
      description: description ? mobileCopy[description] : undefined,
      target,
    })),
  ]
}
