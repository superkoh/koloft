import { GLOBAL_SCOPE } from '@shared/scope'
import { cleanOwnPick } from '@shared/sessionPicks'
import { isRecord, stringsIn } from '@shared/workbenchState'
import { butlerName, butlerSetting } from './names'
import { cleanVersions } from '@core/ownerInstructions'
import { setting, type SettingKeys } from '@core/settings'
import {
  DEFAULT_BUTLER_NAME,
  isKnownBy,
  type ButlerSession,
  type ButlerSetting,
  type KnownBy,
  type PluginsOn,
  type PluginsSeen
} from './types'

function sanitizeButler(raw: unknown): ButlerSetting {
  const doc = isRecord(raw) ? raw : {}
  const instructions = cleanVersions(doc.instructions)
  return {
    ...butlerSetting(butlerName(doc.name), stringsIn(doc.formerNames).map(butlerName)),
    ...(instructions.length > 0 && { instructions })
  }
}

function knownLists(records: readonly object[]): Record<KnownBy, string[]> {
  const lists: Record<KnownBy, string[]> = {}
  for (const record of records)
    for (const [key, value] of Object.entries(record))
      if (isKnownBy(key)) lists[key] = [...new Set([...(lists[key] ?? []), ...stringsIn(value)])]
  return Object.fromEntries(Object.entries(lists).filter(([, keys]) => keys.length))
}

function cleanPluginsSeen(raw: unknown): PluginsSeen | undefined {
  if (!isRecord(raw) || typeof raw.key !== 'string' || !isRecord(raw.on)) return undefined
  const on = Object.entries(raw.on).filter(([, value]) => typeof value === 'boolean')
  return { key: raw.key, on: Object.fromEntries(on) as PluginsOn }
}

function cleanSession(raw: Record<string, unknown>): ButlerSession {
  const { lastSessionKey } = raw
  const carried = cleanOwnPick(raw.carried)
  const pluginsSeen = cleanPluginsSeen(raw.pluginsSeen)
  return {
    sessionIds: stringsIn(raw.sessionIds),
    ...(typeof lastSessionKey === 'string' ? { lastSessionKey } : {}),
    ...(pluginsSeen ? { pluginsSeen } : {}),
    ...knownLists([raw]),
    ...(carried ? { carried } : {})
  }
}

function mergedSessions(sessions: ButlerSession[]): ButlerSession {
  const last = sessions.find((s) => s.lastSessionKey)
  const pluginsSeen = sessions.find((s) => s.pluginsSeen)?.pluginsSeen
  return {
    sessionIds: [...new Set(sessions.flatMap((s) => s.sessionIds))],
    ...(last?.lastSessionKey ? { lastSessionKey: last.lastSessionKey } : {}),
    ...(pluginsSeen ? { pluginsSeen } : {}),
    ...knownLists(sessions),
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
  }),
  ownerAsleepSince: setting<number | null>({
    default: null,
    clean: (raw) => raw as number | null
  })
} satisfies SettingKeys
