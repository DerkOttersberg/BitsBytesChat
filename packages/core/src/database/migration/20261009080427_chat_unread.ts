import { Effect } from "effect"
import { sql } from "drizzle-orm"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261009080427_chat_unread",
  up(tx) {
    return Effect.gen(function* () {
      const columns = yield* tx.all<{ name: string }>(sql`PRAGMA table_info(chat_organization)`)
      if (columns.some((column) => column.name === "unread")) return
      yield* tx.run(`ALTER TABLE \`chat_organization\` ADD \`unread\` integer DEFAULT false NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
