import { resolveTemplate } from "@solid-primitives/i18n"

export function brandTemplate(key: string, template: string, applicationName?: string) {
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
  template: string,
  params?: Record<string, string | number | boolean>,
  applicationName?: string,
) {
  // Brand the source copy before inserting filenames, errors or other user data.
  return resolveTemplate(brandTemplate(key, template, applicationName), params)
}
