import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import fs from 'fs'
import path from 'path'
import type { GitFileStatus, GitStatusMap, GitNumstatMap } from '@shared/types'

const execFile = promisify(execFileCb)

export const GIT_TIMEOUT_MS = Number(process.env.KOLOFT_GIT_TIMEOUT_MS) || 30_000

export interface GitRunner {
  id: string
  git(
    args: string[],
    opts: { maxBuffer?: number; timeout: number }
  ): Promise<{ stdout: string; stderr: string }>
  toplevelStillValid?(absRoot: string, toplevel: string): Promise<boolean>
  resolveBase?(absRoot: string): Promise<string | null>
}

const wasKilled = (e: unknown): boolean => (e as { killed?: boolean }).killed === true

interface Slot {
  run: Promise<unknown>
  trailing: Promise<unknown> | null
}

const slots = new Map<string, Slot>()

function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const again = (): Promise<T> => {
    slots.delete(key)
    return coalesce(key, fn)
  }
  const slot = slots.get(key)
  if (slot) return (slot.trailing ??= slot.run.then(again, again)) as Promise<T>
  const fresh: Slot = {
    trailing: null,
    run: fn().finally(() => {
      if (!fresh.trailing) slots.delete(key)
    })
  }
  slots.set(key, fresh)
  return fresh.run as Promise<T>
}

function classify(xy: string): GitFileStatus {
  const x = xy[0]
  const y = xy[1]
  if (xy === '??') return 'untracked'
  if (x === 'U' || y === 'U' || xy === 'AA' || xy === 'DD') return 'conflict'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'A' || y === 'A') return 'added'
  return 'modified'
}

function classifyDiff(code: string): GitFileStatus {
  if (code === 'A') return 'added'
  if (code === 'D') return 'deleted'
  if (code === 'U') return 'conflict'
  return 'modified'
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.promises.access(p)
    return true
  } catch {
    return false
  }
}

async function nearestGitHolder(dir: string): Promise<string | null> {
  for (let d = dir; ;) {
    if (await exists(path.join(d, '.git'))) return d
    const parent = path.dirname(d)
    if (parent === d) return null
    d = parent
  }
}

async function stillToplevelOf(absRoot: string, toplevel: string): Promise<boolean> {
  if (!(await exists(absRoot))) return false
  const holder = await nearestGitHolder(absRoot)
  if (holder === null) return false
  if (holder === toplevel) return true
  // PLATFORM§30
  try {
    return (await fs.promises.realpath(holder)) === toplevel
  } catch {
    return false
  }
}

export function sanitizeBase(b: unknown): string | undefined {
  return typeof b === 'string' && /^(HEAD|[0-9a-f]{4,64})$/.test(b) ? b : undefined
}

function parsePorcelainInto(out: GitStatusMap, stdout: string, toplevel: string): void {
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]
    if (tok.length < 4) continue
    const xy = tok.slice(0, 2)
    const rel = tok.slice(3)
    if (xy[0] === 'R' || xy[0] === 'C') i++
    out[path.join(toplevel, rel)] = classify(xy)
  }
}

function parseNameStatusInto(out: GitStatusMap, stdout: string, toplevel: string): void {
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i]
    if (!code) continue
    if (code[0] === 'R' || code[0] === 'C') {
      const dst = tokens[i + 2]
      if (dst) out[path.join(toplevel, dst)] = 'renamed'
      i += 2
    } else {
      const rel = tokens[i + 1]
      if (rel) out[path.join(toplevel, rel)] = classifyDiff(code[0])
      i += 1
    }
  }
}

const NUMSTAT_RECORD_PATH_MAY_HOLD_NEWLINE = /^(-|\d+)\t(-|\d+)\t([\s\S]*)$/

function parseNumstatInto(out: GitNumstatMap, stdout: string, toplevel: string): void {
  const tokens = stdout.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const m = NUMSTAT_RECORD_PATH_MAY_HOLD_NEWLINE.exec(tokens[i])
    if (!m) continue
    let rel = m[3]
    if (rel === '') {
      rel = tokens[i + 2] ?? ''
      i += 2
    }
    if (!rel || m[1] === '-') continue
    const key = path.join(toplevel, rel)
    const prev = out[key]
    const added = parseInt(m[1], 10)
    const removed = parseInt(m[2], 10)
    out[key] = prev
      ? { added: prev.added + added, removed: prev.removed + removed }
      : { added, removed }
  }
}

