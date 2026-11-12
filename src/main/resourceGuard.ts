import type { MachineState } from '@shared/types'
import { MachineRoom, READ_THE_MACHINE_EVERY_MS, type MachineRoomDeps } from './machineRoom'
import { toolsOf, treesByTab, type TaggedProcess } from './machineTrees'

export interface ResourceGuardDeps extends MachineRoomDeps {
  koloftPid: number
  agentTabsOnThisMac(): string[]
  lookedAt(): string | null
  changed(state: MachineState): void
  readTrees(): Promise<TaggedProcess[]>
  giveWay(pid: number, on: boolean): Promise<void>
}

const TERMINAL_REPLIES_AND_KEYS_START_WITH = '\x1b'

export function ownerTyped(data: string): boolean {
  return data.length > 0 && !data.startsWith(TERMINAL_REPLIES_AND_KEYS_START_WITH)
}

type StartedAtByPid = Map<number, string>

// ADR-0042
export class ResourceGuard {
  readonly room: MachineRoom
  private ownerWantsAtFullSpeed = new Set<string>()
  private lowered = new Map<string, StartedAtByPid>()
  private memory: Record<string, number> = {}
  private timer: ReturnType<typeof setInterval> | undefined
  private ticking = false
  private oneAtATime: Promise<unknown> = Promise.resolve()
  private last = ''

  constructor(private d: ResourceGuardDeps) {
    this.room = new MachineRoom(d)
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), READ_THE_MACHINE_EVERY_MS)
    this.timer.unref?.()
  }

  async tick(): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      await this.room.tick()
      await this.inTurn(() => (this.room.memoryStaysCritical ? this.lookAt() : this.calmDown()))
    } finally {
      this.ticking = false
    }
  }

  free(tabId: string): Promise<boolean> {
    return this.inTurn(async () => {
      if (!this.room.memoryStaysCritical || this.ownerWantsAtFullSpeed.has(tabId)) return false
      this.ownerWantsAtFullSpeed.add(tabId)
      if (this.lowered.has(tabId)) await this.lift([tabId], await this.d.readTrees())
      this.push()
      return true
    })
  }

  forget(tabId: string): void {
    this.ownerWantsAtFullSpeed.delete(tabId)
    void this.inTurn(async () => {
      if (!this.lowered.has(tabId)) return
      await this.lift([tabId], await this.d.readTrees())
      this.push()
    })
  }

  liftAllBeforeQuitting(): void {
    for (const pids of this.lowered.values())
      for (const pid of pids.keys()) void this.d.giveWay(pid, false)
    this.lowered.clear()
  }

  state(): MachineState {
    return {
      critical: this.room.memoryStaysCritical,
      slowed: [...this.lowered.keys()],
      memory: this.memory
    }
  }

  private inTurn<T>(work: () => Promise<T>): Promise<T> {
    const done = this.oneAtATime.then(work)
    this.oneAtATime = done.catch((err) =>
      this.d.log(`[koloft] machine: could not look at the machine: ${String(err)}`)
    )
    return done
  }

  private keepsItsSpeed(tabId: string): boolean {
    return tabId === this.d.lookedAt() || this.ownerWantsAtFullSpeed.has(tabId)
  }

  private async lookAt(): Promise<void> {
    const rows = await this.d.readTrees()
    if (!rows.length) return
    const trees = treesByTab(rows)
    this.memory = {}
    for (const [tab, members] of trees)
      this.memory[tab] = members.reduce((sum, p) => sum + p.rssBytes, 0)
    const givingWay = this.d.agentTabsOnThisMac().filter((tab) => !this.keepsItsSpeed(tab))
    await this.lift(
      [...this.lowered.keys()].filter((tab) => !givingWay.includes(tab)),
      rows
    )
    const newlyLowered: number[] = []
    for (const tab of givingWay) {
      const before = this.lowered.get(tab)
      const now: StartedAtByPid = new Map()
      for (const p of toolsOf(trees.get(tab) ?? [], this.d.koloftPid)) {
        now.set(p.pid, p.started)
        if (before?.get(p.pid) !== p.started) newlyLowered.push(p.pid)
      }
      for (const p of rows) if (before?.get(p.pid) === p.started) now.set(p.pid, p.started)
      if (now.size) this.lowered.set(tab, now)
      else this.lowered.delete(tab)
    }
    await Promise.all(newlyLowered.map((pid) => this.d.giveWay(pid, true)))
    this.push()
  }

  private async calmDown(): Promise<void> {
    this.memory = {}
    this.ownerWantsAtFullSpeed.clear()
    if (this.lowered.size) await this.lift([...this.lowered.keys()], await this.d.readTrees())
    this.push()
  }

  // PLATFORM§59
  private async lift(tabs: string[], rows: TaggedProcess[]): Promise<void> {
    if (!tabs.length) return
    const trees = treesByTab(rows)
    const pids = new Set<number>()
    for (const tab of tabs) {
      const remembered = this.lowered.get(tab)
      this.lowered.delete(tab)
      for (const p of toolsOf(trees.get(tab) ?? [], this.d.koloftPid)) pids.add(p.pid)
      for (const p of rows) if (remembered?.get(p.pid) === p.started) pids.add(p.pid)
    }
    await Promise.all([...pids].map((pid) => this.d.giveWay(pid, false)))
  }

  private push(): void {
    const state = this.state()
    const text = JSON.stringify(state)
    if (text === this.last) return
    this.last = text
    this.d.changed(state)
  }
}
