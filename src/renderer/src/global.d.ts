import type { KoloftApi } from '@shared/types'
import type { ActionRowState } from './components/extensionActions'

/**
 * The extension library's own bridge, injected into the HOST window by
 * `injectBrowserAction()` in Koloft's preload (browser-extensions D3). Typed here rather
 * than imported: the package ships the injector, not a renderer-side declaration.
 */
interface BrowserActionBridge {
  addEventListener(name: 'update', listener: (state: ActionRowState) => void): void
  removeEventListener(name: 'update', listener: (state: ActionRowState) => void): void
  getState(partition: string): Promise<ActionRowState>
  activate(
    partition: string,
    details: {
      eventType: 'click' | 'contextmenu'
      extensionId: string
      /** -1 leaves the choice of tab to the platform's own bookkeeping */
      tabId: number
      anchorRect: { x: number; y: number; width: number; height: number }
    }
  ): Promise<void>
  /** start/stop receiving `update` for a partition's extensions (ref-counted) */
  addObserver(partition: string): void
  removeObserver(partition: string): void
}

declare global {
  interface Window {
    api: KoloftApi
    browserAction?: BrowserActionBridge
  }
}

export {}
