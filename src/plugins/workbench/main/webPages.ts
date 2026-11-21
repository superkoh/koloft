import { app, webContents, type WebContents } from 'electron'
import { isWorkspaceWorkbenchKey, workspaceOfWorkbenchKey } from '@shared/workbenchState'
import { parseRemoteKey } from '@shared/remoteKey'
import { gestureFresh } from './pageRules'

const A_NEW_PAGE_REPORTS_ITS_TAB_WITHIN_MS = 3000
const CHROMIUM_USER_ACTIVATION_INPUTS = new Set(['mouseDown', 'keyDown'])

export interface WebPagesDeps {
  activeTab(): string | null
  machineOfTab(tabId: string): string | undefined
}

export const isWorkbenchPage = (wc: WebContents): boolean => wc.getType() === 'webview'

export class WebPages {
  private watchers: ((contents: WebContents) => void)[] = []
  private owners = new WeakMap<WebContents, string>()
  private ownerWaiters = new Map<number, ((owner: string | null) => void)[]>()
  private overlay = new Set<number>()
  private gestures = new WeakMap<WebContents, number>()

  constructor(private d: WebPagesDeps) {}

  start(): void {
    app.on('web-contents-created', (_e, contents) => {
      if (!isWorkbenchPage(contents)) return
      for (const w of this.watchers) w(contents)
    })
  }

  activeTab(): string | null {
    return this.d.activeTab()
  }

  onEveryWebPage(watch: (contents: WebContents) => void): void {
    this.watchers.push(watch)
  }

  popupOpened(popup: WebContents): void {
    for (const w of this.watchers) w(popup)
  }

  ownerOf(page: WebContents): string | undefined {
    return this.owners.get(page)
  }

  tabOwning(page: WebContents): string | null {
    return this.owners.get(page) ?? this.activeTab()
  }

  pagesOf(tabId: string): WebContents[] {
    return webContents
      .getAllWebContents()
      .filter((wc) => !wc.isDestroyed() && this.owners.get(wc) === tabId)
  }

  reportedOwner(guestId: number): Promise<string | null> {
    const guest = webContents.fromId(guestId)
    if (!guest || this.overlay.has(guestId)) return Promise.resolve(null)
    const known = this.owners.get(guest)
    if (known) return Promise.resolve(known)
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const left = (this.ownerWaiters.get(guestId) ?? []).filter((w) => w !== answer)
        if (left.length) this.ownerWaiters.set(guestId, left)
        else this.ownerWaiters.delete(guestId)
        resolve(this.owners.get(guest) ?? null)
      }, A_NEW_PAGE_REPORTS_ITS_TAB_WITHIN_MS)
      const answer = (owner: string | null): void => {
        clearTimeout(timer)
        resolve(owner)
      }
      this.ownerWaiters.set(guestId, [...(this.ownerWaiters.get(guestId) ?? []), answer])
    })
  }

  recordOwner(guestId: number, owner: string): void {
    const guest = webContents.fromId(guestId)
    if (guest) this.owners.set(guest, owner)
    for (const resolve of this.ownerWaiters.get(guestId) ?? []) resolve(owner)
    this.ownerWaiters.delete(guestId)
  }

  tabMoved(oldTabId: string, newTabId: string): void {
    for (const wc of webContents.getAllWebContents())
      if (this.owners.get(wc) === oldTabId) this.owners.set(wc, newTabId)
  }

  machineOfOwner(owner: string): string | undefined {
    return isWorkspaceWorkbenchKey(owner)
      ? parseRemoteKey(workspaceOfWorkbenchKey(owner))?.host
      : this.d.machineOfTab(owner)
  }

  pageGone(guestId: number): void {
    this.ownerWaiters.delete(guestId)
  }

  overlayReported(guestId: unknown, on: unknown): void {
    if (typeof guestId !== 'number') return
    if (on) this.overlay.add(guestId)
    else this.overlay.delete(guestId)
    if (!on) return
    for (const resolve of this.ownerWaiters.get(guestId) ?? []) resolve(null)
    this.ownerWaiters.delete(guestId)
  }

  isOverlay(contents: WebContents): boolean {
    return this.overlay.has(contents.id)
  }

  watchGestures(): void {
    this.onEveryWebPage((contents) => {
      contents.on('input-event', (_ev, input) => {
        if (CHROMIUM_USER_ACTIVATION_INPUTS.has(input.type)) {
          this.gestures.set(contents, Date.now())
        }
      })
    })
  }

  takeGesture(contents: WebContents): boolean {
    const fresh = gestureFresh(this.gestures.get(contents), Date.now())
    this.gestures.delete(contents)
    return fresh
  }
}
