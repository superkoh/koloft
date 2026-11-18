import { GLOBAL_SCOPE } from '@shared/conductors'
import { cleanOwnPick } from '@shared/sessionPicks'
import { isRecord, stringsIn } from '@shared/workbenchState'
import { butlerName, butlerSetting } from './names'
import type { ButlerSession, ButlerSetting } from './types'

export function sanitizeButler(raw: unknown): ButlerSetting {
  const doc = isRecord(raw) ? raw : {}
  return butlerSetting(butlerName(doc.name), stringsIn(doc.formerNames).map(butlerName))
}

function cleanSession(raw: Record<string, unknown>): ButlerSession {
  const { lastSessionKey } = raw
  const knowsTodo = stringsIn(raw.knowsTodo)
  const carried = cleanOwnPick(raw.carried)
  return {
    sessionIds: stringsIn(raw.sessionIds),
    ...(typeof lastSessionKey === 'string' ? { lastSessionKey } : {}),
    ...(knowsTodo.length ? { knowsTodo } : {}),
    ...(carried ? { carried } : {})
  }
}

function mergedSessions(sessions: ButlerSession[]): ButlerSession {
  const last = sessions.find((s) => s.lastSessionKey)
  const knowsTodo = [...new Set(sessions.flatMap((s) => s.knowsTodo ?? []))]
  return {
    sessionIds: [...new Set(sessions.flatMap((s) => s.sessionIds))],
    ...(last?.lastSessionKey ? { lastSessionKey: last.lastSessionKey } : {}),
    ...(knowsTodo.length ? { knowsTodo } : {}),
    ...(last?.carried ? { carried: last.carried } : {})
  }
}

export function sanitizeButlerSession(
  raw: unknown,
  legacyAssistSessions: unknown,
  keptByOtherPlugins: Record<string, unknown>[]
): ButlerSession {
  const legacy = Array.isArray(legacyAssistSessions) ? legacyAssistSessions : []
  return mergedSessions([
    ...(isRecord(raw) ? [cleanSession(raw)] : []),
    ...legacy.filter((r) => isRecord(r) && r.scope === GLOBAL_SCOPE).map(cleanSession),
    ...keptByOtherPlugins.map(cleanSession)
  ])
}
