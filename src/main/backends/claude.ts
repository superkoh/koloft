import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
  BackendAvailability,
  CreateTabOptions,
  CreateTabResult,
  ResumePlan,
  SessionInfo,
  SessionResumeRequest,
  SessionResumeResult,
  SessionRow
} from '@shared/types'
import type { SessionEvent } from '@shared/sessionEvent'
import { identityOf } from '@shared/sessionBackend'
import { formatRemoteKey, parseRemoteKey, type RemoteKey } from '@shared/remoteKey'
import { isValidWorktreeName } from '@shared/worktreeName'
import type { SessionBackend } from '../sessionBackends'
import type { PtyManager } from '../ptyManager'
import type { SessionTracker } from '../sessionTracker'
import type { WorkspaceManager } from '../workspaces'
import type { Hosts } from '../host/hosts'
import { publicClaudeSession } from '../host/hosts'
import type { SshHost } from '../host/sshHost'
import type { RemoteSync } from '../remote/sync'
import { launchMode } from '../remote/sync'
import { ensureControlDir, sshOptions } from '../remote/ssh'
import {
  accountEnv,
  launchLine,
  sessionIdOfTmux,
  tmuxSessionName,
  writeTabPackage,
  type MachinePackage
} from '../remote/launch'
import {
  dq,
  mirrorHookDir,
  mirrorProjectsRoot,
  REMOTE_HOOK_DIR,
  remoteMachineDir,
  tabPackageDir
} from '../remote/paths'
import { hookSettings } from '../hooks'
import type { StatusLineSetting } from '../statusline'
import { loadSettings } from '../settings'
import { keychainRead } from '../accounts'
import type { PickResponse } from '../accountPicker'
import { claudeArgv } from '../claudeArgs'
import { acceptClaudeTrust } from '../claudeTrust'
import { probeClaude } from '../claudeProbe'
import { runningClaudePid } from '../claudeSessionRegistry'
import { resolveSpawnCwd } from '../projectInfo'
import {
  dirExistsSync,
  gitProbes,
  occupantName,
  planResume,
  worktreeHomeRoot,
  type GitOut,
  type ResumeProbes
} from '../resumePlan'

export interface ClaudeBackendDeps {
  pty: PtyManager
  tracker: SessionTracker
  hosts: Hosts<SshHost>
  workspaces(): WorkspaceManager | null
  remoteSync(): RemoteSync | null
  machinePackage(): MachinePackage
  remoteControlDir: string
  userData(): string
  setupLine(): string | undefined
  ptysChanged(): void
  pickForLaunch(): Promise<{ res: PickResponse; endpoint?: { baseUrl?: string; model?: string } }>
  git: GitOut
  resumeProbes: ResumeProbes
  dropStatusLog(regDir: string, tabId: string): void
}

const GIT_REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,120}$/
const SESSION_ID_RE = /^[a-zA-Z0-9-]+$/
export const POSIX_SHELL_FOR_REMOTE_LAUNCH_LINE = '/bin/zsh'

function claudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json')
}

// ADR-0026
function trustBeforeWorktreeLaunch(root: string): void {
  try {
    acceptClaudeTrust(claudeJsonPath(), root)
  } catch (err) {
    console.error('[koloft] could not record Claude trust for', root, err)
  }
}

async function rebuildWorktree(
  spec: {
    worktreePath: string
    branch: string
    baseRef: string
  },
  git: GitOut
): Promise<boolean> {
  const root = worktreeHomeRoot(spec.worktreePath)
  if (!root) return false
  const branchLives =
    (await git(root, ['rev-parse', '--verify', 'refs/heads/' + spec.branch])) !== null
  // PLATFORM§30
  const args = branchLives
    ? ['worktree', 'add', spec.worktreePath, spec.branch]
    : ['worktree', 'add', '-b', spec.branch, spec.worktreePath, spec.baseRef]
  return (await git(root, args)) !== null
}

export class ClaudeBackend implements SessionBackend {
  readonly id = 'claude'
  readonly killedRemoteSessions = new Set<string>()
  private remoteKills = new Map<string, Promise<unknown>>()

  constructor(private d: ClaudeBackendDeps) {}

  async availability(): Promise<BackendAvailability> {
    const { found } = await probeClaude()
    return { id: 'claude', available: found, reason: found ? undefined : 'Not installed' }
  }

  list(): SessionInfo[] {
    return this.d.tracker.list().map(publicClaudeSession)
  }

  async historyRows(workspacePath: string): Promise<SessionRow[]> {
    return (this.d.workspaces()?.historyRows(workspacePath) ?? []).filter(
      (r) => identityOf(r.id).backendId === 'claude'
    )
  }

