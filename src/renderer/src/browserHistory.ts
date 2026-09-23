import { SEARCH_URL } from '@shared/browserRoute'
import { loadList, saveList } from './components/filesModel'

export interface HistoryEntry {
  url: string
  title: string
}

export const HISTORY_KEY = 'koloft.browser.history'
export const HISTORY_CAP = 200
const MATCH_CAP = 6

function bare(s: string): string {
  return s
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
}

export function remember(
  list: readonly HistoryEntry[],
  url: string,
  title = ''
): readonly HistoryEntry[] {
  const key = url.split('#')[0]
  if (!key || key === 'about:blank' || key.startsWith(SEARCH_URL)) return list
  const old = list.find((e) => e.url === key)
  return [
    { url: key, title: title || old?.title || '' },
    ...list.filter((e) => e.url !== key)
  ].slice(0, HISTORY_CAP)
}

export function match(list: readonly HistoryEntry[], query: string): HistoryEntry[] {
  const q = bare(query.trim())
  if (!q) return []
  return list
    .filter((e) => bare(e.url).includes(q) || e.title.toLowerCase().includes(q))
    .slice(0, MATCH_CAP)
}

export const loadHistory = (): HistoryEntry[] => loadList<HistoryEntry>(HISTORY_KEY)
export const saveHistory = (list: readonly HistoryEntry[]): void => saveList(HISTORY_KEY, list)
export const clearHistory = (): void => saveList(HISTORY_KEY, [])
