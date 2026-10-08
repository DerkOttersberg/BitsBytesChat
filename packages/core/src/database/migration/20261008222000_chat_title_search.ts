import { ChatTitleSearch } from "../../chat-project/search"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008222000_chat_title_search",
  up: ChatTitleSearch.up,
} satisfies DatabaseMigration.Migration
