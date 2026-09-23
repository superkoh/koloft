import fs from 'fs'
import type { Page, TestInfo } from '@playwright/test'
import { test, expect, pendingAttention } from './helpers/app'
import { centerTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'

const SLOW_GREEN_RUN_WORTH_A_DUMP_MS = 20_000
const DRAIN_MAY_LAND_ON_THE_26S_BACKSTOP_MS = 60_000

interface Step {
  name: string
  at: number
}

function stamp(steps: Step[], name: string): void {
  steps.push({ name, at: Date.now() })
}

async function dumpState(page: Page, steps: Step[], info: TestInfo, home: string): Promise<void> {
  const out: string[] = []
  const t0 = steps[0]?.at ?? Date.now()
  steps.forEach((s, i) => {
    const prev = i === 0 ? t0 : steps[i - 1].at
    out.push(`+${s.at - t0}ms (this step ${s.at - prev}ms) ${s.name}`)
  })
  try {
    const rows = await page.locator('.ws-tab').evaluateAll((els) => els.map((e) => e.className))
    out.push(`rows: ${JSON.stringify(rows)}`)
    out.push(`attention: ${JSON.stringify(await pendingAttention(page))}`)
    const term = await page.evaluate(() => {
      const seam = (
        window as unknown as {
          __koloftTerms?: Record<
            string,
            {
              buffer: {
                active: {
                  length: number
                  getLine(i: number): { translateToString(t?: boolean): string } | undefined
                }
              }
            }
          >
        }
      ).__koloftTerms
      if (!seam) return '<no terminal seam>'
      const seen: string[] = []
      for (const one of Object.values(seam)) {
        const b = one.buffer.active
        for (let i = 0; i < b.length; i++) {
          const l = b.getLine(i)?.translateToString(true) ?? ''
          if (l.trim()) seen.push(l)
        }
      }
      return seen.slice(-12).join('\n')
    })
    out.push(`terminal tail:\n${term}`)
    const projects = `${home}/.claude/projects`
    const sizes: string[] = []
    const walk = (dir: string): void => {
      for (const n of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        const full = `${dir}/${n}`
        if (fs.statSync(full).isDirectory()) walk(full)
        else if (n.endsWith('.jsonl'))
          sizes.push(`${fs.statSync(full).size}b ${full.slice(projects.length)}`)
      }
    }
    walk(projects)
    out.push(`transcripts:\n${sizes.join('\n')}`)
  } catch (e) {
    out.push(`(state read failed: ${String(e).slice(0, 200)})`)
  }
  const fileSinceListReporterDropsAttachments = info.outputPath('session-state.txt')
  fs.writeFileSync(fileSinceListReporterDropsAttachments, out.join('\n'))
  await info.attach('session-state', {
    path: fileSinceListReporterDropsAttachments,
    contentType: 'text/plain'
  })
}

async function expectStillWorkingThroughTheFixtures5sBackgroundWindow(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(700)
    await expect(page.locator('.ws-tab.st-waiting')).toHaveCount(0)
    expect(await pendingAttention(page)).toHaveLength(0)
    await expect(page.locator('.ws-tab.st-working')).toBeVisible()
  }
}

test.describe('background work (subagents, shells, CC-reported tasks) holds the status dot at working until it drains', () => {
  test('background subagent work holds the dot at working, with no turn-done attention, until it drains', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    const steps: Step[] = []
    stamp(steps, 'start')
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    stamp(steps, 'claude launched')

    await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
    stamp(steps, 'startup turn rested')
    await page.locator('.ws-tab').first().click()
    await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(0)
    stamp(steps, 'attention consumed')

    await runIn(page, centerTerm(page), '/bg-work')
    await expect(page.locator('.ws-tab.st-working')).toBeVisible({ timeout: 15_000 })
    stamp(steps, 'working dot up')

    await expectStillWorkingThroughTheFixtures5sBackgroundWindow(page)

    stamp(steps, 'sampling done')
    try {
      await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({
        timeout: DRAIN_MAY_LAND_ON_THE_26S_BACKSTOP_MS
      })
      stamp(steps, 'drained, dot rested')
    } catch (e) {
      stamp(steps, 'GAVE UP waiting for the dot to rest')
      await dumpState(page, steps, test.info(), env.home)
      throw e
    }
    await expect
      .poll(() => pendingAttention(page), { timeout: 10_000 })
      .toMatchObject([{ kind: 'turn-done' }])
    stamp(steps, 'turn-done pending')
    if (steps[steps.length - 1].at - steps[0].at > SLOW_GREEN_RUN_WORTH_A_DUMP_MS) {
      await dumpState(page, steps, test.info(), env.home)
    }
  })

  test('a background shell the model is parked on holds the dot at working through the spawn-ack ledger alone, with nothing written to disk', async ({
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
    await page.locator('.ws-tab').first().click()
    await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(0)

    await runIn(page, centerTerm(page), '/bg-shell')
    await expect(page.locator('.ws-tab.st-working')).toBeVisible({ timeout: 15_000 })

    await expectStillWorkingThroughTheFixtures5sBackgroundWindow(page)

    await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => pendingAttention(page), { timeout: 10_000 })
      .toMatchObject([{ kind: 'turn-done' }])
  })

  // CC§8
  test('a turn-end whose Stop payload reports its own live background_tasks holds the dot, with no ack on disk', async ({
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
    await page.locator('.ws-tab').first().click()
    await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(0)

    await runIn(page, centerTerm(page), '/bg-reported')
    await expect(page.locator('.ws-tab.st-working')).toBeVisible({ timeout: 15_000 })

    await expectStillWorkingThroughTheFixtures5sBackgroundWindow(page)

    await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 30_000 })
    await expect
      .poll(() => pendingAttention(page), { timeout: 10_000 })
      .toMatchObject([{ kind: 'turn-done' }])
  })

  // CC§8
  test('a Monitor left running is parked: the dot rests, and the row shows a ⏸ badge whose click opens its card, not the row menu', async ({
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
    await page.locator('.ws-tab').first().click()
    await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(0)

    await runIn(page, centerTerm(page), '/bg-monitor')
    const badge = page.locator('.ws-tab .ws-tab-parked')
    await expect(badge).toHaveText('⏸ 1', { timeout: 15_000 })
    await badge.click()
    const card = page.locator('.tbu-pop.parked')
    await expect(card).toContainText('monitor · tail -f bot.log')
    await expect(card).toContainText('ctrl+b')
    await expect(page.locator('.menu')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(card).toHaveCount(0)
    await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 15_000 })
    await expect
      .poll(() => pendingAttention(page), { timeout: 10_000 })
      .toMatchObject([{ kind: 'turn-done' }])
  })
})
