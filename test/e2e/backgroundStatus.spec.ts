import fs from 'fs'
import type { Page, TestInfo } from '@playwright/test'
import { test, expect, pendingAttention } from './helpers/app'
import { centerTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'

/**
 * This case is the slowest in the suite and its most frequent flake, and every failure so
 * far has looked identical from the outside: the dot simply never came to rest. What it
 * was doing instead is only knowable from inside the run, so each step is stamped as it
 * passes and the whole picture is attached to the report when the case fails OR takes
 * unusually long. The second half matters: the durations are bimodal (about 10s normally,
 * about 36s otherwise), so the slow-but-green runs are the same event with a bigger
 * budget, and they are the ones that can be caught without waiting for a red run.
 * A fast green run pays nothing for any of it.
 */
const SLOW_RUN_MS = 20_000

interface Step {
  name: string
  at: number
}

function stamp(steps: Step[], name: string): void {
  steps.push({ name, at: Date.now() })
}

/** What the session looked like at that moment: the dot, the terminal, what is pending,
 *  how far the transcripts got. Read-only, and never throws — a diagnostic that fails
 *  would hide the failure it exists to explain. */
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
  // A FILE, not just an attachment: this repo reports with `list`, which drops
  // attachments on the floor — the first time this diagnostic fired, it wrote nothing.
  const file = info.outputPath('session-state.txt')
  fs.writeFileSync(file, out.join('\n'))
  await info.attach('session-state', { path: file, contentType: 'text/plain' })
}

// Requirement: a session whose main loop stopped while BACKGROUND work (subagents /
// workflows) still runs is WORKING — the Stop that ends the spawning turn must not
// flip the dot to 'waiting' nor raise a turn-done attention event; only once the
// background drains (task-notification delivered + wrap-up turn ends) may the dot
// rest. Drives the REAL pipeline: shim → injected hooks → tracker (spawn-ack
// ledger + subagent-transcript tailing) → attention set.
//
// Attention is read through main's pending set rather than any sidebar element: the
// Needs-you strip that used to show it is gone (the status dot is the whole in-app
// story now), and D8 keeps both remaining outlets — OS notification, Dock badge — off
// limits under a background test launch.
test('background work holds the dot at working until it drains', async ({ page, env }) => {
  test.setTimeout(120_000)
  const steps: Step[] = []
  stamp(steps, 'start')
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  stamp(steps, 'claude launched')

  // startup turn lands on waiting; consume its turn-done marker so any later
  // attention raise is unambiguously from the background scenario
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
  stamp(steps, 'startup turn rested')
  await page.locator('.ws-tab').first().click()
  await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(0)
  stamp(steps, 'attention consumed')

  // /bg-work: prompt → spawn ack → Stop, then ~5s of subagent-transcript growth
  await runIn(page, centerTerm(page), '/bg-work')
  await expect(page.locator('.ws-tab.st-working')).toBeVisible({ timeout: 15_000 })
  stamp(steps, 'working dot up')

  // while the background agent runs, the Stop that already fired must NOT
  // surface: no waiting dot, no turn-done marker. Sampling is bounded WELL inside
  // the fixture's ~5s background window (3 × 700ms from just after the working
  // dot appeared) so a slow machine can't push a sample past the legitimate
  // drain and flake on the then-correct waiting dot.
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(700)
    await expect(page.locator('.ws-tab.st-waiting')).toHaveCount(0)
    expect(await pendingAttention(page)).toHaveLength(0)
    await expect(page.locator('.ws-tab.st-working')).toBeVisible()
  }

  // background drains: notification + wrap-up Stop → the dot rests and the
  // turn-done attention finally (and only now) pends. The drain is immediate
  // (the notification advances the main-transcript recency past the subagent's),
  // so no quiescence tail is involved.
  stamp(steps, 'sampling done')
  try {
    // 60s, not 30: measured, this wait is bimodal — about a second normally, about
    // twenty-six seconds when the drain lands on a backstop instead of the
    // notification. The requirement ("not before it drains") is pinned by the negative
    // sampling above; this one only says it eventually rests, so a budget that a slow
    // machine can miss buys nothing but a flake.
    await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 60_000 })
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
  // a green run that took this long is the same event the failures are, with room to
  // spare — worth the same picture, so the next look does not start from zero
  if (steps[steps.length - 1].at - steps[0].at > SLOW_RUN_MS) {
    await dumpState(page, steps, test.info(), env.home)
  }
})

