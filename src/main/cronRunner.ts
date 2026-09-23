import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import { CRON_SAVE_MESSAGES } from '@shared/cronMessages'
import { slugOf, hasWordChar, isValidModelName, worktreeBase } from '@shared/cronNames'
import { isValidSchedule, parseHHMM } from '@shared/schedule'
import {
  isCronEffort,
  type CronEffort,
  type CronJob,
  type CronPermission,
  type CronRunNowResult,
  type CronSaveInput,
  type CronSaveResult,
  type CronState,
  type HistoryLine,
  type LiveRun,
  type Schedule,
  type SessionStatus
} from '@shared/types'
import {
  MISS_WINDOW_MS,
  TICK_MS,
  WAKE_DELAY_MS,
  seedLastDue,
  tick,
  type Due
} from './cronScheduler'

const MAX_WORKTREE_NAME = 64
const STAMP_LEN = 12
const MAX_HISTORY = 20

const PERMISSIONS: CronPermission[] = ['same', 'acceptEdits', 'skipAll']

function withSuffix(base: string, suffix: string): string {
  const over = base.length + suffix.length - MAX_WORKTREE_NAME
  if (over <= 0) return `${base}${suffix}`
  const stamp = base.slice(base.length - STAMP_LEN)
  const slug = base
    .slice(0, base.length - STAMP_LEN)
    .slice(0, -over)
    .replace(/-+$/g, '')
  return `${slug || 'job'}${stamp}${suffix}`
}

// CC§3
export async function worktreeNameFor(
  job: CronJob,
  dueAt: number,
  taken: (name: string) => Promise<boolean>
): Promise<string> {
  const base = worktreeBase(job, dueAt)
  if (!(await taken(base))) return base
  for (let i = 2; i <= 99; i++) {
    const name = withSuffix(base, `-${i}`)
    if (!(await taken(name))) return name
  }
  return withSuffix(base, `-${randomBytes(2).toString('hex')}`)
}

export type LaunchResult = { ok: true; tabId: string } | { ok: false }

export interface LaunchRequest {
  jobId: string
  cwd: string
  worktree?: string
  model?: string
  effort?: CronEffort
  permission: CronPermission
  // CC§9
  env: { KOLOFT_FIRST_PROMPT: string; KOLOFT_SESSION_NAME: string }
}

export interface RunnerDeps {
  now(): number
  bootTime: number
  store: {
    load(): { jobs: CronJob[]; notes: Record<string, string> }
    save(jobs: CronJob[]): void
  }
  dirExists(p: string): boolean
  isPinned(p: string): boolean
  gitDirExists(root: string): boolean
  worktreeDirExists(root: string, name: string): boolean
  branchExists(root: string, branch: string): Promise<boolean>
  countRunFolders(root: string, slug: string): number
  accountUsable(): boolean
  trusted(wsPath: string): boolean
  ready(): boolean
  launch(req: LaunchRequest): LaunchResult | Promise<LaunchResult>
  killTab(tabId: string): void
  toast(text: string): void
  notify(title: string, body: string): void
  push(state: CronState): void
  killed(tabId: string): void
  bindDeadlineMs: number
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
}

export { CRON_SAVE_MESSAGES }

function stripControl(s: string): string {
  return s.replace(/\p{Cc}/gu, '')
}

function scheduleErrors(s: unknown): string[] {
  const errs: string[] = []
  const o = (s ?? {}) as Record<string, unknown>
  if (o.kind === 'daily') {
    if (!isValidSchedule(s)) errs.push(CRON_SAVE_MESSAGES.time)
    return errs
  }
  if (o.kind === 'weekly') {
    const days = o.days
    if (!Array.isArray(days) || days.length === 0) errs.push(CRON_SAVE_MESSAGES.days)
    if (typeof o.at !== 'string' || parseHHMM(o.at) === null) errs.push(CRON_SAVE_MESSAGES.time)
    if (errs.length === 0 && !isValidSchedule(s)) errs.push(CRON_SAVE_MESSAGES.days)
    return errs
  }
  if (o.kind === 'every') {
    if (!isValidSchedule(s)) errs.push(CRON_SAVE_MESSAGES.every)
    return errs
  }
  errs.push(CRON_SAVE_MESSAGES.time)
  return errs
}