  hasTab(tabId: string): boolean {
    return (
      this.d.pty.get(tabId)?.kind === 'claude' ||
      this.d.tracker.list().some((s) => s.tabId === tabId)
    )
  }

  aliveTabFor(key: string): string | undefined {
    return this.d.tracker.aliveTabFor(key) ?? undefined
  }

  observe(tabId: string, event: SessionEvent): void {
    this.d.tracker.receive(tabId, event)
  }

  archive(key: string): boolean {
    return this.d.workspaces()?.archiveSession(key) ?? false
  }

  transcriptExists(key: string): boolean {
    return this.d.tracker.transcriptExists(key)
  }

  stop(tabId: string, how: { detach?: boolean } = {}): void {
    const remote = this.d.tracker.remoteOf(tabId)
    if (remote) {
      if (!how.detach) this.endRemoteTmux(remote.host, remote.tmuxName)
      fs.rmSync(tabPackageDir(this.d.userData(), tabId), { recursive: true, force: true })
    }
    this.d.pty.kill(tabId)
    this.d.tracker.untrack(tabId)
  }

  endRemoteTmux(machine: string, tmuxName: string): void {
    const kill = this.d.hosts
      .machine(machine)
      .endTmuxSession(tmuxName)
      .then(() => {
        if (this.remoteKills.get(tmuxName) === kill) this.remoteKills.delete(tmuxName)
        this.d.remoteSync()?.pokeNow(machine)
      })
    this.remoteKills.set(tmuxName, kill)
    const killedId = sessionIdOfTmux(tmuxName)
    if (killedId) this.killedRemoteSessions.add(killedId)
  }

  async create(opts: CreateTabOptions): Promise<CreateTabResult> {
    const key =
      (typeof opts.cwd === 'string' ? parseRemoteKey(opts.cwd) : null) ??
      this.remoteKeyOfSession(opts.resumeSessionId)
    if (key) {
      return this.createRemoteTab(key, {
        resumeSessionId: opts.resumeSessionId,
        cols: opts.cols,
        rows: opts.rows,
        worktree: opts.worktree
      })
    }
    const cwd = resolveSpawnCwd(opts.cwd)
    if (opts.worktree && !opts.scheduled && cwd === opts.cwd) trustBeforeWorktreeLaunch(cwd)
    return this.createLocalTab({ ...opts, cwd })
  }

  async resume(req: SessionResumeRequest): Promise<SessionResumeResult> {
    const sid = req?.sessionId
    const machineKey = typeof req?.cwd === 'string' ? parseRemoteKey(req.cwd) : null
    const cwd = machineKey ? machineKey.path : req?.cwd
    if (
      typeof sid !== 'string' ||
      !SESSION_ID_RE.test(sid) ||
      typeof cwd !== 'string' ||
      !path.isAbsolute(cwd)
    ) {
      return { ok: false, code: 'invalid-args' }
    }
    const remoteKey = machineKey ?? this.remoteKeyOfSession(sid)
    if (remoteKey) return this.resumeRemote(remoteKey, { ...req, cwd })
    const mode = req.mode ?? 'direct'
    let worktree: string | undefined
    if (mode === 'renamed') {
      if (typeof req.worktree !== 'string' || !isValidWorktreeName(req.worktree)) {
        return { ok: false, code: 'invalid-args' }
      }
      worktree = req.worktree
    }
    if (mode === 'rebuild') {
      const plan = await this.localResumePlan(sid)
      if (plan.action === 'direct') {
        const r = this.createLocalTab({
          cwd: plan.cwd,
          resumeSessionId: sid,
          cols: req.cols,
          rows: req.rows
        })
        return r.ok ? { ok: true, id: r.id, cwd: r.cwd } : { ok: false, code: r.code }
      }
      if (
        plan.action !== 'rebuild' ||
        !GIT_REF_RE.test(plan.branch) ||
        !GIT_REF_RE.test(plan.baseRef)
      ) {
        return { ok: false, code: 'rebuild-failed' }
      }
      if (!(await rebuildWorktree(plan, this.d.git))) return { ok: false, code: 'rebuild-failed' }
    }
    let spawnCwd = cwd
    if (mode === 'main' && !dirExistsSync(spawnCwd)) {
      const wt = this.d.workspaces()?.findRow(sid)?.worktreeState?.worktreePath
      const root = wt ? worktreeHomeRoot(wt) : null
      if (root && dirExistsSync(root)) spawnCwd = root
    }
    if (!dirExistsSync(spawnCwd)) return { ok: false, code: 'cwd-missing' }
    const r = this.createLocalTab({
      cwd: spawnCwd,
      resumeSessionId: sid,
      cols: req.cols,
      rows: req.rows,
      worktree
    })
    return r.ok ? { ok: true, id: r.id, cwd: r.cwd } : { ok: false, code: r.code }
  }

