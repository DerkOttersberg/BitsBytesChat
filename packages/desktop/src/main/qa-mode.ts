import { write } from "./logging"

// Both flags are required: a normal preview must still behave like the app.
export function hiddenQA(env: NodeJS.ProcessEnv = process.env) {
  return env.BB_QA_ISOLATED === "1" && env.BB_QA_HIDDEN === "1"
}

export function offscreenQA(env: NodeJS.ProcessEnv = process.env) {
  return hiddenQA(env) && env.BB_QA_CAPTURE === "1"
}

export function suppressNativeUI(action: string, target?: string) {
  if (!hiddenQA()) return false
  write("qa", "suppressed native UI", { action, target })
  return true
}