// Requirement: the same hold covers a session parked on a background SHELL the
// model was blocked on (a command auto-backgrounded at its timeout). Nothing
// grows on disk while it runs — no subagent transcript, no main-jsonl append —
// so this drives the spawn-ack ledger channel alone, end to end.
test('a shell the model is parked on holds the dot at working', async ({ page }) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')

  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
  await page.locator('.ws-tab').first().click()
  await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(0)

  // /bg-shell: prompt → auto-backgrounded Bash ack → Stop, then ~5s of silence
  await runIn(page, centerTerm(page), '/bg-shell')
  await expect(page.locator('.ws-tab.st-working')).toBeVisible({ timeout: 15_000 })

  // the Stop already fired, and NOTHING is being written — the ledger alone has
  // to keep this session out of 'waiting' for the whole background window
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(700)
    await expect(page.locator('.ws-tab.st-waiting')).toHaveCount(0)
    expect(await pendingAttention(page)).toHaveLength(0)
    await expect(page.locator('.ws-tab.st-working')).toBeVisible()
  }

  // the command finishes: notification wakes the model, its wrap-up turn ends,
  // and only that Stop rests the dot
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => pendingAttention(page), { timeout: 10_000 })
    .toMatchObject([{ kind: 'turn-done' }])
})

// Requirement: when Claude Code reports its OWN live background work in the Stop
// payload (`background_tasks`, claude >= 2.1.228), that count decides the turn-end —
// even with NOTHING in the transcript to infer from. This is the channel that makes
// an unrecognised launch shape (a forked skill, a teammate, whatever CC adds next)
// stop mattering, and it is the only spec driving the whole chain end to end:
// hook script counts → run-state log carries it → drain forwards it → tracker holds.
test('a turn-end that reports its own live tasks holds the dot, with no ack on disk', async ({
  page
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')

  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
  await page.locator('.ws-tab').first().click()
  await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(0)

  // /bg-reported: prompt → Stop reporting one running task. No spawn ack is ever
  // written, so the inferred ledger is empty the whole time.
  await runIn(page, centerTerm(page), '/bg-reported')
  await expect(page.locator('.ws-tab.st-working')).toBeVisible({ timeout: 15_000 })

  // sampled well inside the fixture's 5s window
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(700)
    await expect(page.locator('.ws-tab.st-waiting')).toHaveCount(0)
    expect(await pendingAttention(page)).toHaveLength(0)
    await expect(page.locator('.ws-tab.st-working')).toBeVisible()
  }

  // the second Stop reports an empty list — the turn-end lands on that alone
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 30_000 })
  await expect
    .poll(() => pendingAttention(page), { timeout: 10_000 })
    .toMatchObject([{ kind: 'turn-done' }])
})

// Requirement (product decision): something a session keeps open WITHOUT
// working on it — a persistent Monitor here — must not hold the dot, and must not be
// invisible either: the row shows a ⏸ badge naming it, so the user can go and stop
// it. The only spec driving that whole chain: Monitor ack in the transcript → Stop
// list → tracker judgement → SessionInfo.parked → sidebar badge.
test('a Monitor left running is parked: the dot rests and the row shows a ⏸ badge', async ({
  page
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')

  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
  await page.locator('.ws-tab').first().click()
  await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(0)

  // /bg-monitor: prompt → Monitor ack → Stop reporting it as a running shell
  await runIn(page, centerTerm(page), '/bg-monitor')
  const badge = page.locator('.ws-tab .ws-tab-parked')
  await expect(badge).toHaveText('⏸ 1', { timeout: 15_000 })
  // the badge is the door to the card that names it and says how to release it (a
  // native tooltip never got the chance: the row's hover-intent menu opens first —
  // live,); the click must not reach the row
  await badge.click()
  const card = page.locator('.tbu-pop.parked')
  await expect(card).toContainText('monitor · tail -f bot.log')
  await expect(card).toContainText('ctrl+b')
  await expect(page.locator('.menu')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(card).toHaveCount(0)
  // parked is not working: the turn-end landed on this very Stop
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(() => pendingAttention(page), { timeout: 10_000 })
    .toMatchObject([{ kind: 'turn-done' }])
})
