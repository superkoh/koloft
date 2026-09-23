export const QUIT_ANSWER_GRACE_MS = 5000

export type QuitDecision = 'allow' | 'ask' | 'wait'

let approved = false
let askedAt: number | null = null
let pendingAction: (() => void) | null = null
let pendingDecline: (() => void) | null = null

// PLATFORM§5
export function quitDecision(now: number): QuitDecision {
  if (approved) return 'allow'
  if (askedAt === null) {
    askedAt = now
    return 'ask'
  }
  return now - askedAt >= QUIT_ANSWER_GRACE_MS ? 'allow' : 'wait'
}

export function approve(): void {
  approved = true
}

let askRenderer: () => boolean = () => false

export function setQuitAsk(fn: () => boolean): void {
  askRenderer = fn
}

export function withApproval(
  action: () => void,
  now: number,
  onDecline?: () => void
): 'ran' | 'waiting' {
  if (approved) {
    action()
    return 'ran'
  }
  if (!askRenderer()) {
    approved = true
    action()
    return 'ran'
  }
  pendingAction = action
  pendingDecline = onDecline ?? null
  askedAt = now
  return 'waiting'
}

export function approveAndRun(fallback: () => void): void {
  approved = true
  const run = pendingAction ?? fallback
  pendingAction = null
  pendingDecline = null
  run()
}

export function declineQuit(): void {
  const unwind = pendingDecline
  pendingAction = null
  pendingDecline = null
  reset()
  unwind?.()
}

export function reset(): void {
  approved = false
  askedAt = null
}
