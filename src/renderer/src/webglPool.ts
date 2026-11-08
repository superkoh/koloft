// PLATFORM§20
const MAX_CONTEXTS_BELOW_CHROMIUM_CAP = 12

type Member = {
  attach: () => void
  detach: () => void
  holding: boolean
  shown: boolean
}

const members = new Map<string, Member>()
const holdersLeastRecentFirst: string[] = []

function bump(id: string): void {
  const i = holdersLeastRecentFirst.indexOf(id)
  if (i !== -1) holdersLeastRecentFirst.splice(i, 1)
  holdersLeastRecentFirst.push(id)
}

function evictOne(): void {
  const hidden = holdersLeastRecentFirst.findIndex((h) => !members.get(h)?.shown)
  const [victim] = holdersLeastRecentFirst.splice(Math.max(hidden, 0), 1)
  const vm = members.get(victim)
  if (vm && vm.holding) {
    vm.holding = false
    vm.detach()
  }
}

export function enrollWebgl(id: string, attach: () => void, detach: () => void): void {
  members.set(id, { attach, detach, holding: false, shown: false })
}

export function showWebgl(id: string): void {
  const m = members.get(id)
  if (!m) return
  m.shown = true
  if (!m.holding) {
    while (holdersLeastRecentFirst.length >= MAX_CONTEXTS_BELOW_CHROMIUM_CAP) evictOne()
    m.holding = true
    m.attach()
  }
  bump(id)
}

export function hideWebgl(id: string): void {
  const m = members.get(id)
  if (m) m.shown = false
}

export function releaseWebgl(id: string): void {
  members.delete(id)
  const i = holdersLeastRecentFirst.indexOf(id)
  if (i !== -1) holdersLeastRecentFirst.splice(i, 1)
}