  resumePlan(key: string): Promise<ResumePlan> {
    const machine = this.remoteKeyOfSession(key)?.host
    return machine ? this.remoteResumePlan(machine, key) : this.localResumePlan(key)
  }

  private async localResumePlan(sessionId: string): Promise<ResumePlan> {
    if (await runningClaudePid(sessionId)) return { action: 'unavailable', reason: 'running' }
    const workspaces = this.d.workspaces()
    return planResume(
      workspaces?.findRow(sessionId),
      this.d.resumeProbes,
      workspaces?.bucketDirOf(sessionId)
    )
  }

  private async remoteResumePlan(machine: string, sessionId: string): Promise<ResumePlan> {
    const row = this.d.workspaces()?.findRow(sessionId)
    if (!row) return { action: 'unavailable', reason: 'not-found' }
    if (!row.worktreeState) return { action: 'direct', cwd: row.cwd }
    return planResume(
      row,
      this.machineResumeProbes(machine),
      this.d.workspaces()?.bucketDirOf(sessionId)
    )
  }

  private machineGit(machine: string): GitOut {
    return (dir, args) => this.d.hosts.machine(machine).gitOut(formatRemoteKey(machine, dir), args)
  }

  private machineOccupantOf(machine: string, dir: string): string | null {
    for (const s of this.d.tracker.list()) {
      if (!s.alive || s.remote?.host !== machine) continue
      if (s.cwd === dir) return occupantName(s)
      const bound = s.sessionId
        ? this.d.workspaces()?.findRow(s.sessionId)?.worktreeState
        : undefined
      if (bound?.worktreePath === dir) return occupantName(s)
    }
    return null
  }

  private machineResumeProbes(machine: string): ResumeProbes {
    return {
      dirExists: (p) => this.d.hosts.machine(machine).dirExists(formatRemoteKey(machine, p)),
      occupantOf: (dir) => this.machineOccupantOf(machine, dir),
      ...gitProbes(this.machineGit(machine))
    }
  }

  private remoteKeyOfSession(sessionId?: string): RemoteKey | null {
    if (!sessionId) return null
    for (const t of this.d.tracker.list()) {
      const remote = this.d.tracker.remoteOf(t.tabId)
      if (remote && t.sessionId === sessionId) return { host: remote.host, path: t.cwd }
    }
    const wsPath = this.d.workspaces()?.workspaceOf(sessionId)
    return wsPath ? parseRemoteKey(wsPath) : null
  }

  private async resumeRemote(
    key: RemoteKey,
    req: SessionResumeRequest
  ): Promise<SessionResumeResult> {
    const mode = req.mode ?? 'direct'
    let worktree: string | undefined
    let resumeCwd = req.cwd
    if (mode === 'renamed') {
      if (typeof req.worktree !== 'string' || !isValidWorktreeName(req.worktree)) {
        return { ok: false, code: 'invalid-args' }
      }
      worktree = req.worktree
    }
    if (mode === 'rebuild') {
      const plan = await this.remoteResumePlan(key.host, req.sessionId)
      if (plan.action === 'direct') resumeCwd = plan.cwd
      else if (
        plan.action !== 'rebuild' ||
        !GIT_REF_RE.test(plan.branch) ||
        !GIT_REF_RE.test(plan.baseRef) ||
        !(await rebuildWorktree(plan, this.machineGit(key.host)))
      ) {
        return { ok: false, code: 'rebuild-failed' }
      }
    }
    const r = await this.createRemoteTab(key, {
      resumeSessionId: req.sessionId,
      cols: req.cols,
      rows: req.rows,
      worktree,
      resumeCwd
    })
    return r.ok ? { ok: true, id: r.id, cwd: r.cwd } : { ok: false, code: r.code }
  }

  private createLocalTab(
    spec: Omit<CreateTabOptions, 'kind' | 'cwd'> & { cwd: string }
  ): CreateTabResult {
    const { cwd, resumeSessionId, worktree } = spec
    const base = process.env.KOLOFT_CLAUDE_CMD || 'claude'
    const args = claudeArgv(base, {
      resumeSessionId,
      worktree,
      model: spec.model,
      effort: spec.effort,
      permission: spec.permission
    })
    if (!args.ok) return args
    const launchCommand = `exec ${args.argv.join(' ')}`
    const handle = this.d.pty.create({
      kind: 'claude',
      cwd,
      cols: spec.cols,
      rows: spec.rows,
      setupCommand: this.d.setupLine(),
      launchCommand,
      resumeSessionId,
      // CC§9
      extraEnv:
        spec.firstPrompt !== undefined
          ? { KOLOFT_FIRST_PROMPT: spec.firstPrompt, KOLOFT_SESSION_NAME: spec.name ?? '' }
          : undefined
    })
    const workspaces = this.d.workspaces()
    if (!resumeSessionId || !workspaces?.isMember(resumeSessionId)) {
      workspaces?.launchStarted(handle.id, cwd, worktree)
    }
    this.d.ptysChanged()
    return { ok: true, id: handle.id, cwd }
  }

