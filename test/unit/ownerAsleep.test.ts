import { describe, expect, it } from 'vitest'
import {
  OWNER_ASLEEP_ANSWER,
  OwnerAsleep,
  THIS_MAC,
  type AskedOwner,
  type OwnerAsleepDeps
} from '../../src/main/ownerAsleep'

const HOUR_MS = 60 * 60_000

const question = (text: string, questions = 1): AskedOwner => ({ question: true, questions, text })
const approval = (text: string): AskedOwner => ({ question: false, questions: 0, text })

function setup(over: Partial<OwnerAsleepDeps> = {}, since: number | null = null) {
  let now = 0
  const asks = new Map<string, AskedOwner>()
  const refuses = new Map<string, string[]>()
  const replies: [string, string][] = []
  const marks = new Map<string, string[] | null>()
  const down = new Set<string>()
  const machines = [THIS_MAC, 'lab']
  const reports: string[] = []
  const d: OwnerAsleepDeps = {
    machines: () => machines,
    mark: async (machine, awake) => {
      if (down.has(machine)) return false
      marks.set(machine, awake)
      return true
    },
    awakeTabs: () => ['butler'],
    tabs: () => ['a', 'b', 'butler', 'idle'],
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
  const asleep = new OwnerAsleep(d, since)
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const fallAsleep = async (): Promise<void> => {
    asleep.set(now)
    await settle()
  }
  const wakeAfter = async (ms: number): Promise<void> => {
    now += ms
    asleep.set(null)
    await settle()
  }
  return {
    asleep,
    asks,
    refuses,
    replies,
    marks,
    down,
    machines,
    reports,
    fallAsleep,
    wakeAfter
  }
}

describe('owner asleep', () => {
  it('falling asleep answers every question already showing with "choose your own recommendation" and allows every approval, but leaves the butler’s own', async () => {
    const t = setup()
    t.asks.set('a', question('Blue or red?'))
    t.asks.set('b', approval('npm publish'))
    t.asks.set('butler', question('Which one?'))
    await t.fallAsleep()
    expect(t.replies).toEqual([
      ['a', OWNER_ASLEEP_ANSWER],
      ['b', 'yes']
    ])
  })

  it('a question that takes no words of its own gets its first option instead, and a dialog of several questions gets one answer each', async () => {
    const t = setup()
    await t.fallAsleep()
    t.asks.set('a', question('Pick one'))
    t.refuses.set('a', [OWNER_ASLEEP_ANSWER])
    await t.asleep.asks('a')
    t.asks.set('b', question('Fruit? Size?', 2))
    await t.asleep.asks('b')
    expect(t.replies).toEqual([
      ['a', OWNER_ASLEEP_ANSWER],
      ['a', '1'],
      ['b', `${OWNER_ASLEEP_ANSWER}\n${OWNER_ASLEEP_ANSWER}`]
    ])
  })

  it('a question showing while the owner is awake is left to them', async () => {
    const t = setup()
    t.asks.set('a', question('Blue or red?'))
    await t.asleep.asks('a')
    expect(t.replies).toEqual([])
  })

  it('marks this Mac and every machine with an open tab, the butler left out; a machine that cannot be reached is marked once it can, and waking takes every mark away, from a machine with no tab left too', async () => {
    const t = setup()
    t.down.add('lab')
    await t.fallAsleep()
    expect([...t.marks]).toEqual([[THIS_MAC, ['butler']]])
    t.down.delete('lab')
    await t.asleep.reconcile()
    expect(t.marks.get('lab')).toEqual(['butler'])
    t.down.add('lab')
    t.machines.pop()
    await t.wakeAfter(HOUR_MS)
    expect(t.marks.get(THIS_MAC)).toBeNull()
    expect(t.marks.get('lab')).toEqual(['butler'])
    t.down.delete('lab')
    await t.asleep.reconcile()
    expect(t.marks.get('lab')).toBeNull()
  })

  it('a Koloft that starts awake takes away a mark an earlier run may have left on every machine with an open tab', async () => {
    const t = setup()
    await t.asleep.reconcile()
    expect([...t.marks]).toEqual([
      [THIS_MAC, null],
      ['lab', null]
    ])
  })

  it('a mark that lands after the owner woke is put right on the next check', async () => {
    let finish: (() => void) | undefined
    const t = setup({
      mark: async (machine, awake) => {
        if (awake && machine === 'lab') await new Promise<void>((r) => (finish = r))
        t.marks.set(machine, awake)
        return true
      }
    })
    await t.fallAsleep()
    await t.wakeAfter(HOUR_MS)
    finish?.()
    await new Promise((r) => setTimeout(r, 0))
    expect(t.marks.get('lab')).toEqual(['butler'])
    await t.asleep.reconcile()
    expect(t.marks.get('lab')).toBeNull()
  })

  it('waking hands the butler one report of what changed and of every answer Koloft gave for the owner; a quiet night hands nothing', async () => {
    const t = setup({
      changedSince: () => [{ kind: 'turn-done', title: 'Fix login', reply: 'Opened PR #12.' }]
    })
    await t.fallAsleep()
    t.asks.set('a', question('Blue or red?'))
    t.asks.set('b', approval('npm publish'))
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
