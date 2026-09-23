/**
 * §04 B9 — the download list's bookkeeping, kept pure so the states a user can land in
 * are provable without a running download.
 *
 * The list is the durable home for a finished file: the completion toast went back to
 * dismissing itself once this existed, so a row that quietly disappears takes the only
 * remaining door to the file with it. Nothing here ever drops a record on its own, and
 * every ending — done, failed, cancelled — stays visible with its own action.
 *
 * This run's list only: it is never written to disk (the PRD keeps "no history panel").
 */

export type DownloadState = 'progress' | 'done' | 'failed' | 'cancelled'

export interface DownloadItem {
  id: string
  name: string
  state: DownloadState
  /** bytes written so far; `total` is 0 when the server never said how big it is */
  received: number
  total: number
  /** where it landed — only a completed download has one */
  path?: string
}

export interface DownloadList {
  items: DownloadItem[]
}

export type DownloadEvent =
  | { id: string; kind: 'started'; name: string; total: number }
  | { id: string; kind: 'progress'; received: number }
  | { id: string; kind: 'retrying' }
  | { id: string; kind: 'done'; state: 'completed' | 'cancelled' | 'interrupted'; path?: string }

const ENDED: DownloadState[] = ['done', 'failed', 'cancelled']

function endState(state: 'completed' | 'cancelled' | 'interrupted'): DownloadState {
  if (state === 'completed') return 'done'
  if (state === 'cancelled') return 'cancelled'
  return 'failed'
}

/**
 * Fold one event into the list. Unknown ids are ignored rather than inventing a row:
 * a download this list never saw start is one it cannot describe.
 */
export function applyDownloadEvent(list: DownloadList, event: DownloadEvent): DownloadList {
  if (event.kind === 'started') {
    const item: DownloadItem = {
      id: event.id,
      name: event.name,
      state: 'progress',
      received: 0,
      total: event.total
    }
    // newest first: the one still running is the one being waited on
    return { items: [item, ...list.items.filter((i) => i.id !== event.id)] }
  }

  const index = list.items.findIndex((i) => i.id === event.id)
  if (index < 0) return list
  const current = list.items[index]

  let next: DownloadItem
  if (event.kind === 'progress') {
    // a byte count that goes backwards is a stale event, not a shrinking file
    if (event.received <= current.received) return list
    next = { ...current, received: event.received }
  } else if (event.kind === 'retrying') {
    if (current.state === 'progress') return list
    next = { ...current, state: 'progress', received: 0, path: undefined }
  } else {
    // a cancelled download that reports completion later is still cancelled: the user
    // said stop, and a row that flips back to "done" would offer a file they refused
    if (current.state === 'cancelled' && event.state === 'completed') return list
    next = { ...current, state: endState(event.state), path: event.path ?? current.path }
  }

  const items = list.items.slice()
  items[index] = next
  return { items }
}

/** Whether the head-band icon exists at all — it appears with the first download of
 *  the run and not before (§05 figures 5/6). */
export function hasDownloads(list: DownloadList): boolean {
  return list.items.length > 0
}

/** "Clear history" drops the finished rows only. It never touches a file on disk, and it
 *  never abandons a download still running. */
export function clearFinishedDownloads(list: DownloadList): DownloadList {
  return { items: list.items.filter((i) => !ENDED.includes(i.state)) }
}
