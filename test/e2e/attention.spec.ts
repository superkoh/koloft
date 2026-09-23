import { test, expect, pendingAttention } from './helpers/app'
import {
  centerTerm,
  FAKE_SESSION_TITLE,
  killSession,
  runIn,
  startSessionIn,
  waitBooted,
  waitForCalls
} from './helpers/p1'

// Requirement: main must derive "this session needs the user" markers from real
// session-status transitions, and looking at a tab must consume its marker. This drives
// the REAL pipeline: shim → hooks → tracker 'status' transitions → attention set.
//
// The markers used to be rendered three ways in the sidebar (roll-up count, Needs-you
// strip, row badge); all three are gone — the status dot says it on its own. So these
// specs assert against the pending SET (pendingAttention) plus the dot, which is the
// pair that still has to agree. The set's own outlets (OS notification, Dock badge) are
// unobservable here by design: D8 forbids both under a background test launch.
test('a finished turn pends attention and visiting the tab clears it', async ({ page }) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')

  // the fake claude's prompt→stop cycle lands on 'waiting' — a finished turn
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })

  // the marker pends even though this tab is active: the window is never focused under
  // KOLOFT_TEST_BACKGROUND, which is exactly the "user is elsewhere" case
  await expect
    .poll(() => pendingAttention(page), { timeout: 10_000 })
    .toMatchObject([{ kind: 'turn-done', title: expect.stringContaining('project notes') }])

  // the in-app channels this used to light up are gone and must stay gone
  await expect(page.locator('.needs')).toHaveCount(0)
  await expect(page.locator('.sb-rollup')).toHaveCount(0)
  await expect(page.locator('.ws-badge')).toHaveCount(0)
  await expect(page.locator('.toast')).toHaveCount(0)

  // clicking the row is an explicit visit — the marker is consumed even unfocused
  await page.locator('.ws-tab').first().click()
  await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(0)
  // …and the dot is untouched by any of that: it reports run-state, not attention
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible()
})

// Requirement: a GRACEFUL exit (the user's own doing) must clear the pending marker
// and never raise an 'exited' alert — false alarms train the user to ignore the outlet.
test('a graceful /exit clears pending and never raises exited', async ({ page }) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(1)

  // the fake claude reads stdin: /exit fires SessionEnd(reason=prompt_input_exit)
  await runIn(page, centerTerm(page), '/exit')
  await expect.poll(() => pendingAttention(page), { timeout: 15_000 }).toHaveLength(0)
  // and it STAYS clear across two liveness-sweep periods (2.5s each) — a sweep that
  // misread this graceful end as a hard exit would raise 'exited'
  await page.waitForTimeout(6_000)
  expect(await pendingAttention(page)).toHaveLength(0)
})

// Requirement: a HARD exit (kill -9, no SessionEnd) must leave the session in the list
// as a cold row rather than dropping it — the work is still resumable, and the row is
// the only thing that says so.
//
// NOT asserted here: the 'exited' attention marker. A session pty runs `exec claude`
// (agent-centric §9), so killing claude kills the pty itself — main clears the tab's
// markers on that exit, and the liveness sweep that raises 'exited' only ever sees tabs
// whose pty is still alive. The marker was reachable while a shell hosted claude; that
// shape is gone. The retired lifecycle design still promised the alert — the gap is
// now not a behavior to pin from here.
test('a hard-killed claude turns its row cold in place, keeping its title', async ({
  page,
  env
}) => {
  test.setTimeout(150_000)
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })

  // through killSession, so the SIGKILL can only ever land on this test's own claude
  const [call] = await waitForCalls(env, 1)
  killSession(call.pid, env)

  // the sidebar turns the dead session cold IN PLACE (T-LIFE-04) — the row keeps its
  // title but loses every run-state lightbar.
  const row = page.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })
  await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
  await expect(page.locator('.ws-tab.st-waiting')).toHaveCount(0)
  await expect(page.locator('.ws-tab.st-approval')).toHaveCount(0)
})
