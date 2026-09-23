import type { GitFileStatus, GitNumstatMap, GitStatusMap, SessionInfo } from '@shared/types'
import { isDocPath, relOf, splitPath, type ChangeFilters } from './filesModel'

export type ChangeKind = 'text' | 'renamed' | 'binary' | 'deleted' | 'conflict'

export interface ChangeEntry {
  path: string
  rel: string
  dir: string
  name: string
  status: GitFileStatus
  kind: ChangeKind
  delta: { added: number; removed: number } | null
  wrote: boolean
}

export interface DiffSection {
  rel: string
  text: string
  binary: boolean
  renameFrom: string | null
  truncated?: boolean
}

export interface DiffHunk {
  header: string
  text: string
}

const SECTION_START = 'diff --git '

export function splitAggregateDiff(diff: string): DiffSection[] {
  const out: DiffSection[] = []
  let buf: string[] | null = null
  const flush = (): void => {
    if (!buf) return
    const text = buf.join('\n')
    const rel = sectionPath(text)
    if (rel)
      out.push({ rel, text, binary: isBinarySection(text), renameFrom: renameSourceOf(text) })
  }
  for (const line of diff.split('\n')) {
    if (line.startsWith(SECTION_START)) {
      flush()
      buf = [line]
    } else if (buf) {
      buf.push(line)
    }
  }
  flush()
  return out
}

function preambleOf(section: string): string[] {
  const lines = section.split('\n')
  const at = lines.findIndex((l) => l.startsWith('@@'))
  return at < 0 ? lines : lines.slice(0, at)
}

function isBinarySection(section: string): boolean {
  return preambleOf(section).some(
    (l) => l === 'GIT binary patch' || (l.startsWith('Binary files ') && l.endsWith(' differ'))
  )
}

function renameSourceOf(section: string): string | null {
  const line = preambleOf(section).find((l) => l.startsWith('rename from '))
  return line ? line.slice('rename from '.length) : null
}

function sectionPath(section: string): string | null {
  const lines = preambleOf(section)
  const rename = lines.find((l) => l.startsWith('rename to '))
  if (rename) return rename.slice('rename to '.length)
  const plus = lines.find((l) => l.startsWith('+++ '))
  if (plus && !plus.startsWith('+++ /dev/null')) return stripSide(plus.slice(4))
  const minus = lines.find((l) => l.startsWith('--- '))
  if (minus && !minus.startsWith('--- /dev/null')) return stripSide(minus.slice(4))
  return headerPath(lines[0] ?? '')
}

function stripSide(p: string): string {
  const tab = p.indexOf('\t')
  const cut = tab < 0 ? p : p.slice(0, tab)
  return cut.startsWith('a/') || cut.startsWith('b/') ? cut.slice(2) : cut
}

function headerPath(header: string): string | null {
  if (!header.startsWith(SECTION_START)) return null
  const rest = header.slice(SECTION_START.length)
  const both = /^a\/(.+) b\/(.+)$/.exec(rest)
  if (both && both[1] === both[2]) return both[1]
  const at = rest.lastIndexOf(' b/')
  return at < 0 ? null : rest.slice(at + 3)
}

export function sectionsByPath(
  sections: readonly DiffSection[],
  paths: readonly string[],
  toplevel: string | null
): Record<string, DiffSection> {
  const known = new Set(paths)
  const out: Record<string, DiffSection> = {}
  for (const s of sections) {
    const abs = `${toplevel}/${s.rel}`
    if (known.has(abs)) out[abs] = s
  }
  return out
}

export function mergeSections(
  prev: Record<string, DiffSection>,
  next: Record<string, DiffSection>
): Record<string, DiffSection> {
  const out: Record<string, DiffSection> = {}
  let changed = false
  for (const [path, section] of Object.entries(next)) {
    const old = prev[path]
    if (
      old &&
      old.text === section.text &&
      old.binary === section.binary &&
      old.renameFrom === section.renameFrom
    ) {
      out[path] = old
    } else {
      out[path] = section
      changed = true
    }
  }
  if (!changed && Object.keys(prev).length === Object.keys(out).length) return prev
  return out
}

export function splitHunks(section: string): DiffHunk[] {
  const out: DiffHunk[] = []
  let cur: DiffHunk | null = null
  for (const line of section.split('\n')) {
    if (line.startsWith('@@')) {
      cur = { header: line, text: line }
      out.push(cur)
    } else if (cur) {
      cur.text += '\n' + line
    }
  }
  return out
}

export function writtenPaths(session: SessionInfo | null): Set<string> {
  const out = new Set<string>()
  for (const f of session?.files ?? []) if (f.access === 'wrote') out.add(f.src)
  return out
}

export function classifyKind(status: GitFileStatus, section: DiffSection | undefined): ChangeKind {
  if (status === 'conflict') return 'conflict'
  if (status === 'deleted') return 'deleted'
  if (status === 'renamed') return 'renamed'
  if (section?.binary) return 'binary'
  return 'text'
}

