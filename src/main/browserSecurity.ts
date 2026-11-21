import path from 'path'
import { BROWSER_PARTITION } from '@shared/types'
import { isUnderAnyRoot } from '@core/isUnderAnyRoot'

export function isAppNavigation(target: string, appUrl: string): boolean {
  let to: URL
  let app: URL
  try {
    to = new URL(target)
    app = new URL(appUrl)
  } catch {
    return false
  }
  if (app.protocol === 'file:') return to.protocol === 'file:' && to.pathname === app.pathname
  return to.protocol === app.protocol && to.host === app.host
}

// PLATFORM§8
export interface GuestAttachPrefs {
  preload?: string
  nodeIntegration?: boolean
  contextIsolation?: boolean
  webSecurity?: boolean
  disablePopups?: boolean
  autoplayPolicy?: string
  nodeIntegrationInSubFrames?: boolean
}

export function enforceGuestAttach(
  prefs: GuestAttachPrefs,
  params: Record<string, string>,
  hostPreload: string
): boolean {
  prefs.nodeIntegration = false
  prefs.contextIsolation = true
  prefs.webSecurity = true
  // PLATFORM§13
  prefs.autoplayPolicy = 'document-user-activation-required'
  if (!isGuestPreload(prefs.preload, hostPreload)) delete prefs.preload
  const browserGuest = params.partition === BROWSER_PARTITION
  // PLATFORM§8
  prefs.disablePopups = !browserGuest
  // PLATFORM§14
  prefs.nodeIntegrationInSubFrames = browserGuest
  return browserGuest || (params.src ?? '').toLowerCase().startsWith('koloft-file://')
}

function isGuestPreload(preload: string | undefined, hostPreload: string): boolean {
  if (!preload) return false
  const host = path.resolve(hostPreload)
  return path.resolve(preload) !== host && isUnderAnyRoot(preload, [path.dirname(host)])
}
