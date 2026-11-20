import { COUNTS_KEY, type WorkspaceGithub } from '../shared/counts'
import { coalesce } from '@core/coalesce'

const RECHECK_WELL_INSIDE_THE_LOOKUP_TTL_MS = 60_000
const ONE_SWEEP_AT_A_TIME = 'github-counts-sweep'
const STARTUP_DELAY_MS = 3_000

export const githubCountsData = (
  counts: WorkspaceGithub | undefined
): Readonly<Record<string, unknown>> | undefined => counts && { [COUNTS_KEY]: counts }

export interface GithubCountsDeps {
  workspaces(): Promise<{ path: string; missing: boolean }[]>
  openCounts(wsPath: string): Promise<WorkspaceGithub | null>
  onChange(): void
}

function same(a: WorkspaceGithub | undefined, b: WorkspaceGithub | undefined): boolean {
  return a?.repo === b?.repo && a?.issues === b?.issues && a?.prs === b?.prs
}

export class GithubCountsSweep {
  private cache = new Map<string, WorkspaceGithub>()
  private timers: NodeJS.Timeout[] = []
  private stops = 0
  constructor(private deps: GithubCountsDeps) {}

  private get stopped(): boolean {
    return this.timers.length === 0
  }

  start(delayMs = STARTUP_DELAY_MS): void {
    if (!this.stopped) return
    this.timers = [
      setTimeout(() => void this.sweep(), delayMs).unref(),
      setInterval(() => void this.sweep(), RECHECK_WELL_INSIDE_THE_LOOKUP_TTL_MS).unref()
    ]
  }

  stop(): void {
    this.stops++
    for (const t of this.timers) clearTimeout(t)
    this.timers = []
    if (this.cache.size === 0) return
    this.cache.clear()
    this.deps.onChange()
  }

  get(wsPath: string): WorkspaceGithub | undefined {
    return this.cache.get(wsPath)
  }

  sweep(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    return coalesce(ONE_SWEEP_AT_A_TIME, () => this.sweepOnce())
  }

  private async sweepOnce(): Promise<void> {
    if (this.stopped) return
    const stopsBefore = this.stops
    const live = (await this.deps.workspaces()).filter((ws) => !ws.missing)
    const answers = await Promise.all(
      live.map((ws) => this.deps.openCounts(ws.path).catch(() => null))
    )
    if (this.stops !== stopsBefore) return
    let changed = false
    live.forEach((ws, i) => {
      const next = answers[i] ?? undefined
      if (same(this.cache.get(ws.path), next)) return
      changed = true
      if (next) this.cache.set(ws.path, next)
      else this.cache.delete(ws.path)
    })
    if (changed) this.deps.onChange()
  }
}
