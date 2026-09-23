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

/** Runs the scheduled jobs. It decides when a job starts, remembers the runs
 *  that are alive right now, and writes the finished ones to the store. Pure over the
 *  deps below — no Electron, no fs, no clock of its own — so every rule here is a unit
 *  test rather than a click.
 *
 *  Five facts that are easy to lose and expensive to re-learn:
 *
 *  - **Koloft never types into a session.** There is no path from here to a pty write.
 *    The one thing this file may do to a running pty is kill it at the start deadline
 *    (step 8). Everything else about a run is the person's own doing.
 *  - **The first message travels as an environment variable**, `KOLOFT_FIRST_PROMPT`
 *    (with `KOLOFT_SESSION_NAME`), which the shim turns into `-- "<text>"` on the real
 *    claude line. The launch line itself is joined with spaces and typed into a login
 *    shell, so free text may never go on it: a task like `rm -rf ~` would be a shell
 *    command, not a prompt.
 *  - **A fresh run folder must be free as a folder AND as a branch.** `claude -w <n>`
 *    makes `.claude/worktrees/<n>` on branch `worktree-<n>`; a person can remove the
 *    folder and leave the branch behind, and claude then refuses the name. So
 *    `worktreeNameFor` asks both questions before it hands a name out.
 *  - **The deadline.** If a launched tab never reports SessionStart within
 *    `bindDeadlineMs`, the run is killed, its tab is dropped in the renderer, and the
 *    history says `Claude did not start`. Without it a wedged claude would sit there
 *    for ever, and the job would never fire again because the next due would see a
 *    live run and skip. The commonest reason it never starts is claude's trust question
 *    in a folder it has never run in, so the row names that when `trusted` says no.
 *  - **"The turn ended" is read from the tracker's own status edge**, not from the
 *    attention tracker. Attention swallows the event while the person is watching that
 *    very tab, so a run they were looking at would never reach `done`.
 */

/** A branch name must fit; `isValidWorktreeName` (src/shared/worktreeName.ts) caps a
 *  name at 64 characters, and every name this file hands out has to pass it. */
const MAX_WORKTREE_NAME = 64
/** `-yymmdd-HHMM` — the tail `worktreeBase` always appends. */
const STAMP_LEN = 12
/** newest first, and only this many are kept on disk. */
const MAX_HISTORY = 20

const PERMISSIONS: CronPermission[] = ['same', 'acceptEdits', 'skipAll']

/** Adds a suffix to a run-folder name without ever growing past git's limit. The slug
 *  is what gets shortened, never the date stamp: two runs of the same job in one
 *  minute is exactly the case the suffix exists for, so the stamp has to survive. */
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

/** The folder (and branch) one run gets. `taken(name)` must answer true when either
 *  `.claude/worktrees/<name>` exists or the branch `worktree-<name>` does. */
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
  // 98 names in one minute means something is very wrong; four random hex characters
  // end the search rather than looping for ever.
  return withSuffix(base, `-${randomBytes(2).toString('hex')}`)
}

export type LaunchResult = { ok: true; tabId: string } | { ok: false }

export interface LaunchRequest {
  /** which job this run belongs to — main needs it for the `terminal:spawned` push,
   *  and a name plus a folder is not a reliable stand-in: two jobs in one workspace
   *  may be called the same thing. */
  jobId: string
  cwd: string
  worktree?: string
  model?: string
  effort?: CronEffort
  permission: CronPermission
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
  /** the path is one of the pinned workspaces — the same list the loader filters on */
  isPinned(p: string): boolean
  /** `<root>/.git` is a DIRECTORY. A `.git` FILE means a linked worktree or a
   *  submodule, where `-w` cannot make a sibling copy — such a job runs in place. */
  gitDirExists(root: string): boolean
  worktreeDirExists(root: string, name: string): boolean
  branchExists(root: string, branch: string): Promise<boolean>
  countRunFolders(root: string, slug: string): number
  accountUsable(): boolean
  /** claude has been trusted with this folder (or an ancestor of it) — see claudeTrust.ts.
   *  Only the deadline's wording asks: a run in an untrusted folder cannot start at all. */
  trusted(wsPath: string): boolean
  /** a window exists and the renderer has answered `tabs:list` since its last teardown */
  ready(): boolean
  launch(req: LaunchRequest): LaunchResult | Promise<LaunchResult>
  killTab(tabId: string): void
  toast(text: string): void
  notify(title: string, body: string): void
  push(state: CronState): void
  /** tell the renderer to drop a tab whose pty we killed */
  killed(tabId: string): void
  bindDeadlineMs: number
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
  setTimeout: typeof setTimeout
  clearTimeout: typeof clearTimeout
}

