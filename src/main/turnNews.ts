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

interface LastTurn {
  turn: Turn
  asked?: boolean
  news?: boolean
}

export class NewsJudge {
  private last = new Map<string, LastTurn>()

  constructor(private readonly d: NewsJudgeDeps) {}

  turnEnded(tabId: string, turn: Turn): void {
    this.last.set(tabId, { turn })
    this.marked(tabId)
  }

  prompted(tabId: string): void {
    this.last.delete(tabId)
  }

  marked(tabId: string): void {
    const last = this.last.get(tabId)
    if (!last || !this.d.awaitingVerdict(tabId)) return
    if (last.news) return this.d.markFyi(tabId)
    if (last.asked) return
    last.asked = true
    void this.d.isNews(last.turn).then((news) => {
      last.news = news
      if (news && this.last.get(tabId) === last) this.d.markFyi(tabId)
    })
  }
}
