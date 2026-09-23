import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserDialogAnswer } from '@shared/types'

// PLATFORM§12
const ask = (kind: string, message: string, defaultValue: string): BrowserDialogAnswer =>
  ipcRenderer.sendSync('browser:js-dialog', { kind, message, defaultValue })

interface GuestClick {
  isTrusted: boolean
  target: { closest?(selector: string): { href?: string } | null } | null
  preventDefault(): void
  button?: number
  metaKey?: boolean
  ctrlKey?: boolean
}

const guest = globalThis as unknown as {
  addEventListener(type: 'click' | 'auxclick', fn: (e: GuestClick) => void, capture: boolean): void
  location: { protocol: string }
}

// PLATFORM§12
guest.addEventListener(
  'click',
  (e) => {
    if (!e.isTrusted || guest.location.protocol === 'file:') return
    const href = e.target?.closest?.('a[href]')?.href ?? ''
    if (!href.toLowerCase().startsWith('file:')) return
    e.preventDefault()
    ipcRenderer.send('browser:link-blocked', href)
  },
  true
)

// PLATFORM§12
const backgroundOpen = (e: GuestClick): void => {
  if (!e.isTrusted) return
  const middle = e.button === 1
  const commandClickNotCtrl = e.button === 0 && e.metaKey === true
  if (!middle && !commandClickNotCtrl) return
  const href = e.target?.closest?.('a[href]')?.href ?? ''
  if (!href) return
  e.preventDefault()
  ipcRenderer.send('browser:open-background', href)
}

guest.addEventListener('click', backgroundOpen, true)
guest.addEventListener('auxclick', backgroundOpen, true)

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
    // PLATFORM§14
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
    } catch {}
  }
})

contextBridge.executeInMainWorld({
  func: () => {
    const w = globalThis as unknown as { chrome?: Record<string, unknown> }
    try {
      Object.defineProperty(globalThis.navigator, 'webdriver', {
        get: () => false,
        configurable: true
      })
    } catch {}
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
  func: (ask: (kind: string, message: string, defaultValue: string) => BrowserDialogAnswer) => {
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
