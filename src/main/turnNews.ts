import type { BackgroundItem } from '@shared/types'
import type { Turn } from '@shared/turns'
import type { Assist } from './assist'

const REPLY_CHARS_SENT = 4000
const MOST_REPLIES_OFFERED = 4
const REPLY_OFFERED_CHARS = 40
const QUESTION_CHARS = 120

const SYSTEM =
  'You decide whether a person has to act on what a coding agent just said, and which short replies they could send.'

const INSTRUCTIONS = [
  'A coding agent just finished its turn and stopped. Read its last reply.',
  'Answer ACT if the reply asks the person anything: a question, an approval, a choice, information, a login, or a step only the person can do before the work goes on.',
  'Answer NEWS if the reply only reports: the work is done, or the agent is waiting on something else (another session, a background job, a build, a notice) and will carry on by itself, and it asks the person for nothing.',
  'When unsure, answer ACT.',
  'Write ACT or NEWS alone on the first line.',
  'After ACT, if the person could answer with one tap, add a line "Q: " naming what they decide in at most 8 words, then 2 to 4 lines "- ", each a different answer they could send as it is, at most 5 words, the one the agent recommends first. Every answer must move the work on: no "let me look first" or "wait". A no means "not now", never a step the agent did not offer, such as closing a PR. Write them in the language of the agent\'s reply. Add none when the person has to type something only they know, or do a step away from the chat.'
].join('\n')

const AND_YET_ASKS = '(只|除了|但|直接|吗|？|\\?)'
const SENTENCE_ENDS_ASKING_NOTHING = `(?:[。.！!]|$|[，,；;](?!.*${AND_YET_ASKS}))`
const NOTHING_FOR_YOU = [
  new RegExp(
    `(你|主人)[^：:]{0,8}[：:]\\s*(没有|无|不用做什么|不用做任何事|什么都不用做)${SENTENCE_ENDS_ASKING_NOTHING}`
  ),
  new RegExp(`你.{0,8}(不用|不需要|无需)再?(做|处理)(什么|任何事)?${SENTENCE_ENDS_ASKING_NOTHING}`),
  /\b(next for you|for you to do|your next step)\b[^:]{0,12}:\s*(nothing|none)\b(?:[.!]|$|,(?!.*(just|but|except|only|please|\?)))/i
]

export function saysNothingForYou(reply: string): boolean {
  const last = reply.replace(/\*/g, '').trim().split('\n').pop() ?? ''
  return NOTHING_FOR_YOU.some((re) => re.test(last))
}

export interface ReplyChoices {
  question: string
  options: string[]
}

export interface Verdict {
  news: boolean
  choices?: ReplyChoices
}

const cut = (text: string, max: number): string =>
  Array.from(text).length > max
    ? `${Array.from(text)
        .slice(0, max - 1)
        .join('')}…`
    : text

function choicesIn(lines: string[]): ReplyChoices | undefined {
  const question = lines
    .find((l) => l.startsWith('Q:'))
    ?.slice(2)
    .trim()
  const options = [
    ...new Set(
      lines
        .filter((l) => l.startsWith('- '))
        .map((l) => cut(l.slice(2).trim(), REPLY_OFFERED_CHARS))
        .filter(Boolean)
    )
  ].slice(0, MOST_REPLIES_OFFERED)
  if (!question || options.length < 2) return undefined
  return { question: cut(question, QUESTION_CHARS), options }
}

export interface Waiter {
  sessionId: string
  background?: BackgroundItem[]
}

export interface Helper {
  sessionId: string
  alive: boolean
  status?: string
}

export function waitsOnOtherWork(
  me: Waiter,
  helpers: readonly Helper[],
  parentOf: (sessionId: string) => string | undefined,
  owedOrMessaged: (sessionId: string) => boolean
): boolean {
  // CODEX§4 AGY§13
  if (me.background?.some((b) => b.kind === 'monitor')) return true
  if (owedOrMessaged(me.sessionId)) return true
  return helpers.some(
    (h) =>
      h.alive &&
      (h.status === 'working' || h.status === 'approval') &&
      parentOf(h.sessionId) === me.sessionId
  )
}

export async function judgeTurn(assist: Assist, turn: Turn): Promise<Verdict> {
  const reply = turn.reply.trim()
  if (!reply) return { news: false }
  if (saysNothingForYou(reply)) return { news: true }
  const answer = await assist({
    system: SYSTEM,
    prompt: `${INSTRUCTIONS}\n\nAgent replied:\n${reply.slice(-REPLY_CHARS_SENT)}`
  })
  const lines = (answer ?? '')
    .trim()
    .split('\n')
    .map((l) => l.trim())
  if (lines[0].toUpperCase().startsWith('NEWS')) return { news: true }
  const choices = choicesIn(lines.slice(1))
  return { news: false, ...(choices && { choices }) }
}

export interface NewsJudgeDeps {
  judge(turn: Turn): Promise<Verdict>
  awaitingVerdict(tabId: string): boolean
  markFyi(tabId: string): void
  judged(tabId: string, verdict: Verdict): void
}

export class NewsJudge {
  private round = new Map<string, number>()
  private unjudged = new Map<string, Turn>()
  private beingJudged = new Map<string, number>()

  constructor(private readonly d: NewsJudgeDeps) {}

  judging(tabId: string): boolean {
    return this.beingJudged.has(tabId)
  }

  turnEnded(tabId: string, turn: Turn): void {
    this.nextRound(tabId)
    this.unjudged.set(tabId, turn)
    this.marked(tabId)
  }

  prompted(tabId: string): void {
    this.nextRound(tabId)
    this.unjudged.delete(tabId)
    this.beingJudged.delete(tabId)
  }

  marked(tabId: string): void {
    const turn = this.unjudged.get(tabId)
    if (!turn || !this.d.awaitingVerdict(tabId)) return
    this.unjudged.delete(tabId)
    const round = this.round.get(tabId) ?? 0
    this.beingJudged.set(tabId, round)
    void this.d
      .judge(turn)
      .catch((): Verdict => ({ news: false }))
      .then((verdict) => {
        if (verdict.news && this.round.get(tabId) === round) this.d.markFyi(tabId)
        if (this.beingJudged.get(tabId) !== round) return
        this.beingJudged.delete(tabId)
        this.d.judged(tabId, verdict)
      })
  }

  private nextRound(tabId: string): void {
    this.round.set(tabId, (this.round.get(tabId) ?? 0) + 1)
  }
}
