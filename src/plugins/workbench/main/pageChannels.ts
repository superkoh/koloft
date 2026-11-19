import type { MainIpc } from '@core/ipc'
import type {
  BrowserDialogAnswer,
  BrowserOpenRequest,
  BrowserPagesInUse,
  ExtensionPermissionRequest,
  ExtensionPopupAnchor
} from '@shared/types'
import { CHANNELS } from '../shared/ipc'
import {
  answerPermissionRequest,
  beforeActivate,
  dismissActionPopup,
  listExtensions,
  reportActiveGuest,
  reportOpenDropped,
  setExtensionEnabled,
  uninstallExtension
} from './extensionManager'
import { hostComposing } from './hostComposition'
import type { PageDialogs } from './pageDialogs'
import type { PageDownloads } from './pageDownloads'
import type { PageRouting } from './pageRouting'
import type { PageTools } from './pageTools'
import type { SitePermissions } from './sitePermissions'
import type { WebPages } from './webPages'

export interface PageChannelDeps {
  webPages: WebPages
  sitePermissions: SitePermissions
  pageDialogs: PageDialogs
  pageDownloads: PageDownloads
  pageRouting: PageRouting
  pageTools: PageTools
  openExternal(url: string): void
}

export function registerPageChannels(ipc: MainIpc, deps: PageChannelDeps): void {
  const { webPages, sitePermissions, pageDialogs, pageDownloads, pageRouting, pageTools } = deps
  ipc.onEvent(CHANNELS.guestLimit, (e) => {
    e.returnValue = pageTools.guestLimit()
  })
  ipc.on(CHANNELS.overlayGuest, (guestId: unknown, on: unknown) =>
    webPages.overlayReported(guestId, on)
  )
  ipc.on(CHANNELS.guestOwner, (guestId: unknown, ownerTabId: unknown) => {
    if (typeof guestId !== 'number' || typeof ownerTabId !== 'string') return
    webPages.recordOwner(guestId, ownerTabId)
  })
  ipc.on(CHANNELS.overlayReady, () => pageRouting.overlayReady())
  ipc.on(CHANNELS.hostComposing, (on: unknown) => hostComposing(on === true))
  ipc.on(CHANNELS.openExternal, (url: string) => {
    if (typeof url === 'string') deps.openExternal(url)
  })
  ipc.on(CHANNELS.devtools, (id: unknown) => pageTools.devtools(id))
  ipc.handle(CHANNELS.pickElement, (id: unknown, tabId: unknown) => pageTools.pick(id, tabId))
  ipc.on(CHANNELS.pickStop, (id: unknown) => pageTools.pickStop(id))
  ipc.on(CHANNELS.permissionAnswer, (id: unknown, granted: unknown) =>
    sitePermissions.answer(id, granted)
  )
  ipc.on(CHANNELS.permissionCancel, (id: unknown) => sitePermissions.cancel(id))
  ipc.on(CHANNELS.downloadCancel, (id: unknown) => pageDownloads.cancel(id))
  ipc.on(CHANNELS.downloadRetry, (id: unknown) => pageDownloads.retry(id))
  ipc.on(CHANNELS.copyText, (text: unknown) => pageTools.copyText(text))
  ipc.on(CHANNELS.setMuted, (guestId: unknown, muted: unknown) =>
    pageTools.setMuted(guestId, muted)
  )
  ipc.handle(CHANNELS.certProceed, (url: string) => pageDialogs.certProceed(url))
  ipc.handle(CHANNELS.clearData, () => pageDialogs.clearSiteData())
  ipc.on(CHANNELS.authAnswer, (id: string, answer: BrowserDialogAnswer) =>
    pageDialogs.authAnswer(id, answer)
  )
  ipc.onEvent(
    CHANNELS.jsDialog,
    (e, request: { kind?: unknown; message?: unknown; defaultValue?: unknown }) =>
      pageDialogs.jsDialog(e, request)
  )
  ipc.on(CHANNELS.jsDialogAnswer, (id: string, answer: BrowserDialogAnswer) =>
    pageDialogs.jsDialogAnswer(id, answer)
  )
  ipc.onEvent(CHANNELS.linkBlocked, (e, url: unknown) => pageRouting.linkBlocked(e, url))
  ipc.onEvent(CHANNELS.permissionUndecided, (e, name: unknown) =>
    sitePermissions.undecided(e, name)
  )
  ipc.onEvent(CHANNELS.openBackground, (e, url: unknown) => pageRouting.openBackground(e, url))

  ipc.handle(CHANNELS.extList, () =>
    listExtensions().map(({ id, name, version, enabled }) => ({ id, name, version, enabled }))
  )
  ipc.handle(CHANNELS.extSetEnabled, (id: unknown, enabled: unknown) => {
    if (typeof id !== 'string' || typeof enabled !== 'boolean') return
    return setExtensionEnabled(id, enabled)
  })
  ipc.handle(CHANNELS.extUninstall, (id: unknown) => {
    if (typeof id === 'string') uninstallExtension(id)
  })
  ipc.on(CHANNELS.extActiveGuest, (id: unknown, url: unknown) => {
    if (typeof id === 'number') reportActiveGuest(id, typeof url === 'string' ? url : '')
  })
  ipc.on(CHANNELS.extOpenDropped, (url: unknown) => {
    if (typeof url === 'string') reportOpenDropped(url)
  })
  ipc.handle(CHANNELS.extPopupAnchor, (rect: ExtensionPopupAnchor) => {
    if (!rect) return
    const finite = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v)
    // PLATFORM§5
    if (finite(rect.x) && finite(rect.y) && finite(rect.width) && finite(rect.height)) {
      beforeActivate(rect)
    }
  })
  ipc.on(CHANNELS.extDismissPopup, () => dismissActionPopup())
  ipc.on(CHANNELS.extPermissionAnswer, (id: unknown, granted: unknown) => {
    if (typeof id === 'string') answerPermissionRequest(id, granted === true)
  })
}

export const pagePushes = (ipc: MainIpc) => ({
  open: (request: BrowserOpenRequest): boolean => ipc.push(CHANNELS.pageOpen, request),
  memoryCritical: (inUse: BrowserPagesInUse): boolean => ipc.push(CHANNELS.memoryCritical, inUse),
  extensionsChanged: (): boolean => ipc.push(CHANNELS.extChanged),
  extensionAsks: (request: ExtensionPermissionRequest): boolean =>
    ipc.push(CHANNELS.extPermissionRequest, request)
})
