import type { WebglAddon } from '@xterm/addon-webgl'

type Entry = {
  addon: WebglAddon
  refresh: () => void
  offMerge: () => void
}

const live = new Map<string, Entry>()
const REPAIR_COALESCE_MS = 50
let repairTimer: ReturnType<typeof setTimeout> | undefined
let pendingAtlasWipe = false

function refreshAll(): void {
  for (const e of live.values()) e.refresh()
}

function armRepair(wipeAtlas: boolean): void {
  pendingAtlasWipe = pendingAtlasWipe || wipeAtlas
  clearTimeout(repairTimer)
  repairTimer = setTimeout(() => {
    const wipe = pendingAtlasWipe
    pendingAtlasWipe = false
    if (wipe) repairAllWebgl()
    else refreshAll()
  }, REPAIR_COALESCE_MS)
}

function onMergeSignal(): void {
  armRepair(false)
}

// PLATFORM§20 PLATFORM§23
export function repairAllWebgl(): void {
  for (const e of live.values()) {
    try {
      e.addon.clearTextureAtlas()
    } catch {}
  }
  refreshAll()
}

export function scheduleWebglRepair(): void {
  armRepair(true)
}

// PLATFORM§23
export function registerWebglRepair(id: string, addon: WebglAddon, refresh: () => void): void {
  let offMerge = (): void => {}
  try {
    const ev = addon.onRemoveTextureAtlasCanvas
    if (typeof ev === 'function') {
      const d = ev(onMergeSignal)
      offMerge = (): void => d.dispose()
    }
  } catch {}
  live.get(id)?.offMerge()
  live.set(id, { addon, refresh, offMerge })
  scheduleWebglRepair()
}

// PLATFORM§23
export function unregisterWebglRepair(id: string): void {
  const e = live.get(id)
  if (!e) return
  e.offMerge()
  live.delete(id)
  scheduleWebglRepair()
}
