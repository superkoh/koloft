export type DownloadState = 'progress' | 'done' | 'failed' | 'cancelled'

export interface DownloadItem {
  id: string
  name: string
  state: DownloadState
  received: number
  total: number
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

export function applyDownloadEvent(list: DownloadList, event: DownloadEvent): DownloadList {
  if (event.kind === 'started') {
    const item: DownloadItem = {
      id: event.id,
      name: event.name,
      state: 'progress',
      received: 0,
      total: event.total
    }
    return { items: [item, ...list.items.filter((i) => i.id !== event.id)] }
  }

  const index = list.items.findIndex((i) => i.id === event.id)
  if (index < 0) return list
  const current = list.items[index]

  let next: DownloadItem
  if (event.kind === 'progress') {
    if (event.received <= current.received) return list
    next = { ...current, received: event.received }
  } else if (event.kind === 'retrying') {
    if (current.state === 'progress') return list
    next = { ...current, state: 'progress', received: 0, path: undefined }
  } else {
    if (current.state === 'cancelled' && event.state === 'completed') return list
    next = { ...current, state: endState(event.state), path: event.path ?? current.path }
  }

  const items = list.items.slice()
  items[index] = next
  return { items }
}

export function hasDownloads(list: DownloadList): boolean {
  return list.items.length > 0
}

export function clearFinishedDownloads(list: DownloadList): DownloadList {
  return { items: list.items.filter((i) => !ENDED.includes(i.state)) }
}
