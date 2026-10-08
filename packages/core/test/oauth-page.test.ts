import { describe, expect, test } from "bun:test"
import { OauthCallbackPage } from "../src/oauth/page"

describe("OauthCallbackPage", () => {
  test("local callback states show the application brand with no upstream wordmark", () => {
    for (const html of [OauthCallbackPage.success({ provider: "ChatGPT" }), OauthCallbackPage.error("Try again", { provider: "ChatGPT" }), OauthCallbackPage.bootstrap({ provider: "ChatGPT", tokenPath: "/token" })]) {
      expect(html).toContain("Bits &amp; Bytes Chat")
      expect(html).not.toContain("OpenCode")
      expect(html).toContain("data:image/png;base64,")
      expect(html).not.toMatch(/(?:src|href)="https?:/)
    }
  })

  test("provider names and failure details cannot inject markup", () => {
    const provider = '<img src=x onerror="alert(1)">'
    const html = OauthCallbackPage.error("<script>secret</script>", { provider })
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
    expect(html).toContain("&lt;script&gt;secret&lt;/script&gt;")
    expect(html).not.toContain(provider)
  })
  test("escapes bootstrap options embedded in the inline script", () => {
    const html = OauthCallbackPage.bootstrap({
      provider: `xAI</script><script>alert("provider")</script>`,
      tokenPath: `/token</script><script>alert("path")</script>`,
    })

    expect(html.match(/<\/script>/g)).toHaveLength(1)
    expect(html).toContain(`xAI\\u003c/script>\\u003cscript>alert(\\\"provider\\\")\\u003c/script>`)
    expect(html).toContain(`/token\\u003c/script>\\u003cscript>alert(\\\"path\\\")\\u003c/script>`)
  })
})
