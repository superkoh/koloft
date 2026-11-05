import { InboxError, isState, type InboxCardInput } from '@shared/inbox'
import {
  answered,
  EXIT_USAGE,
  refused,
  splitAtDashes,
  type AgentCaller,
  type AgentReply,
  type AgentVerb
} from './agentRequests'
import type { Inbox } from './inbox'
import { KOLOFT_SOURCE } from './koloftInbox'

export const INBOX_USAGE =
  "koloft inbox: add <key> -- '<card JSON>' | update <key> -- '<fields JSON>' | move <key> <needs-you|in-progress|closed> [-- \"<status>\"] | delete <key> | list [<state>]"

export interface InboxVerbDeps {
  inbox: () => Inbox | null
  whereOf(caller: AgentCaller): Record<string, string>
}

function parseJson(text: string, what: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text)
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  } catch {}
  throw new InboxError(`koloft inbox ${what}: after -- give one JSON object`)
}

function warned(text: string, warnings: string[]): AgentReply {
  return answered(warnings.length ? `${text}\nNote: ${warnings.join('; ')}.` : text)
}

export function inboxVerb(d: InboxVerbDeps): AgentVerb {
  return (args, caller) => {
    const inbox = d.inbox()
    if (!inbox) return refused('koloft inbox: the Inbox is still starting. Try again in a moment.')
    const session = caller.session.sessionId || caller.tabId
    const me = { source: KOLOFT_SOURCE.id, as: session }
    const [sub, key, ...rest] = args
    const { before, after } = splitAtDashes(rest)
    try {
      if (sub === 'add' && key) {
        const card = parseJson(after, 'add') as unknown as InboxCardInput
        const out = inbox.add(me, {
          ...card,
          key,
          where: { ...d.whereOf(caller), ...card.where },
          session
        })
        return warned(out.created ? `Added card ${key}.` : `Replaced card ${key}.`, out.warnings)
      }
      if (sub === 'update' && key) {
        const out = inbox.update(me, key, parseJson(after, 'update'))
        return warned(`Updated card ${key}.`, out.warnings)
      }
      const [to] = before
      if (sub === 'move' && key && isState(to)) {
        inbox.move(me, key, { state: to, ...(after && { status: after }) })
        return answered(`Moved card ${key} to ${before[0]}.`)
      }
      if (sub === 'delete' && key) {
        inbox.delete(me, key)
        return answered(`Deleted card ${key}.`)
      }
      if (sub === 'list') {
        const mine = inbox.list(me, isState(key) ? key : undefined)
        return answered(
          mine.length
            ? mine
                .map(
                  (c) =>
                    `${c.key} · ${c.state}${c.status ? ` · ${c.status}` : ''}${c.press ? ` · ${c.press.step}` : ''} · ${c.title}`
                )
                .join('\n')
            : 'You have no cards in the Inbox.'
        )
      }
    } catch (e) {
      if (e instanceof InboxError) return refused(`koloft inbox: ${e.message}`)
      throw e
    }
    return refused(INBOX_USAGE, EXIT_USAGE)
  }
}
