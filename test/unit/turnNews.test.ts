import { describe, it, expect } from 'vitest'
import {
  NewsJudge,
  judgeTurn,
  waitsOnOtherWork,
  type Helper,
  type Verdict
} from '../../src/main/turnNews'
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
    const verdicts: ((v: Verdict) => void)[] = []
    const marked = new Set<string>()
    const fyi: string[] = []
    const j = new NewsJudge({
      judge: () => new Promise((resolve) => verdicts.push(resolve)),
      awaitingVerdict: (tabId) => marked.has(tabId),
      markFyi: (tabId) => fyi.push(tabId),
      judged: () => {}
    })
    const settle = async (news: boolean): Promise<void> => {
      verdicts.shift()?.({ news })
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

  it('a turn counts as being judged from the ask until its verdict is back, or until the session is written to again', async () => {
    const { j, marked, settle } = judge()
    marked.add('tab-A')
    j.turnEnded('tab-A', turn('Done.'))
    expect(j.judging('tab-A')).toBe(true)
    await settle(false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(j.judging('tab-A')).toBe(false)
    j.turnEnded('tab-A', turn('Done again.'))
    expect(j.judging('tab-A')).toBe(true)
    j.prompted('tab-A')
    expect(j.judging('tab-A')).toBe(false)
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

describe('judgeTurn — the Assist decides only what code cannot', () => {
  const asks: string[] = []
  const say =
    (answer: string | null) =>
    async ({ prompt }: { prompt: string }): Promise<string | null> => {
      asks.push(prompt)
      return answer
    }

  it('news only when the Assist answers NEWS; ACT, no answer or an empty reply keep it a call', async () => {
    asks.length = 0
    expect(
      await judgeTurn(say(' news\n'), turn('PR is open; I will report when CI is green.'))
    ).toEqual({ news: true })
    expect(await judgeTurn(say('ACT'), turn('Merge it?'))).toEqual({ news: false })
    expect(await judgeTurn(say(null), turn('Done.'))).toEqual({ news: false })
    expect(await judgeTurn(say('NEWS'), turn('   '))).toEqual({ news: false })
    expect(asks).toHaveLength(3)
  })

  it('a last line saying the owner has nothing to do is news without asking the Assist, even after recommendations', async () => {
    asks.length = 0
    for (const last of [
      '接下来你要做的：没有，等你合并三份。',
      '**你下一步：** 不用做什么。',
      '你接下来要做的：无。',
      '你现在什么都不用做。合并顺序不变：先合 #1451。',
      '你下一步要做的：没有，memory 已经改好了。',
      '你不用做什么了。',
      'Next for you: nothing.'
    ])
      expect(await judgeTurn(say('ACT'), turn(`- A（推荐）\n- B？\n\n${last}`))).toEqual({
        news: true
      })
    expect(asks).toHaveLength(0)
    for (const last of [
      '你要做的：决定合不合 PR #1539。',
      '你不用处理冲突，但要决定合不合 #12。',
      '你要做的：没有别的，只要合并 #12。',
      '你要做的：不用改代码，只要在 GitHub 上点一下合并 #12。',
      '你要做的：不用管 CI，直接合并 #12。',
      '需要你确认：不用 Haiku 改用 Sonnet 行不行？',
      '你要做的：没有问题的话就合并 #12，有问题告诉我。',
      '你要做的：没有意见就回我一声，我就推。',
      '你要做的：没有了，只差你点合并。',
      '你这边不用做什么，只需要批一下这个 PR。',
      '你不用做什么，除了把 token 发我。',
      '提醒你：没有你的授权我不能推，要推吗？',
      '主人要定：不用 A 用 B 可以吗？',
      '要我合并 #12 吗？\n\n你担心的回归：没有。',
      '我帮你查过日志：没有。',
      '你要做的：没有。要我顺手合并 PR 吗？',
      '你要做的：没有，合并 #12 就行。',
      '你：没有，请合并。',
      '你不用做什么，等测试跑完请合并 PR。',
      '你不用处理，不过记得重启一下。',
      'Next for you: nothing to fix, just approve the PR.',
      'Your next step: none needed, but please confirm the account name.',
      'Next for you: nothing. Please merge #12 when CI is green.',
      'Next for you: none; merge when ready'
    ])
      expect(await judgeTurn(say('ACT'), turn(last))).toEqual({ news: false })
  })

  it('replies offered after ACT ride along: 2 to 4 distinct short ones under a question, a reply too long to send whole is left out, and none when fewer or no question', async () => {
    expect(
      await judgeTurn(
        say(
          'ACT\nQ: Merge PR #12?\n- Merge it\n- Merge it and then delete the release branch afterwards\n- Not yet\n- Merge it\n- A\n- B\n- C'
        ),
        turn('Merge it?')
      )
    ).toEqual({
      news: false,
      choices: { question: 'Merge PR #12?', options: ['Merge it', 'Not yet', 'A', 'B'] }
    })
    expect(await judgeTurn(say('ACT\nQ: Merge?\n- Merge it'), turn('Merge it?'))).toEqual({
      news: false
    })
    expect(await judgeTurn(say('ACT\n- Yes\n- No'), turn('Merge it?'))).toEqual({ news: false })
    expect(await judgeTurn(say('NEWS\nQ: x\n- a\n- b'), turn('Done.'))).toEqual({ news: true })
  })
})
