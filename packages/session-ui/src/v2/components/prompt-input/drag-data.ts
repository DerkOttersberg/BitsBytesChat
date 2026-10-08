// Queue reordering must not be interpreted as a file mention or editor text.
export const queuedInputDragType = "application/x-bitsbytes-queued-input"

export function isQueuedInputDrag(event: DragEvent) {
  return event.dataTransfer?.types.includes(queuedInputDragType) ?? false
}
