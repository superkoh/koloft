import fs from 'fs'
import path from 'path'
import { REMOTE_HOOK_DIR } from './remote/paths'
import { writeWholeBeforeVisible } from './jsonDrops'
import { OWNER_WORDS_QUOTED_CHARS } from '@core/ownerWords'

export const NOTICE_ENV = 'KOLOFT_NOTICE'
export const NOTICE_SUFFIX = '.notice'
export const NOTICE_THIS_TURN = '.turn'

export { OWNER_ASLEEP_FILE } from '@core/presence'

// ADR-0028
export const SENT_WORDS_SUFFIX = '.discord-said'
// ADR-0028
export const SENT_IDS_SUFFIX = '.discord-ids'

export const HANDED_OVER_TASK_COMES_FIRST = '.task-first'

export const STATUS_LOG_SUFFIX = '.status.jsonl'

export function statusLogOf(regDir: string, tabId: string): string {
  return path.join(regDir, `${tabId}${STATUS_LOG_SUFFIX}`)
}

function quotedOwnerWords(ownerWords: string): string {
  return JSON.stringify(ownerWords.slice(0, OWNER_WORDS_QUOTED_CHARS)).slice(1, -1)
}

// ADR-0031
export function seedOwnerWords(said: string, ownerWords: string): void {
  fs.writeFileSync(said, quotedOwnerWords(ownerWords))
}

// ADR-0031
export function handedOverOwnerWordsFiles(ownerWords: string): Record<string, string> {
  return { '': quotedOwnerWords(ownerWords), [HANDED_OVER_TASK_COMES_FIRST]: '' }
}

// ADR-0031
export function seedHandedOverOwnerWords(said: string, ownerWords: string): void {
  for (const [suffix, text] of Object.entries(handedOverOwnerWordsFiles(ownerWords)))
    fs.writeFileSync(said + suffix, text)
}

export function sentIdsFile(regDir: string, tabId: string): string {
  return path.join(regDir, `${tabId}${SENT_IDS_SUFFIX}`)
}

export function remoteSentIdsFile(tabId: string): string {
  return `${REMOTE_HOOK_DIR}/${tabId}${SENT_IDS_SUFFIX}`
}

export function sentWordsFile(regDir: string, tabId: string): string {
  return path.join(regDir, `${tabId}${SENT_WORDS_SUFFIX}`)
}

export function saidFile(regDir: string, tabId: string): string {
  return path.join(regDir, `${tabId}.said`)
}

export function noticeFile(regDir: string, tabId: string): string {
  return path.join(regDir, `${tabId}${NOTICE_SUFFIX}`)
}

export function remoteNoticeFile(tabId: string): string {
  return `${REMOTE_HOOK_DIR}/${tabId}${NOTICE_SUFFIX}`
}

export function remoteSentWordsFile(tabId: string): string {
  return `${REMOTE_HOOK_DIR}/${tabId}${SENT_WORDS_SUFFIX}`
}

export function sentWordsLine(text: string): string {
  return `${JSON.stringify(text).slice(1, -1)}\n`
}

export function ownerAsleepMarker(awakeTabs: string[]): string {
  return awakeTabs.map((tabId) => `${tabId}${NOTICE_SUFFIX}\n`).join('')
}

export function noticeLine(text: string): string {
  return JSON.stringify(`${text}\n\n`).slice(1, -1)
}

export type NoticeKept = 'fresh' | 'merged'

export interface NoticeFile {
  leave(fresh: string, merged?: string): Promise<NoticeKept>
  drop(): Promise<void>
}

export function localNotice(file: string): NoticeFile {
  return {
    leave: async (fresh, merged) => {
      const kept: NoticeKept = merged !== undefined && fs.existsSync(file) ? 'merged' : 'fresh'
      writeWholeBeforeVisible(file, noticeLine(kept === 'merged' ? merged! : fresh))
      return kept
    },
    drop: async () => {
      for (const f of [file, `${file}${NOTICE_THIS_TURN}`]) fs.rmSync(f, { force: true })
    }
  }
}
