import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import {
  HIDDEN_BY_DEFAULT_NAMES,
  type DirEntry,
  type SearchHit,
  type ContentHit
} from '@shared/types'

const execFile = promisify(execFileCb)

const HEAVY = HIDDEN_BY_DEFAULT_NAMES

const IGNORE_BATCH_UNDER_ARG_MAX = 500

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

// PLATFORM§30
async function ignoredChildren(dir: string, names: string[]): Promise<Set<string>> {
  const ignored = new Set<string>()
  if (names.length === 0) return ignored
  for (let i = 0; i < names.length; i += IGNORE_BATCH_UNDER_ARG_MAX) {
    const batch = names.slice(i, i + IGNORE_BATCH_UNDER_ARG_MAX)
    try {
      const { stdout } = await execFile('git', ['-C', dir, 'check-ignore', '--', ...batch], {
        maxBuffer: 16 * 1024 * 1024
      })
      for (const line of stdout.split('\n')) {
        const n = line.replace(/\r$/, '')
        if (n) ignored.add(n)
      }
    } catch (e) {
      if ((e as { code?: unknown }).code === 1) continue
      return ignored
    }
  }
  return ignored
}

export async function dirExists(absPath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(absPath)).isDirectory()
  } catch {
    return false
  }
}

export async function listDir(
  absPath: string,
  opts?: { showIgnored?: boolean }
): Promise<DirEntry[]> {
  let dirents: fs.Dirent[]
  try {
    dirents = await fs.promises.readdir(absPath, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates: DirEntry[] = []
  for (const d of dirents) {
    const full = path.join(absPath, d.name)
    if (d.isSymbolicLink()) {
      try {
        await fs.promises.stat(full)
      } catch {
        continue
      }
    }
    candidates.push({ name: d.name, path: full, isDir: d.isDirectory() })
  }
  const gitIgnored = await ignoredChildren(
    absPath,
    candidates.map((c) => c.name)
  )
  const isIgnored = (c: DirEntry): boolean => HEAVY.has(c.name) || gitIgnored.has(c.name)
  if (!opts?.showIgnored) return sortEntries(candidates.filter((c) => !isIgnored(c)))
  return sortEntries(candidates.map((c) => (isIgnored(c) ? { ...c, ignored: true } : c)))
}

export function passesHeavy(rel: string): boolean {
  for (const seg of rel.split(path.sep)) if (HEAVY.has(seg)) return false
  return true
}

const MAX_RESULTS = 300

const IGNORED_RANK = 100_000
const MAX_VISIT = 100_000

const LS_FILES_BUFFER = 64 * 1024 * 1024

async function gitVisibleFiles(
  absRoot: string,
  showIgnored: boolean
): Promise<{ rel: string; ignored: boolean }[] | null> {
  try {
    const opts = { maxBuffer: LS_FILES_BUFFER }
    const [tracked, others] = await Promise.all([
      execFile('git', ['-C', absRoot, 'ls-files', '-z'], opts),
      execFile('git', ['-C', absRoot, 'ls-files', '--others', '--exclude-standard', '-z'], opts)
    ])
    const ignored = showIgnored
      ? await execFile(
          'git',
          ['-C', absRoot, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
          opts
        ).catch(() => ({ stdout: '' }))
      : { stdout: '' }
    // PLATFORM§30
    const out: { rel: string; ignored: boolean }[] = []
    for (const blob of [tracked.stdout, others.stdout]) {
      for (const p of blob.split('\0'))
        if (p && !p.endsWith('/')) out.push({ rel: p, ignored: false })
    }
    for (const p of ignored.stdout.split('\0')) {
      if (p && !p.endsWith('/')) out.push({ rel: p, ignored: true })
    }
    return out
  } catch {
    return null
  }
}

async function walkFiles(absRoot: string, showIgnored: boolean): Promise<string[]> {
  const realRoot = await fs.promises.realpath(absRoot).catch(() => absRoot)
  const inside = (p: string): boolean => p === realRoot || p.startsWith(realRoot + path.sep)
  const out: string[] = []
  const stack: string[] = [absRoot]
  const seen = new Set<string>()
  let visited = 0
  while (stack.length > 0) {
    if (visited++ > MAX_VISIT) break
    const dir = stack.pop() as string
    let dirents: fs.Dirent[]
    try {
      dirents = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const d of dirents) {
      if (!showIgnored && HEAVY.has(d.name)) continue
      const full = path.join(dir, d.name)
      if (d.isSymbolicLink()) {
        const real = await fs.promises.realpath(full).catch(() => null)
        if (!real || !inside(real)) continue
        const st = await fs.promises.stat(full).catch(() => null)
        if (!st) continue
        if (st.isDirectory()) {
          if (seen.has(real)) continue
          seen.add(real)
          stack.push(full)
        } else {
          out.push(path.relative(absRoot, full))
        }
      } else if (d.isDirectory()) {
        stack.push(full)
      } else {
        out.push(path.relative(absRoot, full))
      }
    }
  }
  return out
}

export async function search(
  absRoot: string,
  query: string,
  opts?: { showIgnored?: boolean }
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const q = query.trim().toLowerCase()
  if (!q) return { hits: [], truncated: false }

  const showIgnored = !!opts?.showIgnored
  const found =
    (await gitVisibleFiles(absRoot, showIgnored)) ??
    (await walkFiles(absRoot, showIgnored)).map((rel) => ({ rel, ignored: false }))

  const scored: { hit: SearchHit; score: number }[] = []
  for (const { rel, ignored } of found) {
    if (!showIgnored && !passesHeavy(rel)) continue
    if (!rel.toLowerCase().includes(q)) continue
    const name = path.basename(rel)
    const score =
      (name.toLowerCase().includes(q) ? 1000 : 0) - rel.length - (ignored ? IGNORED_RANK : 0)
    const hit: SearchHit = { name, path: path.join(absRoot, rel), rel }
    if (ignored) hit.ignored = true
    scored.push({ hit, score })
  }
  scored.sort(
    (a, b) =>
      b.score - a.score || a.hit.name.localeCompare(b.hit.name, undefined, { sensitivity: 'base' })
  )
  return {
    hits: scored.slice(0, MAX_RESULTS).map((s) => s.hit),
    truncated: scored.length > MAX_RESULTS
  }
}

// PLATFORM§31
function parseGrepLine(line: string): { rel: string; line: number; text: string } | null {
  const nul = line.indexOf('\0')
  if (nul <= 0) return null
  const rel = line.slice(0, nul)
  const rest = line.slice(nul + 1)
  const m = /^(\d+)[:\0]([\s\S]*)$/.exec(rest)
  if (!m) return null
  return { rel, line: parseInt(m[1], 10), text: m[2] }
}

// PLATFORM§31
async function rgLines(absRoot: string, q: string, showIgnored: boolean): Promise<string[] | null> {
  const visibility = showIgnored
    ? ['--no-ignore', '--hidden', '-g', '!.git']
    : ['-g', '!{node_modules,.git}']
  try {
    const { stdout } = await execFile(
      'rg',
      [
        '--line-number',
        '--no-heading',
        '--color=never',
        '--null',
        '-S',
        '-F',
        '--max-columns',
        '300',
        '--max-columns-preview',
        ...visibility,
        '--',
        q,
        '.'
      ],
      { cwd: absRoot, maxBuffer: 32 * 1024 * 1024 }
    )
    return stdout.split('\n')
  } catch (e) {
    const err = e as { code?: unknown; stdout?: string }
    if (err.code === 1) return []
    if (typeof err.stdout === 'string' && err.stdout) return err.stdout.split('\n')
    return null
  }
}

async function gitGrepLines(absRoot: string, q: string, showIgnored: boolean): Promise<string[]> {
  try {
    const { stdout } = await execFile(
      'git',
      [
        '-C',
        absRoot,
        'grep',
        '--no-color',
        '-z',
        '-n',
        '-I',
        '-F',
        '--untracked',
        ...(showIgnored ? ['--no-exclude-standard'] : []),
        '-e',
        q
      ],
      { maxBuffer: 32 * 1024 * 1024 }
    )
    return stdout.split('\n')
  } catch (e) {
    return (e as { stdout?: string }).stdout?.split('\n') ?? []
  }
}

const MAX_CONTENT_HITS = 300

export async function searchContent(
  absRoot: string,
  query: string,
  opts?: { showIgnored?: boolean }
): Promise<{ hits: ContentHit[]; truncated: boolean }> {
  const q = query.trim()
  if (!q) return { hits: [], truncated: false }
  const showIgnored = !!opts?.showIgnored
  const lines =
    (await rgLines(absRoot, q, showIgnored)) ?? (await gitGrepLines(absRoot, q, showIgnored))
  const hits: ContentHit[] = []
  let matched = 0
  for (const line of lines) {
    if (!line) continue
    const m = parseGrepLine(line)
    if (!m) continue
    const rel = m.rel.replace(/^\.\//, '')
    if (!showIgnored && !passesHeavy(rel)) continue
    matched++
    if (hits.length < MAX_CONTENT_HITS) {
      hits.push({ path: path.join(absRoot, rel), rel, line: m.line, text: m.text.slice(0, 240) })
    }
  }
  return { hits, truncated: matched > MAX_CONTENT_HITS }
}
