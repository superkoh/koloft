import type { EditFingerprint, EditOpenResult } from '@shared/types'
import { EDIT_WRITE_MAX_BYTES, sizeLabel } from '@shared/editLimits'
import { isDirty, sameStamp } from './components/editBuffer'

export interface DirtyTab {
  ownerTabId: string
  tabId: string
  path: string
}

export interface EditEntry {
  path: string
  eol: 'lf' | 'crlf'
  readOnly: EditOpenResult['readOnly']
  original: string
  text: string
  stamp: EditFingerprint
  savedAt: number | null
  conflict: { text: string | null; stamp: EditFingerprint; unreadable: boolean } | null
  error: string | null
  selection: { start: number; end: number }
}

const entries = new Map<string, EditEntry>()
const listeners = new Set<() => void>()

const SEP = ' '
const keyOf = (ownerTabId: string, tabId: string): string => ownerTabId + SEP + tabId

function notify(): void {
  for (const cb of [...listeners]) cb()
}

// PLATFORM§24
function flatten(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text
}

export function beginEdit(
  ownerTabId: string,
  tabId: string,
  init: {
    path: string
    text: string
    eol: 'lf' | 'crlf'
    stamp: EditFingerprint
    readOnly: EditOpenResult['readOnly']
  }
): void {
  const text = flatten(init.text)
  entries.set(keyOf(ownerTabId, tabId), {
    path: init.path,
    eol: init.eol,
    readOnly: init.readOnly,
    original: text,
    text,
    stamp: init.stamp,
    savedAt: null,
    conflict: null,
    error: null,
    selection: { start: 0, end: 0 }
  })
  notify()
}

export function endEdit(ownerTabId: string, tabId: string): void {
  if (entries.delete(keyOf(ownerTabId, tabId))) notify()
}

export function endEditsOf(ownerTabId: string): void {
  for (const t of allEditTabs()) {
    if (t.ownerTabId === ownerTabId && !isTabDirty(ownerTabId, t.tabId))
      endEdit(ownerTabId, t.tabId)
  }
}

export function getEntry(ownerTabId: string, tabId: string): EditEntry | undefined {
  return entries.get(keyOf(ownerTabId, tabId))
}

export function setText(ownerTabId: string, tabId: string, text: string): void {
  const e = entries.get(keyOf(ownerTabId, tabId))
  if (!e) return
  const was = isDirty(e.original, e.text)
  e.text = text
  if (isDirty(e.original, text) !== was) notify()
}

export function setSelection(ownerTabId: string, tabId: string, start: number, end: number): void {
  const e = entries.get(keyOf(ownerTabId, tabId))
  if (e) e.selection = { start, end }
}

export function applyDisk(
  ownerTabId: string,
  tabId: string,
  text: string,
  stamp: EditFingerprint
): void {
  const e = entries.get(keyOf(ownerTabId, tabId))
  if (!e) return
  e.original = flatten(text)
  e.text = e.original
  e.stamp = stamp
  e.conflict = null
  e.error = null
  notify()
}

export function noteConflict(
  ownerTabId: string,
  tabId: string,
  c: { text: string | null; stamp: EditFingerprint; unreadable: boolean }
): void {
  const e = entries.get(keyOf(ownerTabId, tabId))
  if (!e) return
  e.conflict = { ...c, text: c.text === null ? null : flatten(c.text) }
  notify()
}

export function clearConflict(ownerTabId: string, tabId: string): void {
  const e = entries.get(keyOf(ownerTabId, tabId))
  if (!e || !e.conflict) return
  e.conflict = null
  notify()
}

export function isTabDirty(ownerTabId: string, tabId: string): boolean {
  const e = entries.get(keyOf(ownerTabId, tabId))
  return !!e && isDirty(e.original, e.text)
}

function dirtyList(match?: string): DirtyTab[] {
  const out: DirtyTab[] = []
  for (const [key, e] of entries) {
    if (!isDirty(e.original, e.text)) continue
    const at = key.indexOf(SEP)
    const ownerTabId = key.slice(0, at)
    if (match !== undefined && ownerTabId !== match) continue
    out.push({ ownerTabId, tabId: key.slice(at + 1), path: e.path })
  }
  return out
}

