import fs from 'fs'
import { app, session, type OnBeforeRequestListenerDetails, type CallbackResponse } from 'electron'
import { BROWSER_PARTITION } from '@shared/types'
import { MACHINE_PAGE_SCHEME, PREVIEW_FILE_SCHEME } from '@shared/browserRoute'
import {
  chromeClientHints,
  isAttachmentResponse,
  standardUserAgent
} from '../../../main/browserSecurity'
import { directoryListingHtml, fileNotFoundHtml } from './dirListing'
import type { PageDownloads } from './pageDownloads'
import type { SitePermissions } from './sitePermissions'

export const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8' }

export interface BrowserPartitionDeps {
  machinePage(request: Request): Promise<Response>
  permissions: SitePermissions
  beforeRequest(
    details: OnBeforeRequestListenerDetails,
    callback: (response: CallbackResponse) => void
  ): void
  downloads: PageDownloads
  guestPreload: string
}

function localFilePath(url: string): string | null {
  try {
    const u = new URL(url)
    if (u.host && u.host !== 'localhost') return null
    return decodeURIComponent(u.pathname)
  } catch {
    return null
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(target)).isDirectory()
  } catch {
    return false
  }
}

export function setupBrowserPartition(d: BrowserPartitionDeps): void {
  const ses = session.fromPartition(BROWSER_PARTITION)
  ses.protocol.handle(MACHINE_PAGE_SCHEME, d.machinePage)
  ses.setPermissionRequestHandler((page, permission, callback, details) =>
    d.permissions.request(page, permission, callback, details)
  )
  ses.setPermissionCheckHandler((_wc, permission, _origin, details) =>
    d.permissions.check(permission, details)
  )
  ses.protocol.handle(PREVIEW_FILE_SCHEME, async () => new Response('Forbidden', { status: 403 }))
  // PLATFORM§12
  ses.protocol.handle('file', async (request) => {
    const target = localFilePath(request.url)
    if (target && (await isDirectory(target))) {
      const entries = (await fs.promises.readdir(target, { withFileTypes: true })).map((e) => ({
        name: e.name,
        isDir: e.isDirectory()
      }))
      return new Response(directoryListingHtml(target, entries), { headers: HTML_HEADERS })
    }
    try {
      return await ses.fetch(request, { bypassCustomProtocolHandlers: true })
    } catch (err) {
      if (!target || !String(err).includes('ERR_FILE_NOT_FOUND')) throw err
      return new Response(fileNotFoundHtml(target), { status: 404, headers: HTML_HEADERS })
    }
  })
  const guestUA = standardUserAgent(app.userAgentFallback, app.getName())
  // PLATFORM§14
  ses.setUserAgent(guestUA, app.getPreferredSystemLanguages().join(','))
  // PLATFORM§14
  app.userAgentFallback = guestUA
  const guestHints = chromeClientHints(guestUA)
  if (guestHints) {
    const managed = new Set(Object.keys(guestHints).map((k) => k.toLowerCase()))
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      if (!/^https:/i.test(details.url)) return callback({})
      const headers = details.requestHeaders
      for (const name of Object.keys(headers)) {
        if (managed.has(name.toLowerCase())) delete headers[name]
      }
      callback({ requestHeaders: { ...headers, ...guestHints } })
    })
  }
  ses.registerPreloadScript({
    type: 'frame',
    filePath: d.guestPreload
  })
  ses.webRequest.onBeforeRequest(d.beforeRequest)
  // PLATFORM§13
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = details.responseHeaders
    if (!headers || !isAttachmentResponse(headers)) return callback({})
    callback({ responseHeaders: { ...headers, 'x-content-type-options': ['nosniff'] } })
  })
  ses.on('will-download', (_e, item, contents) => d.downloads.started(item, contents))
}
