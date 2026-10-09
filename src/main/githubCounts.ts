import type { WorkspaceGithub } from '@shared/types'

const RECHECK_WELL_INSIDE_THE_LOOKUP_TTL_MS = 60_000
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
  private sweeping = false

  constructor(private deps: GithubCountsDeps) {}

  start(): void {
    setTimeout(() => void this.sweep(), STARTUP_DELAY_MS).unref()
    setInterval(() => void this.sweep(), RECHECK_WELL_INSIDE_THE_LOOKUP_TTL_MS).unref()
  }

  get(wsPath: string): WorkspaceGithub | undefined {
    return this.cache.get(wsPath)
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
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
    } finally {
      this.sweeping = false
    }
  }
}