  private async createRemoteTab(
    key: RemoteKey,
    opts: {
      resumeSessionId?: string
      cols?: number
      rows?: number
      worktree?: string
      resumeCwd?: string
    }
  ): Promise<CreateTabResult> {
    const { tracker } = this.d
    const workspaces = this.d.workspaces()
    const remoteSync = this.d.remoteSync()
    const pkg = this.d.machinePackage()
    ensureControlDir(this.d.remoteControlDir)
    const settings = loadSettings()
    const sid = opts.resumeSessionId ?? crypto.randomUUID()
    const args = claudeArgv('claude', {
      resumeSessionId: opts.resumeSessionId,
      sessionId: opts.resumeSessionId ? undefined : sid,
      worktree: opts.worktree,
      permission: settings.skipPermissions ? 'bypass' : undefined
    })
    if (!args.ok) return args
    const claudeArgs = args.argv.slice(1)
    const tmuxName = tmuxSessionName(sid)
    const mode = launchMode({
      alive: remoteSync?.alive(key.host) ?? new Set(),
      killed: this.killedRemoteSessions,
      sessionId: sid
    })
    this.killedRemoteSessions.delete(sid)
    // CC§2
    const root = workspaces?.realRemotePath(key) ?? key.path
    const cwd = opts.resumeCwd || (opts.resumeSessionId && workspaces?.findRow(sid)?.cwd) || root
    const wsKey = parseRemoteKey(workspaces?.workspaceOf(sid) ?? '')
    const wsRoot = wsKey ? (workspaces?.realRemotePath(wsKey) ?? wsKey.path) : root

    let env: Record<string, string> | undefined
    let picked: string | undefined
    let banner = "[Koloft] using this machine's own claude login"
    if (mode === 'start' && settings.multiAccount) {
      const { res, endpoint } = await this.d.pickForLaunch()
      if (res.account) {
        const secret = await keychainRead(res.kind, res.account)
        if (secret) {
          env = accountEnv(res.kind, res.account, secret, endpoint)
          picked = res.account
          banner = res.warning ? `${res.banner}\n${res.warning}` : res.banner
        }
      }
    }

    const remoteStatusLine: StatusLineSetting | undefined = settings.statuslineBuiltin
      ? {
          type: 'command',
          command: dq(`${remoteMachineDir(pkg.name)}/statusline/run.sh`),
          padding: 0
        }
      : undefined
    const userData = this.d.userData()
    await this.remoteKills.get(tmuxName)
    const handle = this.d.pty.create({
      kind: 'claude',
      cwd: os.homedir(),
      cols: opts.cols,
      rows: opts.rows,
      setupCommand: this.d.setupLine(),
      launchCommand: (tabId) => {
        const mirror = mirrorHookDir(userData, key.host)
        fs.rmSync(path.join(mirror, `${tabId}.json`), { force: true })
        this.d.dropStatusLog(mirror, tabId)
        const tabDir = tabPackageDir(userData, tabId)
        writeTabPackage(tabDir, {
          tabId,
          tmuxName,
          machineName: pkg.name,
          cwd,
          fallbackCwd: wsRoot !== cwd ? wsRoot : undefined,
          banner,
          env,
          settings: hookSettings(
            `${remoteMachineDir(pkg.name)}/hook.sh`,
            REMOTE_HOOK_DIR,
            tabId,
            remoteStatusLine,
            dq
          ),
          claudeArgs
        })
        return launchLine({
          host: key.host,
          sshOptions: sshOptions(this.d.remoteControlDir, false),
          machine: pkg,
          tabDir,
          tabId,
          mode
        })
      },
      resumeSessionId: opts.resumeSessionId,
      shell: POSIX_SHELL_FOR_REMOTE_LAUNCH_LINE
    })

    tracker.track(handle.id, cwd, {
      host: key.host,
      projectsRoot: mirrorProjectsRoot(userData, key.host),
      tmuxName
    })
    if (picked) tracker.setPickedAccount(handle.id, picked)
    if (mode === 'attach') {
      tracker.bindSession(handle.id, '', sid, cwd)
      workspaces?.onSessionBound(sid)
    } else if (!opts.resumeSessionId) {
      workspaces?.launchStarted(handle.id, root, opts.worktree, key.host)
    }
    this.d.ptysChanged()
    remoteSync?.pokeNow(key.host)
    return { ok: true, id: handle.id, cwd: formatRemoteKey(key.host, key.path) }
  }
}
