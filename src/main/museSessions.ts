import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import type { LaunchPermission } from '@shared/types'
import { PLACEHOLDER_TITLES } from '@shared/types'
import type { Turn } from '@shared/turns'
import { portOffset } from '@shared/worktreeName'
import { resolveCliRuntime, type CliRuntime, type CliSpec } from './cliRuntime'
import { TESTED_MUSE_LINE } from './cliMinimums'
import { record } from './codexObservation'
import { oncePerName, watchJsonDrops } from './jsonDrops'
import { openDropHandler } from './openDrop'
import { removeOpenShim, writeOpenShim } from './openShimScript'
import {
  PROGRAM_STATUS_REPLY,
  ProgramStatusParser,
  statusEvent,
  type ProgramStatus
} from './programStatus'
import { UUID, museSessionKey } from './sessionStore'
import { listMuseSessions, readMuseTurns, type MuseHistory } from './museServe'
import { pathWithDirFirst } from './toolInstall'
import { realpathSafe } from './projectInfo'
import {
  StoredSessions,
  type HistoryEntry,
  type StartContext,
  type StoredRun,
  type StoredSessionDeps
} from './storedSessions'

export interface MuseSessionDeps extends StoredSessionDeps {
  openShimRoot: string
}

interface MuseRun extends StoredRun {
  pid?: number
  startedAt: number
  boundAt: number
  lastStatus?: ProgramStatus
  lastReplyId?: string
}

// MUSE§1
const MUSE: CliSpec = {
  command: 'muse',
  testCommandEnv: 'KOLOFT_MUSE_CMD',
  name: 'Muse',
  cliName: 'Muse Code',
  notInstalled: 'Install Muse Code to start Muse sessions.',
  environment: (env) => env,
  version: /Muse Code (\d+)\.(\d+)\.(\d+)/,
  testedLine: TESTED_MUSE_LINE
}

// MUSE§1
const APPROVAL_MODE: Record<LaunchPermission, string | undefined> = {
  default: undefined,
  acceptEdits: undefined,
  bypass: 'never'
}

// MUSE§4
const REGISTRY_SWEEP_MS = 500

// MUSE§2
function registryDir(env: NodeJS.ProcessEnv): string {
  const data = env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), '.local', 'share')
  return path.join(data, 'muse', 'runtime', 'muse', 'sessions')
}

// MUSE§10
export function museTrustsFolder(env: NodeJS.ProcessEnv, dir: string): boolean {
  const config = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config')
  try {
    const trust = record(
      JSON.parse(fs.readFileSync(path.join(config, 'muse', 'trust.json'), 'utf8'))
    )
    return record(record(trust.projects)[realpathSafe(dir)]).decision === 'trusted'
  } catch {
    return false
  }
}

interface RegistryEntry {
  sessionId: string
  pid: number
  mtimeMs: number
}

// MUSE§4
function readRegistry(dir: string, pids: Set<number>): RegistryEntry[] {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    if (!name.endsWith('.json')) return []
    const full = path.join(dir, name)
    try {
      const entry = record(JSON.parse(fs.readFileSync(full, 'utf8')))
      const pid = Number(/^pid=(\d+)$/.exec(String(entry.process_generation_hint))?.[1])
      if (entry.schema_version !== 1 || typeof entry.session_id !== 'string') return []
      if (!UUID.test(entry.session_id) || !pids.has(pid)) return []
      return [{ sessionId: entry.session_id, pid, mtimeMs: fs.statSync(full).mtimeMs }]
    } catch {
      return []
    }
  })
}

export class MuseSessions extends StoredSessions<MuseRun, HistoryEntry> {
  readonly id = 'muse'
  private parsers = new Map<string, ProgramStatusParser>()
  private sweeping?: ReturnType<typeof setInterval>
  private registrySeenAt?: number
  private unreadable = new Set<string>()

  constructor(
    file: string,
    protected deps: MuseSessionDeps
  ) {
    super(file, museSessionKey, deps)
    deps.pty.on('data', ({ id, data }: { id: string; data: string }) => this.onData(id, data))
  }

