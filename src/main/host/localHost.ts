import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
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
import { LocalRunner, networkGit } from '../gitFreshness'
import { GIT_STEP_TIMEOUT_MS, type GitRunResult } from '../gitSteps'
import { resolveSpawnCwd } from '../projectInfo'
import { leaveForOS, osOpenFallback } from '../osOpen'
import { claudeArgv } from '../claudeArgs'
import {
  acceptClaudeTrust,
  claudeJsonPath,
  claudeTrustsFolder,
  markClaudeOnboarded
} from '../claudeTrust'
import { dirExistsSync, worktreeNameAround } from '../resumePlan'
import { portOffset } from '@shared/worktreeName'
import { listSkills, type SkillFs } from '../skillList'
import { AGENT_PROMPT_FILE } from '../agentPlugin'
import { saidFile, seedHandedOverOwnerWords, writeAllowFile, writeConductorMarker } from '../hooks'
import type { ClaudeLaunch, ClaudeLaunchPlan, Host } from './host'

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

const GIT_CALL_TIMEOUT_MS = 5000
export function localGitOut(
  cwd: string,
  args: string[],
  timeoutMs = GIT_CALL_TIMEOUT_MS
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { timeout: timeoutMs }, (err, stdout) =>
      resolve(err ? null : stdout)
    )
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

export interface LocalClaudeDeps {
  hookRegDir(): string
  agentPlugin(): string | undefined
  assistOf(cwd: string, resumeKey?: string): { role: string; allow: string[] } | undefined
}

async function launchClaude(d: LocalClaudeDeps, spec: ClaudeLaunch): Promise<ClaudeLaunchPlan> {
  const args = claudeArgv(process.env.KOLOFT_CLAUDE_CMD || 'claude', {
    resumeSessionId: spec.resumeSessionId,
    worktree: spec.worktree,
    model: spec.model,
    effort: spec.effort,
    permission: spec.permission
  })
  if (!args.ok) return args
  try {
    markClaudeOnboarded(claudeJsonPath())
  } catch (err) {
    console.error('[koloft] could not mark Claude onboarding done', err)
  }
  const cwd = resolveSpawnCwd(spec.cwd ?? spec.root)
  const launchCommand = `exec ${args.argv.join(' ')}`
  const worktree = spec.worktree ?? worktreeNameAround(cwd)
  // ADR-0029
  const assist = d.assistOf(cwd, spec.resumeSessionId)
  const conductor = !!spec.conductor || !!assist
  const role = spec.role ?? assist?.role
  const agentPlugin = d.agentPlugin()
  return {
    ok: true,
    spawnCwd: cwd,
    cwd,
    conductor,
    launchCommand: (tabId) => {
      const regDir = d.hookRegDir()
      if (role) writeConductorMarker(regDir, tabId, role)
      if (spec.ownerWords) seedHandedOverOwnerWords(saidFile(regDir, tabId), spec.ownerWords)
      if (conductor) writeAllowFile(regDir, tabId, spec.allow ?? assist?.allow ?? [])
      return launchCommand
    },
    extraEnv: {
      // CC§9
      ...(spec.firstPrompt !== undefined || spec.name
        ? { KOLOFT_FIRST_PROMPT: spec.firstPrompt ?? '', KOLOFT_SESSION_NAME: spec.name ?? '' }
        : {}),
      ...(worktree ? { KOLOFT_PORT_OFFSET: String(portOffset(worktree)) } : {}),
      ...(agentPlugin
        ? {
            KOLOFT_AGENT_PLUGIN: agentPlugin,
            KOLOFT_AGENT_PROMPT: conductor ? undefined : path.join(agentPlugin, AGENT_PROMPT_FILE)
          }
        : {})
    }
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

export function localHost(github: GithubLookup, claude: LocalClaudeDeps): Host {
  return {
    listDir,
    dirExists,
    dirExistsOrThrow: dirExists,
    makeDir: (dir) =>
      fs.promises.mkdir(dir).then(
        () => true,
        () => false
      ),
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
    launch: (spec) => launchClaude(claude, spec),
    trustFolder,
    trustsFolder: async (dir) => claudeTrustsFolder(claudeJsonPath(), dir),
    listSkills: async (root) => listSkills(skillFs, root, os.homedir()),
    keyed: (p) => p,
    gitOut: localGitOut,
    gitRun: localGitRun,
    reveal: (p) => void leaveForOS(p, 'reveal'),
    osOpen: osOpenFallback,
    github,
    freshness: new LocalRunner()
  }
}
