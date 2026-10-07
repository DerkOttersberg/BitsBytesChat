// Visibility can hide a prefix (side-chat context) as well as a suffix (undo).
// Keep each selected user turn and all of its assistant/compaction records.
export function visibleTurns<T extends { id: string }>(messages: T[], users: { id: string }[], visible: { id: string }[]) {
  if (users.length === visible.length && users.every((user, index) => user.id === visible[index]?.id)) return messages
  const userIDs = new Set(users.map(user => user.id))
  const visibleIDs = new Set(visible.map(user => user.id))
  let include = false
  return messages.filter(message => {
    if (userIDs.has(message.id)) include = visibleIDs.has(message.id)
    return include
  })
}
