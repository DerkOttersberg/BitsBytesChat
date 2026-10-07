import { useCommand, type CommandOption } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLocal, type ModelSelection } from "@/context/local"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { getCursorPosition, setCursorPosition } from "@/components/prompt-input/editor-dom"
import { useSessionLayout } from "./session-layout"
import { createSessionOwnership } from "./session-ownership"
import { useParams, useSearchParams } from "@solidjs/router"
import { draftAccessKey } from "../../components/chat-access"
import { usePlatform } from "../../context/platform"
import { useSDK } from "../../context/sdk"

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useComposerCommands = (input: { model?: ModelSelection } = {}) => {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const local = useLocal()
  const { sessionKey } = useSessionLayout()
  const sessionOwnership = createSessionOwnership(sessionKey)
  const model = input.model ?? local.model
  const platform = usePlatform(), params = useParams(), sdk = useSDK()
  const [search] = useSearchParams<{ draftId?: string }>()
  const identity = () => params.id ?? draftAccessKey(sdk().scope, sdk().directory, search.draftId)
  const modelCommand = withCategory(language.t("command.category.model"))
  const agentCommand = withCategory(language.t("command.category.agent"))

  const chooseModel = async () => {
    const owner = sessionOwnership.capture()
    const editor = document.querySelector<HTMLElement>('[data-component="prompt-input"]')
    const selection = window.getSelection()
    const cursor =
      editor && selection?.rangeCount && editor.contains(selection.anchorNode) ? getCursorPosition(editor) : null
    const restoreComposer = () => {
      // Kobalte restores focus during its teardown effect; defer past it so the
      // composer keeps focus and the caret returns to where the user left it.
      requestAnimationFrame(() => {
        const editor = document.querySelector<HTMLElement>('[data-component="prompt-input"]')
        if (!editor) return
        editor.focus()
        if (cursor !== null) setCursorPosition(editor, cursor)
      })
    }
    const { DialogSelectModel } = await import("@/components/dialog-select-model")
    owner.run(() => {
      void dialog.show(() => <DialogSelectModel model={model} />, restoreComposer)
    })
  }

  command.register("composer", () => [
    ...(platform.bitsbytes ? [{
      id: "bitsbytes.plan", title: language.t("bitsbytes.plan"), description: language.t("bitsbytes.planDescription"), slash: "plan",
      onSelect: () => { void platform.bitsbytes!.call("runs.mode", { sessionID: identity(), mode: "plan" }); local.agent.set("plan") },
    }, {
      id: "bitsbytes.goal", title: language.t("bitsbytes.goal"), description: language.t("bitsbytes.goalDescription"), slash: "goal",
      onSelect: () => window.dispatchEvent(new CustomEvent("bitsbytes:goal-draft", { detail: { sessionID: identity() } })),
    }, {
      id: "bitsbytes.side",
      title: language.t("bitsbytes.sideChat"),
      description: language.t("bitsbytes.sideChat.description"),
      slash: "side",
      disabled: !params.id,
      onSelect: () => {
        const current = model.current()
        window.dispatchEvent(new CustomEvent("bitsbytes:side-chat", { detail: {
          source: params.id, directory: sdk().directory,
          model: current ? { providerID: current.provider.id, modelID: current.id } : undefined,
          agent: local.agent.current()?.name, variant: model.variant.current() ?? null,
        } }))
      },
    }] : []),
    modelCommand({
      id: "model.choose",
      title: language.t("command.model.choose"),
      description: language.t("command.model.choose.description"),
      keybind: "mod+'",
      slash: "model",
      onSelect: chooseModel,
    }),
    modelCommand({
      id: "model.variant.cycle",
      title: language.t("command.model.variant.cycle"),
      description: language.t("command.model.variant.cycle.description"),
      keybind: "shift+mod+d",
      onSelect: () => model.variant.cycle(),
    }),
    agentCommand({
      id: "agent.cycle",
      title: language.t("command.agent.cycle"),
      description: language.t("command.agent.cycle.description"),
      keybind: "mod+.",
      slash: "agent",
      disabled: !local.agent.visible(),
      onSelect: () => local.agent.move(1),
    }),
    agentCommand({
      id: "agent.cycle.reverse",
      title: language.t("command.agent.cycle.reverse"),
      description: language.t("command.agent.cycle.reverse.description"),
      keybind: "shift+mod+.",
      disabled: !local.agent.visible(),
      onSelect: () => local.agent.move(-1),
    }),
  ])
}
