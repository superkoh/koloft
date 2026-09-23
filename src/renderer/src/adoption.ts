/**
 * renderer re-adoption bookkeeping that must outlive React renders.
 *
 * After a reload the boot effect pulls main's tab inventory and rebuilds the strip
 * (store.adoptTabs). Two races live in the sub-second window before that lands:
 *  - a click on a running row would read "orphan" and offer Force Close for a
 *    session that is about to come back — the confirm awaits `adoptionSettled`;
 *  - a pty can exit after main snapshotted the inventory but before the renderer
 *    applies it — adopting it then would build a zombie tab, so exits seen before
 *    settlement are tombstoned and the boot effect skips them.
 */

let resolveSettled: (() => void) | null = null
let settled = false

/** Resolves once the boot adoption applied (or found nothing to adopt / failed —
 *  the boot effect settles in `finally`, so this can never hang a click). */
export const adoptionSettled: Promise<void> = new Promise((r) => {
  resolveSettled = r
})

export function markAdoptionSettled(): void {
  settled = true
  resolveSettled?.()
}

export function adoptionIsSettled(): boolean {
  return settled
}

/** pty ids whose terminal:exit arrived before adoption settled — stale in the
 *  inventory snapshot, must not adopt. Bounded: nothing is added past settlement. */
export const preAdoptExits = new Set<string>()
