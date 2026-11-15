import fs from 'fs'
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

export function openDropHandler(
  open: (target: string) => void
): (obj: unknown, full: string) => void {
  return (obj, full) => {
    fs.rm(full, { force: true }, () => {})
    const target = openDropTarget((obj && typeof obj === 'object' ? obj : {}) as OpenDrop)
    if (target) open(target)
  }
}