interface Clean {
  name: string
  task: string
  model?: string
  effort?: CronEffort
  permission: CronPermission
}

function clean(input: CronSaveInput): Clean {
  const name = stripControl(String(input.name ?? '')).trim()
  const task = String(input.task ?? '')
    .replace(/\0/g, '')
    .trim()
  const permission = PERMISSIONS.includes(input.permission) ? input.permission : 'same'
  const model = typeof input.model === 'string' ? input.model.trim() : undefined
  return {
    name,
    task,
    permission,
    ...(model ? { model } : {}),
    ...(isCronEffort(input.effort) ? { effort: input.effort } : {})
  }
}

function saveErrors(
  c: Clean,
  schedule: unknown,
  workspacePath: unknown,
  isPinned: (p: string) => boolean
): string[] {
  const errs: string[] = []
  if (
    typeof workspacePath !== 'string' ||
    !path.isAbsolute(workspacePath) ||
    !isPinned(workspacePath)
  ) {
    errs.push(CRON_SAVE_MESSAGES.workspace)
  }
  if (!c.name) errs.push(CRON_SAVE_MESSAGES.nameEmpty)
  else if (c.name.startsWith('-')) errs.push(CRON_SAVE_MESSAGES.nameDash)
  else if (!hasWordChar(c.name)) errs.push(CRON_SAVE_MESSAGES.nameNoWord)
  else if (c.name.length > 80) errs.push(CRON_SAVE_MESSAGES.nameLong)
  if (!c.task) errs.push(CRON_SAVE_MESSAGES.taskEmpty)
  else if (c.task.startsWith('-')) errs.push(CRON_SAVE_MESSAGES.taskDash)
  else if (c.task.length > 4096) errs.push(CRON_SAVE_MESSAGES.taskLong)
  errs.push(...scheduleErrors(schedule))
  if (c.model !== undefined && !isValidModelName(c.model)) errs.push(CRON_SAVE_MESSAGES.model)
  return errs
}

const MANUAL = { manual: true } as const

export class CronRunner {
  private readonly d: RunnerDeps
  private jobs: CronJob[]
  private notes: Record<string, string>
  private folders: Record<string, number> = {}
  private live = new Map<string, LiveRun>()
  private launching = new Set<string>()
  private held = new Map<string, Due[]>()
  private deadlines = new Map<string, ReturnType<typeof setTimeout>>()
  private lastDue = new Map<string, number>()
  private timer: ReturnType<typeof setInterval> | null = null
  private resumeAt = 0

  constructor(deps: RunnerDeps) {
    this.d = deps
    const loaded = deps.store.load()
    this.jobs = loaded.jobs
    this.notes = loaded.notes
    this.refreshFolders()
  }

  start(): void {
    this.lastDue = seedLastDue(this.jobs, this.d.bootTime)
    const t = this.d.setInterval(() => this.onTick(), TICK_MS)
    ;(t as unknown as { unref?: () => void }).unref?.()
    this.timer = t
  }

  stop(): void {
    if (this.timer !== null) this.d.clearInterval(this.timer)
    this.timer = null
    for (const t of this.deadlines.values()) this.d.clearTimeout(t)
    this.deadlines.clear()
  }

  onResume(): void {
    this.resumeAt = this.d.now()
  }

  private onTick(): void {
    const now = this.d.now()
    if (now < this.resumeAt + WAKE_DELAY_MS) return
    const r = tick(this.jobs, now, this.lastDue, this.d.bootTime)
    this.lastDue = r.lastDue
    this.writeMissed(r.missed)
    for (const f of r.fire) {
      const job = this.byId(f.jobId)
      if (job) void this.runDue(job, f.dueAt, false)
    }
  }

