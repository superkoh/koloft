import path from 'path'
import os from 'os'

export interface OpenDrop {
  tabId?: string
  openId?: string
  path?: string
  url?: string
  cwd?: string
}

export function openDropTarget(drop: OpenDrop): string {
  if (drop.url) return drop.url
  if (!drop.path) return ''
  return path.isAbsolute(drop.path) ? drop.path : path.resolve(drop.cwd || os.homedir(), drop.path)
}
