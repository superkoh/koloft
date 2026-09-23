// Auto-repair for WebGL glyph-atlas corruption (the "garbled screen": blank cells, wrong glyphs,
// or a fully garbled screen).
//
// The texture atlas is SHARED across every terminal with matching font/theme/DPR
// (xterm CharAtlasCache), and its page-merge path corrupted rendering (xterm.js
// #5883, #6014/#6055, plus the June–July 2026 per-renderer page-invalidation and
// overflow fixes). Those structural bugs are fixed upstream in @xterm/addon-webgl
// 0.20.0-beta.298+ — the version this repo pins, gated by webglAtlasFix.test.ts and
// scripts/assert-webgl-atlas.sh. (Koloft previously hand-ported #5883/#6014 onto stable
// 0.19.0 via patch-package; the later per-renderer invalidation work is what finally
// killed the residual garbled screen on output bursts, and it is not portable — hence the
// upgrade.) This module covers the two windows the addon's own fixes can't close:
//
//  - After a page merge, the renderer heals on the NEXT rendered frame — but if
//    output stops right on the merge frame, no next frame is ever scheduled.
//    onRemoveTextureAtlasCanvas fires exactly when a merge deletes pages, so a
//    debounced full refresh of every live tab guarantees that healing frame.
//  - OS resume / screen unlock / display changes can silently invalidate GPU texture
//    memory: no webglcontextlost fires and page versions still match, so nothing ever
//    re-uploads. clearTextureAtlas() invalidates the pages for every owner of the
//    shared atlas; main signals those moments via 'webgl:repair'.
//
// One thing that looks like a better fix and is not: pre-emptively clearing the atlas
// "before it fills" CANNOT prevent merges. clearTexture() empties pages but never
// splices `_pages`, and the merge trigger is purely `_pages.length >= maxAtlasPages` —
// the page count is an irreversible high-water mark. (Heavy CJK output fills it fast:
// every char × color × bold is a distinct cache key, which is why the garbled screen appeared
// mid-session, not at startup.)

import type { WebglAddon } from '@xterm/addon-webgl'

type Entry = {
  addon: WebglAddon
  refresh: () => void // full-range term.refresh — schedules a frame; no-ops while hidden
  offMerge: () => void
}

const live = new Map<string, Entry>()
let mergeTimer: ReturnType<typeof setTimeout> | undefined
let pendingFull = false

function refreshAll(): void {
  for (const e of live.values()) e.refresh()
}

// ONE coalescing window for every repair trigger — merge signals want a refresh,
// lifecycle edges want the heavier atlas-wipe repair; when both land in the same
// burst the strongest action wins and everyone still repaints exactly once (two
// racing timers double-refreshed, which the coalescing unit test rightly rejects).
function armRepair(full: boolean): void {
  pendingFull = pendingFull || full
  clearTimeout(mergeTimer)
  mergeTimer = setTimeout(() => {
    const doFull = pendingFull
    pendingFull = false
    if (doFull) repairAllWebgl()
    else refreshAll()
  }, 50)
}

// One merge fires once per deleted page, forwarded to every addon sharing the atlas —
// coalesce the burst before refreshing.
function onMergeSignal(): void {
  armRepair(false)
}

/** Clear the (shared) glyph atlas and repaint every live WebGL tab. Recovery for GPU
 *  state loss that fires no event; wired to main's 'webgl:repair' in App. */
export function repairAllWebgl(): void {
  for (const e of live.values()) {
    // First call wipes the shared atlas (siblings' calls no-op on the emptied atlas),
    // and every call rebuilds that addon's own vertex model. Multiple atlases (mixed
    // configs) are each covered by their own member's call.
    try {
      e.addon.clearTextureAtlas()
    } catch {
      /* addon mid-disposal — skip */
    }
  }
  refreshAll()
}

/** Debounced full repair for terminal LIFECYCLE edges: mounting or disposing an xterm
 *  churns the shared glyph atlas (pages allocate on join, drop/merge on dispose), and
 *  a merge landing on a frame no survivor re-renders leaves them garbled — the
 *  reported case being "close an aux tab, the TUI scrambles". register/unregister
 *  call this, so every mount/unmount path in the app is covered without per-caller
 *  wiring; layout transitions (aux column show/hide) and merge signals share the one
 *  coalescing window (armRepair). */
export function scheduleWebglRepair(): void {
  armRepair(true)
}

export function registerWebglRepair(id: string, addon: WebglAddon, refresh: () => void): void {
  // onRemoveTextureAtlasCanvas is public typed API since addon 0.19.0; it only ever
  // fires from a page merge. Feature-detect anyway: if it drifts across an addon bump,
  // merge-triggered repair silently disarms (the repair IPC still works).
  let offMerge = (): void => {}
  try {
    const ev = addon.onRemoveTextureAtlasCanvas
    if (typeof ev === 'function') {
      const d = ev(onMergeSignal)
      offMerge = (): void => d.dispose()
    }
  } catch {
    /* ignore */
  }
  live.get(id)?.offMerge()
  live.set(id, { addon, refresh, offMerge })
  scheduleWebglRepair() // a new member just churned the shared atlas
}

export function unregisterWebglRepair(id: string): void {
  const e = live.get(id)
  if (!e) return
  e.offMerge()
  live.delete(id)
  scheduleWebglRepair() // the departure churns the atlas the survivors still use
}
