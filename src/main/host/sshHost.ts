import path from 'path'
import {
  HIDDEN_BY_DEFAULT_NAMES,
  type DirEntry,
  type EditCreateResult,
  type EditFingerprint,
  type EditWriteResult,
  type GitNumstatMap,
  type GitStatusMap
} from '@shared/types'
import { formatRemoteKey, parseRemoteKey } from '@shared/remoteKey'
import { shq } from '@shared/shellQuote'
import { contentHitsOf, gitGrepArgs, rankFiles, rgArgs, visibleEntries } from '../fileTree'
import {
  EDIT_OPEN_MAX_BYTES,
  EDIT_WRITE_MAX_BYTES,
  MAX_READ_BYTES,
  bytesToWrite,
  checkNewFileName,
  editOpenResult,
  looksBinary,
  sameFingerprint
} from '../fileEdit'
import { gitOps, type GitOps } from '../gitStatus'
import { GithubLookup, type GithubOptions } from '../github'
import { REMOTE_PATH_LINE } from '../remote/install'
import type { BytesResult } from '../remote/ssh'
import type { Host, ShellLaunch } from './host'

export interface SshHostDeps {
  run(cmd: string, opts?: { timeoutMs?: number; input?: Buffer }): Promise<BytesResult>
  shell(dir: string): Omit<ShellLaunch, 'cwd'>
  github: GithubOptions
}

// PLATFORM§33
export function remoteSh(script: string, args: string[]): string {
  return [`sh -c ${shq(`${REMOTE_PATH_LINE}; ${script}`)} sh`, ...args.map(shq)].join(' ')
}

const GIT_TIMEOUT_MS = 30_000
const NETWORK_GIT_TIMEOUT_MS = 20_000

// PLATFORM§37
const FINGERPRINT = `fp() { stat -c '%.9Y %s' "$1" 2>/dev/null || stat -f '%Fm %z' "$1"; }`

const EXIT_GONE = 44
const EXIT_NOT_FILE = 45
const EXIT_TOO_LARGE = 46
const EXIT_DIR_GONE = 47
const EXIT_EXISTS = 48
const EXIT_WRITE_FAILED = 49
const EXIT_NO_PERM = 50
const EXIT_NO_RG = 127

const ERROR_OF_EXIT: Record<number, string> = {
  [EXIT_GONE]: 'KOLOFT_GONE',
  [EXIT_NOT_FILE]: 'KOLOFT_NOT_FILE',
  [EXIT_TOO_LARGE]: 'KOLOFT_TOO_LARGE',
  [EXIT_DIR_GONE]: 'KOLOFT_DIR_GONE',
  [EXIT_EXISTS]: 'KOLOFT_EXISTS',
  [EXIT_NO_PERM]: 'KOLOFT_NO_PERM'
}

function failure(r: BytesResult, fallback: string): Error {
  return new Error((r.code !== null && ERROR_OF_EXIT[r.code]) || fallback)
}

export function parseFingerprint(line: string): EditFingerprint | null {
  const [mtime, size] = line.trim().split(/\s+/)
  const mtimeMs = parseFloat(mtime) * 1000
  const bytes = parseInt(size, 10)
  return Number.isFinite(mtimeMs) && Number.isFinite(bytes) ? { mtimeMs, size: bytes } : null
}

function headerAndBody(buf: Buffer): { header: string; body: Buffer } {
  const nl = buf.indexOf(0x0a)
  return nl < 0
    ? { header: buf.toString('utf8'), body: Buffer.alloc(0) }
    : { header: buf.toString('utf8', 0, nl), body: buf.subarray(nl + 1) }
}

const LIST_DIR = `cd "$1" 2>/dev/null || exit 0
for f in .* *; do
  case $f in .|..) continue ;; esac
  [ -e "$f" ] || continue
  if [ -d "$f" ]; then printf 'd%s\\0' "$f"; else printf 'f%s\\0' "$f"; fi
done
printf '%s\\0' -
for f in .* *; do
  case $f in .|..) continue ;; esac
  [ -e "$f" ] && printf '%s\\0' "$f"
done | git check-ignore -z --stdin 2>/dev/null
exit 0`

export function parseListDir(
  stdout: string,
  dir: string
): { entries: DirEntry[]; ignored: Set<string> } {
  const entries: DirEntry[] = []
  const ignored = new Set<string>()
  let pastEntries = false
  for (const tok of stdout.split('\0')) {
    if (!tok) continue
    if (!pastEntries && tok === '-') {
      pastEntries = true
      continue
    }
    if (pastEntries) ignored.add(tok)
    else
      entries.push({
        name: tok.slice(1),
        path: path.join(dir, tok.slice(1)),
        isDir: tok[0] === 'd'
      })
  }
  return { entries, ignored }
}