// the words themselves live in @shared/cronMessages, where the form reads them too;
// re-exported here so a caller already importing the runner keeps working
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
    // out of range, repeated, or all seven days: the day row is the one to fix
    if (errs.length === 0 && !isValidSchedule(s)) errs.push(CRON_SAVE_MESSAGES.days)
    return errs
  }
  if (o.kind === 'every') {
    if (!isValidSchedule(s)) errs.push(CRON_SAVE_MESSAGES.every)
    return errs
  }
  // no shape at all — only a hand-made call can get here; answer with the When row's
  // most common complaint so the dialog still has something to show.
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

/** The same rules as the form's `validate`, re-run here: a job can also arrive from a
 *  hand-edited store or a call that never went through the dialog. */
function saveErrors(
  c: Clean,
  schedule: unknown,
  workspacePath: unknown,
  isPinned: (p: string) => boolean
): string[] {
  const errs: string[] = []
  // a path that is not pinned would run this session and then be dropped by the loader
  // on the next start — the job would look saved and quietly not be
  if (
    typeof workspacePath !== 'string' ||
    !path.isAbsolute(workspacePath) ||
    !isPinned(workspacePath)
  ) {
    errs.push(CRON_SAVE_MESSAGES.workspace)
  }
  // the order is the form's: whichever rule the person can act on first
  if (!c.name) errs.push(CRON_SAVE_MESSAGES.nameEmpty)
  // the name reaches the launch line as the value of `--name`, so a dash-leading one
  // would arrive there as a flag where a value belongs — the same rule `-w` names keep
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
  /** tabId → the run; never written to disk */
  private live = new Map<string, LiveRun>()
  /** job ids with a launch in flight; set before the first await */
  private launching = new Set<string>()
  /** per job, every due that landed with no window, oldest first */
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

  // ---- clock -------------------------------------------------------------

  start(): void {
    this.lastDue = seedLastDue(this.jobs, this.d.bootTime)
    const t = this.d.setInterval(() => this.onTick(), TICK_MS)
    ;(t as unknown as { unref?: () => void }).unref?.()
    this.timer = t
  }

  /** Called from before-quit AFTER `quitSweep()`. The deadline timers go too: a timer
   *  that fired during shutdown would kill a tab nobody is watching any more. */
  stop(): void {
    if (this.timer !== null) this.d.clearInterval(this.timer)
    this.timer = null
    for (const t of this.deadlines.values()) this.d.clearTimeout(t)
    this.deadlines.clear()
  }

  /** The Mac woke up. Ticks are ignored for half a minute: the network, the keychain
   *  and the file watches all need a moment, and a launch into that moment fails. */
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

  /** All the dues one tick found too old to start, as ONE line per job — "Missed 4
   *  times" instead of four rows — and one save plus one push for the whole tick.
   *  A job that is due every minute would otherwise spend a person's 20 lines of
   *  history, and the file write behind each of them, on a single quiet morning. */
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
      // `tick` walks forward in time, so the first is the oldest and the last the newest
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

  // ---- the renderer coming and going -------------------------------------

  /** The window went away (a reload, or the last window closed). Nothing to undo:
   *  `ready()` already answers false, so the dues that land now are held instead of
   *  launched. The call site exists so that boundary is visible from index.ts. */
  onRendererTeardown(): void {
    /* nothing to do — see the comment above */
  }

  /** The window is back. Only the NEWEST due a job piled up can still start, and only
   *  if it is inside the 5-minute window; everything older is written down as missed,
   *  folded the same way a sleep is. Keeping the whole pile rather than the last one
   *  matters on macOS, where closing the last window leaves the app running for hours:
   *  an hourly job stacks up a due per hour, and every one of them truly did not run. */
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
    // the misses first, so the run that starts sits above them in the list
    this.writeMissed(stale)
    for (const s of start) void this.runDue(s.job, s.dueAt, false)
  }

  // ---- one due -----------------------------------------------------------

  private async runDue(job: CronJob, dueAt: number, manual: boolean): Promise<CronRunNowResult> {
    // 1. Lock. A second fire inside one launch is dropped without a word.
    if (this.launching.has(job.id)) return { ok: false, reason: 'skipped' }
    this.launching.add(job.id)
    const mark = manual ? MANUAL : {}
    try {
      // 2. Overlap. The last run is still open, so this due does not start.
      const open = this.liveRunOf(job.id)
      if (open) {
        // Fold only into a skip row that belongs to THIS run — one younger than the run
        // is. A closed run's own line is dated by the due it ran for, which is OLDER than
        // the skips that piled up while it was open, so the loader's newest-first sort
        // puts that run's skip row back on top after a restart. Without the age check
        // the next run's first skip would count itself onto the previous run's row.
        const newest = job.history[0]
        if (newest && newest.state === 'skipped' && newest.dueAt > open.dueAt) {
          // fold into the line that is already there, so ten skips are one row
          newest.count = (newest.count ?? 1) + 1
          newest.until = dueAt
          if (manual) newest.manual = true
          this.d.store.save(this.jobs)
          this.push()
          // the clock folding quietly is the point; a PERSON pressing Run now is owed an
          // answer either way, or the button looks broken
          if (manual) this.d.toast(`⏰ ${job.name} skipped: the last run is still open`)
        } else {
          this.writeHistory(job, { dueAt, state: 'skipped', count: 1, ...mark })
          this.d.toast(`⏰ ${job.name} skipped: the last run is still open`)
        }
        return { ok: false, reason: 'skipped' }
      }

      // 3. Folder.
      if (!this.d.dirExists(job.workspacePath)) {
        this.fail(job, dueAt, mark, 'the folder is missing')
        return { ok: false, reason: 'folder-missing' }
      }

      // 4. Account.
      if (!this.d.accountUsable()) {
        this.fail(job, dueAt, mark, 'no usable account')
        return { ok: false, reason: 'no-account' }
      }

      // 5. Ready. No window means no tab to put the run in; hold it for later. Every
      // due is kept, not just the last one — see `onRendererReady`.
      if (!this.d.ready()) {
        if (!manual) {
          const pile = this.held.get(job.id)
          if (pile) pile.push({ jobId: job.id, dueAt })
          else this.held.set(job.id, [{ jobId: job.id, dueAt }])
        }
        return { ok: false, reason: 'not-ready' }
      }

      // 6. Place. A git repo gets a fresh copy; anything else runs in the folder.
      const git = this.d.gitDirExists(job.workspacePath)
      const worktree = git
        ? await worktreeNameFor(job, dueAt, (n) => this.taken(job.workspacePath, n))
        : undefined

      // 7. Launch.
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
      // 10. Release, whichever way we left.
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

  // ---- the deadline ------------------------------------------------------

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
    // the killed run left its folder behind, same as an ordinary exit does
    this.refreshFolders()
    const job = this.byId(run.jobId)
    if (!job) {
      this.push()
      return
    }
    // A folder claude has never been opened in stalls on its trust question, which comes
    // before anything Koloft can see (contract §9) — so the ONE thing that would fix it
    // is named right here. The toast and the notification keep the short words: they are
    // one line each, and the history row is where a person goes to find out why.
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

  // ---- what happens to a live run ----------------------------------------

  onBound(tabId: string, sessionId: string): void {
    const run = this.live.get(tabId)
    if (!run) return
    run.sessionId = sessionId
    // fires again on an in-TUI /clear, /compact or /resume — only the id changes then
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
    // only a run that has really started can be finished. A status edge arriving while
    // the run is still `launching` must not strand it in `done`: that would defuse the
    // start deadline, and every later due would then skip on "the last run is still
    // open" for a run that never opened.
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

  /** A hard death and a ⌘W look the same from here — both are a pty exit — so both
   *  read `closed by you`; the sidebar's own alert covers a real crash. */
  onPtyExit(tabId: string): void {
    const run = this.live.get(tabId)
    if (!run) return
    this.clearDeadline(tabId)
    this.live.delete(tabId)
    this.refreshFolders()
    const job = this.byId(run.jobId)
    if (!job) {
      // its job was deleted while it ran: the run ends, and nothing is written down
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

  /** Koloft is quitting: every run still open ends here, and `live` is emptied so the pty
   *  exits that follow during shutdown write nothing on top. */
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

  // ---- what the dialog asks for ------------------------------------------

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
      // the optional fields are whatever `clean` kept: an edit that leaves one out drops it
      delete existing.model
      delete existing.effort
      Object.assign(existing, c, {
        workspacePath: input.workspacePath,
        schedule,
        enabled: input.enabled === true
      })
      job = existing
      // the person just re-saved it, so the loader's complaint no longer applies
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
    // a changed schedule must never replay the past: the next tick re-seeds with now
    this.lastDue.delete(job.id)
    // and a due that has been waiting for a window belongs to the OLD rule — keeping it
    // would start a job the person just switched off, or run it on the old schedule
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

  /** The job goes; a run of it that is still open stays open as an ordinary session,
   *  and when it ends there is nothing left to write its line to. */
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

  // ---- small helpers -----------------------------------------------------

  private byId(id: string): CronJob | undefined {
    return this.jobs.find((j) => j.id === id)
  }

  /** the job's open run, if it has one (the newest, should two ever overlap) */
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
    // Its open runs stay open — they are ordinary sessions now — so the start deadline
    // must be disarmed too. Left armed, it would kill one of those tabs a minute and a
    // half later with no toast and no history line, because the job it would explain
    // itself with is gone. That reads as the app closing a session by itself.
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

  /** Counting folders means reading a directory, so it happens where a person can see
   *  the number change — the dialog opening, a run starting, a run ending — and never
   *  on the 20-second tick. */
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
