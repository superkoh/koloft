import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import { dirExists, listDir, search, searchContent } from '../fileTree'
import { watchFile, unwatchFile, watchDir, unwatchDir } from '../fileWatch'
import { MAX_READ_BYTES, createFile, looksBinary, openForEdit, writeText } from '../fileEdit'
import {
  diffBase,
  gitStatus,
  gitNumstat,
  gitDiff,
  gitFileDiff,
  gitFileDiffFull
} from '../gitStatus'
import type { GithubRepos } from '../githubRepos'
import { LocalRunner, networkGit } from '../gitFreshness'
import { GIT_STEP_TIMEOUT_MS, readHead, type GitRunResult } from '../gitSteps'
import { coalesce } from '@core/coalesce'
import { resolveSpawnCwd } from '../projectInfo'
import { leaveForOS, osOpenFallback } from '../osOpen'
import { dirExistsSync } from '../resumePlan'
import { listSkills, type SkillFs } from '../skillList'
import type { Host } from './host'
import type { BackendId } from '@shared/types'

const skillFs: SkillFs = {
  readdir: (p) => fs.readdirSync(p),
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  isDir: dirExistsSync,
  isFile: (p) => {
    try {
      return fs.statSync(p).isFile()
    } catch {
      return false
    }
  }
}

export const GIT_CALL_TIMEOUT_MS = 5000
export function localGitOut(
  cwd: string,
  args: string[],
  timeoutMs = GIT_CALL_TIMEOUT_MS,
  onFailure?: (stderr: string) => void
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err) onFailure?.(String(stderr))
      resolve(err ? null : stdout)
    })
  })
}

const GIT_DID_NOT_START = 127
const GIT_FAILED = 1
const networkStepsRunning = new Set<number>()

export function localGitRun(cwd: string, args: string[], network = false): Promise<GitRunResult> {
  if (network) {
    return networkGit('git', cwd, args, GIT_STEP_TIMEOUT_MS, networkStepsRunning).then((r) => ({
      code: r.ok ? 0 : r.timedOut ? null : r.enoent ? GIT_DID_NOT_START : GIT_FAILED,
      stdout: r.stdout,
      stderr: r.stderr
    }))
  }
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { timeout: GIT_STEP_TIMEOUT_MS },
      (err, stdout, stderr) => {
        const code = err?.code
        resolve({
          code: !err ? 0 : err.killed ? null : typeof code === 'number' ? code : GIT_DID_NOT_START,
          stdout: String(stdout),
          stderr: String(stderr)
        })
      }
    )
  })
}

export interface LocalHostDeps {
  moreSkillFoldersEveryAccountReads(backend: BackendId): readonly string[]
}

async function readText(p: string): Promise<string> {
  const st = await fs.promises.stat(p).catch(() => {
    throw new Error('KOLOFT_READ_FAILED')
  })
  if (!st.isFile()) throw new Error('KOLOFT_NOT_FILE')
  if (st.size > MAX_READ_BYTES) throw new Error('KOLOFT_TOO_LARGE')
  const buf = await fs.promises.readFile(p).catch(() => {
    throw new Error('KOLOFT_READ_FAILED')
  })
  if (looksBinary(buf)) throw new Error('KOLOFT_BINARY')
  return buf.toString('utf8')
}

export function localHost(github: GithubRepos, deps: LocalHostDeps): Host {
  return {
    listDir,
    dirExists,
    dirExistsOrThrow: dirExists,
    fileExists: (file) =>
      fs.promises.stat(file).then(
        (st) => st.isFile(),
        () => false
      ),
    makeDir: (dir) =>
      fs.promises.mkdir(dir).then(
        () => true,
        () => false
      ),
    search,
    searchContent,
    gitChanges: async (root, choice) => {
      const base = choice === 'head' ? 'HEAD' : await diffBase(root).catch(() => null)
      const arg = base ?? undefined
      const [status, numstat, exists, head] = await Promise.all([
        gitStatus(root, arg),
        gitNumstat(root, arg),
        dirExists(root),
        coalesce(['local', 'head', root].join('\0'), () =>
          readHead((args) => localGitRun(root, args))
        )
      ])
      return { base, head, status, numstat, missing: !exists }
    },
    gitDiff,
    gitFileDiff,
    gitFileDiffFull,
    readText,
    readBytes: (p) => fs.promises.readFile(p),
    openForEdit: (p) => openForEdit(p),
    writeText: (p, text, expect, opts) => writeText(p, text, expect, opts),
    createFile,
    watchDir,
    unwatchDir,
    watchFile: (p, onChange) =>
      watchFile(p, (fp, st) => onChange(fp, { mtimeMs: st.mtimeMs, size: st.size })),
    unwatchFile,
    shell: (cwd) => {
      const spawnCwd = resolveSpawnCwd(cwd)
      return { spawnCwd, cwd: spawnCwd }
    },
    listSkills: async (root, backend) =>
      listSkills(skillFs, backend, {
        workspace: root,
        home: os.homedir(),
        moreInTheHome: deps.moreSkillFoldersEveryAccountReads(backend)
      }),
    keyed: (p) => p,
    gitOut: localGitOut,
    gitRun: localGitRun,
    reveal: (p) => void leaveForOS(p, 'reveal'),
    osOpen: osOpenFallback,
    github,
    freshness: new LocalRunner()
  }
}
