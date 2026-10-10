import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { useLanguage } from "../../context/language"

export function PanelToggle(props: { expanded: boolean; onToggle: () => void }) {
  const language = useLanguage()
  return (
    <IconButtonV2
      type="button"
      data-bb-panel-toggle
      variant="ghost-muted"
      size="large"
      icon={<Icon name="sidebar-right" />}
      state={props.expanded ? "pressed" : undefined}
      aria-label={language.t(props.expanded ? "bitsbytes.collapse" : "bitsbytes.expand")}
      title={language.t(props.expanded ? "bitsbytes.collapse" : "bitsbytes.expand")}
      aria-expanded={props.expanded}
      onClick={props.onToggle}
    />
  )
}
