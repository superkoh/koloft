import crypto from 'crypto'
import { app, clipboard, session, webContents, type WebContents } from 'electron'
import { BROWSER_PARTITION } from '@shared/types'
import { guestShortcut } from '@shared/shortcutDispatch'
import { CH, type Channel } from '@shared/ipcChannels'
import { pickElement, pickText, stopPick } from './elementPick'
import { mutedWhileHidden } from './mutedWhileHidden'
import { isWorkbenchPage, type WebPages } from './webPages'

const DEFAULT_BROWSER_GUEST_LIMIT = 12

export interface PageToolsDeps {
  send(channel: Channel, ...args: unknown[]): boolean
  pages: WebPages
  machineOfTab(tabId: string): string | undefined
  savePickOn(machine: string, name: string, png: Buffer): Promise<string>
  savePickOnThisMac(png: Buffer): Promise<string>
  handsOn(event: unknown, input: { type: string }): void
  underTest: boolean
}

export class PageTools {
  private mutedWhileHidden = mutedWhileHidden<WebContents>()

  constructor(private d: PageToolsDeps) {}

  guestLimit(): number {
    const injected = Number(process.env.KOLOFT_BROWSER_GUEST_LIMIT)
    return Number.isInteger(injected) && injected > 0 ? injected : DEFAULT_BROWSER_GUEST_LIMIT
  }

  windowHidden(): void {
    this.mutedWhileHidden.hide(webContents.getAllWebContents().filter(isWorkbenchPage))
  }

  windowShown(): void {
    for (const page of this.mutedWhileHidden.show())
      this.d.send(CH.browser.audioState, {
        guestId: page.id,
        audible: page.isCurrentlyAudible(),
        muted: false
      })
  }

  watchMuteWhileHidden(): void {
    this.d.pages.onEveryWebPage((contents) => {
      if (isWorkbenchPage(contents)) this.mutedWhileHidden.opened(contents)
    })
  }

  // PLATFORM§12
  watchUnload(): void {
    this.d.pages.onEveryWebPage((contents) => {
      contents.on('will-prevent-unload', (event) => {
        if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
        event.preventDefault()
      })
    })
  }

  // PLATFORM§8
  muteUnderTest(): void {
    if (!this.d.underTest) return
    this.d.pages.onEveryWebPage((contents) => {
      contents.setAudioMuted(true)
    })
  }

  watchFullscreen(): void {
    app.on('web-contents-created', (_e, contents) => {
      if (!isWorkbenchPage(contents)) return
      let pageFullscreen = false
      // PLATFORM§7
      contents.on('input-event', (_event, input) => {
        if (!pageFullscreen || input.type !== 'rawKeyDown') return
        if ((input as { key?: string }).key !== 'Escape') return
        contents.executeJavaScript('document.exitFullscreen?.()').catch(() => {})
      })
      contents.on('enter-html-full-screen', () => {
        if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
        pageFullscreen = true
        this.d.send(CH.browser.fullscreen, true)
      })
      contents.on('leave-html-full-screen', () => {
        if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
        pageFullscreen = false
        this.d.send(CH.browser.fullscreen, false)
      })
    })
  }

  watchAudio(): void {
    app.on('web-contents-created', (_e, contents) => {
      if (!isWorkbenchPage(contents)) return
      contents.on('audio-state-changed', (event) => {
        if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
        this.d.send(CH.browser.audioState, {
          guestId: contents.id,
          audible: event.audible,
          muted: contents.isAudioMuted()
        })
      })
    })
  }

  watchKeys(): void {
    const sendGuestCommand = (cmd: ReturnType<typeof guestShortcut>): void => {
      if (!cmd) return
      if (cmd === 'find') this.d.send(CH.shortcut.find)
      else if (cmd === 'cycle-next' || cmd === 'cycle-prev') {
        this.d.send(CH.shortcut.workbench, cmd)
      } else this.d.send(CH.shortcut.browser, cmd)
    }
    // PLATFORM§12
    const pdfKeepsItsNativeFind = (
      cmd: ReturnType<typeof guestShortcut>,
      contents: WebContents
    ): boolean => cmd === 'find' && contents.getURL().toLowerCase().endsWith('.pdf')
    // PLATFORM§7
    app.on('web-contents-created', (_e, contents) => {
      if (!isWorkbenchPage(contents)) return
      contents.on('input-event', this.d.handsOn)
      contents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') return
        if (!(input.meta || input.control)) return
        const cmd = guestShortcut(input)
        if (pdfKeepsItsNativeFind(cmd, contents)) return
        if (cmd) {
          event.preventDefault()
          sendGuestCommand(cmd)
        }
      })
      // PLATFORM§7
      contents.on('input-event', (_event, input) => {
        if (input.type !== 'rawKeyDown') return
        const mods = input.modifiers ?? []
        const cmd = guestShortcut({
          key: (input as { key?: string }).key ?? '',
          meta: mods.includes('meta') || mods.includes('command') || mods.includes('cmd'),
          control: mods.includes('control') || mods.includes('ctrl'),
          shift: mods.includes('shift'),
          alt: mods.includes('alt')
        })
        if (pdfKeepsItsNativeFind(cmd, contents)) return
        if (cmd) sendGuestCommand(cmd)
      })
    })
  }

  devtools(id: unknown): void {
    if (typeof id !== 'number') return
    const guest = webContents.fromId(id)
    if (!guest || !isWorkbenchPage(guest)) return
    if (guest.session !== session.fromPartition(BROWSER_PARTITION)) return
    if (guest.isDevToolsOpened()) guest.closeDevTools()
    else guest.openDevTools({ mode: 'detach', activate: !this.d.underTest })
  }

  async pick(id: unknown, tabId: unknown): Promise<string | null> {
    if (typeof id !== 'number' || typeof tabId !== 'string') return null
    const guest = webContents.fromId(id)
    if (!guest || !isWorkbenchPage(guest)) return null
    if (guest.session !== session.fromPartition(BROWSER_PARTITION)) return null
    const picked = await pickElement(guest)
    if (!picked) return null
    if (picked.pictureFailed)
      this.d.send(
        CH.toast.show,
        `The picture of the element could not be taken: ${picked.pictureFailed}`
      )
    const machine = this.d.machineOfTab(tabId)
    const picture = picked.png
      ? await (
          machine
            ? this.d.savePickOn(machine, `${crypto.randomUUID()}.png`, picked.png)
            : this.d.savePickOnThisMac(picked.png)
        ).catch((error) => {
          const why = error instanceof Error ? error.message : String(error)
          this.d.send(
            CH.toast.show,
            machine
              ? `The picture of the element could not be copied to ${machine}: ${why}`
              : `The picture of the element could not be saved: ${why}`
          )
          return null
        })
      : null
    return pickText(picked, picture)
  }

  pickStop(id: unknown): void {
    if (typeof id === 'number') stopPick(id)
  }

  setMuted(guestId: unknown, muted: unknown): void {
    if (typeof guestId !== 'number') return
    const contents = webContents.fromId(guestId)
    if (!contents || contents.session !== session.fromPartition(BROWSER_PARTITION)) return
    contents.setAudioMuted(muted === true)
  }

  copyText(text: unknown): void {
    if (typeof text !== 'string' || !text) return
    clipboard.writeText(text.slice(0, 8192))
  }
}