  protected resolveRuntime(): Promise<CliRuntime> {
    return resolveCliRuntime(MUSE)
  }

  protected untestedNotice(version: string): string {
    return `Muse Code ${version} is newer than the version Koloft was tested with (${TESTED_MUSE_LINE}.x). It may misbehave.`
  }

  private get env(): NodeJS.ProcessEnv {
    return this.processEnv ?? process.env
  }

  trustsFolder(dir: string): boolean {
    return museTrustsFolder(this.env, dir)
  }

  private serveOptions(): { binary: string; env: NodeJS.ProcessEnv } {
    if (!this.binary) throw new Error('Muse Code is unavailable.')
    return { binary: this.binary, env: this.env }
  }

  protected async listHistory(): Promise<
    { key: string; entry: HistoryEntry; archived: boolean }[]
  > {
    const sessions = await listMuseSessions(this.serveOptions())
    return sessions.map((entry) => ({ key: museSessionKey(entry.id), entry, archived: false }))
  }

  async transcriptExists(key: string): Promise<boolean> {
    if (!this.history.has(key)) await this.refreshHistory()
    return this.history.has(key)
  }

  // MUSE§5
  async readTurns(key: string, n: number): Promise<Turn[]> {
    return (await this.readHistoryOf(key, n))?.turns ?? []
  }

  private async readHistoryOf(key: string, n: number): Promise<MuseHistory | undefined> {
    if (!this.binary && !(await this.availability()).available) return undefined
    try {
      return await readMuseTurns(this.serveOptions(), this.nativeId(key), n)
    } catch (error) {
      if (!this.unreadable.has(key)) {
        this.unreadable.add(key)
        this.deps.error(
          `Koloft could not read this Muse session's messages: ${error instanceof Error ? error.message : String(error)}`
        )
      }
      return undefined
    }
  }

  protected async startRun({ opts, cwd, workspace, resource }: StartContext): Promise<MuseRun> {
    const binary = this.binary!
    const tabId = this.deps.pty.nextId()
    const tools = this.startOpenShim((target) => this.deps.events(tabId, { type: 'open', target }))
    const env = { ...this.processEnv, PATH: pathWithDirFirst(this.processEnv?.PATH, tools.dir) }
    const permission = opts.permission ?? 'default'
    // ADR-0026 MUSE§10
    const trust = opts.trustFolder || (!!resource && this.trustsFolder(workspace))
    const argv = [
      ...(opts.model ? ['--model', opts.model] : []),
      ...(opts.effort ? ['--reasoning-effort', opts.effort] : []),
      ...(APPROVAL_MODE[permission] ? ['--approval-mode', APPROVAL_MODE[permission]!] : []),
      ...(trust ? ['--trust-workspace'] : []),
      ...(opts.resumeSessionId
        ? ['resume', this.nativeId(opts.resumeSessionId)]
        : opts.firstPrompt
          ? [opts.firstPrompt]
          : [])
    ]
    this.parsers.set(tabId, new ProgramStatusParser())
    try {
      const handle = this.deps.pty.create({
        id: tabId,
        kind: 'muse',
        cwd,
        cols: opts.cols,
        rows: opts.rows,
        executable: binary,
        argv,
        processEnv: env,
        resumeSessionId: opts.resumeSessionId,
        extraEnv: resource ? { KOLOFT_PORT_OFFSET: String(portOffset(resource.worktreeName)) } : {}
      })
      const run: MuseRun = {
        tabId: handle.id,
        cwd,
        workspace,
        resource,
        explicitStop: false,
        resumeKey: opts.resumeSessionId,
        permission,
        pid: this.deps.pty.pidOf(handle.id),
        startedAt: handle.startedAt,
        boundAt: handle.startedAt,
        releaseTools: () => {
          tools.release()
          this.parsers.delete(handle.id)
        }
      }
      this.sweeping ??= setInterval(() => this.sweepRegistry(), REGISTRY_SWEEP_MS)
      this.sweeping.unref?.()
      return run
    } catch (error) {
      this.parsers.delete(tabId)
      tools.release()
      throw error
    }
  }

