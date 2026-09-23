import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { BROWSER_PARTITION } from '../../src/shared/types'

/**
 * SEC-5/SEC-6 — the guest attribute set, enforced at the source.
 *
 * A <webview> created without `partition` falls back silently to the default session,
 * which is where Koloft's privileged `koloft-file://` protocol lives: a remote page in such a
 * guest could read the disk. The failure is invisible at runtime (the page loads fine),
 * so the guard is "there is exactly one place in the renderer that can create a browser
 * guest, and it names the partition".
 */
const COMPONENTS = path.join(__dirname, '..', '..', 'src', 'renderer', 'src', 'components')
const FACTORY = path.join(COMPONENTS, 'BrowserGuest.tsx')

/** source with comments removed — the prose here talks ABOUT the attributes it forbids */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/** every renderer file that materializes a <webview> tag */
function webviewCreators(): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry.name)) {
        const src = code(full)
        if (/createElement\(\s*'webview'/.test(src) || /<webview[\s>]/.test(src))
          out.push(entry.name)
      }
    }
  }
  walk(path.join(__dirname, '..', '..', 'src', 'renderer', 'src'))
  return out.sort()
}

describe('the browser guest factory', () => {
  it('is the only browser-side webview creation in the renderer', () => {
    // WebView.tsx is Preview's own viewer (koloft-file:// pdf, default session by design,
    // D6); anything else appearing here is a second guest path that can miss the
    // partition. R1 removed the one exception there used to be: the store
    // overlay's own <webview> — the app-level overlay (BrowserOverlay.tsx, which the
    // store is now a caller of) goes through this factory like every other guest, so
    // the second copy of the attribute set, and the test that policed it, are retired.
    expect(webviewCreators()).toEqual(['BrowserGuest.tsx', 'WebView.tsx'])
  })

  it('names the persistent browser partition, from the shared constant', () => {
    const src = code(FACTORY)
    expect(src).toContain("import { BROWSER_PARTITION } from '@shared/types'")
    expect(src).toContain('partition: BROWSER_PARTITION')
    expect(BROWSER_PARTITION).toBe('persist:koloft-browser')
  })

  it('sandboxes the guest', () => {
    expect(code(FACTORY)).toMatch(/webpreferences:\s*'[^']*sandbox=yes/)
  })

  it('gives the guest no preload and no web-security opt-out', () => {
    const src = code(FACTORY)
    expect(src).not.toMatch(/\bpreload:/)
    expect(src).not.toMatch(/\bdisablewebsecurity\b/)
    expect(src).not.toMatch(/\bnodeintegration:\s*true/)
  })

  it('allows popups so main can route them, and main answers every one with deny', () => {
    // SEC-7 spike: without `allowpopups` Electron drops window.open before any
    // window-open handler runs, so the handler that turns a popup into a tab never
    // fires. What stops an OS window is that handler denying every request — assert
    // that, since it is the guarantee, not the attribute's absence.
    expect(code(FACTORY)).toMatch(/allowpopups:\s*true/)
    expect(code('src/main/index.ts')).toMatch(/action:\s*'deny'/)
  })

  it('hides a background guest with visibility, never display:none', () => {
    // #28677: display:none freezes the guest's rAF and wedges its visibilityState, and
    // D8 needs a switched-away session's guests to stay alive.
    const src = code(FACTORY)
    expect(src).toContain("visibility: visible ? undefined : 'hidden'")
    expect(src).not.toMatch(/display:\s*'none'/)
  })
})

/**
 * SEC-6 — the chrome around the guest is Koloft's OWN renderer: privileged preload, default
 * session, Koloft's cookies. Painting anything a page named (a favicon, an image) there is
 * that session fetching from the site, outside the partition the whole design rests on —
 * and it looks perfectly normal at runtime, so only a source guard catches it returning.
 */
describe('the browser chrome', () => {
  // retarget: `BrowserPane.tsx` was subsumed by `WorkbenchPane.tsx`, which now hosts
  // the guests AND the tab strip. The guard follows the code rather than the filename —
  // and it matters MORE after the merge, not less: FR-28 makes tab icons Koloft's own glyphs
  // precisely so a strip full of tabs never becomes a strip full of site fetches.
  const CHROME = [
    'WorkbenchPane.tsx',
    'BrowserAddressBar.tsx',
    'BrowserModal.tsx',
    'BrowserGuest.tsx'
  ]

  it('never renders a page-supplied resource in the host renderer', () => {
    for (const file of CHROME) {
      const src = code(path.join(COMPONENTS, file))
      expect({ file, img: /<img[\s/>]/.test(src) }).toEqual({ file, img: false })
      expect({ file, favicon: /favicon/i.test(src) }).toEqual({ file, favicon: false })
    }
  })
})
