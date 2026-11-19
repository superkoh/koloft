import fs from 'fs'
import path from 'path'
import type { SessionInfo } from '@shared/types'
import { refused, splitAtDashes, type AgentReply } from '@core/command'
import type { Commands } from '@core/commands'
import { watchAndSweepJsonDrops, writeWholeBeforeVisible } from './jsonDrops'
import { anotherLiveInstanceOwns } from './ptyManager'

export interface AgentRequest {
  tabId?: string
  argv: string[]
  cwd: string
  pid?: number
}

export const AGENT_TOOLS_OFF =
  "koloft: Koloft's agent tools are not on for this session: the owner turned them off in Koloft's Settings."
const UNKNOWN_TAB = 'koloft: Koloft does not know this session.'
const UNREADABLE = 'koloft: Koloft could not read this request.'

export function parseAgentRequest(raw: unknown): AgentRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.argv) || !r.argv.every((a) => typeof a === 'string')) return null
  if (typeof r.cwd !== 'string') return null
  return {
    tabId: typeof r.tabId === 'string' && r.tabId ? r.tabId : undefined,
    argv: r.argv,
    cwd: r.cwd,
    ...(typeof r.pid === 'number' ? { pid: r.pid } : {})
  }
}

function asksForHelp(argv: string[]): boolean {
  return splitAtDashes(argv).before.includes('--help')
}

export function replyJson(reply: AgentReply): string {
  return JSON.stringify({ exit: reply.exit, text: reply.text })
}

export interface TabFacts {
  util: boolean
  ownerTabId?: string
}

export type CallerTab = { tabId: string } | 'another-instance' | 'unknown'

export function tabSpokenFor(tabId: string, facts: TabFacts): string {
  return facts.util && facts.ownerTabId ? facts.ownerTabId : tabId
}

export function callerTab(
  tabId: string,
  tab: (id: string) => TabFacts | undefined,
  alive: (pid: number) => boolean
): CallerTab {
  const facts = tab(tabId)
  if (!facts) return anotherLiveInstanceOwns(tabId, alive) ? 'another-instance' : 'unknown'
  return { tabId: tabSpokenFor(tabId, facts) }
}

export interface AgentRequestDeps {
  commands: Commands
  tab(tabId: string): TabFacts | undefined
  session(tabId: string): SessionInfo | undefined
  enabled(tabId: string): boolean
  alive(pid: number): boolean
}

export const REQUEST_NAME = /^req-([A-Za-z0-9-]+)\.json$/
export const AGENT_DROP_NAME = /^(req|res)-[A-Za-z0-9-]+\.json$/
const CLAIM_OUTLIVES_DROP_REREADS_MS = 500

export class AgentRequests {
  private claimed = new Set<string>()

  constructor(private deps: AgentRequestDeps) {}

  watch(dir: string): fs.FSWatcher | null {
    return watchAndSweepJsonDrops(dir, (name) =>
      REQUEST_NAME.test(name) ? (obj): void => void this.answer(dir, name, obj) : null
    )
  }

  answer(dir: string, name: string, raw: unknown): Promise<void> {
    const req = parseAgentRequest(raw)
    if (!req?.tabId) return this.settle(dir, name, req, undefined)
    const caller = callerTab(req.tabId, (id) => this.deps.tab(id), this.deps.alive)
    if (caller === 'another-instance') return Promise.resolve()
    return this.settle(dir, name, req, caller === 'unknown' ? undefined : caller.tabId)
  }

  answerFor(tabId: string | undefined, dir: string, name: string, raw: unknown): Promise<void> {
    return this.settle(dir, name, parseAgentRequest(raw), tabId)
  }

  replyFor(tabId: string | undefined, raw: unknown): Promise<AgentReply> {
    return this.replyTo(parseAgentRequest(raw), tabId)
  }

  private async settle(
    dir: string,
    name: string,
    req: AgentRequest | null,
    tabId: string | undefined
  ): Promise<void> {
    const id = REQUEST_NAME.exec(name)?.[1]
    const full = path.join(dir, name)
    if (!id || this.claimed.has(full)) return
    this.claimed.add(full)
    fs.rm(full, { force: true }, () =>
      setTimeout(() => this.claimed.delete(full), CLAIM_OUTLIVES_DROP_REREADS_MS)
    )
    const pid = req?.pid
    const stillWaiting = pid === undefined ? undefined : () => this.deps.alive(pid)
    const reply = await this.replyTo(req, tabId, stillWaiting)
    if (stillWaiting && !stillWaiting()) return
    try {
      writeWholeBeforeVisible(path.join(dir, `res-${id}.json`), replyJson(reply))
    } catch {}
  }

  private async replyTo(
    req: AgentRequest | null,
    tabId: string | undefined,
    stillWaiting?: () => boolean
  ): Promise<AgentReply> {
    if (!req) return refused(UNREADABLE)
    if (!tabId) return refused(UNKNOWN_TAB)
    if (!this.deps.enabled(tabId)) return refused(AGENT_TOOLS_OFF)
    const session = this.deps.session(tabId)
    if (!session) return refused(UNKNOWN_TAB)
    const [verb = 'help', ...args] = asksForHelp(req.argv) ? ['help'] : req.argv
    return this.deps.commands.dispatch(verb, args, {
      tabId,
      cwd: req.cwd,
      session,
      ...(stillWaiting && { stillWaiting })
    })
  }
}
