import type { BackgroundItem } from '@shared/types'
import type { Turn } from '@shared/turns'
import type { Assist } from './assist'

const REPLY_CHARS_SENT = 4000

const SYSTEM = 'You decide whether a person has to act on what a coding agent just said.'

const INSTRUCTIONS = [
  'A coding agent just finished its turn and stopped. Read its last reply.',
  'Answer ACT if the reply asks the person anything: a question, an approval, a choice, information, a login, or a step only the person can do before the work goes on.',
  'Answer NEWS if the reply only reports: the work is done, or the agent is waiting on something else (another session, a background job, a build, a notice) and will carry on by itself, and it asks the person for nothing.',
  'When unsure, answer ACT.',
  'Reply with the one word ACT or NEWS.'
].join('\n')

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
  if (me.background?.some((b) => b.kind === 'monitor')) return true
  if (owedOrMessaged(me.sessionId)) return true
  return helpers.some(
    (h) =>
      h.alive &&
      (h.status === 'working' || h.status === 'approval') &&
      parentOf(h.sessionId) === me.sessionId
  )
}

export async function onlyNews(assist: Assist, turn: Turn): Promise<boolean> {
  const reply = turn.reply.trim()
  if (!reply) return false
  const answer = await assist({
    system: SYSTEM,
    prompt: `${INSTRUCTIONS}\n\nAgent replied:\n${reply.slice(-REPLY_CHARS_SENT)}`
  })
  return answer?.trim().toUpperCase().startsWith('NEWS') ?? false
}

export interface NewsJudgeDeps {
  isNews(turn: Turn): Promise<boolean>
  awaitingVerdict(tabId: string): boolean
  markFyi(tabId: string): void
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
  }

  marked(tabId: string): void {
    const turn = this.unjudged.get(tabId)
    if (!turn || !this.d.awaitingVerdict(tabId)) return
    this.unjudged.delete(tabId)
    const round = this.round.get(tabId) ?? 0
    this.beingJudged.set(tabId, round)
    void this.d
      .isNews(turn)
      .then((news) => {
        if (news && this.round.get(tabId) === round) this.d.markFyi(tabId)
      })
      .catch(() => undefined)
      .finally(() => {
        if (this.beingJudged.get(tabId) === round) this.beingJudged.delete(tabId)
      })
  }

  private nextRound(tabId: string): void {
    this.round.set(tabId, (this.round.get(tabId) ?? 0) + 1)
  }
}
