import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import { openSessionTerminal, panelTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'

// The webgl:repair channel (main → renderer) fires after OS resume / display changes
// and must clear the glyph atlas + repaint every live WebGL tab WITHOUT breaking the
// terminal (webglRepair.ts). This spec drops the suite-wide KOLOFT_DOM_RENDERER seam to
// launch with the real WebGL renderer — output text isn't DOM-assertable there
// (glyphs live on a canvas), so the contract is asserted through renderer-process
// health and a filesystem side effect instead: repair must produce zero uncaught
// renderer errors, and the terminal must still execute commands afterwards. On a
// GPU-less machine the WebglAddon falls back to the DOM renderer and this still
// verifies the full IPC wiring end-to-end.
test('webgl:repair repaints live tabs without breaking the terminal', async ({ env }) => {
  // a session start is on the critical path now, and it is not cheap
  test.setTimeout(180_000)
  delete env.launchEnv.KOLOFT_DOM_RENDERER

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))

    // don't drive a shortcut into a renderer that hasn't mounted its listeners yet (a
    // cold-start launch can lose that race) — the empty state proves React committed,
    // so the App-level IPC subscriptions exist
    await expect(page.locator('.center')).toContainText('No running session', {
      timeout: 20_000
    })
    await waitBooted(page)
    // D1: shells live in a session's Workbench panel now, so the session comes first.
    await startSessionIn(page, 'ws-a')

    // Two terminals so the repair fans out across the SHARED atlas (the single-tab-only
    // regression this guards against — upstream #6014 — is a multi-tab defect). The
    // island's tab-strip ＋ is retired; a second ⌃` is the same "one more shell" action.
    await openSessionTerminal(app, page)
    await openSessionTerminal(app, page)
    await expect(page.locator('.wb-panel .wb-term')).toHaveCount(2, { timeout: 30_000 })

    const marker = path.join(env.home, 'repair-marker')
    await runIn(page, panelTerm(page), `touch '${marker}.before'`)
    await expect.poll(() => fs.existsSync(`${marker}.before`), { timeout: 15_000 }).toBe(true)

    // The exact IPC main sends after powerMonitor resume / display changes.
    await app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('webgl:repair')
    })

    // The terminal must keep executing commands after the atlas clear + repaint.
    await runIn(page, panelTerm(page), `touch '${marker}.after'`)
    await expect.poll(() => fs.existsSync(`${marker}.after`), { timeout: 15_000 }).toBe(true)

    expect(errors).toEqual([])
  } finally {
    await app.close().catch(() => {})
  }
})

// Forces REAL atlas page merges — the code path the upstream atlas fixes rework. 24k
// distinct glyph-cache keys (4k CJK codepoints × 6 ANSI colors; ~2 cells wide each)
// far exceed the 16-page atlas cap, so _createNewPage must merge repeatedly while
// output streams. On the pre-fix addon (≤0.19.0) this was the reliable garbled-screen repro;
// the automated contract here is that the merge storm raises no uncaught renderer
// error and the terminal keeps working. (Glyph legibility itself isn't DOM-assertable
// under WebGL — the canvas is verified visually in development, not here.)
test('atlas page-merge stress: heavy CJK churn breaks nothing', async ({ env }) => {
  // a session start is on the critical path now, and it is not cheap
  test.setTimeout(180_000)
  delete env.launchEnv.KOLOFT_DOM_RENDERER

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))

    // don't fire shortcut:new-tab into a renderer that hasn't mounted its listeners
    // yet (a cold-start launch can lose that race) — the empty state proves React
    // committed, so the App-level IPC subscriptions exist
    await expect(page.locator('.center')).toContainText('No running session', {
      timeout: 20_000
    })
    await waitBooted(page)
    // D1: the shell the storm runs in is a live session's own terminal tab.
    await startSessionIn(page, 'ws-a')
    await openSessionTerminal(app, page)

    // ${(#)i} is zsh for "the character at codepoint i" — no subshell forks, so the
    // whole storm prints in a couple of seconds while xterm rasterizes every glyph.
    const marker = path.join(env.home, 'stress-marker')
    await runIn(
      page,
      panelTerm(page),
      `for c in 31 32 33 34 35 36; do for i in {19968..23968}; do print -n "\\e[\${c}m\${(#)i}"; done; done; print "\\e[0m"; touch '${marker}'`
    )
    await expect.poll(() => fs.existsSync(marker), { timeout: 30_000 }).toBe(true)

    // let the trailing frames (and the debounced merge-signal refresh) settle
    await page.waitForTimeout(500)

    // the terminal must still execute commands after the merge storm
    await runIn(page, panelTerm(page), `touch '${marker}.after'`)
    await expect.poll(() => fs.existsSync(`${marker}.after`), { timeout: 15_000 }).toBe(true)

    expect(errors).toEqual([])
  } finally {
    await app.close().catch(() => {})
  }
})
