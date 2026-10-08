import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261008210009_chat_organization",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`chat_organization_state\` (
          \`key\` text PRIMARY KEY,
          \`value\` text NOT NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`chat_organization\` (
          \`session_id\` text PRIMARY KEY,
          \`project_id\` text,
          \`pinned\` integer DEFAULT false NOT NULL,
          \`position\` integer DEFAULT 0 NOT NULL,
          CONSTRAINT \`fk_chat_organization_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE,
          CONSTRAINT \`fk_chat_organization_project_id_chat_project_id_fk\` FOREIGN KEY (\`project_id\`) REFERENCES \`chat_project\`(\`id\`) ON DELETE SET NULL
        );
      `)
      yield* tx.run(`
        CREATE TABLE \`chat_project\` (
          \`id\` text PRIMARY KEY,
          \`name\` text NOT NULL,
          \`directory\` text,
          \`pinned\` integer DEFAULT false NOT NULL,
          \`position\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_updated\` integer NOT NULL
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`chat_organization_project_idx\` ON \`chat_organization\` (\`project_id\`,\`session_id\`);`,
      )
      yield* tx.run(`CREATE INDEX \`chat_organization_pin_idx\` ON \`chat_organization\` (\`pinned\`,\`position\`);`)
      yield* tx.run(
        `CREATE INDEX \`session_sidebar_updated_idx\` ON \`session\` (\`parent_id\`,\`time_archived\`,\`time_updated\`,\`id\`);`,
      )
      yield* tx.run(
        `CREATE INDEX \`session_sidebar_created_idx\` ON \`session\` (\`parent_id\`,\`time_archived\`,\`time_created\`,\`id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