const TRACKED_MARK = '/T'
const IGNORED_MARK = '/I'
const WALKED_MARK = '/W'

const heavyPrune = [...HIDDEN_BY_DEFAULT_NAMES].map((n) => `-name ${shq(n)}`).join(' -o ')

const SEARCH_FILES = `cd "$1" 2>/dev/null || exit 0
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  printf '%s\\0' ${TRACKED_MARK}
  git ls-files -z
  git ls-files --others --exclude-standard -z
  if [ "$2" = 1 ]; then
    printf '%s\\0' ${IGNORED_MARK}
    git ls-files --others --ignored --exclude-standard -z
  fi
else
  printf '%s\\0' ${WALKED_MARK}
  if [ "$2" = 1 ]; then find . -type f -print0 2>/dev/null
  else find . \\( ${heavyPrune} \\) -prune -o -type f -print0 2>/dev/null; fi
fi
exit 0`

export function parseSearchFiles(stdout: string): { rel: string; ignored: boolean }[] {
  const out: { rel: string; ignored: boolean }[] = []
  let ignored = false
  for (const tok of stdout.split('\0')) {
    if (!tok || tok === TRACKED_MARK || tok === WALKED_MARK) continue
    if (tok === IGNORED_MARK) {
      ignored = true
      continue
    }
    if (tok.endsWith('/')) continue
    out.push({ rel: tok.replace(/^\.\//, ''), ignored })
  }
  return out
}

const RG_OR_MISSING = `cd "$1" 2>/dev/null || exit 0
shift
command -v rg >/dev/null 2>&1 || exit ${EXIT_NO_RG}
rg "$@" </dev/null
exit 0`

const GIT_GREP = `cd "$1" 2>/dev/null || exit 0
shift
git "$@"
exit 0`

const READ_TEXT = `[ -e "$1" ] || exit ${EXIT_GONE}
[ -f "$1" ] || exit ${EXIT_NOT_FILE}
${FINGERPRINT}
f=$(fp "$1") || exit ${EXIT_GONE}
[ "\${f#* }" -gt "$2" ] && exit ${EXIT_TOO_LARGE}
w=-; [ -w "$1" ] && w=w
d=-; [ -w "$(dirname "$1")" ] && d=w
printf '%s %s %s\\n' "$f" "$w" "$d"
cat "$1"`

const FINGERPRINT_ONLY = `p=$(readlink -f "$1" 2>/dev/null || printf '%s' "$1")
[ -e "$p" ] || { [ -d "$(dirname "$p")" ] && exit ${EXIT_GONE}; exit ${EXIT_DIR_GONE}; }
[ -f "$p" ] || exit ${EXIT_NOT_FILE}
${FINGERPRINT}
fp "$p"`

const WRITE_IF_UNCHANGED = `p=$(readlink -f "$1" 2>/dev/null || printf '%s' "$1")
[ -e "$p" ] || { [ -d "$(dirname "$p")" ] && exit ${EXIT_GONE}; exit ${EXIT_DIR_GONE}; }
[ -f "$p" ] || exit ${EXIT_NOT_FILE}
${FINGERPRINT}
t="$(dirname "$p")/.$(basename "$p").koloft-tmp-$$"
cp -p "$p" "$t" 2>/dev/null || exit ${EXIT_NO_PERM}
cat > "$t" || { rm -f "$t"; exit ${EXIT_WRITE_FAILED}; }
if [ "$2" != - ] && [ "$(fp "$p")" != "$2" ]; then rm -f "$t"; printf 'stale '; fp "$p"; exit 0; fi
mv -f "$t" "$p" || { rm -f "$t"; exit ${EXIT_WRITE_FAILED}; }
printf 'ok '; fp "$p"`

const CREATE_FILE = `d=$(readlink -f "$1" 2>/dev/null || printf '%s' "$1")
[ -d "$d" ] || exit ${EXIT_DIR_GONE}
t="$d/$2"
[ -e "$t" ] && exit ${EXIT_EXISTS}
( set -C; : > "$t" ) 2>/dev/null || { [ -e "$t" ] && exit ${EXIT_EXISTS}; exit ${EXIT_NO_PERM}; }
${FINGERPRINT}
printf '%s\\n' "$t"
fp "$t"`

const GIT = `GIT_OPTIONAL_LOCKS=0 git "$@"`

const NETWORK_GIT = `GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=false SSH_ASKPASS=false \
SSH_ASKPASS_REQUIRE=never GIT_SSH_COMMAND="\${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes" git "$@"`

export class SshHost implements Host {
  readonly github: GithubLookup
  private git: GitOps

  constructor(
    readonly machine: string,
    private deps: SshHostDeps
  ) {
    this.git = gitOps({
      id: `ssh:${machine}`,
      git: async (args, opts) => {
        const r = await deps.run(remoteSh(GIT, args), {
          timeoutMs: opts?.timeout ?? GIT_TIMEOUT_MS
        })
        const stdout = r.stdout.toString('utf8')
        if (r.code === 0) return { stdout, stderr: r.stderr }
        throw Object.assign(new Error(r.stderr || 'git failed'), {
          code: r.code ?? undefined,
          killed: r.code === null,
          stdout,
          stderr: r.stderr
        })
      }
    })
    this.github = new GithubLookup({
      ...deps.github,
      git: (root, args, network) => this.gitOut(root, args, network)
    })
  }

  async gitOut(root: string, args: string[], network = false): Promise<string | null> {
    const r = await this.deps.run(
      remoteSh(network ? NETWORK_GIT : GIT, ['-C', this.bare(root), ...args]),
      { timeoutMs: network ? NETWORK_GIT_TIMEOUT_MS : undefined }
    )
    return r.code === 0 ? r.stdout.toString('utf8') : null
  }

  private bare(p: string): string {
    const key = parseRemoteKey(p)
    if (!key || key.host !== this.machine) throw new Error('KOLOFT_READ_FAILED')
    return key.path
  }

  private keyed(p: string): string {
    return formatRemoteKey(this.machine, p)
  }

  private keyedMap<V>(m: Record<string, V>): Record<string, V> {
    const out: Record<string, V> = {}
    for (const [k, v] of Object.entries(m)) out[this.keyed(k)] = v
    return out
  }

  private sh(script: string, args: string[], opts?: { timeoutMs?: number; input?: Buffer }) {
    return this.deps.run(remoteSh(script, args), opts)
  }

  async listDir(dir: string, opts?: { showIgnored?: boolean }): Promise<DirEntry[]> {
    const bareDir = this.bare(dir)
    const r = await this.sh(LIST_DIR, [bareDir])
    if (r.code !== 0) return []
    const { entries, ignored } = parseListDir(r.stdout.toString('utf8'), bareDir)
    return this.keyedPaths(visibleEntries(entries, ignored, !!opts?.showIgnored))
  }

  private keyedPaths<T extends { path: string }>(items: T[]): T[] {
    return items.map((item) => ({ ...item, path: this.keyed(item.path) }))
  }

  async dirExists(dir: string): Promise<boolean> {
    return (await this.sh('test -d "$1"', [this.bare(dir)])).code === 0
  }

  async search(root: string, query: string, opts?: { showIgnored?: boolean }) {
    const q = query.trim().toLowerCase()
    if (!q) return { hits: [], truncated: false }
    const showIgnored = !!opts?.showIgnored
    const bareRoot = this.bare(root)
    const r = await this.sh(SEARCH_FILES, [bareRoot, showIgnored ? '1' : '0'], {
      timeoutMs: GIT_TIMEOUT_MS
    })
    const found = r.code === 0 ? parseSearchFiles(r.stdout.toString('utf8')) : []
    const ranked = rankFiles(found, bareRoot, q, showIgnored)
    return { ...ranked, hits: this.keyedPaths(ranked.hits) }
  }

  async searchContent(root: string, query: string, opts?: { showIgnored?: boolean }) {
    const q = query.trim()
    if (!q) return { hits: [], truncated: false }
    const showIgnored = !!opts?.showIgnored
    const bareRoot = this.bare(root)
    const timeoutMs = GIT_TIMEOUT_MS
    let r = await this.sh(RG_OR_MISSING, [bareRoot, ...rgArgs(q, showIgnored)], { timeoutMs })
    if (r.code === EXIT_NO_RG)
      r = await this.sh(GIT_GREP, [bareRoot, ...gitGrepArgs(q, showIgnored)], { timeoutMs })
    const lines = r.code === 0 ? r.stdout.toString('utf8').split('\n') : []
    const found = contentHitsOf(lines, bareRoot, showIgnored)
    return { ...found, hits: this.keyedPaths(found.hits) }
  }

  diffBase(root: string): Promise<string | null> {
    return this.git.diffBase(this.bare(root))
  }

  async gitStatus(root: string, base?: string): Promise<GitStatusMap> {
    return this.keyedMap(await this.git.gitStatus(this.bare(root), base))
  }

  async gitNumstat(root: string, base?: string): Promise<GitNumstatMap> {
    return this.keyedMap(await this.git.gitNumstat(this.bare(root), base))
  }

  async gitDiff(root: string, base?: string) {
    const d = await this.git.gitDiff(this.bare(root), base)
    return { ...d, toplevel: d.toplevel === null ? null : this.keyed(d.toplevel) }
  }

  gitFileDiff(file: string, base?: string, untracked?: boolean) {
    return this.git.gitFileDiff(this.bare(file), base, untracked)
  }

  gitFileDiffFull(file: string, base?: string, untracked?: boolean) {
    return this.git.gitFileDiffFull(this.bare(file), base, untracked)
  }

  private async readWithHeader(file: string, maxBytes: number) {
    const r = await this.sh(READ_TEXT, [this.bare(file), String(maxBytes)])
    if (r.code !== 0) throw failure(r, 'KOLOFT_READ_FAILED')
    const { header, body } = headerAndBody(r.stdout)
    const parts = header.split(' ')
    const fp = parseFingerprint(header)
    if (!fp) throw new Error('KOLOFT_READ_FAILED')
    return { fp, body, file: parts[2] === 'w', dir: parts[3] === 'w' }
  }

  async readText(file: string): Promise<string> {
    const { body } = await this.readWithHeader(file, MAX_READ_BYTES).catch((e: Error) => {
      throw e.message === 'KOLOFT_GONE' ? new Error('KOLOFT_READ_FAILED') : e
    })
    if (looksBinary(body)) throw new Error('KOLOFT_BINARY')
    return body.toString('utf8')
  }

  async openForEdit(file: string) {
    const got = await this.readWithHeader(file, EDIT_OPEN_MAX_BYTES)
    return editOpenResult(got.body, got.fp, { file: () => got.file, dir: () => got.dir })
  }

  private async staleResult(file: string, fp: EditFingerprint): Promise<EditWriteResult> {
    let text: string | null = null
    if (fp.size <= EDIT_OPEN_MAX_BYTES) {
      const got = await this.readWithHeader(file, EDIT_OPEN_MAX_BYTES).catch(() => null)
      if (got && !looksBinary(got.body)) text = got.body.toString('utf8')
    }
    return { ok: false, code: 'stale', mtimeMs: fp.mtimeMs, size: fp.size, text }
  }

  async writeText(
    file: string,
    text: string,
    expect: unknown,
    opts?: { force?: unknown; eol?: unknown }
  ): Promise<EditWriteResult> {
    if (typeof text !== 'string') throw new Error('KOLOFT_WRITE_FAILED')
    if (Buffer.byteLength(text, 'utf8') > EDIT_WRITE_MAX_BYTES) throw new Error('KOLOFT_TOO_LARGE')
    const force = opts?.force === true
    const bare = this.bare(file)
    let seen = '-'
    if (!force) {
      const r = await this.sh(FINGERPRINT_ONLY, [bare])
      if (r.code !== 0) throw failure(r, 'KOLOFT_WRITE_FAILED')
      seen = r.stdout.toString('utf8').trim()
      const fp = parseFingerprint(seen)
      if (!fp) throw new Error('KOLOFT_WRITE_FAILED')
      if (!sameFingerprint(expect, fp)) return this.staleResult(file, fp)
    }
    const r = await this.sh(WRITE_IF_UNCHANGED, [bare, seen], {
      input: bytesToWrite(text, opts?.eol)
    })
    if (r.code !== 0) throw failure(r, 'KOLOFT_WRITE_FAILED')
    const out = r.stdout.toString('utf8').trim()
    const fp = parseFingerprint(out.slice(out.indexOf(' ') + 1))
    if (!fp) throw new Error('KOLOFT_WRITE_FAILED')
    if (out.startsWith('stale ')) return this.staleResult(file, fp)
    return { ok: true, mtimeMs: fp.mtimeMs, size: fp.size }
  }

  async createFile(dir: string, name: string): Promise<EditCreateResult> {
    checkNewFileName(name)
    const r = await this.sh(CREATE_FILE, [this.bare(dir), name])
    if (r.code !== 0) throw failure(r, 'KOLOFT_WRITE_FAILED')
    const [created, fpLine] = r.stdout.toString('utf8').split('\n')
    const fp = parseFingerprint(fpLine ?? '')
    if (!created || !fp) throw new Error('KOLOFT_WRITE_FAILED')
    return { path: this.keyed(created), mtimeMs: fp.mtimeMs, size: fp.size }
  }

  watchDir(): boolean {
    return false
  }

  unwatchDir(): void {}

  watchFile(): void {}

  unwatchFile(): void {}

  shell(cwd: string): ShellLaunch {
    return { ...this.deps.shell(this.bare(cwd)), cwd }
  }
}