  // MUSE§8
  private startOpenShim(open: (target: string) => void): { dir: string; release(): void } {
    const shim = writeOpenShim(this.deps.openShimRoot, randomUUID(), undefined)
    const drops = watchJsonDrops(
      shim.requestDir,
      oncePerName(() => openDropHandler(open))
    )
    return {
      dir: shim.shimDir,
      release: () => {
        drops?.close()
        removeOpenShim(shim)
      }
    }
  }

  // MUSE§3
  private onData(tabId: string, data: string): void {
    const parser = this.parsers.get(tabId)
    if (!parser) return
    const { asked, states } = parser.push(data)
    if (asked) this.deps.pty.write(tabId, PROGRAM_STATUS_REPLY)
    const run = this.runs.get(tabId)
    if (!run || run.explicitStop || states.length === 0) return
    for (const status of states) run.lastStatus = status.state === 'clear' ? undefined : status
    if (this.sweepRegistry().has(run) || !run.info) return
    for (const status of states) if (status.state !== 'clear') this.emitState(run, status)
  }

  private emitState(run: MuseRun, status: ProgramStatus): void {
    const event = statusEvent(status)
    if (event) this.deps.events(run.tabId, event)
    if (status.state === 'done' || status.state === 'error') void this.afterTurn(run)
  }

  // MUSE§5
  private async afterTurn(run: MuseRun): Promise<void> {
    const key = run.info?.sessionId
    if (!key) return
    const read = await this.readHistoryOf(key, 1)
    const turn = read?.turns[0]
    const fresh =
      turn &&
      read.lastReplyId &&
      read.lastReplyId !== run.lastReplyId &&
      turn.at >= run.boundAt &&
      run.info?.sessionId === key
    if (fresh) {
      run.lastReplyId = read.lastReplyId
      this.deps.events(run.tabId, { type: 'turn-ended', turn })
    }
    if (run.info?.title !== PLACEHOLDER_TITLES.muse) return
    await this.refreshHistory().catch(() => {})
    const info = run.info
    const named = info && this.history.get(info.sessionId)
    const title = named?.name || named?.preview?.slice(0, 100)
    if (info && title && info.title === PLACEHOLDER_TITLES.muse) this.retitle(info, title)
  }

  // MUSE§4
  private sweepRegistry(): Set<MuseRun> {
    const rebound = new Set<MuseRun>()
    if (this.runs.size === 0 && this.sweeping) {
      clearInterval(this.sweeping)
      this.sweeping = undefined
      return rebound
    }
    const dir = registryDir(this.env)
    let changedAt: number
    try {
      changedAt = fs.statSync(dir).mtimeMs
    } catch {
      return rebound
    }
    const unbound = [...this.runs.values()].some((r) => !r.info && !r.explicitStop)
    if (changedAt === this.registrySeenAt && !unbound) return rebound
    this.registrySeenAt = changedAt
    const live = [...this.runs.values()].filter(
      (r) => !r.explicitStop && !r.stopping && r.pid !== undefined
    )
    const entries = readRegistry(dir, new Set(live.map((r) => r.pid!)))
    for (const run of live) {
      const mine = entries
        .filter((e) => e.pid === run.pid && e.mtimeMs >= run.startedAt - 1000)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
      if (!mine || run.info?.nativeSessionId === mine.sessionId) continue
      const key = museSessionKey(mine.sessionId)
      const known = this.history.get(key)
      run.boundAt = Date.now()
      run.lastReplyId = undefined
      this.bind(run, known ?? { id: mine.sessionId, cwd: run.cwd }, known ? 'switch' : 'replace')
      rebound.add(run)
      if (run.lastStatus) this.emitState(run, run.lastStatus)
    }
    return rebound
  }
}
