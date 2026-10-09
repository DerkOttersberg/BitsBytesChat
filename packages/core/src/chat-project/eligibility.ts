export * as ChatEligibility from "./eligibility"

import { sql } from "drizzle-orm"
import { MessageTable, SessionInputTable, SessionMessageTable, SessionTable } from "../session/sql"

// Admission makes a conversation durable before the runner projects its first message.
// Each lookup uses an existing session-leading index and never loads transcript bodies.
export const condition = () => sql`(
  EXISTS (SELECT 1 FROM ${SessionInputTable} WHERE ${SessionInputTable.session_id} = ${SessionTable.id})
  OR EXISTS (
    SELECT 1 FROM ${MessageTable}
    WHERE ${MessageTable.session_id} = ${SessionTable.id}
      AND CASE WHEN json_valid(${MessageTable.data}) THEN json_extract(${MessageTable.data}, '$.role') END = 'user'
  )
  OR EXISTS (
    SELECT 1 FROM ${SessionMessageTable}
    WHERE ${SessionMessageTable.session_id} = ${SessionTable.id}
      AND ${SessionMessageTable.type} IN ('user', 'shell')
  )
)`
