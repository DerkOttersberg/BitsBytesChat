import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core"
import { SessionTable } from "../session/sql"

export const ChatProjectTable = sqliteTable("chat_project", {
  id: text().primaryKey(),
  name: text().notNull(),
  directory: text(),
  pinned: integer({ mode: "boolean" }).notNull().default(false),
  position: integer().notNull().default(0),
  time_created: integer().notNull(),
  time_updated: integer().notNull(),
})

export const ChatOrganizationTable = sqliteTable(
  "chat_organization",
  {
    session_id: text()
      .primaryKey()
      .references(() => SessionTable.id, { onDelete: "cascade" }),
    project_id: text().references(() => ChatProjectTable.id, { onDelete: "set null" }),
    pinned: integer({ mode: "boolean" }).notNull().default(false),
    unread: integer({ mode: "boolean" }).notNull().default(false),
    position: integer().notNull().default(0),
  },
  (table) => [
    index("chat_organization_project_idx").on(table.project_id, table.session_id),
    index("chat_organization_pin_idx").on(table.pinned, table.position),
  ],
)

export const ChatOrganizationStateTable = sqliteTable("chat_organization_state", {
  key: text().primaryKey(),
  value: text().notNull(),
})
