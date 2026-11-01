import crypto from 'crypto'
import os from 'os'
import path from 'path'
import {
  HIDDEN_BY_DEFAULT_NAMES,
  type BaseChoice,
  type DirEntry,
  type EditCreateResult,
  type EditFingerprint,
  type EditWriteResult,
  type GitChanges,
  type SkillSuggestion
} from '@shared/types'
import { formatRemoteKey, parseRemoteKey } from '@shared/remoteKey'
import { shq } from '@shared/shellQuote'
import { EDIT_OPEN_MAX_BYTES, EDIT_WRITE_MAX_BYTES } from '@shared/editLimits'
import { portOffset } from '@shared/worktreeName'
import { contentHitsOf, gitGrepArgs, rankFiles, rgArgs, visibleEntries } from '../fileTree'
import {
  MAX_READ_BYTES,
  bytesToWrite,
  checkNewFileName,
  editOpenResult,
  isFingerprint,
  looksBinary
} from '../fileEdit'
import {
  GIT_TIMEOUT_MS,
  coalesce,
  gitOps,
  numstatFrom,
  statusFrom,
  type GitOps
} from '../gitStatus'
import { GithubLookup, type GithubOptions } from '../github'
import { GIT_STEP_TIMEOUT_MS, type GitRunResult } from '../gitSteps'
import { parseLeftRight, type FreshnessRunner, type GitSnapshot } from '../gitFreshness'
import { FINGERPRINT, remoteShCommand } from '../remote/install'
import {
  claudeTabSpec,
  killSessionCmd,
  machineToolProgram,
  renameSessionCmd,
  resizeStandInCmd,
  launchLine,
  POSIX_SHELL_FOR_REMOTE_LAUNCH_LINE,
  sessionIdOfTmux,
  tmuxSessionName,
  writeTabPackage,
  type MachinePackage
} from '../remote/launch'
import {
  mirrorHookDir,
  mirrorProjectsRoot,
  REMOTE_HOOK_DIR,
  remoteMachineDir,
  tabPackageDir
} from '../remote/paths'
import { launchMode } from '../remote/sync'
import {
  backgroundOptions,
  ensureControlDir,
  machineOutOfReach,
  needsSignIn,
  problemOf,
  sshLinkBroke,
  sshOptions,
  type BytesResult
} from '../remote/ssh'
import { MUSE_HOOK_FILE, MUSE_TRUSTED_SH, museRunLines } from '../museRemote'
import { remoteMuseHooks, sessionStartContext } from '../museHooks'
import {
  HOLD_FILE,
  NOTICE_THIS_TURN,
  noticeLine,
  OWNER_ASLEEP_FILE,
  ownerAsleepMarker,
  remoteNoticeFile,
  type NoticeFile
} from '../hooks'
import { claudeArgv } from '../claudeArgs'
import type { SummaryRow } from '../agyStore'
import {
  AGY_HELD_ELSEWHERE_EXIT,
  AGY_SEND_SSH_OUTLASTS_THE_SCRIPT_MS,
  agyHeldCmd,
  agySendCmd,
  listAgyCmd,
  parseAgyConfig,
  readAgyConfigCmd,
  type AgyMachineLaunch,
  type AgyMachinePlan,
  type RemoteAgyConfig
} from '../remote/agyTab'
import { listSkills, type SkillFs } from '../skillList'
import { worktreeNameAround, type GitOut } from '../resumePlan'
import type { ClaudeLaunch, ClaudeLaunchPlan, Host, ShellLaunch } from './host'

export interface MachineAccount {
  env: Record<string, string>
  banner: string
}

export interface MachineClaudeDeps {
  userData: string
  controlDir: string
  machinePackage(): MachinePackage
  alive(): ReadonlySet<string>
  firstHeartbeatDone(): Promise<void>
  realPath(p: string): string
  settings(): { skipPermissions: boolean }
  agentTools(): boolean
  pickAccount(launchKey: string, resumeSessionId?: string): Promise<MachineAccount | undefined>
  noAccountMessage(): string
  hookSettings(tabId: string, machineDir: string, allowKoloft: boolean): Record<string, unknown>
}

export interface MuseMachineLaunch {
  cwd: string
  fallbackCwd?: string
  resumeSessionId?: string
  account: { name: string; auth(): string }
  banner?: string
  args: string[]
  trust: string[]
  trustIf?: string
  context?: string
  skill?: string
  portOffset?: number
  ownerWords?: string
  holdWhileBusy?: boolean
}

export interface MuseMachinePlan {
  attach: boolean
  tmuxName(tabId: string): string
  launchCommand(tabId: string): string
  resized(tabId: string, cols: number, rows: number): void
}

export interface SshHostDeps {
  run(cmd: string, opts?: { timeoutMs?: number; input?: Buffer }): Promise<BytesResult>
  sshEnvReady?(): Promise<void>
  shell(dir: string): Omit<ShellLaunch, 'cwd'>
  watch(path: string, onChange: (stamp: string) => void): void
  unwatch(path: string): void
  github: GithubOptions
  claude: MachineClaudeDeps
}

