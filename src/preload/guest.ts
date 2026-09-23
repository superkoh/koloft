import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserDialogAnswer } from '@shared/types'

/**
 * THE guest preload (§05D-11). Registered on the browser partition alone — the host
 * window and Preview's own viewer live on the default session and never see it.
 *
 * D12 says a guest gets no preload. That rule is about Koloft's privileged bridge (pty
 * spawn, account tokens, settings); this script hands the page none of it. It runs in
 * the preload's own isolated world, exposes no bridged object, and the only thing that
 * reaches the page is a replacement for three functions the page already has — zero new
 * capability. It is the pattern Q1's reference implementation names: the preload IS the
 * trust boundary, an isolated world (D12, amended).
 *
 * It exists because Chromium answers alert/confirm/prompt with a NATIVE dialog: an OS
 * window that names no origin, sits outside Koloft, and may not be raised in a headless
 * run (R7/TEST-9). The round trip is synchronous on purpose — the page has to stop
 * exactly where the real API stops it, so `confirm()` still evaluates to a boolean.
 * `sendSync` blocks this guest's renderer only: main answers whenever the user does.
 */
const ask = (kind: string, message: string, defaultValue: string): BrowserDialogAnswer =>
  ipcRenderer.sendSync('browser:js-dialog', { kind, message, defaultValue })

/**
 * SEC-4, the other half: Chromium refuses a remote page's `file://` navigation inside
 * this renderer — no `will-navigate`, no permission request, nothing main can report, so
 * the link reads as dead. The click is caught here (isolated world, capture phase, real
 * events only) and reported, which is all it does: the OS hand-off whitelist is main's
 * and this cannot reach it. Every other scheme travels a main-process path already.
 */
interface GuestClick {
  isTrusted: boolean
  target: { closest?(selector: string): { href?: string } | null } | null
  preventDefault(): void
  /** §07 #1: which mouse button, and whether ⌘ was down — a background-tab click */
  button?: number
  metaKey?: boolean
  ctrlKey?: boolean
}

// the guest's own window, which this (DOM-less) preload tsconfig cannot name
const guest = globalThis as unknown as {
  addEventListener(type: 'click' | 'auxclick', fn: (e: GuestClick) => void, capture: boolean): void
  location: { protocol: string }
}

guest.addEventListener(
  'click',
  (e) => {
    // a local page's own links are Chromium's business — this is about the remote page
    // that cannot have them, and only about clicks the user really made
    if (!e.isTrusted || guest.location.protocol === 'file:') return
    const href = e.target?.closest?.('a[href]')?.href ?? ''
    if (!href.toLowerCase().startsWith('file:')) return
    e.preventDefault()
    ipcRenderer.send('browser:link-blocked', href)
  },
  true
)

/**
 * §07 #1 (B11): ⌘+click and middle-click mean "open in the background". Chromium does
 * NOT turn either into a `window.open`, so main's popup handler never hears about them
 * and the page navigates in place instead — losing what the user was looking at.
 *
 * Caught here for the same reason as the file: link above: this is the only world that
 * sees the click at all. Nothing is trusted from the report — main runs it through the
 * one routing table, and the only outcome it can produce is a tab.
 */
const backgroundOpen = (e: GuestClick): void => {
  if (!e.isTrusted) return
  const middle = e.button === 1
  // ⌘ only. On macOS — the platform Koloft ships — Ctrl+click IS the context-menu
  // gesture, so treating it as "open in background" would hand the user a menu and a
  // tab from one press.
  const modified = e.button === 0 && e.metaKey === true
  if (!middle && !modified) return
  const href = e.target?.closest?.('a[href]')?.href ?? ''
  if (!href) return
  e.preventDefault()
  ipcRenderer.send('browser:open-background', href)
}

guest.addEventListener('click', backgroundOpen, true)
// a middle click never fires `click` — it is an auxclick, and only ever that
guest.addEventListener('auxclick', backgroundOpen, true)

