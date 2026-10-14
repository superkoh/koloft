import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserDialogAnswer } from '@shared/types'

// PLATFORM§12
const ask = (kind: string, message: string, defaultValue: string): BrowserDialogAnswer =>
  ipcRenderer.sendSync('browser:js-dialog', { kind, message, defaultValue })

// PLATFORM§11
const undecided = (name: string): boolean =>
  ipcRenderer.sendSync('browser:permission-undecided', name) === true

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
  func: (
    ask: (kind: string, message: string, defaultValue: string) => BrowserDialogAnswer,
    undecided: (name: string) => boolean
  ) => {
    // PLATFORM§14
    const nativeSource = new WeakMap<object, string>()
    const asNative = <T extends (...args: never[]) => unknown>(fn: T): T => {
      nativeSource.set(fn, `function ${fn.name}() { [native code] }`)
      return fn
    }
    const realToString = Function.prototype.toString
    Function.prototype.toString = asNative(
      {
        toString(this: unknown): string {
          return nativeSource.get(this as object) ?? realToString.call(this)
        }
      }.toString
    )

    type Brand = { brand: string; version: string }
    const withChrome = (list: Brand[] | undefined): Brand[] | undefined => {
      if (!list || list.some((b) => b.brand === 'Google Chrome')) return list
      const chromium = list.find((b) => b.brand === 'Chromium')
      return chromium ? [...list, { brand: 'Google Chrome', version: chromium.version }] : list
    }
    const uad = (globalThis.navigator as unknown as { userAgentData?: object }).userAgentData
    try {
      // PLATFORM§14
      const proto = uad ? (Object.getPrototypeOf(uad) as Record<string, unknown>) : undefined
      if (proto) {
        const brandsDesc = Object.getOwnPropertyDescriptor(proto, 'brands')
        const realBrands = brandsDesc?.get
        if (realBrands) {
          const holder = {
            get brands() {
              return withChrome(realBrands.call(this) as Brand[])
            }
          }
          Object.defineProperty(proto, 'brands', {
            ...brandsDesc,
            get: asNative(Object.getOwnPropertyDescriptor(holder, 'brands')!.get!)
          })
        }
        const hev = proto.getHighEntropyValues as
          ((h: string[]) => Promise<Record<string, unknown>>) | undefined
        if (hev) {
          proto.getHighEntropyValues = asNative(
            {
              async getHighEntropyValues(hints: string[]): Promise<Record<string, unknown>> {
                const r = await hev.call(this, hints)
                if (Array.isArray(r.brands)) r.brands = withChrome(r.brands as Brand[])
                if (Array.isArray(r.fullVersionList))
                  r.fullVersionList = withChrome(r.fullVersionList as Brand[])
                return r
              }
            }.getHighEntropyValues
          )
        }
      }
    } catch {}

    const w = globalThis as unknown as { chrome?: Record<string, unknown> }
    const chrome = w.chrome ?? (w.chrome = {})
    if (typeof chrome.loadTimes !== 'function') {
      chrome.loadTimes = asNative(function () {
        return {
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
        }
      })
    }
    if (typeof chrome.csi !== 'function') {
      chrome.csi = asNative(function () {
        return { startE: 0, onloadT: 0, pageT: 0, tran: 15 }
      })
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

    type PermissionStatusLike = { state: string }
    const permissions = (
      globalThis as unknown as {
        Permissions?: {
          prototype: { query(desc: { name?: unknown }): Promise<PermissionStatusLike> }
        }
      }
    ).Permissions?.prototype
    const realQuery = permissions?.query
    if (permissions && realQuery) {
      // PLATFORM§11
      permissions.query = asNative(
        {
          async query(desc: { name?: unknown }): Promise<PermissionStatusLike> {
            const status = await realQuery.call(this, desc)
            const realState = Object.getOwnPropertyDescriptor(
              Object.getPrototypeOf(status) as object,
              'state'
            )?.get
            if (!realState) return status
            const name = String(desc?.name)
            Object.defineProperty(status, 'state', {
              get: () => {
                const state = realState.call(status) as string
                return state === 'denied' && undecided(name) ? 'prompt' : state
              },
              configurable: true
            })
            return status
          }
        }.query
      )
    }

    // PLATFORM§12
    const dialogs = {
      alert(...args: unknown[]): void {
        ask('alert', String(args[0] ?? ''), '')
      },
      confirm(...args: unknown[]): boolean {
        return ask('confirm', String(args[0] ?? ''), '').ok === true
      },
      prompt(...args: unknown[]): string | null {
        const answer = ask('prompt', String(args[0] ?? ''), String(args[1] ?? ''))
        return answer.ok ? (answer.value ?? '') : null
      }
    }
    const page = globalThis as unknown as Record<string, unknown>
    page.alert = asNative(dialogs.alert)
    page.confirm = asNative(dialogs.confirm)
    page.prompt = asNative(dialogs.prompt)
  },
  args: [ask, undecided]
})
