import type { DirEntry, GitNumstatMap, GitStatusMap, PreviewItem, SessionInfo } from '@shared/types'
import { isWebPagePath, previewKindForPath } from '@shared/preview'

export function inRoot(p: string, root: string): boolean {
  return p === root || p.startsWith(root + '/')
}

export function relTo(p: string, root: string): string {
  return inRoot(p, root) ? p.slice(root.length + 1) : p
}

export function ancestorDirs(p: string, root: string): string[] {
  const out: string[] = []
  let d = p.slice(0, p.lastIndexOf('/'))
  while (d === root || d.startsWith(root + '/')) {
    out.push(d)
    if (d === root) break
    d = d.slice(0, d.lastIndexOf('/'))
  }
  return out
}

export function midTruncate(s: string, max = 26): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return s.slice(0, head) + '…' + s.slice(s.length - tail)
}

export function locFor(p: string, root: string, home: string): string {
  if (inRoot(p, root)) {
    const rel = relTo(p, root)
    const slash = rel.lastIndexOf('/')
    return slash === -1 ? '' : rel.slice(0, slash)
  }
  return shortenHome(p.slice(0, p.lastIndexOf('/')), home)
}

export function shortenHome(p: string, home: string): string {
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p
}

export interface SynNode {
  name: string
  path: string
  isDir: boolean
  children: SynNode[]
}

function sortSyn(nodes: SynNode[]): void {
  nodes.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  for (const n of nodes) if (n.children.length) sortSyn(n.children)
}

export function buildSyn(paths: readonly string[], root: string): SynNode[] {
  const rootNode: SynNode = { name: '', path: root, isDir: true, children: [] }
  for (const p of paths) {
    if (!inRoot(p, root)) continue
    const rel = p.slice(root.length + 1)
    if (!rel) continue
    const segs = rel.split('/')
    let cur = rootNode
    let curPath = root
    for (let i = 0; i < segs.length; i++) {
      curPath = curPath + '/' + segs[i]
      const isLast = i === segs.length - 1
      let child = cur.children.find((c) => c.name === segs[i])
      if (!child) {
        child = { name: segs[i], path: curPath, isDir: !isLast, children: [] }
        cur.children.push(child)
      }
      cur = child
    }
  }
  sortSyn(rootNode.children)
  return rootNode.children
}

export function hiddenTouchedUnder(
  dir: string,
  entries: readonly DirEntry[],
  touchedInProject: readonly string[]
): string[] {
  const names = new Set(entries.map((e) => e.name))
  const prefix = dir + '/'
  return touchedInProject.filter(
    (p) => p.startsWith(prefix) && !names.has(p.slice(prefix.length).split('/')[0])
  )
}

// CC§2
export function isTasksPath(p: string, scratchpadDir: string | undefined): boolean {
  if (!scratchpadDir) return false
  const sessionDir = scratchpadDir.slice(0, scratchpadDir.lastIndexOf('/'))
  for (const base of [sessionDir, scratchpadDir]) {
    if (!base) continue
    const t = base + '/tasks'
    if (p === t || p.startsWith(t + '/')) return true
  }
  return false
}

export function isOutsideEligible(p: string): boolean {
  const k = previewKindForPath(p)
  return k === 'markdown' || k === 'image' || isWebPagePath(p)
}

export function scratchpadEntries(
  entries: readonly DirEntry[] | undefined,
  scratchpadDir: string | undefined
): DirEntry[] {
  if (!entries) return []
  return entries.filter((e) => !isTasksPath(e.path, scratchpadDir))
}

export interface OutsideInput {
  candidates: readonly PreviewItem[]
  scratchpadDir: string | undefined
  scratchListed: ReadonlySet<string>
  missingDirs: ReadonlySet<string>
}

export function outsideFiles(input: OutsideInput): PreviewItem[] {
  const { candidates, scratchpadDir, scratchListed, missingDirs } = input
  return candidates.filter((f) => {
    if (!isOutsideEligible(f.src)) return false
    if (isTasksPath(f.src, scratchpadDir)) return false
    if (scratchListed.has(f.src)) return false
    return !missingDirs.has(f.src.slice(0, f.src.lastIndexOf('/')))
  })
}

export interface SessionIndex {
  wrote: Map<string, PreviewItem>
  touchedInProject: string[]
  touchedDirCount: Map<string, number>
  outsideCandidates: PreviewItem[]
}

export function sessionIndex(session: SessionInfo | null, root: string): SessionIndex {
  const wrote = new Map<string, PreviewItem>()
  const touchedInProject: string[] = []
  const touchedDirCount = new Map<string, number>()
  const outsideCandidates: PreviewItem[] = []
  for (const f of session?.files ?? []) {
    if (f.access !== 'wrote') continue
    wrote.set(f.src, f)
    if (!inRoot(f.src, root)) {
      outsideCandidates.push(f)
      continue
    }
    if (f.src === root) continue
    touchedInProject.push(f.src)
    for (const d of ancestorDirs(f.src, root)) {
      touchedDirCount.set(d, (touchedDirCount.get(d) ?? 0) + 1)
    }
  }
  return { wrote, touchedInProject, touchedDirCount, outsideCandidates }
}

export function changedDirsOf(git: GitStatusMap, root: string): Set<string> {
  const s = new Set<string>()
  for (const p of Object.keys(git)) {
    if (!inRoot(p, root)) continue
    for (const d of ancestorDirs(p, root)) s.add(d)
  }
  return s
}

export function deltaFor(
  p: string,
  numstat: GitNumstatMap,
  item: PreviewItem | undefined
): { added: number; removed: number } {
  const ns = numstat[p]
  if (ns) return { added: ns.added, removed: ns.removed }
  return { added: item?.added ?? 0, removed: item?.removed ?? 0 }
}

export function livePath(session: SessionInfo | null): string | undefined {
  return session?.status === 'working' ? session?.lastWritten : undefined
}

export const SEARCH_DEBOUNCE_MS = 150

export const NO_MATCHES = 'No matches'

export function truncationNotice(n: number): string {
  return `Showing the first ${n} — narrow the query.`
}

export function hitDir(rel: string): string {
  const slash = rel.lastIndexOf('/')
  return slash === -1 ? '' : rel.slice(0, slash)
}

export function persistableExpansion(expanded: Iterable<string>, root: string): string[] {
  return [...expanded].filter((d) => inRoot(d, root))
}

export function initialExpansion(saved: readonly string[] | null, root: string): Set<string> {
  const exp = new Set(saved && saved.length ? saved : [root])
  exp.add(root)
  return exp
}
