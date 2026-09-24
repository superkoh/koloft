import fs from 'fs'
import os from 'os'
import path from 'path'
import type {
  BackendAvailability,
  BackendSessionInfo,
  CreateTabOptions,
  CreateTabResult,
  ResumePlan,
  SessionResumeRequest,
  SessionResumeResult,
  SessionRow
} from '@shared/types'
import type { SessionEvent } from '@shared/sessionEvent'
import { identityOf } from '@shared/sessionBackend'
import { formatRemoteKey, hostOf, isAbsoluteOnHost } from '@shared/remoteKey'
import { isValidWorktreeName } from '@shared/worktreeName'
import type { SessionBackend } from '../sessionBackends'
import type { PtyManager } from '../ptyManager'
import type { SessionTracker } from '../sessionTracker'
import type { WorkspaceManager } from '../workspaces'
import type { Hosts } from '../host/hosts'
import { publicClaudeSession } from '../host/hosts'
import type { MachineAccount, SshHost } from '../host/sshHost'
import type { ClaudeLaunch, Host } from '../host/host'
import type { RemoteSync } from '../remote/sync'
import { accountEnv, tmuxSessionName } from '../remote/launch'
import { dq, mirrorHookDir, REMOTE_HOOK_DIR, tabPackageDir } from '../remote/paths'
import { hookSettings } from '../hooks'
import type { StatusLineSetting } from '../statusline'
import { loadSettings } from '../settings'
import { keychainRead, listAccounts } from '../accounts'
import type { PickResponse } from '../accountPicker'
import { SESSION_ID_RE } from '../claudeArgs'
import { probeClaude } from '../claudeProbe'
import { runningClaudePid } from '../claudeSessionRegistry'
import { rootsWithClaude } from '../claudeLiveness'
import { readAppendedLines, sessionEventFromHook } from '../sessionTracker'
import { makeDropDedupe, ownsHookReport, type HookReport } from '../hookRouting'
import { registeredByTabRoot } from '../shim'
import { watchJsonDrops } from '../jsonDrops'
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
  userData(): string
  setupLine(): string | undefined
  ptysChanged(): void
  resumeProbes: ResumeProbes
  events(tabId: string, event: SessionEvent): void
}

const GIT_REF_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]{0,120}$/