// SEC-12b's page-world half: the guest's UA already claims Chrome and main adds the
// Google Chrome brand to the Sec-CH-UA headers — but `navigator.userAgentData` is read
// from JS, not headers, and still lists only Chromium. Add the same Google Chrome brand
// there so the two agree. Browser-partition preload only; Koloft's own UI never loads it.
contextBridge.executeInMainWorld({
  func: () => {
    type Brand = { brand: string; version: string }
    const uad = (globalThis.navigator as unknown as { userAgentData?: object }).userAgentData
    if (!uad) return
    const withChrome = (list: Brand[] | undefined): Brand[] | undefined => {
      if (!list || list.some((b) => b.brand === 'Google Chrome')) return list
      const chromium = list.find((b) => b.brand === 'Chromium')
      return chromium ? [...list, { brand: 'Google Chrome', version: chromium.version }] : list
    }
    // patch the PROTOTYPE, not the instance: navigator.userAgentData may hand out a fresh
    // object per access, so an own-property override on one instance is lost. Capture the
    // real getter/method and wrap them so every instance carries the Google Chrome brand.
    const proto = Object.getPrototypeOf(uad) as object
    try {
      const brandsDesc = Object.getOwnPropertyDescriptor(proto, 'brands')
      if (brandsDesc?.get) {
        const origGet = brandsDesc.get
        Object.defineProperty(proto, 'brands', {
          configurable: true,
          get(this: object): Brand[] {
            return withChrome(origGet.call(this) as Brand[]) as Brand[]
          }
        })
      }
      const hev = (
        proto as { getHighEntropyValues?: (h: string[]) => Promise<Record<string, unknown>> }
      ).getHighEntropyValues
      if (hev) {
        ;(
          proto as { getHighEntropyValues: (h: string[]) => Promise<Record<string, unknown>> }
        ).getHighEntropyValues = async function (
          this: object,
          hints: string[]
        ): Promise<Record<string, unknown>> {
          const r = await hev.call(this, hints)
          if (Array.isArray(r.brands)) r.brands = withChrome(r.brands as Brand[])
          if (Array.isArray(r.fullVersionList))
            r.fullVersionList = withChrome(r.fullVersionList as Brand[])
          return r
        }
      }
    } catch {
      /* a locked-down userAgentData: leave it rather than throw the page's own scripts */
    }
  }
})

// SEC-12b, page-world tells: real Chrome exposes window.chrome.loadTimes/csi and
// navigator.webdriver === false. Electron's window.chrome is an empty object and, under
// automation, webdriver is true — both are classic "not a real browser" signals
// (Google's embedded-browser gate among the readers). Fill the shape to match Chrome.
// Browser-partition preload only; Koloft's own UI never loads it. window.chrome.runtime is
// left untouched (extension territory — 1Password may own it).
contextBridge.executeInMainWorld({
  func: () => {
    const w = globalThis as unknown as { chrome?: Record<string, unknown> }
    try {
      Object.defineProperty(globalThis.navigator, 'webdriver', {
        get: () => false,
        configurable: true
      })
    } catch {
      /* already false / locked: leave it */
    }
    const chrome = w.chrome ?? (w.chrome = {})
    if (typeof chrome.loadTimes !== 'function') {
      chrome.loadTimes = () => ({
        requestTime: 0,
        startLoadTime: 0,
        commitLoadTime: 0,
        finishDocumentLoadTime: 0,
        finishLoadTime: 0,
        firstPaintTime: 0,
        firstPaintAfterLoadTime: 0,
        navigationType: 'Other',
        wasFetchedViaSpdy: false,
        wasNpnNegotiated: false,
        npnNegotiatedProtocol: 'unknown',
        wasAlternateProtocolAvailable: false,
        connectionInfo: 'unknown'
      })
    }
    if (typeof chrome.csi !== 'function') {
      chrome.csi = () => ({ startE: 0, onloadT: 0, pageT: 0, tran: 15 })
    }
    if (!chrome.app) {
      chrome.app = {
        isInstalled: false,
        InstallState: {
          DISABLED: 'disabled',
          INSTALLED: 'installed',
          NOT_INSTALLED: 'not_installed'
        },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
      }
    }
  }
})

contextBridge.executeInMainWorld({
  // serialized into the page's world, so it closes over nothing: `ask` arrives as the
  // one proxied argument and stays in this closure — `window` gains no new property
  func: (ask: (kind: string, message: string, defaultValue: string) => BrowserDialogAnswer) => {
    // the page's own window, which this (DOM-less) preload tsconfig cannot name
    const page = globalThis as unknown as {
      alert(message?: string): void
      confirm(message?: string): boolean
      prompt(message?: string, defaultValue?: string): string | null
    }
    page.alert = (message?: string): void => {
      ask('alert', String(message ?? ''), '')
    }
    page.confirm = (message?: string): boolean =>
      ask('confirm', String(message ?? ''), '').ok === true
    page.prompt = (message?: string, defaultValue?: string): string | null => {
      const answer = ask('prompt', String(message ?? ''), String(defaultValue ?? ''))
      return answer.ok ? (answer.value ?? '') : null
    }
  },
  args: [ask]
})
