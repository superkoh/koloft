import { memo, useMemo, type JSX } from 'react'
import { BrowserGuest, type GuestElement, type GuestFailure } from './BrowserGuest'
import type { WorkbenchTab } from './workbenchTabs'

export interface TabRuntime {
  loading: boolean
  canBack: boolean
  canForward: boolean
  fail: GuestFailure | null
  crashed: boolean
  zoom: number
  mountToken: number
  pendingUrl: string
}

export const BLANK_RUNTIME: TabRuntime = {
  loading: false,
  canBack: false,
  canForward: false,
  fail: null,
  crashed: false,
  zoom: 1,
  mountToken: 0,
  pendingUrl: ''
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url
  }
}

// PLATFORM§8
export function guestHistory(el: GuestElement | undefined): {
  canBack: boolean
  canForward: boolean
} {
  try {
    return { canBack: el?.canGoBack() ?? false, canForward: el?.canGoForward() ?? false }
  } catch {
    return { canBack: false, canForward: false }
  }
}

// PLATFORM§8
export function guestId(el: GuestElement | undefined): number {
  try {
    return el?.getWebContentsId() ?? 0
  } catch {
    return 0
  }
}

// PLATFORM§8
export function guestLoading(el: GuestElement | undefined): boolean {
  try {
    return el?.isLoading() ?? false
  } catch {
    return false
  }
}

// PLATFORM§8
export function guestUrl(el: GuestElement | undefined): string {
  try {
    return el?.getURL() ?? ''
  } catch {
    return ''
  }
}

function isCertFailure(fail: GuestFailure): boolean {
  return /^ERR_(CERT|SSL)/.test(fail.description)
}

export interface GuestEvents {
  element(owner: string, tabId: string, el: GuestElement | null): void
  attached(owner: string, tabId: string): void
  loading(owner: string, tabId: string, loading: boolean): void
  navigate(owner: string, tabId: string, url: string): void
  title(owner: string, tabId: string, title: string): void
  fail(owner: string, tabId: string, fail: GuestFailure): void
  crash(owner: string, tabId: string): void
  close(owner: string, tabId: string): void
}

export const WebGuestHost = memo(function WebGuestHost({
  owner,
  tabId,
  url,
  visible,
  staged,
  events
}: {
  owner: string
  tabId: string
  url: string
  visible: boolean
  staged: boolean
  events: GuestEvents
}): JSX.Element {
  const on = useMemo(
    () => ({
      onElement: (el: GuestElement | null) => events.element(owner, tabId, el),
      onAttached: () => events.attached(owner, tabId),
      onLoading: (loading: boolean) => events.loading(owner, tabId, loading),
      onNavigate: (next: string) => events.navigate(owner, tabId, next),
      onTitle: (title: string) => events.title(owner, tabId, title),
      onFail: (fail: GuestFailure) => events.fail(owner, tabId, fail),
      onCrash: () => events.crash(owner, tabId),
      onClose: () => events.close(owner, tabId)
    }),
    [owner, tabId, events]
  )
  return <BrowserGuest url={url} visible={visible} staged={staged} {...on} />
})

export function WebPageState({
  tab,
  runtime,
  sessionCold,
  live,
  agentLabel,
  onLoad,
  onReloadCrashed,
  onCertProceed,
  onRetry
}: {
  tab: WorkbenchTab | null
  runtime: TabRuntime
  sessionCold: boolean
  live: boolean
  agentLabel: string
  onLoad: (tab: WorkbenchTab) => void
  onReloadCrashed: (tab: WorkbenchTab) => void
  onCertProceed: (tab: WorkbenchTab, url: string) => void
  onRetry: (tab: WorkbenchTab, url: string) => void
}): JSX.Element | null {
  const fail = runtime.fail
  return sessionCold ? (
    <div className="bempty">
      <div className="bstate-t">Session ended</div>
      <div className="bstate-sub">{tab?.url ? hostOf(tab.url) : ''}</div>
      <button onClick={() => tab && onLoad(tab)}>Reload</button>
    </div>
  ) : runtime.crashed && tab ? (
    <div className="bcrash">
      <div className="bstate-t">This page crashed</div>
      <div className="bstate-sub">{hostOf(tab.url ?? '')}</div>
      <button onClick={() => onReloadCrashed(tab)}>Reload</button>
    </div>
  ) : fail && isCertFailure(fail) && tab ? (
    <div className="bcert">
      <div className="bstate-t">Your connection is not private</div>
      <div className="bstate-sub">
        {hostOf(fail.url)} · {fail.description}
      </div>
      <button onClick={() => onCertProceed(tab, fail.url)}>Proceed anyway (unsafe)</button>
    </div>
  ) : fail && tab ? (
    <div className="berror">
      <div className="bstate-t">Can't reach {hostOf(fail.url)}</div>
      <div className="bstate-sub">{fail.description}</div>
      <button onClick={() => onRetry(tab, fail.url)}>Retry</button>
    </div>
  ) : tab && !tab.url ? (
    <div className="bempty">
      <div className="bstate-t">No page open yet</div>
      <div className="bempty-hint">
        Press ⌘L and enter an address, or a file in this folder like index.html
      </div>
      <div className="bempty-hint">Click a link in the terminal</div>
      <div className="bempty-hint">Or let {agentLabel} open one</div>
    </div>
  ) : tab && !live ? (
    <div className="bempty">
      <div className="bstate-t">Not loaded</div>
      <div className="bstate-sub">{hostOf(tab.url ?? '')}</div>
      <button onClick={() => onLoad(tab)}>Load</button>
    </div>
  ) : null
}
