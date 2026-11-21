import fs from 'fs'
import {
  clipboard,
  Menu,
  session,
  type BaseWindow,
  type BrowserWindow,
  type HandlerDetails,
  type IpcMainEvent,
  type WebContents
} from 'electron'
import {
  BROWSER_PARTITION,
  type BrowserOpenRequest,
  type BrowserOverlayOpen,
  type OpenRequest
} from '@shared/types'
import { routeFor } from '@shared/browserRoute'
import { guestMenuItems } from './pageRules'
import { awaitGuestFor } from './extensionManager'
import { openSignInWindow } from './signInWindow'
import type { WebPages } from './webPages'
import { CHANNELS } from '../shared/ipc'

export interface PageRoutingDeps {
  push(channel: string, ...args: unknown[]): boolean
  pages: WebPages
  openFile(request: OpenRequest): void
  openExternally(url: string): void
  driverOf(guestId: number): string | null
  drivenFromAnotherMachine(guestId: number): boolean
  openAsDrivingAgentsTab(guestId: number, url: string): boolean
  handsOn(event: unknown, input: { type: string }): void
  mainWindow(): BrowserWindow | null
  showMainWindow(win: BrowserWindow): void
  showSignInWindows: boolean
}

const POPUP_WINDOW_FEATURES = /(^|[\s,])(popup|(inner)?width|(inner)?height)\s*(=|,|$)/i

export class PageRouting {
  // PLATFORM§6
  private pendingOverlayOpens: BrowserOverlayOpen[] = []
  private overlayListening = false
  private pageOfSignInWindow = new Map<BaseWindow, WebContents>()

  constructor(private d: PageRoutingDeps) {}

  sendOverlayOpen(url: string, presentation: 'now' | 'background'): void {
    this.pendingOverlayOpens.push({ url, presentation })
    this.flushOverlayOpens()
  }

  overlayReady(): void {
    this.overlayListening = true
    this.flushOverlayOpens()
  }

  private flushOverlayOpens(): void {
    if (!this.overlayListening) return
    while (this.pendingOverlayOpens.length) {
      if (!this.d.push(CHANNELS.overlayOpen, this.pendingOverlayOpens[0])) return
      this.pendingOverlayOpens.shift()
    }
  }

  overlayListenerLost(): void {
    this.overlayListening = false
  }

  routeGuestPopup(url: string, from: WebContents): void {
    if (this.d.pages.isOverlay(from)) {
      const decision = routeFor(url, 'user')
      if (decision.dest === 'browser') this.sendOverlayOpen(decision.target, 'now')
      else if (decision.dest === 'system') this.d.openExternally(decision.target)
      else this.d.push(CHANNELS.blockedScheme, url)
      return
    }
    const decision = routeFor(url, 'user')
    if (decision.dest !== 'browser' && this.d.drivenFromAnotherMachine(from.id)) return
    if (decision.dest === 'browser' && this.d.openAsDrivingAgentsTab(from.id, decision.target))
      return
    const tabId = this.d.pages.tabOwning(from)
    if (!tabId) return
    if (decision.dest === 'browser') {
      const payload: BrowserOpenRequest = { tabId, url: decision.target, source: 'user' }
      this.d.push(CHANNELS.pageOpen, payload)
    } else if (decision.dest === 'preview' && fs.existsSync(decision.target)) {
      const payload: OpenRequest = { tabId, path: decision.target, source: 'user' }
      this.d.openFile(payload)
    } else if (decision.dest === 'system') {
      this.d.openExternally(decision.target)
    } else {
      this.d.push(CHANNELS.blockedScheme, url)
    }
  }

  async openExtensionTab(url: string): Promise<WebContents | null> {
    const tabId = this.d.pages.activeTab()
    if (!tabId) return null
    const decision = routeFor(url, 'user')
    const extensionPage = /^chrome-extension:\/\//i.test(url)
    if (!extensionPage && decision.dest !== 'browser') return null
    const target = extensionPage ? url : decision.target
    const payload: BrowserOpenRequest = { tabId, url: target, source: 'user' }
    if (!this.d.push(CHANNELS.pageOpen, payload)) return null
    return awaitGuestFor(target)
  }

