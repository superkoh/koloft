import fs from 'fs'
import path from 'path'
import { AGENT_GUIDE } from '@shared/agentGuide'
import { watchJsonDrops, writeWholeBeforeVisible } from './jsonDrops'
import { tabInstancePid } from './ptyManager'

export interface AgentRequest {
  tabId?: string
  argv: string[]
  cwd: string
}

export interface AgentReply {
  ok: boolean
  text: string
  exit: number
}

export interface AgentCaller {
  tabId: string
  cwd: string
}

export type AgentVerb = (args: string[], caller: AgentCaller) => AgentReply | Promise<AgentReply>
export type AgentVerbs = Record<string, AgentVerb>

export const EXIT_USAGE = 2

export function answered(text: string): AgentReply {
  return { ok: true, text, exit: 0 }
}

export function refused(text: string, exit = 1): AgentReply {
  return { ok: false, text, exit }
}

export const BUILTIN_VERBS: AgentVerbs = {
  help: () => answered(AGENT_GUIDE)
}

export const NOT_PINNED = 'koloft: pin this workspace in the sidebar first.'

export const AGENT_TOOLS_OFF =
  "koloft: Koloft's agent tools are off for this session. The owner can turn them on in Koloft's Settings."
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
    cwd: r.cwd
  }
}

export async function dispatchAgent(
  verbs: AgentVerbs,
  argv: string[],
  caller: AgentCaller
): Promise<AgentReply> {
  const [verb = 'help', ...rest] = argv
  const run = Object.hasOwn(verbs, verb) ? verbs[verb] : undefined
  if (!run)
    return refused(
      `koloft: there is no "${verb}" command. Run "koloft help" to see the commands.`,
      EXIT_USAGE
    )
  try {
    return await run(rest, caller)
  } catch (error) {
    return refused(`koloft: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function replyJson(reply: AgentReply): string {
  return JSON.stringify({ ok: reply.ok, exit: reply.exit, text: reply.text })
}

export interface TabFacts {
  util: boolean
  ownerTabId?: string
}

export type CallerTab = { tabId: string } | 'another-instance' | 'unknown'

export function callerTab(
  tabId: string,
  tab: (id: string) => TabFacts | undefined,
  ownPid: number,
  alive: (pid: number) => boolean
): CallerTab {
  const facts = tab(tabId)
  if (!facts) {
    const owner = tabInstancePid(tabId)
    return owner !== null && owner !== ownPid && alive(owner) ? 'another-instance' : 'unknown'
  }
  return { tabId: facts.util && facts.ownerTabId ? facts.ownerTabId : tabId }
}

export interface AgentRequestDeps {
  verbs: AgentVerbs
  tab(tabId: string): TabFacts | undefined
  enabled(tabId: string): boolean
  alive(pid: number): boolean
}

const REQUEST_NAME = /^req-([A-Za-z0-9-]+)\.json$/

export class AgentRequests {
  private claimed = new Set<string>()

  constructor(private deps: AgentRequestDeps) {}

  watch(dir: string): fs.FSWatcher | null {
    return watchJsonDrops(dir, (name) =>
      REQUEST_NAME.test(name) ? (obj): void => void this.answer(dir, name, obj) : null
    )
  }

  answer(dir: string, name: string, raw: unknown): Promise<void> {
    const req = parseAgentRequest(raw)
    if (!req?.tabId) return this.settle(dir, name, req, undefined)
    // ADR-0004
    const caller = callerTab(req.tabId, (id) => this.deps.tab(id), process.pid, this.deps.alive)
    if (caller === 'another-instance') return Promise.resolve()
    return this.settle(dir, name, req, caller === 'unknown' ? undefined : caller.tabId)
  }

  answerFor(tabId: string | undefined, dir: string, name: string, raw: unknown): Promise<void> {
    return this.settle(dir, name, parseAgentRequest(raw), tabId)
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
    fs.rm(full, { force: true }, () => {})
    const reply = !req
      ? refused(UNREADABLE)
      : !tabId
        ? refused(UNKNOWN_TAB)
        : !this.deps.enabled(tabId)
          ? refused(AGENT_TOOLS_OFF)
          : await dispatchAgent(this.deps.verbs, req.argv, { tabId, cwd: req.cwd })
    try {
      writeWholeBeforeVisible(path.join(dir, `res-${id}.json`), replyJson(reply))
    } catch {}
  }
}
