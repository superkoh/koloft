// Chromium caps live WebGL contexts at ~16 per renderer process, and every Koloft
// terminal tab lives in the one renderer process — so they all draw from the same
// budget. Past the cap Chromium kills the oldest context ("Too many active WebGL
// contexts. The oldest context will be lost."), which scrambles that tab's glyphs
// (the CJK "garbled glyphs"). This pool keeps WebGL on only the MAX most-recently-used tabs and
// reverts the rest to their fallback renderer, so the limit is never reached.
//
// It governs ONLY the render backend (a WebglAddon) — never the Terminal buffer or the
// pty — so evicting and later restoring a tab's context is invisible and never ends a
// session. The cap sits below 16 to leave headroom for the brief moment a context is
// being torn down and for any other GL surfaces in the process.

const MAX = 12

type Member = {
  attach: () => void // create + load the WebglAddon on this tab's terminal
  detach: () => void // dispose the WebglAddon (terminal reverts to its fallback)
  holding: boolean // whether this tab currently owns a live context
}

const members = new Map<string, Member>()
const mru: string[] = [] // ids of current holders, least-recently-used first

function bump(id: string): void {
  const i = mru.indexOf(id)
  if (i !== -1) mru.splice(i, 1)
  mru.push(id)
}

function promote(id: string): void {
  const m = members.get(id)
  if (!m) return
  if (!m.holding) {
    // Free a slot before attaching so we never momentarily exceed the cap.
    while (mru.length >= MAX) {
      const victim = mru.shift()
      if (victim === undefined) break
      const vm = members.get(victim)
      if (vm && vm.holding) {
        vm.holding = false
        vm.detach()
      }
    }
    m.holding = true
    m.attach()
  }
  bump(id)
}

/** Register a WebGL-capable tab and give it a context straight away. */
export function acquireWebgl(id: string, attach: () => void, detach: () => void): void {
  const existing = members.get(id)
  if (existing) {
    existing.attach = attach
    existing.detach = detach
  } else {
    members.set(id, { attach, detach, holding: false })
  }
  promote(id)
}

/** Bump a tab to most-recently-used on activation, re-attaching it if it was evicted. */
export function touchWebgl(id: string): void {
  promote(id)
}

/** Drop a tab from the pool (unmount or unrecoverable context loss).
 *  Bookkeeping only — the caller disposes the addon (component teardown / loss handler). */
export function releaseWebgl(id: string): void {
  members.delete(id)
  const i = mru.indexOf(id)
  if (i !== -1) mru.splice(i, 1)
}
