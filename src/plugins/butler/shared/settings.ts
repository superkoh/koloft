import { GLOBAL_SCOPE } from '@shared/conductors'
import { cleanOwnPick } from '@shared/sessionPicks'
import { isRecord, stringsIn } from '@shared/workbenchState'
import { butlerName, butlerSetting } from './names'
import { cleanVersions } from './instructions'
import { setting, type SettingKeys } from '@core/settings'
import { DEFAULT_BUTLER_NAME, type ButlerSession, type ButlerSetting } from './types'

function sanitizeButler(raw: unknown): ButlerSetting {
  const doc = isRecord(raw) ? raw : {}
  const instructions = cleanVersions(doc.instructions)
  return {
    ...butlerSetting(butlerName(doc.name), stringsIn(doc.formerNames).map(butlerName)),
    ...(instructions.length > 0 && { instructions })
  }
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

function sanitizeButlerSession(raw: unknown, olderRecords: readonly unknown[]): ButlerSession {
  return mergedSessions([
    ...(isRecord(raw) ? [cleanSession(raw)] : []),
    ...olderRecords
      .filter(isRecord)
      .filter((r) => r.scope === GLOBAL_SCOPE)
      .map(cleanSession)
  ])
}

export const SETTINGS = {
  butler: setting<ButlerSetting>({
    default: { name: DEFAULT_BUTLER_NAME, formerNames: [] },
    clean: sanitizeButler,
    keptOnReset: true
  }),
  butlerSession: setting<ButlerSession>({
    default: { sessionIds: [] },
    clean: sanitizeButlerSession,
    keptOnReset: true,
    writtenByMainOnly: true,
    retires: { assistSessions: (raw) => (Array.isArray(raw) ? raw : []) }
  })
} satisfies SettingKeys
