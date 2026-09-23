import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * §05D-11 / D12 (amended) — the guest preload's boundary, enforced at the source.
 *
 * D12 forbids handing a guest Koloft's privileged bridge. The two channels are allowed to
 * exist BECAUSE they grant the page nothing: the dialog one replaces three functions the
 * page already has, and the blocked-link one only reports a navigation Chromium already
 * refused (SEC-4) — neither exposes an object at all. Both halves of that are invisible
 * at runtime — a page cannot tell you what it was NOT given — so they are asserted on the
 * file: the IPC channels it may speak, and the one session it may be loaded into.
 */
const SRC = path.join(__dirname, '..', '..', 'src')
const GUEST = path.join(SRC, 'preload', 'guest.ts')
const MAIN = path.join(SRC, 'main', 'index.ts')

/** source with comments removed — the prose here talks ABOUT what it forbids */
function code(file: string): string {
  return fs
    .readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

describe('the guest preload', () => {
  it('exposes nothing to the page: no bridged object, no node, no app IPC', () => {
    const src = code(GUEST)
    expect(src).not.toMatch(/exposeInMainWorld|exposeInIsolatedWorld/)
    expect(src).not.toMatch(/\brequire\s*\(/)
    expect(src).not.toMatch(/\bprocess\b/)
    expect(src).not.toMatch(/webFrame|shell|clipboard/)
  })

  it('speaks three channels and no others: the dialog, the refused link, the background open', () => {
    // The list is the point of this case: every channel added here widens what a page's
    // own world can say to main, so growing it has to be a deliberate edit rather than a
    // side effect. The third one (§07 #1) carries a url main does not trust — it runs the
    // same routing table every other in-page action does, and the only thing it can
    // produce is a background tab.
    const src = code(GUEST)
    expect(src.match(/ipcRenderer\.\w+/g)).toEqual([
      'ipcRenderer.sendSync',
      'ipcRenderer.send',
      'ipcRenderer.send'
    ])
    expect(src.match(/'browser:[^']+'/g)).toEqual([
      "'browser:js-dialog'",
      "'browser:link-blocked'",
      "'browser:open-background'"
    ])
  })

  it('is registered on the browser partition alone, once', () => {
    // the host window's preload is Koloft's own bridge (pty spawn, account tokens): a
    // second registration point is how the guest script would reach a window that has it
    const main = code(MAIN)
    expect(main.match(/registerPreloadScript/g)).toHaveLength(1)
    const partitionSetup = main.slice(
      main.indexOf('function setupBrowserPartition'),
      main.indexOf('function handleOpenRequest')
    )
    expect(partitionSetup).toContain('registerPreloadScript')
    expect(partitionSetup).toContain("'../preload/guest.js'")
    expect(main.match(/preload\/guest\.js/g)).toHaveLength(1)
  })
})
