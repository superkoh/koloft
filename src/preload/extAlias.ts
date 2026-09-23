import { contextBridge, ipcRenderer } from 'electron'

const realm = globalThis as { location?: { href?: string } }
const href = realm.location?.href
const extensionFrame = href !== undefined && href.startsWith('chrome-extension:')
// PLATFORM§15
const extensionServiceWorker = href === undefined

// PLATFORM§15
if (extensionServiceWorker || extensionFrame) {
  contextBridge.executeInMainWorld({
    func: () => {
      const world = globalThis as unknown as Record<string, unknown>
      if (!world.chrome || world.browser === world.chrome) return
      try {
        Object.defineProperty(world, 'browser', { value: world.chrome, configurable: true })
      } catch (err) {
        console.error('[koloft] browser alias failed', err)
      }
    }
  })
}

// PLATFORM§7
if (extensionFrame) {
  const frame = globalThis as {
    addEventListener?: (
      type: string,
      listener: (event: { key?: string }) => void,
      capture?: boolean
    ) => void
  }
  // PLATFORM§15
  frame.addEventListener?.(
    'keyup',
    (event) => {
      if (event.key === 'Escape') ipcRenderer.send('ext:dismiss-popup')
    },
    true
  )
}
