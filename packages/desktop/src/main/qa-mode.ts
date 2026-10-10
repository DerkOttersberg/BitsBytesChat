import { write } from "./logging"

// Both flags are required: a normal preview must still behave like the app.
export function hiddenQA(env: NodeJS.ProcessEnv = process.env) {
  return env.BB_QA_ISOLATED === "1" && env.BB_QA_HIDDEN === "1"
}

export function offscreenQA(env: NodeJS.ProcessEnv = process.env) {
  return hiddenQA(env) && env.BB_QA_CAPTURE === "1"
}

export function imageQAEndpoints(env: NodeJS.ProcessEnv = process.env) {
  if (!hiddenQA(env) || !env.BB_QA_IMAGE_URL) return {}
  const endpoint = new URL(env.BB_QA_IMAGE_URL)
  if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1" || endpoint.username || endpoint.password)
    throw new Error("QA image requests require an unauthenticated loopback fixture URL")
  return { endpoint: endpoint.href, catalogueEndpoint: new URL("/api/v1/images/models", endpoint).href }
}

export function suppressNativeUI(action: string, target?: string) {
  if (!hiddenQA()) return false
  write("qa", "suppressed native UI", { action, target })
  return true
}
