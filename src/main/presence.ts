export const AWAY_AFTER_MS = 5 * 60_000
// PLATFORM§60
const PAGE_INPUT_IS_THE_MACS_WITHIN_SECONDS = 1

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
  private locked = false

  constructor(private readonly d: PresenceDeps) {
    this.lastHands = d.now()
  }

  handsOnWindow(): void {
    this.lastHands = this.d.now()
    this.locked = false
  }

  handsOnPage(): void {
    if (this.d.macIdleSeconds() <= PAGE_INPUT_IS_THE_MACS_WITHIN_SECONDS) this.handsOnWindow()
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