  private writeMissed(missed: Due[]): void {
    if (missed.length === 0) return
    const byJob = new Map<string, Due[]>()
    for (const m of missed) {
      const list = byJob.get(m.jobId)
      if (list) list.push(m)
      else byJob.set(m.jobId, [m])
    }
    let wrote = false
    for (const [jobId, dues] of byJob) {
      const job = this.byId(jobId)
      if (!job) continue
      const first = dues[0].dueAt
      const last = dues[dues.length - 1].dueAt
      const line: HistoryLine = { dueAt: first, state: 'missed' }
      if (dues.length > 1) {
        line.count = dues.length
        line.until = last
      }
      this.pushLine(job, line)
      wrote = true
    }
    if (!wrote) return
    this.d.store.save(this.jobs)
    this.push()
  }

  onRendererTeardown(): void {}

  onRendererReady(): void {
    if (this.held.size === 0) return
    const piles = [...this.held.values()]
    this.held.clear()
    const now = this.d.now()
    const stale: Due[] = []
    const start: { job: CronJob; dueAt: number }[] = []
    for (const dues of piles) {
      const job = this.byId(dues[0].jobId)
      if (!job) continue
      const newest = dues[dues.length - 1]
      if (now - newest.dueAt <= MISS_WINDOW_MS) {
        stale.push(...dues.slice(0, -1))
        start.push({ job, dueAt: newest.dueAt })
      } else {
        stale.push(...dues)
      }
    }
    this.writeMissed(stale)
    for (const s of start) void this.runDue(s.job, s.dueAt, false)
  }

  private async runDue(job: CronJob, dueAt: number, manual: boolean): Promise<CronRunNowResult> {
    if (this.launching.has(job.id)) return { ok: false, reason: 'skipped' }
    this.launching.add(job.id)
    const mark = manual ? MANUAL : {}
    try {
      const open = this.liveRunOf(job.id)
      if (open) {
        const newest = job.history[0]
        if (newest && newest.state === 'skipped' && newest.dueAt > open.dueAt) {
          newest.count = (newest.count ?? 1) + 1
          newest.until = dueAt
          if (manual) newest.manual = true
          this.d.store.save(this.jobs)
          this.push()
          if (manual) this.d.toast(`⏰ ${job.name} skipped: the last run is still open`)
        } else {
          this.writeHistory(job, { dueAt, state: 'skipped', count: 1, ...mark })
          this.d.toast(`⏰ ${job.name} skipped: the last run is still open`)
        }
        return { ok: false, reason: 'skipped' }
      }

      if (!this.d.dirExists(job.workspacePath)) {
        this.fail(job, dueAt, mark, 'the folder is missing')
        return { ok: false, reason: 'folder-missing' }
      }

      if (!this.d.accountUsable()) {
        this.fail(job, dueAt, mark, 'no usable account')
        return { ok: false, reason: 'no-account' }
      }

      if (!this.d.ready()) {
        if (!manual) {
          const pile = this.held.get(job.id)
          if (pile) pile.push({ jobId: job.id, dueAt })
          else this.held.set(job.id, [{ jobId: job.id, dueAt }])
        }
        return { ok: false, reason: 'not-ready' }
      }

      const git = this.d.gitDirExists(job.workspacePath)
      const worktree = git
        ? await worktreeNameFor(job, dueAt, (n) => this.taken(job.workspacePath, n))
        : undefined

      const res = await this.d.launch({
        jobId: job.id,
        cwd: job.workspacePath,
        worktree,
        model: job.model,
        effort: job.effort,
        permission: job.permission,
        env: { KOLOFT_FIRST_PROMPT: job.task, KOLOFT_SESSION_NAME: job.name }
      })
      if (!res.ok) {
        this.fail(job, dueAt, mark, 'Claude exited before it started')
        return { ok: false, reason: 'failed' }
      }
      const run: LiveRun = {
        jobId: job.id,
        tabId: res.tabId,
        state: 'launching',
        startedAt: this.d.now(),
        dueAt,
        ...(worktree ? { worktree } : {}),
        ...mark
      }
      this.live.set(res.tabId, run)
      this.d.toast(`⏰ ${job.name} started`)
      this.armDeadline(res.tabId)
      this.refreshFolders()
      this.push()
      return { ok: true }
    } finally {
      this.launching.delete(job.id)
    }
  }

