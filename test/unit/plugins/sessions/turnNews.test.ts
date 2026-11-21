import { describe, it, expect } from 'vitest'
import {
  NewsJudge,
  judgeTurn,
  waitsOnOtherWork,
  type Helper,
  type Verdict
} from '../../../../src/plugins/sessions/main/turnNews'
import type { Turn } from '../../../../src/shared/turns'

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
    const held = new Set<string>()
    const holderHeard: string[] = []
    const j = new NewsJudge({
      judge: () => new Promise((resolve) => verdicts.push(resolve)),
      awaitingVerdict: (tabId) => marked.has(tabId),
      markFyi: (tabId) => fyi.push(tabId),
      holdsTurn: (tabId) => held.has(tabId),
      judgedWhileHeld: (tabId, v) => holderHeard.push(`${tabId} ${v.news}`)
    })
    const heard: string[] = []
    j.onVerdict((tabId, v) => heard.push(`first ${tabId} ${v.news}`))
    j.onVerdict((tabId, v) => heard.push(`second ${tabId} ${v.news}`))
    const settle = async (news: boolean): Promise<void> => {
      verdicts.shift()?.({ news })
      await Promise.resolve()
    }
    return { j, marked, fyi, heard, verdicts, settle, held, holderHeard }
  }

  it('the verdict on a turn a plugin holds goes to that plugin first, and to the rest only once it lets the turn go', async () => {
    const { j, marked, heard, settle, held, holderHeard } = judge()
    for (const tab of ['tab-A', 'tab-B']) {
      marked.add(tab)
      held.add(tab)
      j.turnEnded(tab, turn('Merge it?'))
      await settle(false)
    }
    expect(holderHeard).toEqual(['tab-A false', 'tab-B false'])
    expect(heard).toEqual([])
    j.letGo('tab-A')
    j.taken('tab-B')
    j.letGo('tab-B')
    expect(heard).toEqual(['first tab-A false', 'second tab-A false'])
  })

  it('a held turn’s verdict never reaches the next turn, nor anyone once the plugin took the turn before the verdict came back', async () => {
    const { j, marked, heard, settle, held } = judge()
    marked.add('tab-A')
    held.add('tab-A')
    j.turnEnded('tab-A', turn('Merge it?'))
    await settle(false)
    held.delete('tab-A')
    j.turnEnded('tab-A', turn('Done?'))
    j.letGo('tab-A')
    j.taken('tab-A')
    await settle(false)
    expect(heard).toEqual([])
  })

  it('asks once the turn and its mark are both in, in either order, a flapping mark keeps the verdict, and every subscriber hears each verdict', async () => {
    const { j, marked, fyi, heard, verdicts, settle } = judge()
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
    expect(heard).toEqual([
      'first tab-A true',
      'second tab-A true',
      'first tab-B false',
      'second tab-B false'
    ])
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
    const { j, marked, fyi, heard, settle } = judge()
    marked.add('tab-A')
    j.turnEnded('tab-A', turn('Done.'))
    j.prompted('tab-A')
    await settle(true)
    expect(fyi).toEqual([])
    expect(heard).toEqual([])
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

  it('the Assist is asked on its turn row with this exact text, and sees only the last 4000 characters of the reply', async () => {
    const jobs: unknown[] = []
    const reply = `${'a'.repeat(10)}${'b'.repeat(3990)}${'c'.repeat(10)}`
    await judgeTurn(async (job) => {
      jobs.push(job)
      return 'ACT'
    }, turn(reply))
    expect(jobs).toEqual([
      {
        row: 'turn',
        system:
          'You decide whether a person has to act on what a coding agent just said, and which short replies they could send.',
        prompt: `A coding agent just finished its turn and stopped. Read its last reply.
Answer ACT if the reply asks the person anything: a question, an approval, a choice, information, a login, or a step only the person can do before the work goes on.
Answer NEWS if the reply only reports: the work is done, or the agent is waiting on something else (another session, a background job, a build, a notice) and will carry on by itself, and it asks the person for nothing.
When unsure, answer ACT.
Write ACT or NEWS alone on the first line.
After ACT, if the person could answer with one tap, add a line "Q: " naming what they decide in at most 8 words, then 2 to 4 lines "- ", each a different answer they could send as it is, at most 5 words, the one the agent recommends first. Every answer must move the work on: no "let me look first" or "wait". A no means "not now", never a step the agent did not offer, such as closing a PR. Write them in the language of the agent's reply. Add none when the person has to type something only they know, or do a step away from the chat.

Agent replied:
${'b'.repeat(3990)}${'c'.repeat(10)}`
      }
    ])
  })

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
      'Next for you: none; merge when ready',
      'Merge #12 first. Next for you: nothing.',
      '你合并 #12 后就不用再做什么了。',
      '请先合并 #12。你不用再做什么了。',
      '你要做的：没有，等你确认后我再合并。',
      '你要做的：没有，由你决定要不要发版。',
      '你不用做什么了，除非你想改名字。'
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