// CC§9
export function machineClaudeArgs(
  spec: ClaudeLaunch,
  sessionId: string,
  skipPermissions: boolean
): { ok: true; args: string[] } | { ok: false; code: 'invalid-args' } {
  const argv = claudeArgv('claude', {
    resumeSessionId: spec.resumeSessionId,
    sessionId: spec.resumeSessionId ? undefined : sessionId,
    worktree: spec.worktree,
    model: spec.model,
    effort: spec.effort,
    permission:
      spec.permission && spec.permission !== 'default'
        ? spec.permission
        : skipPermissions
          ? 'bypass'
          : undefined
  })
  if (!argv.ok) return argv
  const fresh = !spec.resumeSessionId
  return {
    ok: true,
    args: [
      ...argv.argv.slice(1),
      ...(fresh && spec.name ? ['--name', spec.name] : []),
      ...(fresh && spec.firstPrompt ? ['--', spec.firstPrompt] : [])
    ]
  }
}

const CLAUDE_TRUST_JS = [
  'const fs=require("fs"),path=require("path");',
  'const [f,d]=process.argv.slice(1);',
  'let top=null;',
  'for(let x=d;;x=path.dirname(x)){',
  'let s;try{s=fs.lstatSync(path.join(x,".git"))}catch(e){}',
  'if(s&&(s.isDirectory()||s.isFile())){top=x;if(s.isFile())try{',
  'const l=fs.readFileSync(path.join(x,".git"),"utf8").split("\\n").find((l)=>l.startsWith("gitdir:"));',
  'const g=path.resolve(x,l.slice(7).trim());',
  'top=path.dirname(path.resolve(g,fs.readFileSync(path.join(g,"commondir"),"utf8").trim()));',
  'try{top=fs.realpathSync(top)}catch(e){}',
  '}catch(e){top=x}break}',
  'if(path.dirname(x)===x)break}',
  'const trusted=(p)=>{',
  'const ok=(x)=>p[x]&&p[x].hasTrustDialogAccepted===true;',
  'if(top!==null&&d!==top&&!d.startsWith(top.endsWith("/")?top:top+"/"))return ok(d);',
  'for(let x=d;;x=path.dirname(x)){',
  'if(ok(x))return true;',
  'if(x===top||path.dirname(x)===x)return false}};'
].join('')

const TRUST_CWD_JS = [
  CLAUDE_TRUST_JS,
  'let j={};',
  'try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch(e){if(e.code!=="ENOENT")process.exit(0)}',
  'const p=(j.projects=j.projects||{});',
  'if(trusted(p))process.exit(0);',
  'p[d]=Object.assign({},p[d],{hasTrustDialogAccepted:true});',
  'fs.writeFileSync(f+".koloft",JSON.stringify(j,null,2),{mode:0o600});',
  'fs.renameSync(f+".koloft",f)'
].join('')

const TRUSTED_JS = [
  CLAUDE_TRUST_JS,
  'let p={};',
  'try{p=JSON.parse(fs.readFileSync(f,"utf8")).projects||{}}catch(e){}',
  'process.exit(trusted(p)?0:1)'
].join('')

const NOT_TRUSTED = 1

const WITH_NODE_IN_REAL_DIR = `cd "$1" 2>/dev/null || exit ${NOT_TRUSTED}
command -v node >/dev/null 2>&1 || exit ${NOT_TRUSTED}
node -e "$2" "$HOME/.claude.json" "$(pwd -P)"`

const NETWORK_GIT_TIMEOUT_MS = 20_000

const AGY_WAITS_FOR_ANOTHER_TAB_TO_SIGN_IN =
  'This machine wants a password or a new host key first, and an Antigravity tab cannot ask for it yet: sign in through a Claude Code, Codex or Muse session there first'
const MACHINE_PAGE_FILE_MAX_BYTES = 32 * 1024 * 1024
const MACHINE_PAGE_READ_MS = 120_000
const MACHINE_PAGE_READS_AT_ONCE_UNDER_DEFAULT_SSHD_MAX_SESSIONS = 4

const GONE_FROM_DISK = { mtimeMs: 0, size: 0 }

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

function lineAt(buf: Buffer, at: number): [string, number] {
  const nl = buf.indexOf(0x0a, at)
  return nl < 0 ? [buf.toString('utf8', at), buf.length] : [buf.toString('utf8', at, nl), nl + 1]
}

function headerAndBody(buf: Buffer): { header: string; body: Buffer } {
  const [header, body] = lineAt(buf, 0)
  return { header, body: buf.subarray(body) }
}

const REAL_FILES = `while IFS= read -r f; do
  case $f in '~/'*) p=$HOME/\${f#\\~/} ;; *) p=$f ;; esac
  [ -f "$p" ] || continue
  r=$(realpath "$p" 2>/dev/null || readlink -f "$p" 2>/dev/null) || r=
  printf '%s\\0%s\\0' "$f" "\${r:-$p}"
done`

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

const ANY_FINGERPRINT = '-'
const NO_FINGERPRINT = 'none'

