import type { SessionInfo } from '@shared/types'

export interface AgentReply {
  text: string
  exit: number
}

export interface AgentCaller {
  tabId: string
  cwd: string
  session: SessionInfo
}

export type AgentVerb = (args: string[], caller: AgentCaller) => AgentReply | Promise<AgentReply>

export const EXIT_USAGE = 2

export const NOT_PINNED = 'koloft: pin this workspace in the sidebar first.'

export function answered(text: string): AgentReply {
  return { text, exit: 0 }
}

export function refused(text: string, exit = 1): AgentReply {
  return { text, exit }
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string }

export function fail<T>(error: string): Parsed<T> {
  return { ok: false, error }
}

export function splitAtDashes(args: string[]): { before: string[]; after: string } {
  const dashes = args.indexOf('--')
  if (dashes < 0) return { before: args, after: '' }
  return {
    before: args.slice(0, dashes),
    after: args
      .slice(dashes + 1)
      .join(' ')
      .trim()
  }
}

const REPLY_CHARS_A_TURN_HOLDS = 20_000

export function cutForATurn(text: string, ifCut = ''): string {
  if (text.length <= REPLY_CHARS_A_TURN_HOLDS) return text
  return `${text.slice(0, REPLY_CHARS_A_TURN_HOLDS)}\n[koloft: cut at ${REPLY_CHARS_A_TURN_HOLDS} characters${ifCut}]`
}
