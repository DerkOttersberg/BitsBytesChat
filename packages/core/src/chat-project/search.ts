export * as ChatTitleSearch from "./search"

import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { DatabaseMigration } from "../database/migration"
import { SessionTable } from "../session/sql"

// Drizzle cannot describe FTS virtual tables or triggers. This shared extension
// is installed by both the additive migration and the empty-database bootstrap.
// A stable INTEGER PRIMARY KEY avoids coupling postings to session rowids, which
// SQLite is allowed to change during VACUUM on a text-primary-key table.
export const up: DatabaseMigration.Migration["up"] = (tx) =>
  Effect.gen(function* () {
    yield* tx.run(`CREATE TABLE IF NOT EXISTS chat_title_content (
    search_id INTEGER PRIMARY KEY,
    session_id TEXT NOT NULL UNIQUE REFERENCES session(id) ON DELETE CASCADE,
    title TEXT NOT NULL
  )`)
    yield* tx.run(`CREATE VIRTUAL TABLE IF NOT EXISTS chat_title_search USING fts5(
    title, content='chat_title_content', content_rowid='search_id', tokenize='trigram'
  )`)
    yield* tx.run(`CREATE TABLE IF NOT EXISTS chat_title_short (
    gram TEXT NOT NULL,
    search_id INTEGER NOT NULL REFERENCES chat_title_content(search_id) ON DELETE CASCADE,
    PRIMARY KEY(gram, search_id)
  ) WITHOUT ROWID`)
    yield* tx.run(`CREATE INDEX IF NOT EXISTS chat_title_short_session_idx ON chat_title_short(search_id)`)
    const shortInsert = `INSERT OR IGNORE INTO chat_title_short(gram, search_id)
    WITH RECURSIVE positions(n) AS (
      SELECT 1 WHERE length(new.title) > 0
      UNION ALL SELECT n + 1 FROM positions WHERE n < length(new.title)
    )
    SELECT lower(substr(new.title, n, 1)), new.search_id FROM positions
    UNION SELECT lower(substr(new.title, n, 2)), new.search_id FROM positions WHERE n < length(new.title);`
    yield* tx.run(`CREATE TRIGGER IF NOT EXISTS chat_title_content_insert AFTER INSERT ON chat_title_content BEGIN
    INSERT INTO chat_title_search(rowid, title) VALUES (new.search_id, new.title);
    ${shortInsert}
  END`)
    yield* tx.run(`CREATE TRIGGER IF NOT EXISTS chat_title_content_delete AFTER DELETE ON chat_title_content BEGIN
    INSERT INTO chat_title_search(chat_title_search, rowid, title) VALUES ('delete', old.search_id, old.title);
  END`)
    yield* tx.run(`CREATE TRIGGER IF NOT EXISTS chat_title_content_update AFTER UPDATE OF title ON chat_title_content BEGIN
    INSERT INTO chat_title_search(chat_title_search, rowid, title) VALUES ('delete', old.search_id, old.title);
    INSERT INTO chat_title_search(rowid, title) VALUES (new.search_id, new.title);
    DELETE FROM chat_title_short WHERE search_id = old.search_id;
    ${shortInsert}
  END`)
    yield* tx.run(`CREATE TRIGGER IF NOT EXISTS chat_title_session_insert AFTER INSERT ON session BEGIN
    INSERT INTO chat_title_content(session_id, title) VALUES(new.id, new.title);
  END`)
    yield* tx.run(`CREATE TRIGGER IF NOT EXISTS chat_title_session_update AFTER UPDATE OF title ON session
    WHEN old.title IS NOT new.title BEGIN
      UPDATE chat_title_content SET title = new.title WHERE session_id = new.id;
    END`)
    yield* tx.run(`INSERT INTO chat_title_content(session_id, title)
    SELECT id, title FROM session WHERE true
    ON CONFLICT(session_id) DO UPDATE SET title = excluded.title
    WHERE chat_title_content.title IS NOT excluded.title`)
  })

export function condition(search: string) {
  const text = search.trim()
  const pattern = "%" + text.replace(/[\\%_]/g, "\\$&") + "%"
  // FTS trigram postings require three Unicode codepoints. The compact short
  // index covers one/two-character substring searches with the same ASCII-only
  // case folding as SQLite LIKE, rather than falling back to a history scan.
  const ids =
    Array.from(text).length < 3
      ? sql`SELECT search_id FROM chat_title_short WHERE gram = ${text.replace(/[A-Z]/g, (value) => value.toLowerCase())}`
      : sql`SELECT rowid FROM chat_title_search WHERE chat_title_search MATCH ${'"' + text.replaceAll('"', '""') + '"'}`
  return sql`${SessionTable.id} IN (
    SELECT session_id FROM chat_title_content
    WHERE search_id IN (${ids}) AND title LIKE ${pattern} ESCAPE '\\'
    UNION
    SELECT membership.session_id FROM chat_organization AS membership
    INNER JOIN chat_project AS project ON project.id = membership.project_id
    WHERE project.name LIKE ${pattern} ESCAPE '\\'
  )`
}
