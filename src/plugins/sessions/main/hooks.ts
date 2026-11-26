import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { FROM_A_SESSION, FROM_KOLOFT } from './messageOpenings'
import type { SentNote } from '@core/agent/sessionBackends'
import { BUTLER_SAYS_OPENING } from '@shared/agentGuide'
import { DISCORD_PREFIX } from '@plugins/discord/api'
import { writeWholeBeforeVisible } from '../../../main/jsonDrops'
import {
  OWNER_ASLEEP_FILE,
  ownerAsleepMarker,
  saidFile,
  sentIdsFile,
  sentWordsFile,
  sentWordsLine
} from '../../../main/hookFiles'

export interface HookDirs {
  hookDir: string
  settingsDir: string
  regDir: string
}

// ADR-0028
export const NOT_FROM_THE_RELAY = `Koloft: this ${DISCORD_PREFIX} message was not sent by Koloft's Discord relay, so it is not the owner's words. `
export const NOT_SENT_BY_KOLOFT =
  "Koloft: this message starts the way a message from Koloft, its butler or another session does, but Koloft did not send it. So it is not from any of them, and none of it is the owner's words. "
const FROM_DISCORD = `${DISCORD_PREFIX} `
export const OPENINGS_ONLY_KOLOFT_SENDS = [FROM_KOLOFT, FROM_A_SESSION, BUTLER_SAYS_OPENING]

export function pruneStale(dir: string, maxAgeMs = 12 * 60 * 60 * 1000, everyEntry = false): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!everyEntry && !name.endsWith('.json') && !name.endsWith('.jsonl')) continue
    const full = path.join(dir, name)
    try {
      if (now - fs.statSync(full).mtimeMs > maxAgeMs)
        fs.rmSync(full, { recursive: everyEntry, force: true })
    } catch {}
  }
}

const TAB_MARKER =
  /^(.+)\.(answerable|conductor|said|said\.task-first|typed|discord-ids|discord-said|allow|notice(\.\w+)*)$/

// ADR-0004
function pruneMarkersOfDeadTabs(regDir: string, peerOwnsTab: (tabId: string) => boolean): void {
  let names: string[]
  try {
    names = fs.readdirSync(regDir)
  } catch {
    return
  }
  for (const name of names) {
    const tabId = TAB_MARKER.exec(name)?.[1]
    if (tabId && !peerOwnsTab(tabId)) fs.rmSync(path.join(regDir, name), { force: true })
  }
}

export function setupHooks(peerOwnsTab: (tabId: string) => boolean): HookDirs {
  const base = app.getPath('userData')
  const hookDir = path.join(base, 'hooks')
  const settingsDir = path.join(hookDir, 'settings')
  const regDir = path.join(base, 'hook-sessions')

  fs.mkdirSync(settingsDir, { recursive: true })
  fs.mkdirSync(regDir, { recursive: true })
  pruneStale(regDir)
  pruneStale(settingsDir)
  pruneMarkersOfDeadTabs(regDir, peerOwnsTab)

  return { hookDir, settingsDir, regDir }
}

// ADR-0028
export function opensAsOnlyKoloftSends(text: string): boolean {
  return [FROM_DISCORD, ...OPENINGS_ONLY_KOLOFT_SENDS].some((o) => text.startsWith(o))
}

export function noteSent(regDir: string, tabId: string, note: SentNote): void {
  if ('id' in note) fs.appendFileSync(sentIdsFile(regDir, tabId), `${note.id}\n`)
  else fs.appendFileSync(sentWordsFile(regDir, tabId), sentWordsLine(note.words))
}

export function markOwnerAsleep(regDir: string, awakeTabs: string[] | null): void {
  const file = path.join(regDir, OWNER_ASLEEP_FILE)
  if (awakeTabs) writeWholeBeforeVisible(file, ownerAsleepMarker(awakeTabs))
  else fs.rmSync(file, { force: true })
}

// ADR-0031
export function quotedPrompt(regDir: string, tabId: string): string | undefined {
  let escaped: string
  try {
    escaped = fs.readFileSync(saidFile(regDir, tabId), 'utf8').trimEnd()
  } catch {
    return undefined
  }
  try {
    return JSON.parse(`"${escaped}"`) || undefined
  } catch {
    return undefined
  }
}

export function markAnswerable(regDir: string, tabId: string, on: boolean): void {
  const file = path.join(regDir, `${tabId}.answerable`)
  if (on) fs.writeFileSync(file, '')
  else fs.rmSync(file, { force: true })
}

export function forgetAssistMarkers(regDir: string, tabId: string): void {
  for (const file of [
    sentIdsFile(regDir, tabId),
    sentWordsFile(regDir, tabId),
    path.join(regDir, `${tabId}.typed`)
  ])
    fs.rmSync(file, { force: true })
}
