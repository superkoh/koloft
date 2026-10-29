import type { WorkspaceGithub } from '@shared/types'
import { coalesce } from './gitStatus'

const RECHECK_WELL_INSIDE_THE_LOOKUP_TTL_MS = 60_000
const ONE_SWEEP_AT_A_TIME = 'github-counts-sweep'
const STARTUP_DELAY_MS = 3_000

export interface GithubCountsDeps {
  workspaces(): { path: string; missing: boolean }[]
  openCounts(wsPath: string): Promise<WorkspaceGithub | null>
  onChange(): void
}

function same(a: WorkspaceGithub | undefined, b: WorkspaceGithub | undefined): boolean {
  return a?.repo === b?.repo && a?.issues === b?.issues && a?.prs === b?.prs
}

export class GithubCountsSweep {
  private cache = new Map<string, WorkspaceGithub>()
  constructor(private deps: GithubCountsDeps) {}

  start(): void {
    setTimeout(() => void this.sweep(), STARTUP_DELAY_MS).unref()
    setInterval(() => void this.sweep(), RECHECK_WELL_INSIDE_THE_LOOKUP_TTL_MS).unref()
  }

  get(wsPath: string): WorkspaceGithub | undefined {
    return this.cache.get(wsPath)
  }

  sweep(): Promise<void> {
    return coalesce(ONE_SWEEP_AT_A_TIME, () => this.sweepOnce())
  }

  private async sweepOnce(): Promise<void> {
    const live = this.deps.workspaces().filter((ws) => !ws.missing)
    const answers = await Promise.all(
      live.map((ws) => this.deps.openCounts(ws.path).catch(() => null))
    )
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
