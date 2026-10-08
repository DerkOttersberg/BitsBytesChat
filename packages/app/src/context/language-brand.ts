import { resolveTemplate } from "@solid-primitives/i18n"

export function brandTemplate(key: string, template: string | undefined, applicationName?: string) {
  // Dynamic tool permissions have no dictionary entry. Preserve the translator's
  // missing-key contract so their approval dock can omit its optional hint.
  if (typeof template !== "string") return key
  if (
    !applicationName ||
    key.startsWith("provider.connect.opencodeZen.") ||
    key === "dialog.model.unpaid.freeModels.title"
  )
    return template
  return template.replace(/\bOpenCode(?: Desktop)?\b/g, () => applicationName)
}

export function resolveBrandedTemplate(
  key: string,
  template: string | undefined,
  params?: Record<string, string | number | boolean>,
  applicationName?: string,
) {
  // Brand the source copy before inserting filenames, errors or other user data.
  return resolveTemplate(brandTemplate(key, template, applicationName), params)
}
