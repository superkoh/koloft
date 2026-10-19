import { describe, it, expect } from 'vitest'
import { NewsJudge, onlyNews, waitsOnOtherWork, type Helper } from '../../src/main/turnNews'
import type { Turn } from '../../src/shared/turns'

const turn = (reply: string): Turn => ({ said: [], reply, at: 1 })
const nobodyOwes = (): boolean => false
const noParent = (): undefined => undefined

describe('waitsOnOtherWork — what Koloft itself can see a session waiting on', () => {
  it('a Monitor it left watching for an event, but no other leftover: a server never ends, an idle teammate or a finished helper is waited on by no one', () => {
    const job = (kind: 'monitor' | 'server' | 'teammate' | 'agent') => ({
      sessionId: 'me',
      background: [{ id: 'b', kind, label: kind, state: 'waiting' as const }]
    })
    expect(waitsOnOtherWork(job('monitor'), [], noParent, nobodyOwes)).toBe(true)
    for (const other of ['server', 'teammate', 'agent'] as const)
      expect(waitsOnOtherWork(job(other), [], noParent, nobodyOwes)).toBe(false)
  })

  it('a session that owes it a reply, or that it wrote to and that has not finished', () => {
    expect(waitsOnOtherWork({ sessionId: 'me' }, [], noParent, (id) => id === 'me')).toBe(true)
  })

  it('a session it started that is still working or asking, and no one else’s', () => {
    const helpers: Helper[] = [
      { sessionId: 'mine', alive: true, status: 'waiting' },
      { sessionId: 'theirs', alive: true, status: 'working' }
    ]
    const parentOf = (id: string): string | undefined =>
      ({ mine: 'me', theirs: 'other' })[id] as string | undefined
    expect(waitsOnOtherWork({ sessionId: 'me' }, helpers, parentOf, nobodyOwes)).toBe(false)
    helpers[0].status = 'approval'
    expect(waitsOnOtherWork({ sessionId: 'me' }, helpers, parentOf, nobodyOwes)).toBe(true)
  })
})

describe('NewsJudge — each finished turn is judged once, and only its own mark takes the verdict', () => {
  function judge() {
    const verdicts: ((news: boolean) => void)[] = []
    const marked = new Set<string>()
    const fyi: string[] = []
    const j = new NewsJudge({
      isNews: () => new Promise((resolve) => verdicts.push(resolve)),
      awaitingVerdict: (tabId) => marked.has(tabId),
      markFyi: (tabId) => fyi.push(tabId)
    })
    const settle = async (news: boolean): Promise<void> => {
      verdicts.shift()?.(news)
      await Promise.resolve()
    }
    return { j, marked, fyi, verdicts, settle }
  }

  it('asks once the turn and its mark are both in, in either order, and a flapping mark keeps the verdict', async () => {
    const { j, marked, fyi, verdicts, settle } = judge()
    j.turnEnded('tab-A', turn('Done.'))
    expect(verdicts).toHaveLength(0)
    marked.add('tab-A')
    j.marked('tab-A')
    j.marked('tab-A')
    expect(verdicts).toHaveLength(1)
    await settle(true)
    expect(fyi).toEqual(['tab-A'])

    marked.add('tab-B')
    j.marked('tab-B')
    j.turnEnded('tab-B', turn('Merge it?'))
    await settle(false)
    expect(fyi).toEqual(['tab-A'])
  })

  it('a verdict that comes back after the owner wrote again is dropped', async () => {
    const { j, marked, fyi, settle } = judge()
    marked.add('tab-A')
    j.turnEnded('tab-A', turn('Done.'))
    j.prompted('tab-A')
    await settle(true)
    expect(fyi).toEqual([])
  })
})

describe('onlyNews — the Assist decides only what code cannot', () => {
  it('news only when the Assist answers NEWS; ACT, no answer or an empty reply keep it a call', async () => {
    const asks: string[] = []
    const say =
      (answer: string | null) =>
      async ({ prompt }: { prompt: string }): Promise<string | null> => {
        asks.push(prompt)
        return answer
      }
    expect(
      await onlyNews(say(' news\n'), turn('PR is open; I will report when CI is green.'))
    ).toBe(true)
    expect(await onlyNews(say('ACT'), turn('Merge it?'))).toBe(false)
    expect(await onlyNews(say(null), turn('Done.'))).toBe(false)
    expect(await onlyNews(say('NEWS'), turn('   '))).toBe(false)
    expect(asks).toHaveLength(3)
  })
})
