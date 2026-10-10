import { bbt } from "../../bitsbytes/copy"
import { mobileCopy } from "../../bitsbytes/mobile-copy"

/** Labels only: stored tokens, account data and live control values never enter search. */
export function nativeSettingsSearchEntries() {
  const rows = [
    ["audio", "audio-microphone", "microphone"],
    ["audio", "audio-model", "audioModel", "audioModelHint"],
    ["audio", "audio-language", "audioLanguage", "audioLanguageHint"],
    ["audio", "audio-diarization", "audioDiarization", "audioDiarizationHint"],
    ["extensions", "extensions-mcp-tab", "extensions.mcps", "mcpHint"],
    ["extensions", "extensions-plugins-tab", "extensions.plugins", "extensions.pluginHint"],
    ["extensions", "extensions-skills-tab", "skills", "skillHint"],
    ["images", "tools-images", "imageGeneration.title", "imageGeneration.hint"],
    ["images", "tools-image-provider", "imageGeneration.provider"],
    ["images", "tools-image-model", "imageGeneration.model"],
    ["tools", "tools-question-timer", "questionTimer", "questionTimerHint"],
    ["tools", "tools-artifacts", "artifactsRuntime", "artifactsHint"],
    ["tools", "tools-browser", "browserControl", "browserHint"],
    ["tools", "tools-computer", "computerControl", "computerHint"],
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
