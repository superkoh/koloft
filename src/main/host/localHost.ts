import { execFile } from 'child_process'
import fs from 'fs'
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
import type { GithubLookup } from '../github'
import { resolveSpawnCwd } from '../projectInfo'
import { leaveForOS, osOpenFallback } from '../osOpen'
import { claudeArgv } from '../claudeArgs'
import { acceptClaudeTrust, claudeJsonPath, claudeTrustsFolder } from '../claudeTrust'
import type { ClaudeLaunch, ClaudeLaunchPlan, Host } from './host'

const GIT_CALL_TIMEOUT_MS = 5000
export function localGitOut(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: GIT_CALL_TIMEOUT_MS }, (err, stdout) =>
      resolve(err ? null : stdout)
    )
  })
}

async function launchClaude(spec: ClaudeLaunch): Promise<ClaudeLaunchPlan> {
  const args = claudeArgv(process.env.KOLOFT_CLAUDE_CMD || 'claude', {
    resumeSessionId: spec.resumeSessionId,
    worktree: spec.worktree,
    model: spec.model,
    effort: spec.effort,
    permission: spec.permission
  })
  if (!args.ok) return args
  const cwd = resolveSpawnCwd(spec.cwd ?? spec.root)
  const launchCommand = `exec ${args.argv.join(' ')}`
  return {
    ok: true,
    spawnCwd: cwd,
    cwd,
    launchCommand: () => launchCommand,
    // CC§9
    extraEnv:
      spec.firstPrompt !== undefined
        ? { KOLOFT_FIRST_PROMPT: spec.firstPrompt, KOLOFT_SESSION_NAME: spec.name ?? '' }
        : undefined
  }
}

// ADR-0026
async function trustFolder(dir: string): Promise<void> {
  if (!fs.existsSync(dir)) return
  try {
    acceptClaudeTrust(claudeJsonPath(), dir)
  } catch (err) {
    console.error('[koloft] could not record Claude trust for', dir, err)
  }
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

export function localHost(github: GithubLookup): Host {
  return {
    listDir,
    dirExists,
    search,
    searchContent,
    diffBase,
    gitStatus,
    gitNumstat,
    gitDiff,
    gitFileDiff,
    gitFileDiffFull,
    readText,
    openForEdit: async (p) => openForEdit(p),
    writeText: async (p, text, expect, opts) => writeText(p, text, expect, opts),
    createFile: async (dir, name) => createFile(dir, name),
    watchDir,
    unwatchDir,
    watchFile: (p, onChange) =>
      watchFile(p, (fp, st) => onChange(fp, { mtimeMs: st.mtimeMs, size: st.size })),
    unwatchFile,
    shell: (cwd) => {
      const spawnCwd = resolveSpawnCwd(cwd)
      return { spawnCwd, cwd: spawnCwd }
    },
    launch: launchClaude,
    trustFolder,
    trustsFolder: async (dir) => claudeTrustsFolder(claudeJsonPath(), dir),
    keyed: (p) => p,
    gitOut: localGitOut,
    reveal: (p) => void leaveForOS(p, 'reveal'),
    osOpen: osOpenFallback,
    github
  }
}
