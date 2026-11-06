import type { QueuedLaunch } from '@shared/types'

export const GAP_AFTER_A_LAUNCH_MS = 90_000
export const GAP_BETWEEN_LAUNCHES_ON_A_ROOMY_MACHINE_MS = 20_000

interface Entry extends QueuedLaunch {
  start(): Promise<string | null>
  settle(id: string | null): void
}

export interface LaunchQueueDeps {
  room: { readonly holding: boolean; readonly busy: boolean }
  now(): number
  changed(): void
}

export type LaunchOutcome = 'started' | 'dropped' | 'failed'
export type HeldSend = () => Promise<unknown>

export interface InTurn {
  tabId: string
  queued: boolean
  started: Promise<string | null>
  outcome: Promise<LaunchOutcome>
}

export class LaunchQueue {
  private entries: Entry[] = []
  private starting = new Map<string, Entry>()
  private dropped = new Set<string>()
  private held = new Map<string, HeldSend[]>()
  private nextLaunchAt = 0

  constructor(private d: LaunchQueueDeps) {}

  list(): QueuedLaunch[] {
    return this.entries.map(plain)
  }

  notStartedYet(): QueuedLaunch[] {
    return [...this.entries, ...this.starting.values()].map(plain)
  }

  has(tabId: string): boolean {
    return this.starting.has(tabId) || this.entries.some((e) => e.tabId === tabId)
  }

  // ADR-0041
  launch(q: Omit<QueuedLaunch, 'since'>, start: () => Promise<string | null>): InTurn {
    let settle!: (id: string | null) => void
    const started = new Promise<string | null>((resolve) => (settle = resolve))
    const entry: Entry = { ...q, since: this.d.now(), start, settle }
    const outcome = started.then((id): LaunchOutcome => {
      if (id) return 'started'
      return this.dropped.delete(q.tabId) ? 'dropped' : 'failed'
    })
    if (!this.entries.length && this.mayLaunchNow()) {
      this.claimGap()
      this.run(entry)
      return { tabId: q.tabId, queued: false, started, outcome }
    }
    this.entries.push(entry)
    this.d.changed()
    return { tabId: q.tabId, queued: true, started, outcome }
  }

  pump(): void {
    if (!this.entries.length || !this.mayLaunchNow()) return
    this.claimGap()
    this.run(this.entries[0])
  }

  startNow(tabId: string): boolean {
    const entry = this.entries.find((e) => e.tabId === tabId)
    if (!entry) return false
    this.run(entry)
    return true
  }

  drop(tabId: string): boolean {
    const entry = this.entries.find((e) => e.tabId === tabId)
    if (!entry) return false
    this.entries = this.entries.filter((e) => e !== entry)
    this.held.delete(tabId)
    this.dropped.add(tabId)
    entry.settle(null)
    this.d.changed()
    return true
  }

  hold(tabId: string, send: HeldSend): boolean {
    if (!this.has(tabId)) return false
    const pile = this.held.get(tabId)
    if (pile) pile.push(send)
    else this.held.set(tabId, [send])
    return true
  }

  takeHeld(tabId: string): HeldSend[] {
    const pile = this.held.get(tabId) ?? []
    this.held.delete(tabId)
    return pile
  }

  private mayLaunchNow(): boolean {
    return !this.d.room.holding && this.d.now() >= this.nextLaunchAt
  }

  private claimGap(): void {
    this.nextLaunchAt =
      this.d.now() +
      (this.d.room.busy ? GAP_AFTER_A_LAUNCH_MS : GAP_BETWEEN_LAUNCHES_ON_A_ROOMY_MACHINE_MS)
  }

  private run(entry: Entry): void {
    this.entries = this.entries.filter((e) => e !== entry)
    this.starting.set(entry.tabId, entry)
    this.d.changed()
    entry
      .start()
      .catch(() => null)
      .then((id) => {
        this.starting.delete(entry.tabId)
        if (!id) this.held.delete(entry.tabId)
        entry.settle(id)
      })
  }
}

function plain({ tabId, kind, cwd, title, jobId, since }: QueuedLaunch): QueuedLaunch {
  return { tabId, kind, cwd, title, jobId, since }
}
