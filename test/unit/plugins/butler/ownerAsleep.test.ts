import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  morningReport,
  OWNER_ASLEEP_ANSWER,
  OwnerAsleep,
  SENDING_THE_ANSWER_FAILED,
  THIS_MAC,
  type AskedOwner,
  type OwnerAsleepDeps
} from '../../../../src/plugins/butler/main/ownerAsleep'
import { ANSWER_NOT_TAKEN } from '../../../../src/plugins/sessions/api'
import { OwnerPresence } from '../../../../src/core/presence'

const HOUR_MS = 60 * 60_000
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-asleep-'))
let setups = 0
afterAll(() => fs.rmSync(userData, { recursive: true, force: true }))

const question = (text: string, questions = 1): AskedOwner => ({ question: true, questions, text })
const approval = (text: string): AskedOwner => ({ question: false, questions: 0, text })

const presenceAsleepSince = (asleepSince: number | null): OwnerPresence =>
  new OwnerPresence({
    now: () => 0,
    macIdleSeconds: () => 0,
    asleepSince,
    wake: () => undefined
  })

function setup(over: Partial<OwnerAsleepDeps> = {}) {
  let now = 0
  const presence = presenceAsleepSince(null)
  const asks = new Map<string, AskedOwner>()
  const refuses = new Map<string, string[]>()
  const replies: [string, string][] = []
  const marks = new Map<string, string[] | null>()
  const down = new Set<string>()
  const machines = [THIS_MAC, 'lab']
  const reports: string[] = []
  const d: OwnerAsleepDeps = {
    presence,
    machines: () => machines,
    mark: async (machine, awake) => {
      if (down.has(machine)) return false
      marks.set(machine, awake)
      return true
    },
    awakeTabs: () => ['butler'],
    askClaimed: () => false,
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
    answeredFile: path.join(userData, `answered-${++setups}.json`),
    ...over
  }
  const asleep = new OwnerAsleep(d)
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
  const fallAsleep = async (): Promise<void> => {
    presence.asleepSinceIs(now)
    await settle()
  }
  const wakeAfter = async (ms: number): Promise<void> => {
    now += ms
    presence.asleepSinceIs(null)
    await settle()
  }
  return {
    d,
    asleep,
    asks,
    refuses,
    replies,
    marks,
    down,
    machines,
    reports,
    settle,
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

  it('a question a plugin claims is left unanswered, even on falling asleep, until the plugin stops claiming it', async () => {
    const claimed = new Set(['a'])
    const t = setup({ askClaimed: (tabId) => claimed.has(tabId) })
    t.asks.set('a', question('Blue or red?'))
    await t.fallAsleep()
    await t.asleep.asks('a')
    expect(t.replies).toEqual([])
    claimed.clear()
    await t.asleep.asks('a')
    expect(t.replies).toEqual([['a', OWNER_ASLEEP_ANSWER]])
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

  it('an answer typed in that the session was not seen to take is not followed by another, so a second answer never lands in the session', async () => {
    const t = setup()
    t.d.answer = async (tabId, reply) => {
      t.replies.push([tabId, reply])
      return ANSWER_NOT_TAKEN
    }
    await t.fallAsleep()
    t.asks.set('a', question('Pick one'))
    await t.asleep.asks('a')
    expect(t.replies).toEqual([['a', OWNER_ASLEEP_ANSWER]])
  })

  it('a second question asked while Koloft waits to see its first answer taken is answered once that wait ends', async () => {
    const t = setup()
    let landed: (() => void) | undefined
    t.d.answer = async (tabId, reply) => {
      t.replies.push([tabId, reply])
      t.asks.delete(tabId)
      if (t.replies.length === 1) await new Promise<void>((r) => (landed = r))
      return undefined
    }
    await t.fallAsleep()
    t.asks.set('a', question('Blue or red?'))
    const first = t.asleep.asks('a')
    await t.settle()
    landed?.()
    t.asks.set('a', approval('npm publish'))
    await t.asleep.asks('a')
    await first
    expect(t.replies).toEqual([
      ['a', OWNER_ASLEEP_ANSWER],
      ['a', 'yes']
    ])
    await t.wakeAfter(HOUR_MS)
    expect(t.reports[0]).toContain(
      '2. "Session a" asked to be allowed: "npm publish"; Koloft allowed it.'
    )
  })

  it('an answer step that throws is reported as not answered, and a second question waiting behind it is still answered', async () => {
    const t = setup()
    let failed: ((e: Error) => void) | undefined
    t.d.answer = async (tabId, reply) => {
      t.replies.push([tabId, reply])
      t.asks.delete(tabId)
      if (t.replies.length === 1) await new Promise<void>((_, reject) => (failed = reject))
      return undefined
    }
    await t.fallAsleep()
    t.asks.set('a', question('Blue or red?'))
    const first = t.asleep.asks('a')
    await t.settle()
    t.asks.set('a', approval('npm publish'))
    await t.asleep.asks('a')
    failed?.(new Error())
    await first
    expect(t.replies).toEqual([
      ['a', OWNER_ASLEEP_ANSWER],
      ['a', 'yes']
    ])
    await t.wakeAfter(HOUR_MS)
    expect(t.reports[0]).toContain(
      `1. "Session a" asked the owner "Blue or red?"; Koloft could not answer it (${SENDING_THE_ANSWER_FAILED}), so it still waits for the owner.`
    )
    expect(t.reports[0]).toContain(
      '2. "Session a" asked to be allowed: "npm publish"; Koloft allowed it.'
    )
  })

  it('a dialog Koloft already answered gets no second answer when the session signals it again during the wait, whether or not the answer was seen taken', async () => {
    for (const outcome of [undefined, ANSWER_NOT_TAKEN]) {
      const t = setup()
      let ended: (() => void) | undefined
      t.d.answer = async (tabId, reply) => {
        t.replies.push([tabId, reply])
        if (t.replies.length === 1) await new Promise<void>((r) => (ended = r))
        return outcome
      }
      await t.fallAsleep()
      t.asks.set('a', question('Blue or red?'))
      const first = t.asleep.asks('a')
      await t.settle()
      await t.asleep.asks('a')
      ended?.()
      await first
      expect(t.replies).toEqual([['a', OWNER_ASLEEP_ANSWER]])
    }
  })

  it('a question that shows while Koloft is still looking for one on that tab is answered too', async () => {
    const t = setup()
    await t.fallAsleep()
    let looked: (() => void) | undefined
    t.d.asked = async (tabId) => {
      const showing = t.asks.get(tabId)
      if (!looked) await new Promise<void>((r) => (looked = r))
      return showing
    }
    const first = t.asleep.asks('a')
    t.asks.set('a', question('Blue or red?'))
    await t.asleep.asks('a')
    looked?.()
    await first
    expect(t.replies).toEqual([['a', OWNER_ASLEEP_ANSWER]])
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

  it("a plugin's lines, read when the owner wakes from the time they fell asleep, end the morning report and make one on a night with nothing else", async () => {
    const t = setup()
    const askedFrom: number[] = []
    t.asleep.addToMorningReport((sleptAt) => {
      askedFrom.push(sleptAt)
      return ['Alfred answered "Fix login" for the owner.']
    })
    await t.fallAsleep()
    await t.wakeAfter(HOUR_MS)
    expect(askedFrom).toEqual([0])
    expect(t.reports).toHaveLength(1)
    expect(t.reports[0]).toMatch(/is back now\..* Alfred answered "Fix login" for the owner\.$/)

    const nothing = setup()
    nothing.asleep.addToMorningReport(() => [])
    await nothing.fallAsleep()
    await nothing.wakeAfter(HOUR_MS)
    expect(nothing.reports).toEqual([])
  })

  it('what Koloft answered before a restart in the night is still in the morning report, and the next night starts with none', async () => {
    const t = setup()
    await t.fallAsleep()
    t.asks.set('a', question('Blue or red?'))
    await t.asleep.asks('a')
    const afterRestart = presenceAsleepSince(0)
    const restarted = new OwnerAsleep({ ...t.d, presence: afterRestart })
    t.asks.set('b', approval('npm publish'))
    await restarted.asks('b')
    afterRestart.asleepSinceIs(null)
    expect(t.reports).toHaveLength(1)
    expect(t.reports[0]).toContain('"Session a" asked the owner "Blue or red?"')
    expect(t.reports[0]).toContain('"Session b" asked to be allowed: "npm publish"')

    const nextNight = presenceAsleepSince(HOUR_MS)
    new OwnerAsleep({ ...t.d, presence: nextNight })
    nextNight.asleepSinceIs(null)
    expect(t.reports).toHaveLength(1)
  })
})

describe('the full text of what Koloft answers while the owner sleeps and of the morning report, pinned so that moving them changes no character', () => {
  it('the answer, and the report for each mix of changed sessions and answers, every way an answer ends and each way a night’s length reads', async () => {
    const long = 'Which one? '.repeat(30)
    const changed = [
      {
        kind: 'turn-done' as const,
        title: 'Fix login',
        sessionId: 's-1',
        workspace: 'app',
        reply: 'Opened PR #12.'
      },
      { kind: 'approval' as const, title: 'Deploy' },
      { kind: 'exited' as const }
    ]
    const answered = [
      { title: 'Session a', asked: question('Blue or red?'), gave: OWNER_ASLEEP_ANSWER },
      { title: 'Session b', asked: question('Pick one'), gave: '1' },
      { title: 'Session c', asked: approval('npm publish'), gave: 'yes' },
      { title: 'Session d', asked: question(long), failed: SENDING_THE_ANSWER_FAILED },
      { title: 'Session e', asked: approval('rm -rf build'), failed: ANSWER_NOT_TAKEN }
    ]
    const lines = [
      `answer: ${OWNER_ASLEEP_ANSWER}`,
      `nothing: ${morningReport(HOUR_MS, [], [])}`,
      `changed, 45 min: ${morningReport(45 * 60_000, changed, [])}`,
      `answered, 2 h: ${morningReport(2 * HOUR_MS, [], answered)}`,
      `both, 7 h 35 min: ${morningReport(7 * HOUR_MS + 35 * 60_000, changed, answered)}`,
      `both, under a minute: ${morningReport(1000, changed.slice(0, 1), answered.slice(0, 1))}`
    ]
    await expect(lines.join('\n') + '\n').toMatchFileSnapshot('./text/owner-asleep.txt')
  })
})
