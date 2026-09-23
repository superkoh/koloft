import type { GitFileStatus } from '@shared/types'

/**
 * The `files` tab's shared vocabulary — the pieces both Changes (FR-38…FR-43) and Browse
 * (FR-44…FR-49) speak, plus the two localStorage slots §Data Model puts per workspace.
 *
 * Kept out of `FilesView.tsx` so the two views can import types without importing the
 * container that mounts them: a view importing its own parent is a cycle that only fails
 * once someone adds a module-level constant to it.
 */

/** Which half of the Files tab is on screen (FR-38 / FR-44). Runtime-only, kept per
 *  conversation — a session never looked at before starts at Changes. */
export type FilesTab = 'changes' | 'browse'

/** FR-39 — the Changes baseline. `merge-base` is the default and resolves to
 *  `merge-base(HEAD, default branch)`; `head` is the literal `'HEAD'`. Runtime-only. */
export type BaseChoice = 'merge-base' | 'head'

/** FR-40's three filter groups. Each group is single-select with `all` as its default and
 *  the groups AND together; the whole record is runtime-only, kept per conversation. */
export interface ChangeFilters {
  /** the git letter, or every status */
  status: GitFileStatus | 'all'
  /** `session` = only files THIS session wrote (the transcript's `access: 'wrote'`) */
  owner: 'all' | 'session'
  /** `docs` = markdown + html, decided at the review round; `code` = the rest */
  type: 'all' | 'docs' | 'code'
}

export const DEFAULT_FILTERS: ChangeFilters = { status: 'all', owner: 'all', type: 'all' }

/** FR-40's docs group. Kept here rather than in `@shared/preview` because that module's
 *  `isWebPagePath` answers a different question (does this render in a guest) and html is
 *  a doc for the filter while being a web page for FR-11. */
export function isDocPath(path: string): boolean {
  return /\.(md|markdown|html?|mdx)$/i.test(path)
}

/**
 * Every popover the Files tab owns, in one union — FR-54's third rung consumes whichever
 * is open, and the panel can only do that if it can see all of them in one place. The
 * `context` member is FR-48's row menu, shared by Changes' and Browse's rows.
 */
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

/** A path as the panel SPELLS it: workspace-relative when the file is inside the
 *  workspace, absolute when it is not. The root itself, and a null root, answer the path
 *  unchanged — both are load-bearing for callers, so neither may be "tidied". */
export function relOf(path: string, root: string | null): string {
  return root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path
}

/** Split an absolute path into the directory prefix shown dim and the basename, both
 *  relative to the workspace root when the file is inside it — i.e. `relOf` cut at its
 *  last slash, so the two can never disagree about what "relative" means. */
export function splitPath(path: string, root: string | null): { dir: string; name: string } {
  const rel = relOf(path, root)
  const cut = rel.lastIndexOf('/')
  return cut < 0 ? { dir: '', name: rel } : { dir: rel.slice(0, cut + 1), name: rel.slice(cut + 1) }
}

// ---------------------------------------------------------------------------
// Per-workspace localStorage. FR-47 and FR-49 inherit the retiring tree's OWN slots
// (`koloft.ft.expanded:<root>` and its siblings) rather than minting new ones — the user's
// expansion state and bookmarks survive the tree's retirement that way, which is the
// whole point of naming the existing key in the requirement.

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
  } catch {
    /* quota / private mode — the convenience just won't persist */
  }
}

/** A yes/no slot next to the list ones above. Stored as `'1'` / `'0'` rather than JSON so
 *  a half-written or hand-edited value reads as "off" instead of throwing. */
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
  } catch {
    /* quota / private mode — the convenience just won't persist */
  }
}

export const expandedKey = (root: string): string => 'koloft.ft.expanded:' + root
export const bookmarksKey = (root: string): string => 'koloft.ft.bookmarks:' + root
export const recentKey = (root: string): string => 'koloft.ft.recent:' + root
/** A-05 — the "Show ignored files" switch. Keyed on the tree root, which is the session's
 *  own checkout, so a worktree remembers its own answer: two checkouts of the same project
 *  ignore different things, and one of them being noisy should not force the other open. */
export const showIgnoredKey = (root: string): string => 'koloft.ft.showIgnored:' + root

/** FR-49 — most recent first, deduplicated by path (a reopen MOVES the entry to the
 *  front rather than adding a second), capped at 12. Pure so the cap and the dedupe are
 *  unit-testable without a DOM. */
export function pushRecent(list: readonly string[], path: string): string[] {
  return [path, ...list.filter((p) => p !== path)].slice(0, RECENT_CAP)
}