export function rekeyOwner(oldOwnerTabId: string, newOwnerTabId: string): void {
  let moved = false
  for (const [key, e] of [...entries]) {
    const at = key.indexOf(SEP)
    if (key.slice(0, at) !== oldOwnerTabId) continue
    entries.delete(key)
    entries.set(keyOf(newOwnerTabId, key.slice(at + 1)), e)
    moved = true
  }
  if (moved) notify()
}

export function allEditTabs(): DirtyTab[] {
  const out: DirtyTab[] = []
  for (const [key, e] of entries) {
    const at = key.indexOf(SEP)
    out.push({ ownerTabId: key.slice(0, at), tabId: key.slice(at + 1), path: e.path })
  }
  return out
}

export function reconcileDisk(
  ownerTabId: string,
  tabId: string,
  disk: { text: string | null; stamp: EditFingerprint }
): void {
  const e = entries.get(keyOf(ownerTabId, tabId))
  if (!e || sameStamp(disk.stamp, e.stamp)) return
  if (disk.text !== null) {
    if (!isDirty(e.original, e.text) || flatten(disk.text) === e.text) {
      applyDisk(ownerTabId, tabId, disk.text, disk.stamp)
      return
    }
  } else if (e.conflict && sameStamp(e.conflict.stamp, disk.stamp)) return
  noteConflict(ownerTabId, tabId, { text: disk.text, stamp: disk.stamp, unreadable: false })
}

export function dirtyTabsOf(ownerTabId: string): DirtyTab[] {
  return dirtyList(ownerTabId)
}

export function allDirtyTabs(): DirtyTab[] {
  return dirtyList()
}

function saveFailureMessage(err: unknown): string {
  const msg = String((err as Error)?.message ?? '')
  if (msg.includes('KOLOFT_NO_PERM')) return 'Not allowed to write this file.'
  if (msg.includes('KOLOFT_DIR_GONE')) return 'The folder is gone — nothing was written.'
  if (msg.includes('KOLOFT_GONE')) return 'This file is not there any more.'
  if (msg.includes('KOLOFT_TOO_LARGE'))
    return `Too big to save — the limit is ${sizeLabel(EDIT_WRITE_MAX_BYTES)}.`
  if (msg.includes('KOLOFT_NOT_FILE')) return 'This is not a plain file any more.'
  return 'Could not save this file.'
}

export function saveTab(
  ownerTabId: string,
  tabId: string,
  opts?: { force?: boolean }
): Promise<SaveResult> {
  const key = keyOf(ownerTabId, tabId)
  const before = inFlight.get(key)
  const next = (): Promise<SaveResult> => writeOnce(key, opts)
  const p = before ? before.then(next, next) : next()
  inFlight.set(key, p)
  const done = (): void => {
    if (inFlight.get(key) === p) inFlight.delete(key)
  }
  p.then(done, done)
  return p
}

type SaveResult = 'saved' | 'stale' | 'failed' | 'clean'

const inFlight = new Map<string, Promise<SaveResult>>()

async function writeOnce(key: string, opts?: { force?: boolean }): Promise<SaveResult> {
  const e = entries.get(key)
  if (!e) return 'clean'
  if (!opts?.force && !isDirty(e.original, e.text)) return 'clean'
  const sent = e.text
  try {
    const r = await window.api.edit.write(
      e.path,
      sent,
      e.stamp,
      opts?.force ? { force: true, eol: e.eol } : { eol: e.eol }
    )
    if (!r.ok) {
      const disk: string | null = r.text ?? null
      e.conflict = {
        text: disk === null ? null : flatten(disk),
        stamp: { mtimeMs: r.mtimeMs, size: r.size },
        unreadable: disk === null
      }
      notify()
      return 'stale'
    }
    e.original = sent
    e.stamp = { mtimeMs: r.mtimeMs, size: r.size }
    e.savedAt = Date.now()
    e.conflict = null
    e.error = null
    notify()
    return 'saved'
  } catch (err) {
    e.error = saveFailureMessage(err)
    notify()
    return 'failed'
  }
}

export function discardTab(ownerTabId: string, tabId: string): void {
  const e = entries.get(keyOf(ownerTabId, tabId))
  if (!e) return
  e.text = e.original
  e.conflict = null
  e.error = null
  notify()
}

let editingNow = false

export function setEditingActive(active: boolean): void {
  if (active === editingNow) return
  editingNow = active
  notify()
}

export function editingActive(): boolean {
  return editingNow
}

export function subscribeDirty(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
