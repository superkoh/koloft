import { describe, expect, it } from 'vitest'
import {
  OWNER_ASLEEP_ANSWER,
  OwnerAsleep,
  THIS_MAC,
  type Asked,
  type OwnerAsleepDeps
} from '../../src/main/ownerAsleep'

const HOUR_MS = 60 * 60_000

function setup(over: Partial<OwnerAsleepDeps> = {}) {
  let since: number | null = null
  let now = 0
  const asks = new Map<string, Asked>()
  const refuses = new Map<string, string[]>()
  const replies: [string, string][] = []
  const marks = new Map<string, string[] | null>()
  const down = new Set<string>()
  const reports: string[] = []
  const d: OwnerAsleepDeps = {
    since: () => since,
    machines: () => [THIS_MAC, 'lab'],
    mark: async (machine, awake) => {
      if (down.has(machine)) return false
      marks.set(machine, awake)
      return true
    },
    awakeTabs: () => ['butler'],
    asking: () => [...asks.keys()],
    asked: async (tabId) => asks.get(tabId),
    answer: async (tabId, reply) => {
      replies.push([tabId, reply])
      if (refuses.get(tabId)?.includes(reply)) return 'it takes an option number'
      asks.delete(tabId)
      return undefined
    },
    titleOf: (tabId) => `Session ${tabId}`,
    changedSince: () => [],
    report: (text) => reports.push(text),
    now: () => now,
    ...over
  }
  const asleep = new OwnerAsleep(d)
  const fallAsleep = async (): Promise<void> => {
    since = now
    asleep.changed()
    await new Promise((r) => setTimeout(r, 0))
  }
  const wakeAfter = async (ms: number): Promise<void> => {
    now += ms
    since = null
    asleep.changed()
    await new Promise((r) => setTimeout(r, 0))
  }
  return { asleep, asks, refuses, replies, marks, down, reports, fallAsleep, wakeAfter }
}

describe('owner asleep', () => {
  it('falling asleep answers every question already showing with "choose your own recommendation" and allows every approval, but leaves the butler’s own', async () => {
    const t = setup()
    t.asks.set('a', { question: true, text: 'Blue or red?' })
    t.asks.set('b', { question: false, text: 'npm publish' })
    t.asks.set('butler', { question: true, text: 'Which one?' })
    await t.fallAsleep()
    expect(t.replies).toEqual([
      ['a', OWNER_ASLEEP_ANSWER],
      ['b', 'yes']
    ])
  })

  it('a question that takes no words of its own gets its first option instead', async () => {
    const t = setup()
    await t.fallAsleep()
    t.asks.set('a', { question: true, text: 'Pick one' })
    t.refuses.set('a', [OWNER_ASLEEP_ANSWER])
    await t.asleep.asks('a')
    expect(t.replies).toEqual([
      ['a', OWNER_ASLEEP_ANSWER],
      ['a', '1']
    ])
  })

  it('a question showing while the owner is awake is left to them', async () => {
    const t = setup()
    t.asks.set('a', { question: true, text: 'Blue or red?' })
    await t.asleep.asks('a')
    expect(t.replies).toEqual([])
  })

  it('marks this Mac and every machine with an open tab, the butler left out; a machine that cannot be reached is marked once it can, and waking removes every mark', async () => {
    const t = setup()
    t.down.add('lab')
    await t.fallAsleep()
    expect([...t.marks]).toEqual([[THIS_MAC, ['butler']]])
    t.down.delete('lab')
    await t.asleep.reconcile()
    expect(t.marks.get('lab')).toEqual(['butler'])
    t.down.add('lab')
    await t.wakeAfter(HOUR_MS)
    expect(t.marks.get(THIS_MAC)).toBeNull()
    expect(t.marks.get('lab')).toEqual(['butler'])
    t.down.delete('lab')
    await t.asleep.reconcile()
    expect(t.marks.get('lab')).toBeNull()
  })

  it('waking hands the butler one report of what changed and of every answer Koloft gave for the owner; a quiet night hands nothing', async () => {
    const t = setup({
      changedSince: () => [{ kind: 'turn-done', title: 'Fix login', reply: 'Opened PR #12.' }]
    })
    await t.fallAsleep()
    t.asks.set('a', { question: true, text: 'Blue or red?' })
    t.asks.set('b', { question: false, text: 'npm publish' })
    await t.asleep.asks('a')
    await t.asleep.asks('b')
    await t.wakeAfter(7 * HOUR_MS + 35 * 60_000)
    expect(t.reports).toHaveLength(1)
    expect(t.reports[0]).toContain('asleep for 7 h 35 min')
    expect(t.reports[0]).toContain(
      '"Fix login" finished its turn and waits; it said: "Opened PR #12."'
    )
    expect(t.reports[0]).toContain(
      '"Session a" asked the owner "Blue or red?"; Koloft told it to choose its own recommendation and go on.'
    )
    expect(t.reports[0]).toContain(
      '"Session b" asked to be allowed: "npm publish"; Koloft allowed it.'
    )

    const quiet = setup()
    await quiet.fallAsleep()
    await quiet.wakeAfter(HOUR_MS)
    expect(quiet.reports).toEqual([])
  })
})
