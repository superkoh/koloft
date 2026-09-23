/**
 * Whether a layout gutter is being dragged right now, so terminals can hold their pty
 * size until the pointer is released (TerminalView's ResizeObserver).
 *
 * A drag walks the box through every intermediate size, and each one that reaches a pty
 * is a SIGWINCH the program inside has to answer: a shell reprints its prompt — scrolling
 * if the transient box is shorter than the prompt, which appends those lines to the
 * scrollback permanently — and an alt-screen TUI redraws into a screen it is about to
 * lose again. Both are paid per intermediate size and neither is refundable, so the
 * intermediate sizes are simply not delivered; only the size the user settles on is. A
 * time-based quiet window cannot do this job — a hand drag pauses far longer than any
 * window worth waiting for, so every pause bills its own resize.
 *
 * Deliberately DOM-free: the drag handlers in App.tsx already own the mousemove/mouseup
 * pair, so the gate only has to hold the flag and announce the release.
 */
let dragging = false
const endListeners = new Set<() => void>()

export function beginLayoutDrag(): void {
  dragging = true
}

/** Ends the drag and lets everyone who deferred work settle it. No-op when idle, so a
 *  stray mouseup can never trigger a resize nobody asked for. */
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
