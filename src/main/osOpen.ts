import fs from 'fs'
import path from 'path'
import { shell } from 'electron'
import { canOpenExternally } from '@shared/browserRoute'

/**
 * The single choke point for leaving Koloft (TEST-2). Everything the OS is ever handed
 * passes through here, so "nothing was forced out of Koloft" is one observation.
 *
 * Resolves to Electron's own error string for a `path` open (empty when it worked, and
 * empty for the other kinds, which report nothing) — `shell.openPath` resolves rather
 * than rejects on failure, and the self-update fallback has to tell the two apart.
 */
export async function leaveForOS(target: string, kind: 'url' | 'path' | 'reveal'): Promise<string> {
  const log = process.env.KOLOFT_EXTERNAL_OPENS_FILE
  if (log) fs.appendFile(log, `${target}\n`, () => {})
  // E2E sets this: shell.openPath/openExternal go through LaunchServices, not PATH, so
  // the suite's fake `open` can't catch it — a test must never launch real apps, and a
  // Finder window raised behind the app's back is a focus steal.
  if (process.env.KOLOFT_SUPPRESS_OS_OPEN) return ''
  if (kind === 'url') void shell.openExternal(target)
  else if (kind === 'reveal') shell.showItemInFolder(target)
  else return await shell.openPath(target)
  return ''
}

/** D15's ↗ and every other "the user chose to leave" path. SEC-4: the escape hatch is a
 *  choice about http(s)/mailto/tel, never a way to have Koloft launch an arbitrary
 *  handler on someone else's word. */
export function openUrlExternally(url: string): void {
  if (canOpenExternally(url)) void leaveForOS(url, 'url')
}

/** OS-default open for a request Koloft intercepted but cannot deliver in-app. A URL only
 *  leaves through the SEC-4 whitelist, so no path into here can make Koloft launch
 *  `file:///Applications/Evil.app` on someone else's word. */
export function osOpenFallback(target: string): void {
  if (path.isAbsolute(target)) void leaveForOS(target, 'path')
  else openUrlExternally(target)
}
