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

// Hidden-by-default names (see HIDDEN_BY_DEFAULT_NAMES), treated exactly like a
// git-ignored entry: dropped while the "Show ignored files" switch is off, listed and
// marked when it is on. Dotfiles are deliberately NOT here — the user wants them visible.
const HEAVY = HIDDEN_BY_DEFAULT_NAMES

// `git check-ignore` is invoked in batches so a directory with thousands of entries
// can't blow past ARG_MAX.
const IGNORE_BATCH = 500

function sortEntries(entries: DirEntry[]): DirEntry[] {
  return entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
}

/** The subset of `names` that git would ignore. Runs `git -C <dir> check-ignore --
 *  <names>` with the bare child names (relative to the `-C` cwd, so no repo-root math
 *  needed). (`-z` is only valid with `--stdin`; the old code combined `-z` with
 *  pathspec args, which git rejects with exit 128 — silently disabling the filter on
 *  every repo. The pathspec form mis-parses only the pathological case of a filename
 *  containing a literal newline.) Respects nested .gitignore, .git/info/exclude, the
 *  global excludesFile, and negations; tracked files are never reported as ignored.
 *  A hard failure (not a git repo, git missing) collapses to an empty set — i.e. fall back
 *  to showing everything modulo HEAVY. */
async function ignoredChildren(dir: string, names: string[]): Promise<Set<string>> {
  const ignored = new Set<string>()
  if (names.length === 0) return ignored
  for (let i = 0; i < names.length; i += IGNORE_BATCH) {
    const batch = names.slice(i, i + IGNORE_BATCH)
    try {
      const { stdout } = await execFile('git', ['-C', dir, 'check-ignore', '--', ...batch], {
        maxBuffer: 16 * 1024 * 1024
      })
      for (const line of stdout.split('\n')) {
        const n = line.replace(/\r$/, '')
        if (n) ignored.add(n)
      }
    } catch (e) {
      // exit 1 only means "nothing in THIS batch is ignored" — the later batches still
      // have to be asked, or every ignored file past the first 500 entries loses its mark.
      // Anything else (128 = not a repo, or git missing) will answer the same for every
      // remaining batch, so stop there and show everything.
      if ((e as { code?: unknown }).code === 1) continue
      return ignored
    }
  }
  return ignored
}

/**
 * Does this path exist and is it a directory?
 *
 * `listDir` deliberately cannot answer this: it returns `[]` for a missing, an unreadable
 * AND an empty directory alike, and Browse depends on that conflation — FR-46's "a missing
 * directory hides its whole node" is implemented as "an empty listing hides it". So the one
 * place that needs the distinction (§6's "the worktree was removed under us", which puts a
 * placeholder over both halves of the Files tab) asks separately rather than by teaching
 * `listDir` to throw and changing what every other caller sees.
 */
export async function dirExists(absPath: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(absPath)).isDirectory()
  } catch {
    return false
  }
}

/** List the immediate children of `absPath` for the Workbench's Browse view. .gitignore
 *  is respected inside git repos (and silently skipped otherwise); HEAVY names count as
 *  ignored everywhere. Dirs sort before files, case-insensitive.
 *
 *  With `showIgnored` off, every ignored entry — file or directory — is dropped. With it
 *  on, EVERYTHING is listed and the ignored entries (directories included, so `.venv/`
 *  and `node_modules/` can be opened) come back marked. One switch, one meaning: the
 *  earlier files-only reveal left a tracked-looking `build/` with no way to be seen. */
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
    // Skip dangling symlinks (stat-ing the target throws); valid symlinks still
    // follow — isDirectory() resolves the target, matching normal file-manager
    // behavior.
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

/** true unless any segment of a relative path is a HEAVY name. Applied only while the
 *  switch is off, mirroring `listDir`, so search and tree agree — including on a
 *  `node_modules/` that git happens to track. */
export function passesHeavy(rel: string): boolean {
  for (const seg of rel.split(path.sep)) if (HEAVY.has(seg)) return false
  return true
}

/** Cap on results returned by `search` — keeps the IPC payload small and the list
 *  scrollable. `truncated` tells the renderer more matched. */
const MAX_RESULTS = 300

/** Ignored files sort below every other hit, and by more than any ordinary score can make
 *  up (the rest of the range is one 1000-point bonus minus a path length). Measured: a
 *  directory of 2000 ignored logs outscores a source file buried deeper than they are,
 *  fills the cap above, and the file the user was looking for never reaches the list. */
const IGNORED_RANK = 100_000
/** Backstop for the non-git `walkFiles` fallback so a pathological tree can't hang. */
const MAX_VISIT = 100_000

/** Every `git ls-files` spawn here reads a whole file list into memory, and Node's default
 *  `maxBuffer` is 1 MB — measured, a checkout with a 20 000-file `node_modules` prints
 *  1 240 022 bytes of ignored paths. Past the limit the child throws, the catch below
 *  swallows it, and search silently degrades to walking the tree. */
const LS_FILES_BUFFER = 64 * 1024 * 1024