  private async taken(root: string, name: string): Promise<boolean> {
    if (this.d.worktreeDirExists(root, name)) return true
    return this.d.branchExists(root, `worktree-${name}`)
  }

  private fail(job: CronJob, dueAt: number, mark: object, note: string): void {
    this.writeHistory(job, { dueAt, state: 'failed', note, ...mark })
    this.d.toast(`⏰ ${job.name} could not start: ${note}`)
  }

  private armDeadline(tabId: string): void {
    const t = this.d.setTimeout(() => {
      this.deadlines.delete(tabId)
      this.onDeadline(tabId)
    }, this.d.bindDeadlineMs)
    this.deadlines.set(tabId, t)
  }

  private clearDeadline(tabId: string): void {
    const t = this.deadlines.get(tabId)
    if (t === undefined) return
    this.d.clearTimeout(t)
    this.deadlines.delete(tabId)
  }

  private onDeadline(tabId: string): void {
    const run = this.live.get(tabId)
    if (!run || run.state !== 'launching') return
    this.d.killTab(tabId)
    this.d.killed(tabId)
    this.live.delete(tabId)
    this.refreshFolders()
    const job = this.byId(run.jobId)
    if (!job) {
      this.push()
      return
    }
    // CC§9
    const note = this.d.trusted(job.workspacePath)
      ? 'Claude did not start'
      : 'Claude did not start — this folder was never opened in Claude; start one session here first'
    this.writeHistory(job, {
      dueAt: run.dueAt,
      state: 'failed',
      note,
      ...(run.worktree ? { worktree: run.worktree } : {}),
      ...(run.manual ? MANUAL : {})
    })
    this.d.toast(`⏰ ${job.name} could not start: Claude did not start`)
    this.d.notify(job.name, 'Could not start — Claude did not start')
  }

  onBound(tabId: string, sessionId: string): void {
    const run = this.live.get(tabId)
    if (!run) return
    run.sessionId = sessionId
    // CC§1
    if (run.state === 'launching') {
      run.state = 'running'
      this.clearDeadline(tabId)
    }
    this.push()
  }

  onStatus(tabId: string, prev: SessionStatus | undefined, next: SessionStatus): void {
    const run = this.live.get(tabId)
    if (!run) return
    let changed = false
    if (
      next === 'waiting' &&
      (prev === 'working' || prev === 'approval') &&
      run.state === 'running'
    ) {
      run.state = 'done'
      changed = true
    } else if (next === 'working' && run.state === 'done') {
      run.state = 'running'
      changed = true
    }
    if (changed) this.push()
  }

  onPtyExit(tabId: string): void {
    const run = this.live.get(tabId)
    if (!run) return
    this.clearDeadline(tabId)
    this.live.delete(tabId)
    this.refreshFolders()
    const job = this.byId(run.jobId)
    if (!job) {
      this.push()
      return
    }
    const line = {
      dueAt: run.dueAt,
      ...(run.worktree ? { worktree: run.worktree } : {}),
      ...(run.manual ? MANUAL : {})
    }
    if (run.state === 'launching') {
      this.writeHistory(job, { ...line, state: 'failed', note: 'Claude exited before it started' })
      this.d.toast(`⏰ ${job.name} could not start: Claude exited before it started`)
    } else {
      this.writeHistory(job, { ...line, state: 'closed' })
    }
  }

  quitSweep(): void {
    for (const t of this.deadlines.values()) this.d.clearTimeout(t)
    this.deadlines.clear()
    if (this.live.size === 0) return
    for (const run of this.live.values()) {
      const job = this.byId(run.jobId)
      if (!job) continue
      this.pushLine(job, {
        dueAt: run.dueAt,
        state: 'ended',
        ...(run.worktree ? { worktree: run.worktree } : {}),
        ...(run.manual ? MANUAL : {})
      })
    }
    this.live.clear()
    this.d.store.save(this.jobs)
    this.push()
  }

