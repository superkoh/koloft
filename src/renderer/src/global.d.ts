import type { KoloftApi } from '@shared/types'
import type { ActionRowState } from './components/extensionActions'

interface BrowserActionBridge {
  addEventListener(name: 'update', listener: (state: ActionRowState) => void): void
  removeEventListener(name: 'update', listener: (state: ActionRowState) => void): void
  getState(partition: string): Promise<ActionRowState>
  activate(
    partition: string,
    details: {
      eventType: 'click' | 'contextmenu'
      extensionId: string
      tabId: number
      anchorRect: { x: number; y: number; width: number; height: number }
    }
  ): Promise<void>
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
