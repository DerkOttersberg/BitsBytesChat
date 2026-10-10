// Form handlers need allow-forms even when JavaScript cancels submission.
// Keep the origin opaque and use CSP to prevent outbound form navigation.
export const htmlPreviewSandbox = "allow-scripts allow-forms"

export function isolatedHTML(text: string) {
  return (
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none';\">" +
    text
  )
}
