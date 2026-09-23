let dragging = false
const endListeners = new Set<() => void>()

export function beginLayoutDrag(): void {
  dragging = true
}

export function endLayoutDrag(): void {
  if (!dragging) return
  dragging = false
  for (const fn of [...endListeners]) fn()
}

export function isLayoutDragging(): boolean {
  return dragging
}

export function onLayoutDragEnd(fn: () => void): () => void {
  endListeners.add(fn)
  return () => {
    endListeners.delete(fn)
  }
}
