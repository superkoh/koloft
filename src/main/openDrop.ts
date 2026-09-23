import path from 'path'
import os from 'os'

/** One `<openId>.json` the `open` shim drops for the app to consume. A target arrives
 *  as EITHER a url or a path, never both: the shim fills whichever field applies and
 *  leaves the other empty. */
export interface OpenDrop {
  tabId?: string
  openId?: string
  path?: string
  url?: string
  cwd?: string
}

/**
 * The target a drop is asking for, in the one form the router takes (IMPL-3). The cwd
 * prefix is filesystem-only: applying it to a url would produce `<cwd>/http:/host/…`,
 * a path nothing can resolve and a mistake nothing downstream could detect.
 */
export function openDropTarget(drop: OpenDrop): string {
  if (drop.url) return drop.url
  if (!drop.path) return ''
  return path.isAbsolute(drop.path) ? drop.path : path.resolve(drop.cwd || os.homedir(), drop.path)
}
