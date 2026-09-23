import { test, expect, pendingAttention } from './helpers/app'
import {
  centerTerm,
  processAlive,
  readCalls,
  runIn,
  startSessionIn,
  termIds,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'

// a renderer reload re-adopts main's live ptys instead of orphaning them.
// Main owns the tab inventory (tabs:list); the reloaded renderer rebuilds the strip
// under the SAME pty ids, re-attaches each xterm, and a one-shot SIGWINCH nudge makes
// the claude TUI repaint into the fresh (blank) buffer. The assertions lean on process
// boundaries (pty ids via __koloftTerms, claude pids and launch counts via the fake's
// call log) rather than DOM state — adoption is a process-reality claim.
// The adoption-FAILED fallback (Force Close) lives in orphan-session.spec.ts behind
// the KOLOFT_TEST_NO_ADOPT seam.

test('T-REL-01: a reload re-adopts the session — same pty, one claude, repaint, typing works', async ({
  page,
  env
}) => {
  test.setTimeout(180_000)
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const [launch] = await waitForCalls(env, 1)
  const idsBefore = await termIds(page)
  expect(idsBefore).toHaveLength(1)
  const row = wsRows(page, 'ws-a').first()

  await page.reload()
  await waitBooted(page)
  // the positive, event-driven adoption wait comes FIRST — every negative assert
  // below is only meaningful once the key set proves the same ptys re-attached
  await expect.poll(() => termIds(page), { timeout: 30_000 }).toEqual(idsBefore)
  // the nudge's SIGWINCH reached the claude behind the SAME pty, and the fresh
  // xterm renders what it printed — repaint, attach and data path in one marker
  await expect(centerTerm(page)).toContainText('[fake-claude] winch', { timeout: 30_000 })

  // the row never went cold, and clicking it activates the adopted tab — the
  // Force Close confirm (async: it awaits adoption + a main round trip) must not
  // appear, so give its path room to (not) raise the modal before asserting
  await expect(row).not.toHaveClass(/\bcold\b/)
  await row.click()
  await page.waitForTimeout(1500)
  await expect(page.locator('.modal')).toHaveCount(0)

  // typing reaches the same claude process — the session continues, not restarts
  await runIn(page, centerTerm(page), 'after-reload-marker')
  await expect(centerTerm(page)).toContainText('handled: after-reload-marker', {
    timeout: 30_000
  })
  expect(readCalls(env)).toHaveLength(1) // nothing respawned
  expect(processAlive(launch.pid)).toBe(true)
})

test('T-REL-02: attention markers and the active tab survive the reload', async ({ page, env }) => {
  test.setTimeout(180_000)
  await waitBooted(page)
  // session A with a finished turn (its marker pends: the background test window is
  // never OS-focused, so no tab is ever "watched" — attention.spec's precondition)
  await startSessionIn(page, 'ws-a')
  await waitForCalls(env, 1)
  await runIn(page, centerTerm(page), 'marker-a')
  await expect(centerTerm(page)).toContainText('handled: marker-a', { timeout: 30_000 })
  // session B on top (last created = last appended), with its own pending turn
  await startSessionIn(page, 'ws-b')
  await waitForCalls(env, 2)
  await runIn(page, centerTerm(page), 'marker-b')
  await expect(centerTerm(page)).toContainText('handled: marker-b', { timeout: 30_000 })
  await expect.poll(() => pendingAttention(page), { timeout: 15_000 }).toHaveLength(2)
  // back to A: the visit consumes A's marker (B's survives) and A becomes the tab
  // the reload must remember
  const rowA = wsRows(page, 'ws-a').first()
  await rowA.click()
  await expect(rowA).toHaveClass(/\bactive\b/)
  await expect.poll(() => pendingAttention(page), { timeout: 15_000 }).toHaveLength(1)
  const ids = await termIds(page)
  expect(ids).toHaveLength(2)

  await page.reload()
  await waitBooted(page)
  await expect.poll(() => termIds(page), { timeout: 30_000 }).toEqual(ids)
  // Decision 3: the tab the user was on is selected again — NOT the last one adopted.
  // (The adopted xterm holds only post-reload output — main keeps no scrollback and
  // the fake's winch handler prints a marker, not a transcript repaint — so the
  // pre-reload text can't identify the tab; the sidebar selection can.)
  await expect(rowA).toHaveClass(/\bactive\b/, { timeout: 30_000 })
  await expect(wsRows(page, 'ws-b').first()).not.toHaveClass(/\bactive\b/)
  // Decision 2: B's marker survived the reload (same tab-id universe, still joinable)…
  await expect.poll(() => pendingAttention(page), { timeout: 15_000 }).toHaveLength(1)
  // …and an explicit visit on the ADOPTED tab still consumes it
  await wsRows(page, 'ws-b').first().click()
  await expect.poll(() => pendingAttention(page), { timeout: 15_000 }).toHaveLength(0)
})

test('T-REL-03: a crashed renderer auto-recovers and re-adopts (the production path)', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  // Playwright's Page object never recovers from a renderer crash (every call —
  // even reload() — rejects "Page crashed" forever), so everything after the crash
  // is driven through main: app.evaluate → webContents.executeJavaScript. The
  // Electron side is healthy; only the CDP client wrapper is dead.
  const inRenderer = <T>(expr: string): Promise<T> =>
    app.evaluate(
      ({ BrowserWindow }, js) =>
        BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(js) as Promise<T>,
      expr
    )

  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const [launch] = await waitForCalls(env, 1)
  const idsBefore = await termIds(page)

  // the production orphaning event: no navigation, the renderer process just dies —
  // main's render-process-gone handler must reload the window on its own.
  const crashed = page.waitForEvent('crash')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer()
  })
  await crashed
  // This event firing WITHOUT any Playwright-side navigation IS the auto-recovery
  // proof — only main's render-process-gone reload can commit a document now. It
  // also gates the executeJavaScript below: issued before the new document commits,
  // the call queues against the dead renderer and never settles.
  await page.waitForEvent('domcontentloaded', { timeout: 30_000 })
  // the recovery boot ran: only the reloaded renderer can set these
  await expect
    .poll(
      () =>
        inRenderer<boolean>('!!(window.__koloftShortcutsReady && window.__koloftRowsReady)').catch(
          () => false
        ),
      { timeout: 30_000 }
    )
    .toBe(true)
  // …and it re-adopted the same pty (key-set equality = nothing respawned)
  await expect
    .poll(() => inRenderer<string[]>('Object.keys(window.__koloftTerms ?? {})'), {
      timeout: 30_000
    })
    .toEqual(idsBefore)
  // input still reaches the same claude through the adopted tab's pty
  await inRenderer<void>(
    `window.api.terminal.write(${JSON.stringify(idsBefore[0])}, 'after-crash-marker\\r')`
  )
  await expect
    .poll(
      () =>
        inRenderer<string>(
          `(() => { const t = (window.__koloftTerms ?? {})[${JSON.stringify(idsBefore[0])}];
             if (!t) return '';
             const b = t.buffer.active; const out = [];
             for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
             return out.join('\\n') })()`
        ),
      { timeout: 30_000 }
    )
    .toContain('handled: after-crash-marker')
  expect(readCalls(env)).toHaveLength(1)
  expect(processAlive(launch.pid)).toBe(true)
})

// T-REL-04 — "the island respawns on reload and the old shell is
// killed, not leaked". D4 flipped the respawn half: terminal tabs are not layout data, so
// nothing comes back. The surviving half (no leaked zsh across a reload) and the flipped
// half now live together in workbench-terminal.spec.ts T-WT-11, driven through a session's
// own terminal tab — the only shell the product has.