  state(): CronState {
    this.refreshFolders()
    return this.buildState()
  }

  save(input: CronSaveInput): CronSaveResult {
    const c = clean(input)
    const errors = saveErrors(c, input.schedule, input.workspacePath, (p) => this.d.isPinned(p))
    if (errors.length > 0) return { ok: false, errors }
    const schedule = input.schedule as Schedule

    const existing = input.id ? this.byId(input.id) : undefined
    let job: CronJob
    if (existing) {
      delete existing.model
      delete existing.effort
      Object.assign(existing, c, {
        workspacePath: input.workspacePath,
        schedule,
        enabled: input.enabled === true
      })
      job = existing
      delete this.notes[job.id]
    } else {
      job = {
        ...c,
        id: input.id ?? randomUUID(),
        workspacePath: input.workspacePath,
        schedule,
        enabled: input.enabled === true,
        createdAt: this.d.now(),
        history: []
      }
      this.jobs.push(job)
    }
    this.lastDue.delete(job.id)
    this.held.delete(job.id)
    this.d.store.save(this.jobs)
    this.refreshFolders()
    this.push()
    return { ok: true, job }
  }

  setEnabled(jobId: string, on: boolean): void {
    const job = this.byId(jobId)
    if (!job) return
    job.enabled = on
    this.lastDue.delete(jobId)
    if (!on) this.held.delete(jobId)
    this.d.store.save(this.jobs)
    this.push()
  }

  delete(jobId: string): void {
    const i = this.jobs.findIndex((j) => j.id === jobId)
    if (i < 0) return
    this.jobs.splice(i, 1)
    this.forget(jobId)
    this.d.store.save(this.jobs)
    this.refreshFolders()
    this.push()
  }

  async runNow(jobId: string): Promise<CronRunNowResult> {
    const job = this.byId(jobId)
    if (!job) return { ok: false, reason: 'unknown-job' }
    return this.runDue(job, this.d.now(), true)
  }

  jobCountFor(workspacePath: string): number {
    return this.jobs.filter((j) => j.workspacePath === workspacePath).length
  }

  removeWorkspace(path: string): void {
    const gone = this.jobs.filter((j) => j.workspacePath === path)
    if (gone.length === 0) return
    this.jobs = this.jobs.filter((j) => j.workspacePath !== path)
    for (const j of gone) this.forget(j.id)
    this.d.store.save(this.jobs)
    this.refreshFolders()
    this.push()
  }

  private byId(id: string): CronJob | undefined {
    return this.jobs.find((j) => j.id === id)
  }

  private liveRunOf(jobId: string): LiveRun | undefined {
    let found: LiveRun | undefined
    for (const l of this.live.values()) {
      if (l.jobId === jobId && (!found || l.dueAt > found.dueAt)) found = l
    }
    return found
  }

  private forget(jobId: string): void {
    this.lastDue.delete(jobId)
    this.held.delete(jobId)
    delete this.notes[jobId]
    for (const run of this.live.values()) if (run.jobId === jobId) this.clearDeadline(run.tabId)
  }

  private pushLine(job: CronJob, line: HistoryLine): void {
    job.history.unshift(line)
    if (job.history.length > MAX_HISTORY) job.history.length = MAX_HISTORY
  }

  private writeHistory(job: CronJob, line: HistoryLine): void {
    this.pushLine(job, line)
    this.d.store.save(this.jobs)
    this.push()
  }

  private refreshFolders(): void {
    const next: Record<string, number> = {}
    for (const j of this.jobs) {
      if (!this.d.gitDirExists(j.workspacePath)) continue
      next[j.id] = this.d.countRunFolders(j.workspacePath, slugOf(j.name))
    }
    this.folders = next
  }

  private buildState(): CronState {
    return {
      jobs: this.jobs,
      live: [...this.live.values()],
      folders: this.folders,
      notes: this.notes
    }
  }

  private push(): void {
    this.d.push(this.buildState())
  }
}