  openBackground(e: IpcMainEvent, url: unknown): void {
    if (e.sender.session !== session.fromPartition(BROWSER_PARTITION)) return
    if (typeof url !== 'string' || !url) return
    if (this.d.pages.isOverlay(e.sender)) {
      this.routeGuestPopup(url.slice(0, 4096), e.sender)
      return
    }
    const decision = routeFor(url.slice(0, 4096), 'user')
    if (decision.dest !== 'browser') {
      this.routeGuestPopup(url, e.sender)
      return
    }
    if (this.d.openAsDrivingAgentsTab(e.sender.id, decision.target)) return
    const tabId = this.d.pages.tabOwning(e.sender)
    if (!tabId) return
    const payload: BrowserOpenRequest = { tabId, url: decision.target, source: 'agent' }
    this.d.push(CHANNELS.pageOpen, payload)
  }

  // PLATFORM§12
  linkBlocked(e: IpcMainEvent, url: unknown): void {
    if (e.sender.session !== session.fromPartition(BROWSER_PARTITION)) return
    if (typeof url !== 'string' || !url) return
    this.d.push(CHANNELS.blockedScheme, url.slice(0, 2048))
  }

  keptBySignInWindow(
    from: BaseWindow | undefined,
    key: 'closes-it' | 'acts-on-its-page' | 'acts-on-the-app'
  ): boolean {
    if (!from || !this.pageOfSignInWindow.has(from)) return false
    if (key === 'closes-it') from.close()
    if (key !== 'acts-on-the-app') return true
    const main = this.d.mainWindow()
    if (main && !main.isDestroyed()) this.d.showMainWindow(main)
    return false
  }

  signInWindowOpeners(): WebContents[] {
    return [...this.pageOfSignInWindow.values()]
  }

  private adoptSignInWindow(win: BrowserWindow, popup: WebContents, opener: WebContents): void {
    this.pageOfSignInWindow.set(win, opener)
    popup.on('input-event', this.d.handsOn)
    const host = this.d.mainWindow()
    const close = (): void => {
      if (!win.isDestroyed()) win.close()
    }
    opener.once('destroyed', close)
    host?.once('closed', close)
    win.once('closed', () => {
      this.pageOfSignInWindow.delete(win)
      opener.removeListener('destroyed', close)
      host?.removeListener('closed', close)
    })
    const popupId = popup.id
    void this.d.pages.reportedOwner(opener.id).then((owner) => {
      if (owner) this.d.pages.recordOwner(popupId, owner)
    })
    this.d.pages.popupOpened(popup)
  }

  private opensAsSignInWindow(
    from: WebContents,
    { url, disposition, features }: HandlerDetails
  ): boolean {
    return (
      disposition === 'new-window' &&
      POPUP_WINDOW_FEATURES.test(features) &&
      /^https?:/i.test(url) &&
      !this.d.pages.isOverlay(from) &&
      this.d.driverOf(from.id) === null &&
      !this.d.drivenFromAnotherMachine(from.id) &&
      this.d.pages.takeGesture(from)
    )
  }

  watchPopups(): void {
    this.d.pages.onEveryWebPage((contents) => {
      contents.setWindowOpenHandler((details) => {
        if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return { action: 'deny' }
        // PLATFORM§8
        if (this.opensAsSignInWindow(contents, details)) {
          return {
            action: 'allow',
            createWindow: (options) => {
              const { host, page } = openSignInWindow(options, this.d.showSignInWindows)
              this.adoptSignInWindow(host, page, contents)
              return page
            }
          }
        }
        this.routeGuestPopup(details.url, contents)
        return { action: 'deny' }
      })
    })
  }

  watchContextMenu(): void {
    this.d.pages.onEveryWebPage((contents) => {
      contents.on('context-menu', (_event, params) => {
        if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
        const items = guestMenuItems(params)
        if (!items.length) return
        Menu.buildFromTemplate(
          items.map((item) => ({
            label: item.label,
            click: () => {
              if (item.action === 'copy-link') clipboard.writeText(item.target)
              else if (item.action === 'open-link') this.routeGuestPopup(item.target, contents)
              else contents.downloadURL(item.target)
            }
          }))
        ).popup()
      })
    })
  }
}