export interface DiffResult {
  text: string
  truncated: boolean
}

function partialOf(e: unknown): DiffResult | null {
  const partial = (e as { stdout?: string }).stdout
  if (typeof partial === 'string' && partial) return { text: partial, truncated: true }
  if (wasKilled(e)) throw e
  return null
}

const FULL_CONTEXT = 1_000_000_000

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export type GitDiffResult = DiffResult & { notRepo: boolean; toplevel: string | null }

export interface GitOps {
  defaultBranch(absRoot: string, opts?: { timeoutMs?: number }): Promise<string | null>
  diffBase(absRoot: string): Promise<string | null>
  gitStatus(absRoot: string, base?: string): Promise<GitStatusMap>
  gitNumstat(absRoot: string, base?: string): Promise<GitNumstatMap>
  gitDiff(absRoot: string, base?: string): Promise<GitDiffResult>
  gitFileDiff(absPath: string, base?: string, untracked?: boolean): Promise<DiffResult>
  gitFileDiffFull(absPath: string, base?: string, untracked?: boolean): Promise<DiffResult>
}

export function gitOps(runner: GitRunner): GitOps {
  const git = (
    args: string[],
    opts?: { maxBuffer?: number; timeout?: number }
  ): Promise<{ stdout: string; stderr: string }> =>
    runner.git(args, { ...opts, timeout: opts?.timeout ?? GIT_TIMEOUT_MS })

  const gitOut = async (
    args: string[],
    opts?: { maxBuffer?: number; timeout?: number }
  ): Promise<string | null> => {
    try {
      return (await git(args, opts)).stdout
    } catch (e) {
      if (wasKilled(e)) throw e
      return null
    }
  }

  const gated =
    <A extends (string | boolean | undefined)[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      coalesce([runner.id, name, ...args].join('\0'), () => fn(...args))

  const toplevelCache = new Map<string, string>()

  async function resolveToplevel(absRoot: string): Promise<string | null> {
    const hit = toplevelCache.get(absRoot)
    if (hit !== undefined) {
      if (!runner.toplevelStillValid || (await runner.toplevelStillValid(absRoot, hit))) return hit
      toplevelCache.delete(absRoot)
    }
    const top = (await gitOut(['-C', absRoot, 'rev-parse', '--show-toplevel']))?.trim()
    if (top) toplevelCache.set(absRoot, top)
    return top || null
  }

  async function defaultBranch(
    absRoot: string,
    { timeoutMs }: { timeoutMs?: number } = {}
  ): Promise<string | null> {
    const opts = { timeout: timeoutMs }
    const refExists = async (ref: string): Promise<boolean> =>
      (await gitOut(['-C', absRoot, 'rev-parse', '--verify', '--quiet', ref], opts)) !== null
    const ref = (
      await gitOut(['-C', absRoot, 'symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], opts)
    )?.trim()
    if (ref) {
      const short = ref.replace(/^refs\/remotes\//, '')
      if (await refExists(short)) return short
    }
    for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
      if (await refExists(ref)) return ref
    }
    return null
  }

  async function resolveBase(absRoot: string): Promise<string | null> {
    const def = await defaultBranch(absRoot)
    if (def) {
      const mb = (await gitOut(['-C', absRoot, 'merge-base', 'HEAD', def]))?.trim()
      if (mb) return mb
    }
    const head = await gitOut(['-C', absRoot, 'rev-parse', '--verify', '--quiet', 'HEAD'])
    return head === null ? null : 'HEAD'
  }

  const diffBase = gated('base', runner.resolveBase ?? resolveBase)

  async function statusOf(absRoot: string, baseIn?: string): Promise<GitStatusMap> {
    const cap = { maxBuffer: 32 * 1024 * 1024 }
    const [toplevel, base] = await Promise.all([
      resolveToplevel(absRoot),
      baseIn === undefined ? diffBase(absRoot) : Promise.resolve(baseIn)
    ])
    if (!toplevel) return {}
    const out: GitStatusMap = {}
    const [trackedOut, othersOut, unmergedOut] = await Promise.all([
      base ? gitOut(['-C', absRoot, 'diff', '--name-status', '-z', base, '--'], cap) : null,
      gitOut(
        ['-C', toplevel, 'ls-files', '--others', '--exclude-standard', '-z', '--full-name'],
        cap
      ),
      gitOut(['-C', toplevel, 'ls-files', '-u', '-z', '--full-name'], cap)
    ])
    if (trackedOut !== null) parseNameStatusInto(out, trackedOut, toplevel)
    if (othersOut !== null) {
      for (const rel of othersOut.split('\0')) {
        if (rel) out[path.join(toplevel, rel)] = 'untracked'
      }
    }
    if (trackedOut === null) {
      const porcelain = await gitOut(['-C', absRoot, 'status', '--porcelain=v1', '-z'], cap)
      if (porcelain !== null) parsePorcelainInto(out, porcelain, toplevel)
    }
    if (unmergedOut !== null) {
      for (const rec of unmergedOut.split('\0')) {
        const tab = rec.indexOf('\t')
        if (tab < 0) continue
        out[path.join(toplevel, rec.slice(tab + 1))] = 'conflict'
      }
    }
    return out
  }

  async function numstatOf(absRoot: string, baseIn?: string): Promise<GitNumstatMap> {
    const cap = { maxBuffer: 64 * 1024 * 1024 }
    const [toplevel, base] = await Promise.all([
      resolveToplevel(absRoot),
      baseIn === undefined ? diffBase(absRoot) : Promise.resolve(baseIn)
    ])
    if (!toplevel) return {}
    const out: GitNumstatMap = {}
    if (base) {
      const vsBase = await gitOut(['-C', absRoot, 'diff', base, '--numstat', '-z', '--'], cap)
      if (vsBase !== null) {
        parseNumstatInto(out, vsBase, toplevel)
        return out
      }
    }
    const [cached, unstaged] = await Promise.all([
      gitOut(['-C', absRoot, 'diff', '--cached', '--numstat', '-z', '--'], cap),
      gitOut(['-C', absRoot, 'diff', '--numstat', '-z', '--'], cap)
    ])
    if (cached !== null && unstaged !== null) {
      parseNumstatInto(out, cached, toplevel)
      parseNumstatInto(out, unstaged, toplevel)
    }
    return out
  }

  async function aggregateDiff(absRoot: string, base: string | null): Promise<DiffResult> {
    const cap = { maxBuffer: 64 * 1024 * 1024 }
    if (base) {
      try {
        const { stdout } = await git(['-C', absRoot, 'diff', base, '--'], cap)
        return { text: stdout, truncated: false }
      } catch (e) {
        const partial = partialOf(e)
        if (partial) return partial
      }
    }
    try {
      const [cached, unstaged] = await Promise.all([
        git(['-C', absRoot, 'diff', '--cached', '--'], cap),
        git(['-C', absRoot, 'diff', '--'], cap)
      ])
      return { text: cached.stdout + unstaged.stdout, truncated: false }
    } catch (e2) {
      return partialOf(e2) ?? { text: '', truncated: false }
    }
  }

  async function diffOf(absRoot: string, baseIn?: string): Promise<GitDiffResult> {
    const [toplevel, base] = await Promise.all([
      resolveToplevel(absRoot),
      baseIn === undefined ? diffBase(absRoot) : baseIn
    ])
    if (!toplevel) return { text: '', truncated: false, notRepo: true, toplevel }
    return { ...(await aggregateDiff(absRoot, base)), notRepo: false, toplevel }
  }

  async function isTracked(toplevel: string, absPath: string): Promise<boolean> {
    return (await gitOut(['-C', toplevel, 'ls-files', '--error-unmatch', '--', absPath])) !== null
  }

  async function isIgnored(toplevel: string, absPath: string): Promise<boolean> {
    return (await gitOut(['-C', toplevel, 'check-ignore', '-q', '--', absPath])) !== null
  }

  async function renameSourceOf(
    toplevel: string,
    base: string,
    absPath: string
  ): Promise<string | null> {
    const stdout = await gitOut(['-C', toplevel, 'diff', '--name-status', '-z', base, '--'], {
      maxBuffer: 32 * 1024 * 1024
    })
    if (stdout === null) return null
    const tokens = stdout.split('\0')
    for (let i = 0; i < tokens.length; i++) {
      const code = tokens[i]
      if (!code) continue
      if (code[0] === 'R' || code[0] === 'C') {
        const src = tokens[i + 1]
        const dst = tokens[i + 2]
        if (dst && src && path.join(toplevel, dst) === absPath) return path.join(toplevel, src)
        i += 2
      } else {
        i += 1
      }
    }
    return null
  }

  async function noIndexDiff(
    toplevel: string,
    absPath: string,
    ctx: string[],
    cap: { maxBuffer: number }
  ): Promise<DiffResult> {
    const rel = path.relative(toplevel, absPath)
    try {
      const { stdout } = await git(
        ['-C', toplevel, 'diff', ...ctx, '--no-index', '--', '/dev/null', rel || absPath],
        cap
      )
      return { text: stdout, truncated: false }
    } catch (e) {
      const cut =
        (e as { code?: string }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || wasKilled(e)
      return { text: partialOf(e)?.text ?? '', truncated: cut }
    }
  }

  async function fileDiff(
    absPath: string,
    context?: number,
    baseIn?: string,
    untracked = false
  ): Promise<DiffResult> {
    const cap = { maxBuffer: 64 * 1024 * 1024 }
    const ctx = context === undefined ? [] : [`-U${context}`]
    const dir = path.dirname(absPath)
    const [toplevel, base] = await Promise.all([
      resolveToplevel(dir),
      untracked || baseIn !== undefined ? Promise.resolve(baseIn) : diffBase(dir)
    ])
    if (!toplevel) return { text: '', truncated: false }
    if (untracked) return noIndexDiff(toplevel, absPath, ctx, cap)
    if (base) {
      try {
        const { stdout } = await git(['-C', toplevel, 'diff', ...ctx, base, '--', absPath], cap)
        if (stdout) {
          if (/^new file mode /m.test(stdout)) {
            const src = await renameSourceOf(toplevel, base, absPath)
            if (src) {
              try {
                const paired = await git(
                  ['-C', toplevel, 'diff', ...ctx, base, '--', src, absPath],
                  cap
                )
                if (paired.stdout) return { text: paired.stdout, truncated: false }
              } catch (e) {
                const partial = partialOf(e)
                if (partial) return partial
              }
            }
          }
          return { text: stdout, truncated: false }
        }
      } catch (e) {
        const partial = partialOf(e)
        if (partial) return partial
        if ((e as { code?: unknown }).code === 128) {
          const own = await diffBase(toplevel)
          if (own && own !== base) return fileDiff(absPath, context, own)
        }
      }
    } else if (context !== undefined) {
      try {
        const { stdout } = await git(
          ['-C', toplevel, 'diff', ...ctx, EMPTY_TREE, '--', absPath],
          cap
        )
        if (stdout) return { text: stdout, truncated: false }
      } catch (e) {
        const partial = partialOf(e)
        if (partial) return partial
      }
    } else {
      try {
        const [cached, unstaged] = await Promise.all([
          git(['-C', toplevel, 'diff', ...ctx, '--cached', '--', absPath], cap),
          git(['-C', toplevel, 'diff', ...ctx, '--', absPath], cap)
        ])
        const combined = cached.stdout + unstaged.stdout
        if (combined) return { text: combined, truncated: false }
      } catch (e) {
        const partial = partialOf(e)
        if (partial) return partial
      }
    }
    if (await isTracked(toplevel, absPath)) return { text: '', truncated: false }
    if (await isIgnored(toplevel, absPath)) return { text: '', truncated: false }
    return noIndexDiff(toplevel, absPath, ctx, cap)
  }

  return {
    defaultBranch,
    diffBase,
    gitStatus: gated('status', statusOf),
    gitNumstat: gated('numstat', numstatOf),
    gitDiff: gated('diff', diffOf),
    gitFileDiff: gated('file', (absPath: string, base?: string, untracked?: boolean) =>
      fileDiff(absPath, undefined, base, untracked === true)
    ),
    gitFileDiffFull: gated('full', (absPath: string, base?: string, untracked?: boolean) =>
      fileDiff(absPath, FULL_CONTEXT, base, untracked === true)
    )
  }
}

const localGit = gitOps({
  id: 'local',
  git: (args, opts) =>
    execFile('git', args, {
      ...opts,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
    }),
  toplevelStillValid: stillToplevelOf
})

export const {
  defaultBranch,
  diffBase,
  gitStatus,
  gitNumstat,
  gitDiff,
  gitFileDiff,
  gitFileDiffFull
} = localGit
