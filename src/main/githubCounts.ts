import type { WorkspaceGithub } from '@shared/types'

const SWEEP_INTERVAL_MS = 5 * 60_000
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
    setInterval(() => void this.sweep(), SWEEP_INTERVAL_MS).unref()
  }

  get(wsPath: string): WorkspaceGithub | undefined {
    return this.cache.get(wsPath)
  }

  async sweep(): Promise<void> {
    if (this.sweeping) return
    this.sweeping = true
    try {
      let changed = false
      const pinned = new Set<string>()
      for (const ws of this.deps.workspaces()) {
        if (ws.missing) continue
        pinned.add(ws.path)
        const next = (await this.deps.openCounts(ws.path).catch(() => null)) ?? undefined
        if (same(this.cache.get(ws.path), next)) continue
        changed = true
        if (next) this.cache.set(ws.path, next)
        else this.cache.delete(ws.path)
      }
      for (const p of [...this.cache.keys()]) {
        if (pinned.has(p)) continue
        this.cache.delete(p)
        changed = true
      }
      if (changed) this.deps.onChange()
    } finally {
      this.sweeping = false
    }
  }
}
