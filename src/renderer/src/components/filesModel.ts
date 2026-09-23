import type { GitFileStatus } from '@shared/types'

export type FilesTab = 'changes' | 'browse'

export type BaseChoice = 'merge-base' | 'head'

export interface ChangeFilters {
  status: GitFileStatus | 'all'
  owner: 'all' | 'session'
  type: 'all' | 'docs' | 'code'
}

export const DEFAULT_FILTERS: ChangeFilters = { status: 'all', owner: 'all', type: 'all' }

export function isDocPath(path: string): boolean {
  return /\.(md|markdown|html?|mdx)$/i.test(path)
}

export type FilesMenu =
  | { kind: 'base' }
  | { kind: 'filter' }
  | { kind: 'context'; path: string; rel: string; isDir: boolean; x: number; y: number }

export const GIT_LETTER: Record<GitFileStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  untracked: 'U',
  renamed: 'R',
  conflict: '!'
}

export function relOf(path: string, root: string | null): string {
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

export function splitPath(path: string, root: string | null): { dir: string; name: string } {
  const rel = relOf(path, root)
  const cut = rel.lastIndexOf('/')
  return cut < 0 ? { dir: '', name: rel } : { dir: rel.slice(0, cut + 1), name: rel.slice(cut + 1) }
}

export const RECENT_CAP = 12

export function loadList<T = string>(key: string): T[] {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T[]) : []
  } catch {
    return []
  }
}

export function saveList(key: string, v: readonly unknown[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(v))
  } catch {}
}

export function loadFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export function saveFlag(key: string, v: boolean): void {
  try {
    localStorage.setItem(key, v ? '1' : '0')
  } catch {}
}

export const expandedKey = (root: string): string => 'koloft.ft.expanded:' + root
export const bookmarksKey = (root: string): string => 'koloft.ft.bookmarks:' + root
export const recentKey = (root: string): string => 'koloft.ft.recent:' + root
export const showIgnoredKey = (root: string): string => 'koloft.ft.showIgnored:' + root

export function pushRecent(list: readonly string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, RECENT_CAP)
}
