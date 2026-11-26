export const AWAY_AFTER_MS = 5 * 60_000
export const OWNER_ASLEEP_FILE = 'owner-asleep'
// PLATFORM§60
const INPUT_IS_THE_MACS_WITHIN_SECONDS = 1
const HANDS_RECHECKED_AFTER_MS = 1000

const HANDS_ON = new Set(['mouseDown', 'mouseMove', 'mouseWheel', 'rawKeyDown', 'keyDown'])

export function isHandsOn(inputType: string): boolean {
  return HANDS_ON.has(inputType)
}

export interface PresenceDeps {
  now(): number
  macIdleSeconds(): number
}

// PLATFORM§60
export class Presence {
  private lastHands: number
  private lastAsked = -Infinity
  private locked = false

  constructor(private readonly d: PresenceDeps) {
    this.lastHands = d.now()
  }

  macLastUsed(): void {
    this.lastHands = this.d.now() - this.d.macIdleSeconds() * 1000
  }

  handsOn(): void {
    const now = this.d.now()
    if (now - this.lastAsked < HANDS_RECHECKED_AFTER_MS) return
    this.lastAsked = now
    if (this.d.macIdleSeconds() > INPUT_IS_THE_MACS_WITHIN_SECONDS) return
    this.lastHands = now
    this.locked = false
  }

  screenLocked(): void {
    this.locked = true
  }

  lastHandsAt(): number {
    return this.lastHands
  }

  away(): boolean {
    return this.locked || this.d.now() - this.lastHands >= AWAY_AFTER_MS
  }
}

export type OwnerWhere = 'at-the-mac' | 'away' | 'asleep'

export type SleepChanged = (since: number | null, sleptAt: number | null) => void

export interface OwnerPresenceDeps extends PresenceDeps {
  asleepSince: number | null
  wake(): void
  awayForTests?(): boolean | undefined
}

export class OwnerPresence {
  private readonly hands: Presence
  private since: number | null
  private readonly sleepListeners: SleepChanged[] = []

  constructor(private readonly d: OwnerPresenceDeps) {
    this.hands = new Presence(d)
    this.since = d.asleepSince
  }

  asleepSince(): number | null {
    return this.since
  }

  asleep(): boolean {
    return this.since !== null
  }

  away(): boolean {
    if (this.asleep()) return false
    return this.d.awayForTests?.() ?? this.hands.away()
  }

  where(): OwnerWhere {
    return this.asleep() ? 'asleep' : this.away() ? 'away' : 'at-the-mac'
  }

  lastHandsAt(): number {
    return this.hands.lastHandsAt()
  }

  macLastUsed(): void {
    this.hands.macLastUsed()
  }

  handsOn(): void {
    this.hands.handsOn()
  }

  screenLocked(): void {
    this.hands.screenLocked()
  }

  ownerWrote(): void {
    if (this.asleep()) this.d.wake()
  }

  asleepSinceIs(since: number | null): void {
    const sleptAt = this.since
    if (since === sleptAt) return
    this.since = since
    for (const listener of this.sleepListeners) listener(since, sleptAt)
  }

  listenToSleep(listener: SleepChanged): void {
    this.sleepListeners.push(listener)
  }
}
