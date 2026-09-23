import { contextBridge, ipcRenderer } from 'electron'

/**
 * THE script Koloft runs inside an extension's own realms — the `browser` alias below (D9)
 * and, in a frame, the one key the app owes the user (D5).
 *
 * D9: Chromium ships a native `browser` global that is NOT the same object as `chrome`,
 * and electron-chrome-extensions patches only `chrome` (windows/contextMenus/…). An
 * extension that mixes the two namespaces — 1Password does — dies on its first
 * `browser.windows.*`. In real Chrome both names resolve to the same bindings, so this
 * restores that: registered on the browser partition AFTER the lib's own preloads, in
 * both realms an extension runs in (service worker and extension page/frame).
 *
 * The frame registration is session-wide, so it reaches ordinary web pages too — those
 * must be left exactly as they are, and the `chrome-extension:` test below is what
 * keeps `browser` from appearing in a page's world. A service-worker preload runs in an
 * isolated world with no `location` at all, which is why an absent one means "alias".
 */
const realm = globalThis as { location?: { href?: string } }
const href = realm.location?.href
const extensionFrame = href !== undefined && href.startsWith('chrome-extension:')

if (href === undefined || extensionFrame) {
  contextBridge.executeInMainWorld({
    // serialized into the extension's own world: it closes over nothing, and reads the
    // `chrome` the lib has already patched there
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

// D5: Esc closes the action popup — and the popup IS the extension's own page, whose
// document is the only place that key ever lands. Main's own key path does not see it:
// `before-input-event` is fed by native input alone. Capture, so a page that handles Esc
// itself cannot keep the floater open, and no `preventDefault` — what the page wants to
// do with the key is still its business.
if (extensionFrame) {
  const frame = globalThis as {
    addEventListener?: (
      type: string,
      listener: (event: { key?: string }) => void,
      capture?: boolean
    ) => void
  }
  // on the RELEASE, not the press: closing the floater tears this document down with it,
  // and a key is not finished until it comes back up — a page destroyed between the two
  // halves of one keystroke loses the rest of it
  frame.addEventListener?.(
    'keyup',
    (event) => {
      if (event.key === 'Escape') ipcRenderer.send('ext:dismiss-popup')
    },
    true
  )
}