export function buildEntries(input: {
  git: GitStatusMap
  numstat: GitNumstatMap
  root: string
  written: ReadonlySet<string>
  sections: Record<string, DiffSection>
}): ChangeEntry[] {
  const { git, numstat, root, written, sections } = input
  const out: ChangeEntry[] = []
  for (const [path, status] of Object.entries(git)) {
    const kind = classifyKind(status, sections[path])
    const { dir, name } = splitPath(path, root)
    const raw = numstat[path]
    const delta = kind === 'binary' || status === 'untracked' ? null : (raw ?? null)
    out.push({
      path,
      rel: relOf(path, root),
      dir,
      name,
      status,
      kind,
      delta,
      wrote: written.has(path)
    })
  }
  out.sort((a, b) => cmp(a.dir, b.dir) || cmp(a.name, b.name))
  return out
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sameEntry(a: ChangeEntry, b: ChangeEntry): boolean {
  return (
    a.path === b.path &&
    a.status === b.status &&
    a.kind === b.kind &&
    a.wrote === b.wrote &&
    a.delta?.added === b.delta?.added &&
    a.delta?.removed === b.delta?.removed &&
    (a.delta === null) === (b.delta === null)
  )
}

export function stableEntries(prev: readonly ChangeEntry[], next: ChangeEntry[]): ChangeEntry[] {
  const byPath = new Map(prev.map((e) => [e.path, e]))
  return next.map((e) => {
    const old = byPath.get(e.path)
    return old && sameEntry(old, e) ? old : e
  })
}

export function passesFilters(e: ChangeEntry, f: ChangeFilters): boolean {
  if (f.status !== 'all' && e.status !== f.status) return false
  if (f.owner === 'session' && !e.wrote) return false
  if (f.type === 'docs' && !isDocPath(e.rel)) return false
  if (f.type === 'code' && isDocPath(e.rel)) return false
  return true
}

export interface ChangeGroup {
  dir: string
  label: string
  entries: ChangeEntry[]
}

// PLATFORM§25
export function groupByDir(entries: readonly ChangeEntry[]): ChangeGroup[] {
  const byDir = new Map<string, ChangeGroup>()
  for (const e of entries) {
    let g = byDir.get(e.dir)
    if (!g) {
      g = { dir: e.dir, label: e.dir ? e.dir.replace(/\/$/, '') : '/', entries: [] }
      byDir.set(e.dir, g)
    }
    g.entries.push(e)
  }
  return [...byDir.values()]
}

export interface ChangeTotals {
  files: number
  added: number
  removed: number
  noCount: number
}

export function totalDelta(entries: readonly ChangeEntry[]): ChangeTotals {
  const out: ChangeTotals = { files: entries.length, added: 0, removed: 0, noCount: 0 }
  for (const e of entries) {
    if (!e.delta) {
      out.noCount++
      continue
    }
    out.added += e.delta.added
    out.removed += e.delta.removed
  }
  return out
}

export const HIGHLIGHT_LEAD_IN = 400

export const BIG_DIFF_LINES = 2000

export function isBigDiff(text: string): boolean {
  let n = 0
  for (let i = text.indexOf('\n'); i !== -1 && n <= BIG_DIFF_LINES; i = text.indexOf('\n', i + 1))
    n++
  return n > BIG_DIFF_LINES
}

export interface Span {
  top: number
  bottom: number
}

export function nearViewport(block: Span, viewport: Span, lead = HIGHLIGHT_LEAD_IN): boolean {
  return block.bottom >= viewport.top - lead && block.top <= viewport.bottom + lead
}

export const CHANGES_MSG = {
  empty: 'No changes against the base.',
  loading: 'Reading the change set…',
  filtered: 'No changes match the current filters.',
  notGit: 'Not a git repository.',
  gitFailed: 'Repo too large or git unresponsive — retry.',
  bigDiff: 'Large diff not shown by default — Load diff',
  truncated: (n: number): string => `Change set too large — showing the first ${n} files.`,
  renamed: (from: string | null): string => (from ? `Renamed from ${from}` : 'Renamed'),
  binary: 'Binary file — no text diff.',
  deleted: 'File deleted — no content shown.',
  conflict: 'Merge conflict — resolve it to see a diff.',
  noText: 'No textual changes.',
  cutOff: 'Not shown — the change set was truncated.',
  fileCutOff: 'This file’s diff was truncated — showing what fits.',
  noDiff: 'No diff available.',
  totals: (t: ChangeTotals): string => {
    const one = t.files === 1
    let s = `${t.files} ${one ? 'file' : 'files'} listed · ${t.added} added, ${t.removed} removed.`
    if (t.noCount > 0) {
      s += ` ${t.noCount} of them ${t.noCount === 1 ? 'brings' : 'bring'} no line count (new, binary, or git gave none).`
    }
    return s
  }
} as const

export function emptyStreamMessage(input: {
  entryCount: number
  load: { done: boolean; failed: boolean; notRepo: boolean; files: number }
}): string {
  const { entryCount, load } = input
  if (entryCount > 0) return CHANGES_MSG.filtered
  if (!load.done && !load.failed) return CHANGES_MSG.loading
  if (load.done && !load.failed && load.files > 0) return CHANGES_MSG.loading
  if (load.done && !load.failed && load.notRepo) return CHANGES_MSG.notGit
  return CHANGES_MSG.empty
}

export function baseUnresolved(base: string | null | undefined): base is undefined {
  return base === undefined
}

export function baseArg(base: string | null | undefined): string {
  return base ?? ''
}
