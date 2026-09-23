import { test, expect } from './helpers/app'
import { openSessionTerminal, panelTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'
import type { FlowStats } from '../../src/shared/types'

// Requirement: a sustained flood must arrive INTACT and must not strand the tab
// (send window shut with no pump) or the child (pty paused with no resume). Honest
// scope: xterm's ~50MB discard cap itself is not reachable in an e2e-sized flood —
// the discard-avoidance decision logic is pinned by test/unit/flowControl.test.ts.
// What THIS spec pins is the live wiring the unit layer can't: the ack loop across
// real IPC (a broken loop shuts the window at 512KB and the marker never renders),
// the ack-driven pump of held backlog after the child goes quiet, and end-to-end
// delivery under pressure.
test('a sustained output flood arrives intact and the terminal stays responsive', async ({
  app,
  page
}) => {
  // the per-test budget must exceed every expect() timeout below, or those budgets
  // are dead letters (the runner kills the test first)
  test.setTimeout(240_000)

  await waitBooted(page)
  // D1: the only shell is a live session's own terminal tab, so the session is the
  // setup line now. The flood itself is unchanged — same pty, same ack loop.
  await startSessionIn(page, 'ws-a')
  await openSessionTerminal(app, page)
  // 50k lines × ~80 chars (~4MB) from the shell itself; the marker value is computed
  // by the shell so it can only appear if the pipeline actually ran to completion.
  await runIn(
    page,
    panelTerm(page),
    `yes "$(printf 'x%.0s' {1..78})" | head -n 50000; echo FLOOD_END_$((40 + 2))`
  )
  await expect(panelTerm(page).locator('.xterm-rows')).toContainText('FLOOD_END_42', {
    timeout: 120_000
  })

  // the ack loop really ran: main forwarded the flood and the renderer acked it back
  // (a dead ack path would have stalled forwarding at the first 512KB window)
  await expect
    .poll(
      async () => {
        const stats = (await page.evaluate(() =>
          (
            window as unknown as {
              api: { terminal: { flowStats(): Promise<unknown> } }
            }
          ).api.terminal.flowStats()
        )) as FlowStats[]
        const tab = stats.find((s) => s.attached && s.sentUnits > 3_000_000)
        if (!tab) return 'no flooded tab'
        return tab.ackedUnits >= tab.sentUnits * 0.9 ? 'acked' : 'lagging'
      },
      { timeout: 30_000 }
    )
    .toBe('acked')

  // and nothing is stranded: the tab still runs commands afterwards
  await runIn(page, panelTerm(page), 'echo AFTER_$((6 * 7))')
  await expect(panelTerm(page).locator('.xterm-rows')).toContainText('AFTER_42', {
    timeout: 15_000
  })
})
