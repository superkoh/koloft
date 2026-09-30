import { SEARCH_URL } from '@shared/browserRoute'
import { loadList, saveList } from './components/filesModel'

export interface HistoryEntry {
  url: string
  title: string
  visits?: Record<string, number>
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

export const historyKey = (url: string): string => url.split('#')[0]

export function remember(
  list: readonly HistoryEntry[],
  url: string,
  title = '',
  visitIn?: string
): readonly HistoryEntry[] {
  const key = historyKey(url)
  if (!key || key === 'about:blank' || key.startsWith(SEARCH_URL)) return list
  const old = list.find((e) => e.url === key)
  const visits = visitIn
    ? { ...old?.visits, [visitIn]: (old?.visits?.[visitIn] ?? 0) + 1 }
    : old?.visits
  return [
    { url: key, title: title || old?.title || '', visits },
    ...list.filter((e) => e.url !== key)
  ].slice(0, HISTORY_CAP)
}

const totalVisits = (e: HistoryEntry): number =>
  Object.values(e.visits ?? {}).reduce((a, b) => a + b, 0)

export function match(
  list: readonly HistoryEntry[],
  query: string,
  workspace: string | null = null
): HistoryEntry[] {
  const q = bare(query.trim())
  if (!q) return []
  const here = (e: HistoryEntry): number => (workspace && e.visits?.[workspace]) || 0
  return list
    .filter((e) => bare(e.url).includes(q) || e.title.toLowerCase().includes(q))
    .sort((a, b) => here(b) - here(a) || (here(a) ? 0 : totalVisits(b) - totalVisits(a)))
    .slice(0, MATCH_CAP)
}

export const loadHistory = (): HistoryEntry[] => loadList<HistoryEntry>(HISTORY_KEY)
export const saveHistory = (list: readonly HistoryEntry[]): void => saveList(HISTORY_KEY, list)
export const clearHistory = (): void => saveList(HISTORY_KEY, [])
