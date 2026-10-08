// Local authorization pages run outside the renderer. Keep their complete copy
// in one typed bundle so the fallback and browser bootstrap use the same text.
export const callbackCopy = {
  brand: "Bits & Bytes Chat",
  successTitle: "Authorization successful",
  errorTitle: "Authorization failed",
  pendingTitle: "Finishing sign-in",
  connected: "Bits & Bytes Chat is now connected to {{provider}}.",
  authorized: "Bits & Bytes Chat is now authorized.",
  connectionFailed: "Bits & Bytes Chat couldn't finish connecting to {{provider}}.",
  authorizationFailed: "Bits & Bytes Chat couldn't complete authorization.",
  retry: "Close this window and try again from Bits & Bytes Chat.",
  close: "You can close this window.",
  completingProvider: "Completing your {{provider}} authorization.",
  completing: "Completing authorization.",
  closeWhenFinished: "You can close this window once sign-in finishes.",
  callbackFailed: "Authorization callback failed ({{status}})",
} as const

export function callbackT(key: keyof typeof callbackCopy, parameters: Record<string, string | number> = {}) {
  return callbackCopy[key].replace(/\{\{(\w+)\}\}/g, (placeholder, name: string) => String(parameters[name] ?? placeholder))
}
