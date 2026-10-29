export const AWAY_AFTER_MS = 5 * 60_000
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
