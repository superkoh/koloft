import { webContents, type WebContents } from 'electron'
import type { BrowserPagesInUse } from '@shared/types'
import { isWorkbenchPage, type WebPages } from './webPages'

export interface PageHeldElsewhere {
  tabId: string
  guestId?: number
}

export interface PagesInUseDeps {
  pages: WebPages
  held(): number[]
  modalPage(): number | null
  signInWindowOpeners(): WebContents[]
  heldElsewhere(): PageHeldElsewhere[]
  ownerDriven(owner: string): boolean
  drivenFromAnotherMachine(guestId: number): boolean
}

export function pagesInUse(d: PagesInUseDeps): BrowserPagesInUse {
  const guestIds = new Set<number>(d.held())
  const modalPage = d.modalPage()
  if (modalPage !== null) guestIds.add(modalPage)
  const owners = new Set<string>()
  const keepOwnerOf = (page: WebContents): void => {
    guestIds.add(page.id)
    const owner = d.pages.ownerOf(page)
    if (owner) owners.add(owner)
  }
  for (const opener of d.signInWindowOpeners()) if (!opener.isDestroyed()) keepOwnerOf(opener)
  for (const ask of d.heldElsewhere()) {
    owners.add(ask.tabId)
    if (ask.guestId !== undefined) guestIds.add(ask.guestId)
  }
  for (const page of webContents.getAllWebContents()) {
    if (page.isDestroyed() || !isWorkbenchPage(page)) continue
    const owner = d.pages.ownerOf(page)
    if (owner && d.ownerDriven(owner)) owners.add(owner)
    if (
      page.isLoading() ||
      page.debugger.isAttached() ||
      page.isDevToolsOpened() ||
      page.isCurrentlyAudible() ||
      d.drivenFromAnotherMachine(page.id)
    )
      guestIds.add(page.id)
  }
  return { guestIds: [...guestIds], owners: [...owners] }
}