// PLATFORM§28
const STATUS_LOG_POLL_MS = 2000
// CC§1
const SESSION_END_SETTLE_MS = 800
// CC§1
const EVICTING_END_REASONS = new Set(['prompt_input_exit', 'logout'])
const REMOTE_EXIT_WAIT_MS = 10_000
const REMOTE_EXIT_POLL_MS = 500
const REMOTE_EXIT_SLACK_MS = 30_000
const LIVENESS_SWEEP_MS = 2500
const MISSED_SWEEPS_BEFORE_UNTRACK = 2
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
  private hookRegDir = ''
  private statusLogCursors = new Map<string, { offset: number; tail: Buffer }>()
  private statusLogDraining = new Map<string, boolean>()
  private processedRegIds = new Set<string>()
  private watchedHookMirrors = new Map<string, () => void>()

  constructor(private d: ClaudeBackendDeps) {}

  async availability(): Promise<BackendAvailability> {
    const { found } = await probeClaude()
    return { id: 'claude', available: found, reason: found ? undefined : 'Not installed' }
  }

  list(): BackendSessionInfo[] {
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

  occupantOf(dir: string): string | null {
    const target = path.resolve(dir)
    for (const s of this.d.tracker.list()) {
      if (!s.alive || s.remote) continue
      if (s.treeRoot && path.resolve(s.treeRoot) === target) return occupantName(s)
      // CC§4
      const bound = s.sessionId
        ? this.d.workspaces()?.findRow(s.sessionId)?.worktreeState
        : undefined
      if (bound && path.resolve(bound.worktreePath) === target) return occupantName(s)
    }
    return null
  }

  accountUsable(): boolean {
    if (!loadSettings().multiAccount) return true
    return listAccounts().some((a) => a.kind !== 'codex-home' && a.enabled && a.status === 'ok')
  }

  trustsFolder(dir: string): Promise<boolean> {
    return this.d.hosts.of(dir).trustsFolder(dir)
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
    void this.d.hosts
      .machine(machine)
      .endTmuxSession(tmuxName)
      .then(() => this.d.remoteSync()?.pokeNow(machine))
  }

  sessionIdOf(tabId: string): string | undefined {
    return this.d.tracker.list().find((s) => s.tabId === tabId)?.sessionId
  }

  private titleOf(tabId: string): string | undefined {
    return this.d.tracker.list().find((s) => s.tabId === tabId)?.title
  }

  watchShimRegistrations(regDir: string): void {
    watchJsonDrops(regDir, () => (raw) => this.handleRegistration(raw))
  }

  private handleRegistration(raw: unknown): void {
    const obj = raw as {
      tabId?: string
      regId?: string
      sessionId?: string
      cwd?: string
      ts?: number
      mode?: string
      pid?: number
    }
    if (!obj.tabId || !obj.regId) return
    if (this.processedRegIds.has(obj.regId)) return
    if (!this.d.pty.get(obj.tabId)) return
    if (!registeredByTabRoot(obj.pid, this.d.pty.pidOf(obj.tabId))) return
    this.processedRegIds.add(obj.regId)
    const cwd = obj.cwd && obj.cwd.length ? obj.cwd : os.homedir()
    this.d.tracker.track(obj.tabId, cwd)
  }

  watchLocalHooks(regDir: string): void {
    this.hookRegDir = regDir
    this.watchHookRegistrations(regDir)
    // CC§1
    if (process.platform !== 'win32') this.startLivenessSweep()
  }

  onPtyExit(tabId: string): void {
    const remote = this.d.tracker.remoteOf(tabId)
    if (!remote) {
      // CC§1
      this.drainExitRegistration(this.hookRegDir, tabId)
      this.dropStatusLog(this.hookRegDir, tabId)
      return
    }
    const sid = this.sessionIdOf(tabId)
    const title = this.titleOf(tabId)
    this.d.tracker.untrack(tabId)
    const userData = this.d.userData()
    fs.rmSync(tabPackageDir(userData, tabId), { recursive: true, force: true })
    void this.drainRemoteExit(remote.host, mirrorHookDir(userData, remote.host), tabId, sid, title)
  }

  private startLivenessSweep(): void {
    const goneStrikes = new Map<string, number>()
    let sweeping = false
    const sweepLiveness = async (): Promise<void> => {
      if (sweeping) return
      sweeping = true
      try {
        const pidByTab = new Map<string, number>()
        for (const s of this.d.tracker.list()) {
          if (!s.alive || !s.jsonlPath || s.remote) continue
          const pid = this.d.pty.pidOf(s.tabId)
          if (pid) pidByTab.set(s.tabId, pid)
        }
        for (const tabId of [...goneStrikes.keys()]) {
          if (!pidByTab.has(tabId)) goneStrikes.delete(tabId)
        }
        if (!pidByTab.size) return
        const alive = await rootsWithClaude([...pidByTab.values()])
        if (!alive) return
        for (const [tabId, pid] of pidByTab) {
          if (alive.has(pid)) {
            goneStrikes.delete(tabId)
            continue
          }
          const strikes = (goneStrikes.get(tabId) ?? 0) + 1
          if (strikes >= MISSED_SWEEPS_BEFORE_UNTRACK) {
            goneStrikes.delete(tabId)
            this.d.events(tabId, { type: 'exited', clean: false, title: this.titleOf(tabId) })
            this.d.tracker.untrack(tabId)
          } else {
            goneStrikes.set(tabId, strikes)
          }
        }
      } finally {
        sweeping = false
      }
    }
    setInterval(() => void sweepLiveness(), LIVENESS_SWEEP_MS).unref()
  }

  private watchHookRegistrations(dir: string, mirror = false): () => void {
    const isNews = mirror ? makeDropDedupe() : null
    const drops = watchJsonDrops(dir, () => (obj, full) => {
      if (isNews && !isNews(full, JSON.stringify(obj))) return
      this.handleHookRegistration(obj)
    })
    const logs = this.watchStatusLogs(dir)
    return () => {
      drops?.close()
      logs()
    }
  }

  private watchStatusLogs(dir: string): () => void {
    let watcher: fs.FSWatcher | null = null
    try {
      watcher = fs.watch(dir, (_event, filename) => {
        const name = filename?.toString()
        if (!name || !name.endsWith('.status.jsonl')) return
        void this.drainStatusLog(path.join(dir, name))
      })
    } catch {}
    const poll = setInterval(() => {
      let names: string[]
      try {
        names = fs.readdirSync(dir)
      } catch {
        return
      }
      for (const name of names) {
        if (name.endsWith('.status.jsonl')) void this.drainStatusLog(path.join(dir, name))
      }
    }, STATUS_LOG_POLL_MS)
    return () => {
      watcher?.close()
      clearInterval(poll)
    }
  }

  private dropStatusLog(regDir: string, tabId: string): void {
    const full = path.join(regDir, `${tabId}.status.jsonl`)
    this.statusLogCursors.delete(full)
    this.statusLogDraining.delete(full)
    fs.rm(full, { force: true }, () => {})
  }

  private async drainStatusLog(full: string): Promise<void> {
    if (this.statusLogDraining.get(full)) return
    this.statusLogDraining.set(full, true)
    try {
      let again = true
      while (again) {
        again = false
        let size: number
        try {
          size = (await fs.promises.stat(full)).size
        } catch {
          return
        }
        let cur = this.statusLogCursors.get(full)
        if (!cur) {
          cur = { offset: 0, tail: Buffer.alloc(0) }
          this.statusLogCursors.set(full, cur)
        }
        if (size < cur.offset) {
          cur.offset = 0
          cur.tail = Buffer.alloc(0)
        }
        if (size <= cur.offset) return
        const lines = await readAppendedLines(full, size, cur)
        if (!lines) return
        for (const line of lines) {
          if (!line) continue
          try {
            this.handleStatusRegistration(JSON.parse(line))
          } catch {}
        }
        again = true
      }
    } finally {
      this.statusLogDraining.set(full, false)
    }
  }

  private liveTabFor(report: { tabId?: string; tmux?: string }): string | undefined {
    const { pty, tracker } = this.d
    if (report.tabId && pty.get(report.tabId)) return report.tabId
    if (!report.tmux) return undefined
    for (const s of tracker.list()) {
      if (s.alive && tracker.remoteOf(s.tabId)?.tmuxName === report.tmux && pty.get(s.tabId)) {
        return s.tabId
      }
    }
    return undefined
  }

  private handleStatusRegistration(raw: unknown): void {
    const obj = raw as HookReport & {
      tabId?: string
      message?: string
      bgl?: string
      wake?: number
    }
    obj.tabId = this.liveTabFor(obj)
    if (!obj.tabId) return
    // CC§5
    if (!ownsHookReport(obj, this.sessionIdOf(obj.tabId))) return
    // CC§8
    if (typeof obj.wake === 'number') this.d.tracker.setWakeupPending(obj.tabId, obj.wake === 1)
    const event = sessionEventFromHook(obj.event, obj.message, obj.bgl)
    if (event) this.d.events(obj.tabId, event)
  }

  // CC§1
  private untrackIfClaudeGone(tabId: string): void {
    if (this.d.tracker.remoteOf(tabId)) return
    setTimeout(async () => {
      const pid = this.d.pty.pidOf(tabId)
      if (!pid) return
      if (!this.d.tracker.list().some((s) => s.tabId === tabId && s.jsonlPath)) return
      const alive = await rootsWithClaude([pid])
      if (!alive) return
      if (!alive.has(pid)) this.d.tracker.untrack(tabId)
    }, SESSION_END_SETTLE_MS)
  }

  private remoteSessionGone(host: string, sessionId: string): boolean {
    const remoteSync = this.d.remoteSync()
    return !!remoteSync?.connected(host) && !remoteSync.alive(host).has(sessionId)
  }

  noticeRemoteExits(host: string, sessionIds: string[]): void {
    const { tracker } = this.d
    for (const s of tracker.list()) {
      if (!s.alive || !sessionIds.includes(s.sessionId)) continue
      if (tracker.remoteOf(s.tabId)?.host !== host) continue
      const { tabId, sessionId } = s
      setTimeout(() => {
        const still = tracker
          .list()
          .some((t) => t.tabId === tabId && t.alive && t.sessionId === sessionId)
        if (!still || !this.remoteSessionGone(host, sessionId)) return
        this.d.events(tabId, { type: 'exited', clean: false, title: this.titleOf(tabId) })
        tracker.untrack(tabId)
      }, REMOTE_EXIT_WAIT_MS).unref()
    }
  }

  private async drainRemoteExit(
    host: string,
    mirrorDir: string,
    tabId: string,
    sid?: string,
    title?: string
  ): Promise<void> {
    // PLATFORM§34
    const since = Date.now() - REMOTE_EXIT_SLACK_MS
    const thisExit = (): { name: string; raw: { event?: string; reason?: string } } | undefined => {
      let names: string[] = []
      try {
        names = fs.readdirSync(mirrorDir)
      } catch {
        return undefined
      }
      for (const name of names) {
        if (!name.endsWith('.json')) continue
        const full = path.join(mirrorDir, name)
        try {
          if (fs.statSync(full).mtimeMs < since) continue
          const text = fs.readFileSync(full, 'utf8')
          if (!sid || !text.includes(`"${sid}"`)) continue
          const raw = JSON.parse(text) as { event?: string; reason?: string }
          if (raw.event === 'end') return { name, raw }
        } catch {}
      }
      return undefined
    }
    this.d.remoteSync()?.pokeNow(host)
    const deadline = Date.now() + REMOTE_EXIT_WAIT_MS
    let hit = thisExit()
    while (!hit && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, REMOTE_EXIT_POLL_MS))
      hit = thisExit()
    }
    if (hit && EVICTING_END_REASONS.has(hit.raw.reason ?? '')) {
      const stillBound = !!sid && this.d.tracker.list().some((t) => t.alive && t.sessionId === sid)
      if (sid && !stillBound) this.d.workspaces()?.dropOwnership(sid)
    }
    if (!hit && sid && this.remoteSessionGone(host, sid))
      this.d.events(tabId, { type: 'exited', clean: false, title })
    for (const name of new Set([`${tabId}.json`, hit?.name ?? ''])) {
      if (name) fs.rmSync(path.join(mirrorDir, name), { force: true })
    }
    this.dropStatusLog(mirrorDir, tabId)
  }

  private drainExitRegistration(regDir: string, tabId: string): void {
    let raw: { event?: string; reason?: string }
    try {
      raw = JSON.parse(fs.readFileSync(path.join(regDir, `${tabId}.json`), 'utf8'))
    } catch {
      return
    }
    if (raw.event === 'end' && EVICTING_END_REASONS.has(raw.reason ?? '')) {
      this.handleHookRegistration(raw)
    }
  }

  private handleHookRegistration(raw: unknown): void {
    const { tracker } = this.d
    const workspaces = this.d.workspaces()
    const obj = raw as HookReport & {
      tabId?: string
      transcriptPath?: string
      cwd?: string
      reason?: string
      account?: string
      ccVersion?: string
    }
    obj.tabId = this.liveTabFor(obj)
    if (!obj.tabId) return
    // CC§5
    if (!ownsHookReport(obj, this.sessionIdOf(obj.tabId))) return
    if (obj.event === 'end') {
      this.d.events(obj.tabId, { type: 'exited', clean: true })
      if (EVICTING_END_REASONS.has(obj.reason ?? '')) {
        const sid = this.sessionIdOf(obj.tabId)
        tracker.untrack(obj.tabId)
        const stillBound = !!sid && tracker.list().some((s) => s.alive && s.sessionId === sid)
        if (sid && !stillBound) workspaces?.dropOwnership(sid)
      } else {
        // CC§1
        this.untrackIfClaudeGone(obj.tabId)
      }
      return
    }
    if (obj.cwd) workspaces?.onSessionStart(obj.tabId, obj.cwd)
    const prevId = this.sessionIdOf(obj.tabId)
    tracker.bindSession(
      obj.tabId,
      obj.transcriptPath || '',
      obj.sessionId || '',
      obj.cwd || '',
      obj.account || '',
      obj.ccVersion || '',
      obj.source || ''
    )
    this.d.pty.clearResumeIntent(obj.tabId)
    const nextId = this.sessionIdOf(obj.tabId)
    if (prevId && nextId && nextId !== prevId) {
      if (tracker.remoteOf(obj.tabId)) tracker.setRemoteTmuxName(obj.tabId, tmuxSessionName(nextId))
      workspaces?.onSessionRebind(prevId, nextId, obj.source || '')
      if (obj.source === 'clear') {
        workspaces?.dropOwnership(prevId)
      }
    }
    if (nextId) workspaces?.onSessionBound(nextId)
    if (nextId) this.d.events(obj.tabId, { type: 'bound', key: nextId })
  }

  watchRemoteHookMirrors(): void {
    const userData = this.d.userData()
    const wanted = new Set(
      (this.d.workspaces()?.remoteTargets() ?? []).map((t) => mirrorHookDir(userData, t.host))
    )
    for (const [dir, dispose] of this.watchedHookMirrors) {
      if (wanted.has(dir)) continue
      dispose()
      this.watchedHookMirrors.delete(dir)
    }
    for (const dir of wanted) {
      if (this.watchedHookMirrors.has(dir)) continue
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch {}
      this.watchedHookMirrors.set(dir, this.watchHookRegistrations(dir, true))
    }
  }

  async create(opts: CreateTabOptions): Promise<CreateTabResult> {
    const asked = typeof opts.cwd === 'string' ? opts.cwd : ''
    const root = hostOf(asked) === 'ssh' ? asked : (this.homeOf(opts.resumeSessionId) ?? asked)
    const host = this.d.hosts.of(root)
    if (opts.worktree && !opts.scheduled && !opts.resumeSessionId) await host.trustFolder(root)
    return this.createTab(host, {
      root,
      resumeSessionId: opts.resumeSessionId,
      worktree: opts.worktree,
      model: opts.model,
      effort: opts.effort,
      permission: opts.permission,
      firstPrompt: opts.firstPrompt,
      name: opts.name,
      cols: opts.cols,
      rows: opts.rows
    })
  }

  async resume(req: SessionResumeRequest): Promise<SessionResumeResult> {
    const sid = req?.sessionId
    const asked = req?.cwd
    if (
      typeof sid !== 'string' ||
      !SESSION_ID_RE.test(sid) ||
      typeof asked !== 'string' ||
      !isAbsoluteOnHost(asked)
    ) {
      return { ok: false, code: 'invalid-args' }
    }
    const home = hostOf(asked) === 'ssh' ? asked : this.homeOf(sid)
    const host = this.d.hosts.of(home ?? asked)
    let cwd = host.keyed(asked)
    const mode = req.mode ?? 'direct'
    let worktree: string | undefined
    if (mode === 'renamed') {
      if (typeof req.worktree !== 'string' || !isValidWorktreeName(req.worktree)) {
        return { ok: false, code: 'invalid-args' }
      }
      worktree = req.worktree
    }
    if (mode === 'rebuild') {
      const plan = home ? await this.machineResumePlan(host, sid) : await this.localResumePlan(sid)
      if (plan.action === 'direct') cwd = host.keyed(plan.cwd)
      else if (
        plan.action !== 'rebuild' ||
        !GIT_REF_RE.test(plan.branch) ||
        !GIT_REF_RE.test(plan.baseRef) ||
        !(await rebuildWorktree(plan, hostGit(host)))
      ) {
        return { ok: false, code: 'rebuild-failed' }
      }
    }
    if (!home) {
      if (mode === 'main' && !dirExistsSync(cwd)) {
        const wt = this.d.workspaces()?.findRow(sid)?.worktreeState?.worktreePath
        const root = wt ? worktreeHomeRoot(wt) : null
        if (root && dirExistsSync(root)) cwd = root
      }
      if (!dirExistsSync(cwd)) return { ok: false, code: 'cwd-missing' }
    }
    const r = await this.createTab(host, {
      root: home ?? cwd,
      cwd,
      resumeSessionId: sid,
      worktree,
      cols: req.cols,
      rows: req.rows
    })
    return r.ok ? { ok: true, id: r.id, cwd: r.cwd } : { ok: false, code: r.code }
  }

  resumePlan(key: string): Promise<ResumePlan> {
    const home = this.homeOf(key)
    return home ? this.machineResumePlan(this.d.hosts.of(home), key) : this.localResumePlan(key)
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

  private async machineResumePlan(host: Host, sessionId: string): Promise<ResumePlan> {
    const row = this.d.workspaces()?.findRow(sessionId)
    if (!row) return { action: 'unavailable', reason: 'not-found' }
    if (!row.worktreeState) return { action: 'direct', cwd: row.cwd }
    return planResume(
      row,
      {
        dirExists: (p) => host.dirExists(host.keyed(p)),
        occupantOf: (dir) => this.machineOccupantOf(host.keyed(dir)),
        ...gitProbes(hostGit(host))
      },
      this.d.workspaces()?.bucketDirOf(sessionId)
    )
  }

  private machineOccupantOf(dir: string): string | null {
    for (const s of this.d.tracker.list()) {
      if (!s.alive || !s.remote) continue
      const onMachine = (p: string): string => formatRemoteKey(s.remote!.host, p)
      if (onMachine(s.cwd) === dir) return occupantName(s)
      const bound = s.sessionId
        ? this.d.workspaces()?.findRow(s.sessionId)?.worktreeState
        : undefined
      if (bound && onMachine(bound.worktreePath) === dir) return occupantName(s)
    }
    return null
  }

  private homeOf(sessionId?: string): string | undefined {
    if (!sessionId) return undefined
    for (const t of this.d.tracker.list()) {
      const remote = this.d.tracker.remoteOf(t.tabId)
      if (remote && t.sessionId === sessionId) return formatRemoteKey(remote.host, t.cwd)
    }
    const ws = this.d.workspaces()?.workspaceOf(sessionId)
    return ws && hostOf(ws) === 'ssh' ? ws : undefined
  }

  private async createTab(
    host: Host,
    spec: ClaudeLaunch & { cols?: number; rows?: number }
  ): Promise<CreateTabResult> {
    const { tracker } = this.d
    const workspaces = this.d.workspaces()
    const ws = spec.resumeSessionId ? workspaces?.workspaceOf(spec.resumeSessionId) : undefined
    const plan = await host.launch({
      ...spec,
      fallbackCwd: ws && this.d.hosts.of(ws) === host ? ws : undefined
    })
    if (!plan.ok) return plan
    const machine = plan.machine
    const handle = this.d.pty.create({
      kind: 'claude',
      cwd: plan.spawnCwd,
      cols: spec.cols,
      rows: spec.rows,
      setupCommand: this.d.setupLine(),
      launchCommand: (tabId) => {
        if (machine) this.forgetHookReports(machine.hookMirror, tabId)
        return plan.launchCommand(tabId)
      },
      resumeSessionId: spec.resumeSessionId,
      shell: plan.shell,
      extraEnv: plan.extraEnv
    })
    if (machine) {
      tracker.track(handle.id, machine.cwd, machine.tracking)
      if (machine.picked) tracker.setPickedAccount(handle.id, machine.picked)
      if (machine.attachTo) {
        tracker.bindSession(handle.id, '', machine.attachTo, machine.cwd)
        workspaces?.onSessionBound(machine.attachTo)
      } else if (!spec.resumeSessionId) {
        workspaces?.launchStarted(handle.id, machine.root, spec.worktree, machine.tracking.host)
      }
      this.d.remoteSync()?.pokeNow(machine.tracking.host)
    } else if (!spec.resumeSessionId || !workspaces?.isMember(spec.resumeSessionId)) {
      workspaces?.launchStarted(handle.id, plan.cwd, spec.worktree)
    }
    this.d.ptysChanged()
    return { ok: true, id: handle.id, cwd: plan.cwd }
  }

  private forgetHookReports(dir: string, tabId: string): void {
    fs.rmSync(path.join(dir, `${tabId}.json`), { force: true })
    this.dropStatusLog(dir, tabId)
  }
}

function hostGit(host: Host): GitOut {
  return (dir, args) => host.gitOut(host.keyed(dir), args)
}

export async function pickMachineAccount(
  pick: () => Promise<{ res: PickResponse; endpoint?: { baseUrl?: string; model?: string } }>
): Promise<MachineAccount | undefined> {
  const { res, endpoint } = await pick()
  if (!res.account) return undefined
  const secret = await keychainRead(res.kind, res.account)
  if (!secret) return undefined
  return {
    env: accountEnv(res.kind, res.account, secret, endpoint),
    picked: res.account,
    banner: res.warning ? `${res.banner}\n${res.warning}` : res.banner
  }
}

export function machineHookSettings(
  tabId: string,
  machineDir: string,
  statusline: boolean
): Record<string, unknown> {
  const remoteStatusLine: StatusLineSetting | undefined = statusline
    ? { type: 'command', command: dq(`${machineDir}/statusline/run.sh`), padding: 0 }
    : undefined
  return hookSettings(`${machineDir}/hook.sh`, REMOTE_HOOK_DIR, tabId, remoteStatusLine, dq)
}
