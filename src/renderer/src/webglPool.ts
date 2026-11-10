// PLATFORM§20
const MAX_CONTEXTS_BELOW_CHROMIUM_CAP = 12

type Member = {
  attach: () => void
  detach: () => void
  shown: boolean
}

const members = new Map<string, Member>()
const holdersLeastRecentFirst = new Set<string>()

function bump(id: string): void {
  holdersLeastRecentFirst.delete(id)
  holdersLeastRecentFirst.add(id)
}

function evictOne(): void {
  let victim = holdersLeastRecentFirst.values().next().value as string
  for (const h of holdersLeastRecentFirst) {
    if (!members.get(h)?.shown) {
      victim = h
      break
    }
  }
  holdersLeastRecentFirst.delete(victim)
  members.get(victim)?.detach()
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
  if (holdersLeastRecentFirst.has(id)) bump(id)
}

export function releaseWebgl(id: string): void {
  members.delete(id)
  holdersLeastRecentFirst.delete(id)
}
