import fs from 'fs'
import path from 'path'
import { shell } from 'electron'
import { canOpenExternally } from '@shared/browserRoute'

export async function leaveForOS(target: string, kind: 'url' | 'path' | 'reveal'): Promise<string> {
  const log = process.env.KOLOFT_EXTERNAL_OPENS_FILE
  if (log) fs.appendFile(log, `${target}\n`, () => {})
  // PLATFORM§4
  if (process.env.KOLOFT_SUPPRESS_OS_OPEN) return ''
  if (kind === 'url') void shell.openExternal(target)
  else if (kind === 'reveal') shell.showItemInFolder(target)
  // PLATFORM§4
  else return await shell.openPath(target)
  return ''
}

export function openUrlExternally(url: string): void {
  if (canOpenExternally(url)) void leaveForOS(url, 'url')
}

export function osOpenFallback(target: string): void {
  if (path.isAbsolute(target)) void leaveForOS(target, 'path')
  else openUrlExternally(target)
}
