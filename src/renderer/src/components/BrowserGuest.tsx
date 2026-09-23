import { createElement, useEffect, useRef, type JSX } from 'react'
import { BROWSER_PARTITION } from '@shared/types'

export type GuestElement = HTMLElement & {
  loadURL(url: string): Promise<void>
  getURL(): string
  reload(): void
  stop(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  isLoading(): boolean
  getZoomFactor(): number
  setZoomFactor(factor: number): void
  getWebContentsId(): number
  findInPage(
    text: string,
    options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean }
  ): number
  stopFindInPage(action: 'clearSelection' | 'keepSelection' | 'activateSelection'): void
  executeJavaScript(code: string): Promise<unknown>
}

export interface GuestFailure {
  code: number
  description: string
  url: string
}

const BOOTSTRAP_SRC = 'about:blank'
const NET_ERR_ABORTED = -3

export interface BrowserGuestProps {
  url: string
  visible: boolean
  onElement(el: GuestElement | null): void
  onAttached(): void
  onLoading(loading: boolean): void
  onNavigate(url: string): void
  onTitle(title: string): void
  onFail(failure: GuestFailure): void
  onCrash(): void
  onClose(): void
  staged?: boolean
}

export function BrowserGuest({
  url,
  visible,
  staged,
  onElement,
  onAttached,
  onLoading,
  onNavigate,
  onTitle,
  onFail,
  onCrash,
  onClose
}: BrowserGuestProps): JSX.Element {
  const ref = useRef<GuestElement | null>(null)
  const cb = useRef({ onAttached, onLoading, onNavigate, onTitle, onFail, onCrash, onClose })
  cb.current = { onAttached, onLoading, onNavigate, onTitle, onFail, onCrash, onClose }
  const target = useRef(url)
  target.current = url
  const loadOwedAtDomReady = useRef(false)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    onElement(el)

    // PLATFORM§8
    const load = (): void => {
      // PLATFORM§16
      if (target.current === BOOTSTRAP_SRC) return
      try {
        void el.loadURL(target.current).catch(() => {})
      } catch {
        loadOwedAtDomReady.current = true
      }
    }
    const onAttach = (): void => {
      setTimeout(load, 0)
      cb.current.onAttached()
    }
    const onDomReady = (): void => {
      if (!loadOwedAtDomReady.current) return
      loadOwedAtDomReady.current = false
      load()
    }
    const onStart = (): void => cb.current.onLoading(true)
    const onStop = (): void => cb.current.onLoading(false)
    const onNav = (e: Event): void => {
      const url = (e as Event & { url: string }).url
      if (url === BOOTSTRAP_SRC && target.current && target.current !== BOOTSTRAP_SRC) return
      cb.current.onNavigate(url)
    }
    const onTitleEv = (e: Event): void => cb.current.onTitle((e as Event & { title: string }).title)
    const onFailEv = (e: Event): void => {
      const f = e as Event & {
        errorCode: number
        errorDescription: string
        validatedURL: string
        isMainFrame: boolean
      }
      if (!f.isMainFrame || f.errorCode === NET_ERR_ABORTED) return
      cb.current.onFail({
        code: f.errorCode,
        description: f.errorDescription,
        url: f.validatedURL || target.current
      })
    }
    const onGone = (): void => cb.current.onCrash()
    const onCloseEv = (): void => cb.current.onClose()

    el.addEventListener('did-attach', onAttach)
    el.addEventListener('dom-ready', onDomReady)
    el.addEventListener('did-start-loading', onStart)
    el.addEventListener('did-stop-loading', onStop)
    el.addEventListener('did-navigate', onNav)
    el.addEventListener('did-navigate-in-page', onNav)
    el.addEventListener('page-title-updated', onTitleEv)
    el.addEventListener('did-fail-load', onFailEv)
    el.addEventListener('render-process-gone', onGone)
    el.addEventListener('crashed', onGone)
    el.addEventListener('close', onCloseEv)
    return () => {
      el.removeEventListener('did-attach', onAttach)
      el.removeEventListener('dom-ready', onDomReady)
      el.removeEventListener('did-start-loading', onStart)
      el.removeEventListener('did-stop-loading', onStop)
      el.removeEventListener('did-navigate', onNav)
      el.removeEventListener('did-navigate-in-page', onNav)
      el.removeEventListener('page-title-updated', onTitleEv)
      el.removeEventListener('did-fail-load', onFailEv)
      el.removeEventListener('render-process-gone', onGone)
      el.removeEventListener('crashed', onGone)
      el.removeEventListener('close', onCloseEv)
      onElement(null)
    }
  }, [])

  return createElement('webview', {
    ref,
    className: 'bguest' + (staged ? ' staged' : ''),
    src: BOOTSTRAP_SRC,
    partition: BROWSER_PARTITION,
    allowpopups: true,
    webpreferences: 'sandbox=yes',
    plugins: true,
    allowfullscreen: true,
    style: { visibility: visible ? undefined : 'hidden' }
  })
}