// PLATFORM§37
const WRITE_IF_UNCHANGED = `p=$(readlink -f "$1" 2>/dev/null || printf '%s' "$1")
[ -e "$p" ] || { [ -d "$(dirname "$p")" ] && exit ${EXIT_GONE}; exit ${EXIT_DIR_GONE}; }
[ -f "$p" ] || exit ${EXIT_NOT_FILE}
${FINGERPRINT}
t="$(dirname "$p")/.$(basename "$p").koloft-tmp-$$"
cp -p "$p" "$t" 2>/dev/null || exit ${EXIT_NO_PERM}
cat > "$t" || { rm -f "$t"; exit ${EXIT_WRITE_FAILED}; }
if [ "$2" != ${ANY_FINGERPRINT} ] && ! fp "$p" | awk -v ms="$2" -v sz="$3" '{ same = $1 * 1000 == ms && $2 == sz } END { exit !same }'
then rm -f "$t"; printf 'stale '; fp "$p"; exit 0; fi
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

const GIT_IN_REPO = `g() { GIT_OPTIONAL_LOCKS=0 git -C "$r" "$@" 2>/dev/null; }`

const DEFAULT_REF = `dr() {
  ref=$(g symbolic-ref --quiet refs/remotes/origin/HEAD) && ref=\${ref#refs/remotes/} &&
    g rev-parse --verify --quiet "$ref" >/dev/null && { printf '%s' "$ref"; return 0; }
  for c in "$@"; do
    g rev-parse --verify --quiet "$c" >/dev/null && { printf '%s' "$c"; return 0; }
  done
  return 1
}`

const MERGE_BASE = `${DEFAULT_REF}
db() {
  def=$(dr origin/main origin/master main master)
  if [ -n "$def" ]; then
    mb=$(g merge-base HEAD "$def") && [ -n "$mb" ] && { printf '%s' "$mb"; return 0; }
  fi
  g rev-parse --verify --quiet HEAD >/dev/null && printf HEAD
  return 0
}`

const DIFF_BASE = `r=$1
${GIT_IN_REPO}
${MERGE_BASE}
db
exit 0`

const CHANGES_GONE = 'gone'
const CHANGES_NOT_A_REPO = 'norepo'
const CHANGES_REPO = 'repo'

// PLATFORM§37
const CHANGES = `r=$1
${GIT_IN_REPO}
${MERGE_BASE}
[ -d "$r" ] || { echo ${CHANGES_GONE}; exit 0; }
top=$(g rev-parse --show-toplevel) || { echo ${CHANGES_NOT_A_REPO}; exit 0; }
if [ "$2" = head ]; then b=HEAD; else b=$(db); fi
o=$(mktemp) || exit 1
trap 'rm -f "$o"' EXIT
part() { n=$1; shift; "$@" >"$o"; c=$?; printf '%s %s %s\\n' "$n" "$c" "$(wc -c <"$o")"; cat "$o"; }
printf '${CHANGES_REPO}\\n%s\\n%s\\n' "$b" "$top"
ns=1 nb=1
if [ -n "$b" ]; then
  part nameStatus g diff --name-status -z "$b" --; ns=$c
  part vsBase g diff "$b" --numstat -z --; nb=$c
fi
part others g -C "$top" ls-files --others --exclude-standard -z --full-name
part unmerged g -C "$top" ls-files -u -z --full-name
[ "$ns" = 0 ] || part porcelain g status --porcelain=v1 -z
[ "$nb" = 0 ] || { part cached g diff --cached --numstat -z --; part unstaged g diff --numstat -z --; }
exit 0`

const CHANGES_GIT_QUERIES_IN_A_ROW = 9

function parseChanges(stdout: Buffer): GitChanges | null {
  const [state, afterState] = lineAt(stdout, 0)
  if (state === CHANGES_GONE || state === CHANGES_NOT_A_REPO)
    return { base: null, status: {}, numstat: {}, missing: state === CHANGES_GONE }
  if (state !== CHANGES_REPO) return null
  const [base, afterBase] = lineAt(stdout, afterState)
  const [toplevel, afterTop] = lineAt(stdout, afterBase)
  const parts = new Map<string, string | null>()
  for (let at = afterTop; at < stdout.length;) {
    const [header, body] = lineAt(stdout, at)
    const [name, code, bytes] = header.split(/\s+/)
    const end = body + Number(bytes)
    if (!Number.isInteger(end) || end > stdout.length) return null
    parts.set(name, code === '0' ? stdout.toString('utf8', body, end) : null)
    at = end
  }
  const out = (name: string): string | null => parts.get(name) ?? null
  return {
    base: base || null,
    status: statusFrom(toplevel, {
      nameStatus: out('nameStatus'),
      others: out('others'),
      porcelain: out('porcelain'),
      unmerged: out('unmerged')
    }),
    numstat: numstatFrom(toplevel, {
      vsBase: out('vsBase'),
      cached: out('cached'),
      unstaged: out('unstaged')
    }),
    missing: false
  }
}

const SKILL_FILES = `printf '%s\\0' "$HOME"
for b in "$1" "$HOME"; do
  for f in "$b"/.claude/skills/*/SKILL.md; do
    [ -f "$f" ] && { printf '%s\\0' "$f"; cat "$f"; printf '\\0'; }
  done
  for f in "$b"/.claude/commands/*.md; do
    [ -f "$f" ] && printf '%s\\0\\0' "$f"
  done
done
exit 0`

function skillFsOf(files: Map<string, string>): SkillFs {
  const children = (dir: string): string[] => {
    const names = new Set<string>()
    for (const f of files.keys())
      if (f.startsWith(dir + '/')) names.add(f.slice(dir.length + 1).split('/')[0])
    return [...names]
  }
  return {
    readdir: children,
    readFile: (p) => {
      const text = files.get(p)
      if (text === undefined) throw new Error('KOLOFT_READ_FAILED')
      return text
    },
    isDir: (p) => children(p).length > 0,
    isFile: (p) => files.has(p)
  }
}

const NETWORK_ENV = `GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=false SSH_ASKPASS=false \
SSH_ASKPASS_REQUIRE=never GIT_SSH_COMMAND="\${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes"`

const NETWORK_GIT = `${NETWORK_ENV} git "$@"`

// PLATFORM§30
const FRESHNESS = `r=$1
${GIT_IN_REPO}
${DEFAULT_REF}
${FINGERPRINT}
br=$(g rev-parse --abbrev-ref HEAD) && head=$(g rev-parse HEAD) || exit 1
def=$(dr origin/main origin/master)
l=0; [ -f "$r/.git" ] && l=1
s=0; [ -e "$r/.gitmodules" ] && s=1
fh=$(fp "$r/.git/FETCH_HEAD" 2>/dev/null) || fh=-
printf '%s\\n%s\\n%s\\n%s %s\\n%s\\n' "$br" "$head" "$def" "$l" "$s" "$fh"
[ "$br" != HEAD ] && [ -n "$def" ] || exit 0
f=-
if [ "$2" = 1 ]; then
  if ${NETWORK_ENV} git -C "$r" fetch --quiet --no-auto-maintenance origin "\${def#origin/}" >/dev/null 2>&1
  then f=1; else f=0; fi
fi
c=$(g rev-list --left-right --count "HEAD...$def") && d=$(g status --porcelain -uno --ignore-submodules=all) && t=$(g rev-parse "$def") || exit 1
printf '%s\\n%s\\n%s\\n%s\\n' "$f" "$c" "\${d:+dirty}" "$t"`

const PULLED = 'KOLOFT_PULLED'

const FAST_FORWARD = `r=$1 from=$3
${NETWORK_ENV} git -C "$r" -c advice.diverging=false pull --ff-only --no-recurse-submodules origin "$2"
ok=$?
n=$(git -C "$r" rev-list --count "$from..HEAD" 2>/dev/null) || n=0
printf '\\n${PULLED} %s\\n' "$n"
( set -- "$r" 0
${FRESHNESS}
)
exit $ok`

export function parseFreshness(stdout: string): GitSnapshot | null {
  const [branch, head, defRef, flags, fetchHead, fetched, counts, dirty, defHead] =
    stdout.split('\n')
  if (!branch || !head || fetchHead === undefined) return null
  const [linked, subs] = flags.split(' ')
  const snapshot: GitSnapshot = {
    branch,
    head,
    defRef,
    linked: linked === '1',
    hasSubmodules: subs === '1',
    tracking: null
  }
  if (fetched === undefined || fetched === '') return snapshot
  const lr = parseLeftRight(counts ?? '')
  if (!lr) return null
  return {
    ...snapshot,
    tracking: {
      fetched: fetched === '-' ? null : fetched === '1',
      fetchHeadAt: parseFingerprint(fetchHead)?.mtimeMs ?? null,
      ...lr,
      dirty: dirty === 'dirty',
      defHead: defHead ?? ''
    }
  }
}

const PULLED_TAIL = new RegExp(`\\n${PULLED} (\\d+)\\n([\\s\\S]*)$`)

const ANSWER_AGENT_REQUEST = `d="${REMOTE_HOOK_DIR}"
[ -f "$d/req-$1.json" ] || exit 0
cat > "$d/res-$1.json.tmp" && mv -f "$d/res-$1.json.tmp" "$d/res-$1.json" && rm -f "$d/req-$1.json"`
const TAKE_AWAY_AGENT_REQUEST = `rm -f "${REMOTE_HOOK_DIR}/req-$1.json"`
const leaveNoticeOnMachine = (file: string): string => `mkdir -p "${REMOTE_HOOK_DIR}" || exit 1
IFS= read -r fresh; IFS= read -r merged
t="$fresh"; k=fresh
[ -n "$merged" ] && [ -f "${file}" ] && { t="$merged"; k=merged; }
printf '%s' "$t" > "${file}.part" && mv -f "${file}.part" "${file}" && printf '%s' "$k"`

const MARK_OWNER_ASLEEP = `mkdir -p "${REMOTE_HOOK_DIR}" || exit 1
f="${REMOTE_HOOK_DIR}/${OWNER_ASLEEP_FILE}"
cat > "$f.part" && mv -f "$f.part" "$f"`

const SAVE_PICK = `d="$HOME/.koloft/element-picks"
mkdir -p "$d" && cd "$d" || exit 1
find . -type f -mtime +0 -exec rm -f {} + 2>/dev/null
cat > "$1.part" && mv -f "$1.part" "$1" && printf '%s/%s' "$(pwd -P)" "$1"`

const RESIZE_SETTLE_MS = 200

const REMOTE_FILE_LIST_FRESH_MS = 30_000

// PLATFORM§35
const NO_TAB_NAME_IS_ANOTHERS_PREFIX = '-t'

export class SshHost implements Host {
  readonly github: GithubLookup
  private git: GitOps
  private killedSessions = new Set<string>()
  private kills = new Map<string, Promise<unknown>>()
  private resizes = new Map<string, ReturnType<typeof setTimeout>>()
  private fileLists = new Map<string, Promise<{ rel: string; ignored: boolean }[] | null>>()
  private pageReads = 0
  private pageReadsWaiting: (() => void)[] = []

  private resized = (tabId: string, cols: number, rows: number): void => {
    clearTimeout(this.resizes.get(tabId))
    this.resizes.set(
      tabId,
      setTimeout(() => {
        this.resizes.delete(tabId)
        void this.deps.run(resizeStandInCmd(tabId, cols, rows))
      }, RESIZE_SETTLE_MS)
    )
  }

  constructor(
    readonly machine: string,
    private deps: SshHostDeps
  ) {
    this.git = gitOps({
      id: `ssh:${machine}`,
      git: async (args, opts) => {
        const r = await this.sh(GIT, args, { timeoutMs: opts.timeout })
        const stdout = r.stdout.toString('utf8')
        if (r.code === 0) return { stdout, stderr: r.stderr }
        throw Object.assign(new Error(r.stderr || 'git failed'), {
          code: r.code ?? undefined,
          killed: sshLinkBroke(r),
          stdout,
          stderr: r.stderr
        })
      },
      resolveBase: async (root) => {
        const r = await this.sh(DIFF_BASE, [root], { timeoutMs: GIT_TIMEOUT_MS })
        if (r.code === null) throw Object.assign(new Error('git timed out'), { killed: true })
        return r.stdout.toString('utf8').trim() || null
      }
    })
    this.github = new GithubLookup({
      ...deps.github,
      git: (root, args, network) =>
        network
          ? this.runGit(NETWORK_GIT, root, args, NETWORK_GIT_TIMEOUT_MS)
          : this.gitOut(root, args)
    })
  }

  gitOut: GitOut = (root, args, timeoutMs, onFailure) =>
    this.runGit(GIT, root, args, timeoutMs, onFailure)

  private async runGit(
    script: string,
    root: string,
    args: string[],
    timeoutMs?: number,
    onFailure?: (stderr: string) => void
  ): Promise<string | null> {
    const r = await this.sh(script, ['-C', this.bare(root), ...args], { timeoutMs })
    if (r.code !== 0) onFailure?.(r.stderr)
    return r.code === 0 ? r.stdout.toString('utf8') : null
  }

  readonly freshness: FreshnessRunner = {
    measure: async (root, fetchTimeoutMs) => {
      const r = await this.sh(FRESHNESS, [this.bare(root), fetchTimeoutMs === null ? '0' : '1'], {
        timeoutMs: (fetchTimeoutMs ?? 0) + GIT_TIMEOUT_MS
      })
      return {
        snapshot: r.code === 0 ? parseFreshness(r.stdout.toString('utf8')) : null,
        enoent: false
      }
    },
    pull: async (root, defBranch, from, timeoutMs) => {
      const r = await this.sh(FAST_FORWARD, [this.bare(root), defBranch, from], { timeoutMs })
      const stdout = r.stdout.toString('utf8')
      const tail = PULLED_TAIL.exec(stdout)
      return {
        ok: r.code === 0,
        stdout: tail ? stdout.slice(0, tail.index) : stdout,
        stderr: r.stderr,
        timedOut: r.code === null,
        enoent: false,
        count: tail ? Number(tail[1]) : 0,
        after: tail ? parseFreshness(tail[2]) : null
      }
    }
  }

  async gitRun(root: string, args: string[], network = false): Promise<GitRunResult> {
    const r = await this.sh(network ? NETWORK_GIT : GIT, ['-C', this.bare(root), ...args], {
      timeoutMs: GIT_STEP_TIMEOUT_MS
    })
    return { code: r.code, stdout: r.stdout.toString('utf8'), stderr: r.stderr }
  }

  private bare(p: string): string {
    const key = parseRemoteKey(p)
    if (!key || key.host !== this.machine) throw new Error('KOLOFT_READ_FAILED')
    return key.path
  }

  keyed(p: string): string {
    return parseRemoteKey(p) ? p : formatRemoteKey(this.machine, p)
  }

  private keyedMap<V>(m: Record<string, V>): Record<string, V> {
    const out: Record<string, V> = {}
    for (const [k, v] of Object.entries(m)) out[this.keyed(k)] = v
    return out
  }

  private sh(script: string, args: string[], opts?: { timeoutMs?: number; input?: Buffer }) {
    return this.deps.run(remoteShCommand(script, args), opts)
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

  private testDir(dir: string) {
    return this.sh('test -d "$1"', [this.bare(dir)])
  }

  async dirExists(dir: string): Promise<boolean> {
    return (await this.testDir(dir)).code === 0
  }

  async dirExistsOrThrow(dir: string): Promise<boolean> {
    const r = await this.testDir(dir)
    if (sshLinkBroke(r)) throw new Error(problemOf(r))
    return r.code === 0
  }

  async sessionDirThere(dir: string): Promise<boolean> {
    const r = await this.testDir(dir)
    if (machineOutOfReach(r)) throw new Error(problemOf(r))
    return r.code === 0 || sshLinkBroke(r)
  }

  async reachOrThrow(): Promise<void> {
    const r = await this.sh('true', [])
    if (machineOutOfReach(r)) throw new Error(problemOf(r))
  }

  async makeDir(dir: string): Promise<boolean> {
    return (await this.sh('mkdir -- "$1"', [this.bare(dir)])).code === 0
  }

  async fileExists(file: string): Promise<boolean> {
    return (await this.sh('test -f "$1"', [this.bare(file)])).code === 0
  }

  async realFiles(files: string[]): Promise<Map<string, string>> {
    const r = await this.sh(REAL_FILES, [], { input: Buffer.from(files.join('\n') + '\n') })
    if (r.code !== 0) throw new Error(problemOf(r))
    const out = new Map<string, string>()
    const parts = r.stdout.toString('utf8').split('\0')
    for (let i = 0; i + 1 < parts.length; i += 2) out.set(parts[i], parts[i + 1])
    return out
  }

  async search(root: string, query: string, opts?: { showIgnored?: boolean }) {
    const q = query.trim().toLowerCase()
    if (!q) return { hits: [], truncated: false }
    const showIgnored = !!opts?.showIgnored
    const bareRoot = this.bare(root)
    const found = (await this.fileList(bareRoot, showIgnored)) ?? []
    const ranked = rankFiles(found, bareRoot, q, showIgnored)
    return { ...ranked, hits: this.keyedPaths(ranked.hits) }
  }

  private fileList(bareRoot: string, showIgnored: boolean) {
    const key = `${bareRoot}\0${showIgnored}`
    const cached = this.fileLists.get(key)
    if (cached) return cached
    const listed = this.sh(SEARCH_FILES, [bareRoot, showIgnored ? '1' : '0'], {
      timeoutMs: GIT_TIMEOUT_MS
    }).then((r) => (r.code === 0 ? parseSearchFiles(r.stdout.toString('utf8')) : null))
    const forget = (): void => {
      if (this.fileLists.get(key) === listed) this.fileLists.delete(key)
    }
    this.fileLists.set(key, listed)
    void listed.then((files) => (files ? setTimeout(forget, REMOTE_FILE_LIST_FRESH_MS) : forget()))
    return listed
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

  gitChanges(root: string, base: BaseChoice): Promise<GitChanges> {
    const bareRoot = this.bare(root)
    return coalesce(['ssh', this.machine, 'changes', bareRoot, base].join('\0'), async () => {
      const r = await this.sh(CHANGES, [bareRoot, base], {
        timeoutMs: GIT_TIMEOUT_MS * CHANGES_GIT_QUERIES_IN_A_ROW
      })
      const got = r.code === 0 ? parseChanges(r.stdout) : null
      if (!got) throw new Error(problemOf(r))
      return { ...got, status: this.keyedMap(got.status), numstat: this.keyedMap(got.numstat) }
    })
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

  private async readWithHeader(file: string, maxBytes: number, timeoutMs?: number) {
    const r = await this.sh(READ_TEXT, [this.bare(file), String(maxBytes)], { timeoutMs })
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

  async readPageFile(file: string): Promise<Buffer> {
    while (this.pageReads >= MACHINE_PAGE_READS_AT_ONCE_UNDER_DEFAULT_SSHD_MAX_SESSIONS)
      await new Promise<void>((free) => this.pageReadsWaiting.push(free))
    this.pageReads++
    try {
      const read = this.readWithHeader(file, MACHINE_PAGE_FILE_MAX_BYTES, MACHINE_PAGE_READ_MS)
      return (await read).body
    } finally {
      this.pageReads--
      this.pageReadsWaiting.shift()?.()
    }
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
    const want =
      opts?.force === true
        ? [ANY_FINGERPRINT, ANY_FINGERPRINT]
        : isFingerprint(expect)
          ? [String(expect.mtimeMs), String(expect.size)]
          : [NO_FINGERPRINT, NO_FINGERPRINT]
    const r = await this.sh(WRITE_IF_UNCHANGED, [this.bare(file), ...want], {
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
    this.fileLists.clear()
    const [created, fpLine] = r.stdout.toString('utf8').split('\n')
    const fp = parseFingerprint(fpLine ?? '')
    if (!created || !fp) throw new Error('KOLOFT_WRITE_FAILED')
    return { path: this.keyed(created), mtimeMs: fp.mtimeMs, size: fp.size }
  }

  // PLATFORM§57
  watchDir(dir: string, onChange: (dir: string) => void): boolean {
    this.deps.watch(this.bare(dir), () => onChange(dir))
    return false
  }

  unwatchDir(dir: string): void {
    this.deps.unwatch(this.bare(dir))
  }

  watchFile(
    file: string,
    onChange: (file: string, fp: { mtimeMs: number; size: number }) => void
  ): void {
    this.deps.watch(this.bare(file), (stamp) =>
      onChange(file, parseFingerprint(stamp) ?? GONE_FROM_DISK)
    )
  }

  unwatchFile(file: string): void {
    this.deps.unwatch(this.bare(file))
  }

  shell(cwd: string): ShellLaunch {
    return { ...this.deps.shell(this.bare(cwd)), cwd, resized: this.resized }
  }

  reveal(): void {}

  osOpen(): void {}

  endTmuxSession(tmuxName: string): Promise<string | undefined> {
    const killedId = sessionIdOfTmux(tmuxName)
    const kill = this.deps.run(killSessionCmd(tmuxName)).then((r) => {
      if (this.kills.get(tmuxName) === kill) this.kills.delete(tmuxName)
      if (!sshLinkBroke(r)) return undefined
      if (killedId) this.killedSessions.delete(killedId)
      return problemOf(r)
    })
    this.kills.set(tmuxName, kill)
    if (killedId) this.killedSessions.add(killedId)
    return kill
  }

  async renameTmuxSession(tabId: string, from: string, to: string): Promise<boolean> {
    return (await this.deps.run(renameSessionCmd(tabId, from, to))).code === 0
  }

  async answerAgent(requestId: string, reply: string | null): Promise<void> {
    if (reply === null) await this.sh(TAKE_AWAY_AGENT_REQUEST, [requestId])
    else await this.sh(ANSWER_AGENT_REQUEST, [requestId], { input: Buffer.from(reply) })
  }

  async savePick(name: string, png: Buffer): Promise<string> {
    const r = await this.sh(SAVE_PICK, [name], { input: png })
    if (r.code !== 0) throw new Error(problemOf(r))
    return r.stdout.toString('utf8')
  }

  async markOwnerAsleep(awakeTabs: string[] | null): Promise<boolean> {
    const r = awakeTabs
      ? await this.sh(MARK_OWNER_ASLEEP, [], { input: Buffer.from(ownerAsleepMarker(awakeTabs)) })
      : await this.sh(`rm -f "${REMOTE_HOOK_DIR}/${OWNER_ASLEEP_FILE}"`, [])
    return r.code === 0
  }

  notice(tabId: string): NoticeFile {
    const file = remoteNoticeFile(tabId)
    return {
      leave: async (fresh, merged) => {
        const both = `${noticeLine(fresh)}\n${merged === undefined ? '' : noticeLine(merged)}\n`
        const r = await this.sh(leaveNoticeOnMachine(file), [], { input: Buffer.from(both) })
        if (r.code !== 0) throw new Error(problemOf(r))
        return r.stdout.toString('utf8') === 'merged' ? 'merged' : 'fresh'
      },
      drop: async () => {
        await this.sh(`rm -f "${file}" "${file}${NOTICE_THIS_TURN}"`, [])
      }
    }
  }

  // CC§9 ADR-0026
  async trustFolder(dir: string): Promise<void> {
    await this.sh(WITH_NODE_IN_REAL_DIR, [this.bare(dir), TRUST_CWD_JS])
  }

  // CC§9
  async trustsFolder(dir: string): Promise<boolean> {
    return (await this.sh(WITH_NODE_IN_REAL_DIR, [this.bare(dir), TRUSTED_JS])).code !== NOT_TRUSTED
  }

  // MUSE§17
  async launchMuse(spec: MuseMachineLaunch): Promise<MuseMachinePlan> {
    const d = this.deps.claude
    await this.sshReady()
    const sid = spec.resumeSessionId
    const attach = !!sid && (await this.attachOrStart(sid)) === 'attach'
    const auth = attach ? undefined : spec.account.auth()
    const tmuxName = (tabId: string): string =>
      sid ? tmuxSessionName(sid) : `m-${tabId}${NO_TAB_NAME_IS_ANOTHERS_PREFIX}`
    const pkg = d.machinePackage()
    const hookScript = `${remoteMachineDir(pkg.name)}/${MUSE_HOOK_FILE}`
    const bareOrNot = (p?: string): string | undefined => (p ? this.bare(p) : undefined)
    return {
      attach,
      tmuxName,
      launchCommand: (tabId) => {
        const tabDir = tabPackageDir(d.userData, tabId)
        const contextFile = spec.context ? `$HOME/.koloft/tabs/${tabId}.ctx.json` : undefined
        const files: Record<string, string> = {
          [`${tabId}.hooks.json`]: remoteMuseHooks(
            hookScript,
            tabId,
            contextFile,
            spec.holdWhileBusy ? `${remoteMachineDir(pkg.name)}/${HOLD_FILE}` : undefined
          )
        }
        if (spec.context) files[`${tabId}.ctx.json`] = sessionStartContext(spec.context)
        if (spec.skill) files[`${tabId}.skill.md`] = spec.skill
        if (auth !== undefined) files[`${tabId}.auth.json`] = auth
        writeTabPackage(tabDir, {
          tabId,
          tmuxName: tmuxName(tabId),
          machineName: pkg.name,
          cwd: this.bare(spec.cwd),
          fallbackCwd: bareOrNot(spec.fallbackCwd),
          banner: '',
          portOffset: spec.portOffset,
          ownerWords: spec.ownerWords,
          program: machineToolProgram(
            'muse',
            museRunLines({
              tabId,
              account: spec.account.name,
              banner: spec.banner,
              args: spec.args,
              trust: spec.trust.map((p) => this.bare(p)),
              trustIf: bareOrNot(spec.trustIf)
            }),
            files
          )
        })
        return this.tabLaunchLine(pkg, tabDir, tabId, attach ? 'attach' : 'start')
      },
      resized: this.resized
    }
  }

  private async sshReady(): Promise<void> {
    await this.deps.sshEnvReady?.()
    ensureControlDir(this.deps.claude.controlDir)
  }

  // PLATFORM§35
  private async attachOrStart(sid: string): Promise<'start' | 'attach'> {
    await this.deps.claude.firstHeartbeatDone()
    const mode = launchMode({
      alive: this.deps.claude.alive(),
      killed: this.killedSessions,
      sessionId: sid
    })
    this.killedSessions.delete(sid)
    await this.kills.get(tmuxSessionName(sid))
    return mode
  }

  private tabLaunchLine(
    machine: MachinePackage,
    tabDir: string,
    tabId: string,
    mode: 'start' | 'attach'
  ): string {
    return launchLine({
      host: this.machine,
      sshOptions: sshOptions(this.deps.claude.controlDir, false),
      machine,
      tabDir,
      tabId,
      mode
    })
  }

  // MUSE§10
  async museTrusts(dir: string): Promise<boolean> {
    return (await this.sh(MUSE_TRUSTED_SH, [this.bare(dir)])).code === 0
  }

  async runScript(script: string, args: string[]): Promise<string | null> {
    const r = await this.sh(script, args, { timeoutMs: GIT_TIMEOUT_MS })
    return r.code === 0 ? r.stdout.toString('utf8') : null
  }

  // MUSE§5 MUSE§17
  museServe(args: string[]): { binary: string; args: string[] } {
    const d = this.deps.claude
    ensureControlDir(d.controlDir)
    return {
      binary: 'ssh',
      args: [
        ...backgroundOptions(this.machine, d.controlDir),
        this.machine,
        remoteShCommand('MUSE_NO_AUTO_UPDATE=1 exec muse serve "$@"', args)
      ]
    }
  }

  async listSkills(root: string): Promise<SkillSuggestion[]> {
    const bareRoot = this.bare(root)
    const r = await this.sh(SKILL_FILES, [bareRoot])
    if (r.code !== 0) return []
    const [home, ...rest] = r.stdout.toString('utf8').split('\0')
    const files = new Map<string, string>()
    for (let i = 0; i + 1 < rest.length; i += 2) files.set(rest[i], rest[i + 1])
    return listSkills(skillFsOf(files), bareRoot, home)
  }

  async readAgyConfig(account: string): Promise<RemoteAgyConfig> {
    await this.deps.sshEnvReady?.()
    const r = await this.deps.run(readAgyConfigCmd(account))
    if (needsSignIn(r)) throw new Error(AGY_WAITS_FOR_ANOTHER_TAB_TO_SIGN_IN)
    if (sshLinkBroke(r)) throw new Error(problemOf(r))
    return parseAgyConfig(r.stdout.toString('utf8'))
  }

  async agyHeldElsewhere(conversationId: string): Promise<boolean> {
    return (await this.deps.run(agyHeldCmd(conversationId))).code === AGY_HELD_ELSEWHERE_EXIT
  }

  async agySend(tmuxName: string, conversationId: string, text: string): Promise<boolean> {
    const r = await this.deps.run(agySendCmd(tmuxName, conversationId), {
      input: Buffer.from(text),
      timeoutMs: AGY_SEND_SSH_OUTLASTS_THE_SCRIPT_MS
    })
    return r.code === 0
  }

  async agyConversations(): Promise<SummaryRow[]> {
    const r = await this.deps.run(listAgyCmd(this.deps.claude.machinePackage().name))
    if (r.code !== 0) throw new Error(problemOf(r))
    const rows: unknown = JSON.parse(r.stdout.toString('utf8') || '[]')
    return Array.isArray(rows) ? (rows as SummaryRow[]) : []
  }

  async launchAgy(spec: AgyMachineLaunch): Promise<AgyMachinePlan> {
    const d = this.deps.claude
    await this.sshReady()
    const sid = spec.resumeId
    const attach = !!sid && (await this.attachOrStart(sid)) === 'attach'
    const tmuxName = sid ? tmuxSessionName(sid) : `m-${spec.tabId}${NO_TAB_NAME_IS_ANOTHERS_PREFIX}`
    const pkg = d.machinePackage()
    const tabDir = tabPackageDir(d.userData, spec.tabId)
    return {
      attach,
      tmuxName,
      spawnCwd: os.homedir(),
      shell: POSIX_SHELL_FOR_REMOTE_LAUNCH_LINE,
      resized: this.resized,
      launchCommand: () => {
        writeTabPackage(tabDir, {
          tabId: spec.tabId,
          tmuxName,
          machineName: pkg.name,
          cwd: this.bare(spec.cwd),
          banner: '',
          env: spec.env,
          portOffset: spec.portOffset,
          program: attach ? { ...spec.program, files: {} } : spec.program
        })
        return this.tabLaunchLine(pkg, tabDir, spec.tabId, attach ? 'attach' : 'start')
      }
    }
  }

  async launch(spec: ClaudeLaunch): Promise<ClaudeLaunchPlan> {
    const d = this.deps.claude
    await this.sshReady()
    await this.reachOrThrow()
    const settings = d.settings()
    const agentTools = d.agentTools()
    const sid = spec.resumeSessionId ?? crypto.randomUUID()
    const args = machineClaudeArgs(spec, sid, settings.skipPermissions)
    if (!args.ok) return args
    const tmuxName = tmuxSessionName(sid)
    const mode = await this.attachOrStart(sid)
    // CC§2
    const root = d.realPath(this.bare(spec.root))
    const cwd = spec.cwd ? this.bare(spec.cwd) : root
    const wsRoot = spec.fallbackCwd ? d.realPath(this.bare(spec.fallbackCwd)) : root
    const worktree = spec.worktree ?? worktreeNameAround(cwd)
    const pkg = d.machinePackage()
    const machineDir = remoteMachineDir(pkg.name)
    const pickKey = mode === 'start' ? `launch-${sid}` : undefined
    const account = pickKey ? await d.pickAccount(pickKey, spec.resumeSessionId) : undefined
    // ADR-0030
    if (pickKey && !account) throw new Error(d.noAccountMessage())
    // CC§9
    const model = spec.model && account?.env.ANTHROPIC_MODEL ? args.args.indexOf('--model') : -1
    const claudeArgs = args.args.filter((_, i) => model < 0 || (i !== model && i !== model + 1))
    return {
      ok: true,
      spawnCwd: os.homedir(),
      cwd: spec.root,
      conductor: !!spec.conductor,
      shell: POSIX_SHELL_FOR_REMOTE_LAUNCH_LINE,
      launchCommand: (tabId) => {
        const tabDir = tabPackageDir(d.userData, tabId)
        writeTabPackage(
          tabDir,
          claudeTabSpec(
            {
              tabId,
              tmuxName,
              machineName: pkg.name,
              cwd,
              fallbackCwd: wsRoot !== cwd ? wsRoot : undefined,
              banner: account?.banner ?? '',
              env: account?.env,
              portOffset: worktree ? portOffset(worktree) : undefined,
              ownerWords: spec.ownerWords
            },
            {
              settings: d.hookSettings(tabId, machineDir, agentTools),
              agentPlugin: agentTools,
              claudeArgs
            }
          )
        )
        return this.tabLaunchLine(pkg, tabDir, tabId, mode)
      },
      resized: this.resized,
      machine: {
        tracking: {
          host: this.machine,
          projectsRoot: mirrorProjectsRoot(d.userData, this.machine),
          tmuxName
        },
        cwd,
        root,
        hookMirror: mirrorHookDir(d.userData, this.machine),
        attachTo: mode === 'attach' ? sid : undefined,
        pickKey
      }
    }
  }
}
