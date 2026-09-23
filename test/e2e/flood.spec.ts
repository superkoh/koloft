import { test, expect } from './helpers/app'
import { openSessionTerminal, panelTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'
import type { FlowStats } from '../../src/shared/types'

test('a sustained output flood arrives intact through the real IPC ack loop, nothing is stranded, and the terminal stays responsive', async ({
  app,
  page
}) => {
  test.setTimeout(240_000)

  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await openSessionTerminal(app, page)
  await runIn(
    page,
    panelTerm(page),
    `yes "$(printf 'x%.0s' {1..78})" | head -n 50000; echo FLOOD_END_$((40 + 2))`
  )
  await expect(panelTerm(page).locator('.xterm-rows')).toContainText('FLOOD_END_42', {
    timeout: 120_000
  })

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

  await runIn(page, panelTerm(page), 'echo AFTER_$((6 * 7))')
  await expect(panelTerm(page).locator('.xterm-rows')).toContainText('AFTER_42', {
    timeout: 15_000
  })
})