/** All files under `absRoot` search may show, as paths relative to it. Two `git ls-files`
 *  spawns — tracked ∪ (untracked, non-ignored) — honor nested .gitignore, the global
 *  excludesFile, and negations, exactly mirroring what `listDir`'s `check-ignore`
 *  filter would show if the whole tree were expanded. `-z` NUL-separates so filenames
 *  with spaces/newlines survive (valid here: no pathspec args, unlike the `-z`+pathspec
 *  bug noted on `ignoredChildren`).
 *
 *  `showIgnored` adds a third spawn for the ignored files — every one of them, the files
 *  inside ignored directories included, since the tree now opens those too. (The earlier
 *  `--directory` fold that kept whole ignored trees out is gone with the files-only rule.)
 *  A 20 000-file `node_modules` is ~1.2 MB of paths, well inside LS_FILES_BUFFER.
 *
 *  Returns null when `absRoot` isn't in a git repo or git is missing — caller falls back
 *  to walking. */
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
    // The ignored pass is the one that can grow without bound (every file of every ignored
    // tree). When it overflows LS_FILES_BUFFER it is dropped ALONE — the tracked and
    // untracked results still stand, instead of the whole search degrading to a blind walk
    // that would then list node_modules as ordinary files.
    const ignored = showIgnored
      ? await execFile(
          'git',
          ['-C', absRoot, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
          opts
        ).catch(() => ({ stdout: '' }))
      : { stdout: '' }
    // A nested repository (a checkout inside the tree with its own .git) is printed by
    // `--others` as one `dir/` entry: not a file, so it is not a hit. Dropped from every
    // blob, since the ignored pass can print one the same way.
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
    return null // exit 128 (not a repo) / git missing → fall back to walking
  }
}

/** Non-git fallback: walk `absRoot`, collecting files relative to it. Only HEAVY dirs
 *  are pruned, and only while the switch is off (no .gitignore signal without git).
 *  Symlinks are followed only while
 *  their target stays inside the root — a link pointing elsewhere is skipped so search
 *  can't leak outside files, and a realpath-keyed `seen` set breaks symlink loops.
 *  Bounded by MAX_VISIT so a huge untracked tree can't hang the search. */
async function walkFiles(absRoot: string, showIgnored: boolean): Promise<string[]> {
  // canonical boundary: realpath so a symlinked root still contains correctly
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
        // resolve the target; refuse dangling links, escape attempts, and loops.
        // Plain (non-symlink) entries can't leave the root, so only links need this.
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

/** Recursively find files under `absRoot` whose relative path contains `query`
 *  (case-insensitive). Visibility follows `listDir`, `showIgnored` included, so ⌘P and the
 *  tree agree about what exists. Files-only; basename matches rank above path-only
 *  matches. Outside a git repo there is no notion of "ignored", so the flag changes
 *  nothing there. */
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
    // basename hit beats path-only hit; shorter (shallower) paths beat longer as a tiebreak
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

/** One NUL-delimited grep line → its parts, or null if malformed. The NUL after the
 *  path lets a filename containing ':' still parse. The line/text separator differs by
 *  backend: `rg --null` emits `<path>\0<line>:<text>`, but `git grep -z -n` emits
 *  `<path>\0<line>\0<text>` (NUL, not colon) — accept either, else the git-grep fallback
 *  drops every match whose text has no ':' and mangles those whose text does. */
function parseGrepLine(line: string): { rel: string; line: number; text: string } | null {
  const nul = line.indexOf('\0')
  if (nul <= 0) return null
  const rel = line.slice(0, nul)
  const rest = line.slice(nul + 1)
  const m = /^(\d+)[:\0]([\s\S]*)$/.exec(rest)
  if (!m) return null
  return { rel, line: parseInt(m[1], 10), text: m[2] }
}

/** ripgrep lines for `q` under `absRoot` (fixed-string; gitignore-aware and HEAVY dirs
 *  excluded while the switch is off, `--no-ignore --hidden` with only `.git` excluded when
 *  it is on). NUL-delimits the path so colons in names survive; --max-columns-preview
 *  shows a snippet of long lines instead of a placeholder. Returns [] on "no matches",
 *  null when rg is unavailable (so the caller falls back to `git grep`). */
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
    // NOTE the trailing '.' search path. Without an explicit path, ripgrep reads from
    // stdin when stdin isn't a tty — and execFile hands the child an open (never-closed)
    // stdin pipe, so rg would block forever on it instead of searching the tree. The '.'
    // forces a filesystem search; it prefixes matches with './', stripped in searchContent.
    return stdout.split('\n')
  } catch (e) {
    const err = e as { code?: unknown; stdout?: string }
    if (err.code === 1) return [] // exit 1 = no matches
    // exit 2 can mean "printed matches but failed to read some file" — keep the matches
    if (typeof err.stdout === 'string' && err.stdout) return err.stdout.split('\n')
    return null // rg missing / no output → fall back
  }
}

/** `git grep` fallback (fixed-string, -I skips binaries, -z NUL-delimits paths). Searches
 *  untracked-but-not-ignored files too (--untracked) to mirror ripgrep's coverage, and the
 *  ignored ones as well (--no-exclude-standard) when the switch is on. [] on no matches /
 *  error. */
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

/** Search file *contents* under `absRoot` for `q` (fixed string, case-smart). Prefers
 *  ripgrep, falls back to `git grep`. Visibility follows the tree's switch, like
 *  `search`. Files-only line matches, capped at MAX_CONTENT_HITS. */
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
    const rel = m.rel.replace(/^\.\//, '') // rg is given '.' as its path, so it prefixes ./
    if (!showIgnored && !passesHeavy(rel)) continue
    matched++
    if (hits.length < MAX_CONTENT_HITS) {
      hits.push({ path: path.join(absRoot, rel), rel, line: m.line, text: m.text.slice(0, 240) })
    }
  }
  return { hits, truncated: matched > MAX_CONTENT_HITS }
}
