import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import { DatabaseMigration } from "@opencode-ai/core/database/migration"
import chatUnreadMigration from "@opencode-ai/core/database/migration/20261009080427_chat_unread"

test("unread migration preserves old organization state and safely repeats", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run(sql`CREATE TABLE chat_organization (
      session_id TEXT PRIMARY KEY, project_id TEXT, pinned INTEGER NOT NULL DEFAULT false, position INTEGER NOT NULL DEFAULT 0
    )`)
      yield* db.run(
        sql`INSERT INTO chat_organization (session_id, project_id, pinned, position) VALUES ('ses_saved', 'cpr_saved', 1, 7)`,
      )
      yield* DatabaseMigration.applyOnly(db, [chatUnreadMigration])
      yield* DatabaseMigration.applyOnly(db, [chatUnreadMigration])
      expect(yield* db.get(sql`SELECT * FROM chat_organization`)).toEqual({
        session_id: "ses_saved",
        project_id: "cpr_saved",
        pinned: 1,
        position: 7,
        unread: 0,
      })
      yield* db.run(sql`UPDATE chat_organization SET unread = 1`)
      yield* db.transaction(chatUnreadMigration.up)
      expect(yield* db.get(sql`SELECT unread FROM chat_organization`)).toEqual({ unread: 1 })
      expect(yield* db.all(sql`SELECT id FROM migration`)).toEqual([{ id: chatUnreadMigration.id }])
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )
})
