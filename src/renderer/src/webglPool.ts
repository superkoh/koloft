// PLATFORM§20
const MAX_CONTEXTS_BELOW_CHROMIUM_CAP = 12

type Member = {
  attach: () => void
  detach: () => void
  holding: boolean
}

const members = new Map<string, Member>()
const holdersLeastRecentFirst: string[] = []

function bump(id: string): void {
  const i = holdersLeastRecentFirst.indexOf(id)
  if (i !== -1) holdersLeastRecentFirst.splice(i, 1)
  holdersLeastRecentFirst.push(id)
}

function promote(id: string): void {
  const m = members.get(id)
  if (!m) return
  if (!m.holding) {
    while (holdersLeastRecentFirst.length >= MAX_CONTEXTS_BELOW_CHROMIUM_CAP) {
      const victim = holdersLeastRecentFirst.shift()
      if (victim === undefined) break
      const vm = members.get(victim)
      if (vm && vm.holding) {
        vm.holding = false
        vm.detach()
      }
    }
    m.holding = true
    m.attach()
  }
  bump(id)
}

export function acquireWebgl(id: string, attach: () => void, detach: () => void): void {
  const existing = members.get(id)
  if (existing) {
    existing.attach = attach
    existing.detach = detach
  } else {
    members.set(id, { attach, detach, holding: false })
  }
  promote(id)
}

export function touchWebgl(id: string): void {
  promote(id)
}

export function releaseWebgl(id: string): void {
  members.delete(id)
  const i = holdersLeastRecentFirst.indexOf(id)
  if (i !== -1) holdersLeastRecentFirst.splice(i, 1)
}
