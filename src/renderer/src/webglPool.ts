// PLATFORM§20
const MAX_CONTEXTS_BELOW_CHROMIUM_CAP = 12
// PLATFORM§20
const HIDDEN_CONTEXTS_KEPT_FOR_A_QUICK_RETURN = 2
const HAND_BACK_AFTER_THE_SWITCH_HAS_PAINTED_MS = 1000

type Member = {
  attach: () => void
  detach: () => void
  shown: boolean
}

const members = new Map<string, Member>()
const holdersLeastRecentFirst = new Set<string>()
let handBackTimer: ReturnType<typeof setTimeout> | undefined

function bump(id: string): void {
  holdersLeastRecentFirst.delete(id)
  holdersLeastRecentFirst.add(id)
}

function handBack(id: string): void {
  holdersLeastRecentFirst.delete(id)
  members.get(id)?.detach()
}

function hiddenHoldersLeastRecentFirst(): string[] {
  return [...holdersLeastRecentFirst].filter((h) => !members.get(h)?.shown)
}

function evictOne(): void {
  handBack(
    hiddenHoldersLeastRecentFirst()[0] ?? (holdersLeastRecentFirst.values().next().value as string)
  )
}

function handBackHiddenBeyondTheKept(): void {
  const hidden = hiddenHoldersLeastRecentFirst()
  const surplus = Math.max(0, hidden.length - HIDDEN_CONTEXTS_KEPT_FOR_A_QUICK_RETURN)
  for (const h of hidden.slice(0, surplus)) handBack(h)
}

export function enrollWebgl(id: string, attach: () => void, detach: () => void): void {
  members.set(id, { attach, detach, shown: false })
}

export function showWebgl(id: string): void {
  const m = members.get(id)
  if (!m) return
  m.shown = true
  if (holdersLeastRecentFirst.has(id)) {
    bump(id)
    return
  }
  while (holdersLeastRecentFirst.size >= MAX_CONTEXTS_BELOW_CHROMIUM_CAP) evictOne()
  holdersLeastRecentFirst.add(id)
  m.attach()
}

export function hideWebgl(id: string): void {
  const m = members.get(id)
  if (!m) return
  m.shown = false
  if (!holdersLeastRecentFirst.has(id)) return
  bump(id)
  handBackTimer ??= setTimeout(() => {
    handBackTimer = undefined
    handBackHiddenBeyondTheKept()
  }, HAND_BACK_AFTER_THE_SWITCH_HAS_PAINTED_MS)
}

export function releaseWebgl(id: string): void {
  members.delete(id)
  holdersLeastRecentFirst.delete(id)
}
