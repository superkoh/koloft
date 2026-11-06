// PLATFORM§10
const COMPOSITION_LEFT_OPEN_MS = 8_000
let composingTimer: NodeJS.Timeout | undefined
const heldWhileComposing: (() => void)[] = []

export function hostComposing(on: boolean): void {
  clearTimeout(composingTimer)
  composingTimer = on ? setTimeout(() => hostComposing(false), COMPOSITION_LEFT_OPEN_MS) : undefined
  if (!on) for (const go of heldWhileComposing.splice(0)) go()
}

export function compositionDone(): Promise<void> {
  if (!composingTimer) return Promise.resolve()
  return new Promise((resolve) => heldWhileComposing.push(resolve))
}
