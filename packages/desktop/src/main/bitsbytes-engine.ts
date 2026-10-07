import type { ServerReadyData } from "../preload/types"

// Metadata is safe to poll again after a stalled read. Mutations can already
// have been admitted, so they retain the caller's explicit cancellation policy.
export async function engineRequest<T = unknown>(server: ServerReadyData, path: string, options: RequestInit, directory: string): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set("content-type", "application/json")
  headers.set("x-opencode-directory", encodeURIComponent(directory))
  if (server.password) headers.set("authorization", "Basic " + Buffer.from(`${server.username ?? "opencode"}:${server.password}`).toString("base64"))
  const deadline = ["GET", "HEAD"].includes((options.method ?? "GET").toUpperCase()) ? AbortSignal.timeout(15000) : undefined
  const signal = deadline && options.signal ? AbortSignal.any([deadline, options.signal]) : deadline ?? options.signal
  return fetch(server.url + path, { ...options, headers, signal }).then(async response => {
    if (!response.ok) throw new Error(`OpenCode ${response.status}: ${(await response.text()).slice(0, 500)}`)
    return response.status === 204 ? undefined as T : await response.json() as T
  }).catch(error => {
    if (deadline?.aborted && !options.signal?.aborted) throw new Error("bb.error.engineTimeout")
    throw error
  })
}
