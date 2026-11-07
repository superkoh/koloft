import fs from 'fs'
import path from 'path'
import { test, expect } from './helpers/app'
import { openSessionTerminal, panelTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'
import type { FlowStats } from '../../src/shared/types'

const SYNC_FRAMES = 12
const ROW_PADDING_SGR_RESETS = 4000
const GAP_BETWEEN_FRAMES_FOR_A_PAINT_MS = 60
const SYNC_FRAME_PRINTER = `
const [rows, frames, padCount, gapMs] = process.argv.slice(2).map(Number)
const pad = '\\x1b[0m'.repeat(padCount)
const frame = (k) => {
  if (k === frames) return process.stdout.write('\\x1b[' + rows + ';1H\\r\\nSYNC_FRAMES_DONE\\r\\n')
  let f = '\\x1b[?2026h'
  for (let r = 1; r <= rows; r++) f += '\\x1b[' + r + ';1Hframe ' + String(k).padStart(4, '0') + pad + '\\x1b[K'
  process.stdout.write(f + '\\x1b[?2026l', () => setTimeout(() => frame(k + 1), gapMs))
}
frame(0)
`

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

// CC§12 PLATFORM§21
test('a synchronized frame several output slices long still lands on screen whole, never half old and half new', async ({
  env,
  page,
  app
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await openSessionTerminal(app, page)
  const ptyId = await page.locator('.wb-panel .wb-term:visible').getAttribute('data-pty')
  const rows = await page.evaluate((id) => {
    type Term = { rows: number; element: HTMLElement; onRender(cb: () => void): void }
    const w = window as unknown as {
      __koloftTerms: Record<string, Term>
      __frames: { painted: number; torn: string[] }
    }
    const term = w.__koloftTerms[id!]
    w.__frames = { painted: 0, torn: [] }
    term.onRender(() => {
      const shown = [...term.element.querySelectorAll('.xterm-rows > div')].map(
        (row) => row.textContent ?? ''
      )
      if (shown.some((row) => row.includes('SYNC_FRAMES_DONE'))) return
      const labels = shown.map((row) => /frame (\d{4})/.exec(row)?.[1] ?? '-')
      if (labels.every((l) => l === '-')) return
      w.__frames.painted += 1
      if (new Set(labels).size > 1) w.__frames.torn.push(labels.join(' '))
    })
    return term.rows
  }, ptyId)
  const printer = path.join(env.home, 'sync-frames.js')
  fs.writeFileSync(printer, SYNC_FRAME_PRINTER)
  await runIn(
    page,
    panelTerm(page),
    `'${process.execPath}' '${printer}' ${rows} ${SYNC_FRAMES} ${ROW_PADDING_SGR_RESETS} ${GAP_BETWEEN_FRAMES_FOR_A_PAINT_MS}`
  )
  await expect(panelTerm(page).locator('.xterm-rows')).toContainText('SYNC_FRAMES_DONE', {
    timeout: 60_000
  })
  const frames = await page.evaluate(
    () => (window as unknown as { __frames: { painted: number; torn: string[] } }).__frames
  )
  expect(frames.painted).toBeGreaterThan(0)
  expect(frames.torn).toEqual([])
})
