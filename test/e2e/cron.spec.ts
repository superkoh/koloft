import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import {
  auxIcon,
  centerTerm,
  clickAppMenuItem,
  closeMenu,
  encodeCwd,
  focusOwner,
  gitInit,
  menuItemTexts,
  openMenu,
  openWorktreeSession,
  readCalls,
  resumedId,
  sendShortcut,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows,
  type ClaudeCall
} from './helpers/p1'
import type { CronFile, CronJob } from '../../src/shared/types'

const gitWhere = (slug: string): string =>
  `A new copy of the repo every time — .claude/worktrees/${slug}-<date>-<time>, ` +
  `branch worktree-${slug}-…. Your own files are never touched. Each run's folder and ` +
  `branch stay until you remove them (git worktree remove). Closing and /exit work ` +
  `exactly as in any New worktree session.`

function cronDialog(page: Page): Locator {
  return page.locator('.modal.cronjobs')
}

async function openCron(page: Page, wsName: string): Promise<Locator> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
  const dlg = cronDialog(page)
  await expect(dlg).toBeVisible({ timeout: 15_000 })
  return dlg
}

async function closeCron(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(cronDialog(page)).toHaveCount(0)
}

function card(page: Page, name: string): Locator {
  return page.locator('.job-row').filter({
    has: page.locator('.job-name', {
      hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
    })
  })
}

type WhenSpec =
  | { kind: 'daily'; at: string }
  | { kind: 'weekly'; days: string[]; at: string }
  | { kind: 'every'; n: number; unit: 'minutes' | 'hours' }

interface JobSpec {
  name: string
  task: string
  when?: WhenSpec
  model?: string
  effort?: string
  permission?: string
}

async function fillForm(dlg: Locator, spec: JobSpec): Promise<void> {
  await dlg.locator('input[aria-label="Name"]').fill(spec.name)
  await dlg.locator('[aria-label="What to run"]').fill(spec.task)
  const when: WhenSpec = spec.when ?? { kind: 'daily', at: '21:00' }
  if (when.kind === 'daily') {
    await dlg.locator('.chip', { hasText: 'Every day' }).click()
    await dlg.locator('input[aria-label="at"]').fill(when.at)
  } else if (when.kind === 'weekly') {
    await dlg.locator('.chip', { hasText: 'Pick days' }).click()
    for (const d of when.days) await dlg.locator('.chip.day', { hasText: d }).click()
    await dlg.locator('input[aria-label="at"]').fill(when.at)
  } else {
    await dlg.locator('.chip', { hasText: 'Repeat every' }).click()
    await dlg.locator('input[aria-label="Repeat every"]').fill(String(when.n))
    await dlg.locator('select[aria-label="unit"]').selectOption(when.unit)
  }
  if (spec.model) await dlg.locator('.chip', { hasText: spec.model }).click()
  if (spec.effort) await dlg.locator('.chip', { hasText: spec.effort }).click()
  if (spec.permission) await dlg.locator('.chip', { hasText: spec.permission }).click()
}

async function createJob(page: Page, dlg: Locator, spec: JobSpec): Promise<void> {
  await dlg.locator('button.mini', { hasText: 'New job' }).click()
  await expect(dlg.locator('.fgrid')).toBeVisible()
  await fillForm(dlg, spec)
  await dlg.locator('.modal-foot .btn-primary').click()
  await expect(dlg.locator('.fgrid')).toHaveCount(0)
  await expect(card(page, spec.name)).toHaveCount(1)
}

async function clickRunNow(page: Page, name: string): Promise<void> {
  await card(page, name).locator('button.mini', { hasText: 'Run now' }).click()
}

function toastMsg(page: Page): Locator {
  return page.locator('.toast .toast-msg')
}

function jobSwitch(page: Page, name: string): Locator {
  return page.locator(`input.switch[aria-label="${name} on"]`)
}

interface HistLine {
  when: string
  state: string
  wt: string
}

async function histLines(page: Page): Promise<HistLine[]> {
  return cronDialog(page)
    .locator('.hist-row')
    .evaluateAll((rows) =>
      rows.map((r) => ({
        when: (r.querySelector('.hist-when')?.textContent ?? '').trim(),
        state: (r.querySelector('.hist-state')?.textContent ?? '').trim(),
        wt: r.querySelector('.hist-wt')?.textContent ?? ''
      }))
    )
}

function storePath(env: E2EEnv): string {
  return path.join(env.userData, 'cron.json')
}

function readStore(env: E2EEnv): CronFile | null {
  try {
    return JSON.parse(fs.readFileSync(storePath(env), 'utf8')) as CronFile
  } catch {
    return null
  }
}

async function storedJobs(env: E2EEnv, count: number): Promise<CronJob[]> {
  await expect.poll(() => readStore(env)?.jobs.length ?? -1, { timeout: 15_000 }).toBe(count)
  return readStore(env)!.jobs
}

function cronRows(page: Page, wsName: string): Locator {
  return wsRows(page, wsName).filter({ has: page.locator('.ws-tab-cron') })
}

function plainRows(page: Page, wsName: string): Locator {
  return wsRows(page, wsName).filter({ hasNot: page.locator('.ws-tab-cron') })
}

function nextRow(page: Page, wsName: string): Locator {
  return page
    .locator('.ws')
    .filter({ has: page.locator('.ws-head', { hasText: wsName }) })
    .locator('.ws-next')
}

async function tabDisplays(page: Page): Promise<string[]> {
  return page
    .locator('.terminals .term-wrap')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).style.display))
}

const EVERY_MINUTE_DUE_PLUS_TICK_MS = 120_000
const DUE_PLUS_WINDOW_FIRST_TICKS_MS = 150_000
const A_LATER_END_OF_THE_FINISHED_RUN_WOULD_HAVE_SHOWN_BY_MS = 5_000
const ROOM_FOR_A_WRONG_WORKTREE_REMOVAL_MS = 5_000

async function waitTurnStopSoTheTranscriptExistsBeforeClose(
  page: Page,
  name: string
): Promise<void> {
  await expect
    .poll(() => card(page, name).locator('.job-last').innerText(), {
      timeout: 90_000
    })
    .toContain('done — waiting for you')
}

async function waitColdRowMarkedBeforeRunNowSoTheCountsAfterMeanSomething(
  page: Page
): Promise<void> {
  await expect(wsRows(page, 'ws-a')).toHaveCount(1, { timeout: 30_000 })
  await expect(cronRows(page, 'ws-a')).toHaveCount(1, { timeout: 30_000 })
}

async function waitRunStateBound(row: Locator): Promise<void> {
  await expect(row).toHaveClass(/\bst-(working|waiting)\b/, { timeout: 60_000 })
}

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function unpaddedHour(at: string): string {
  const [h, m] = at.split(':')
  return `${Number(h)}:${m}`
}

type CallWithToken = ClaudeCall & { oauthToken: string | null }

async function waitNewCall(env: E2EEnv, before: number, timeout = 60_000): Promise<CallWithToken> {
  const calls = await waitForCalls(env, before + 1, timeout)
  return calls[calls.length - 1] as CallWithToken
}

function worktreeOf(call: ClaudeCall): string {
  const i = call.argv.indexOf('-w')
  return i >= 0 ? call.argv[i + 1] : ''
}

test.describe('Scheduled jobs · main flow (edge cases in cron-edge.spec.ts)', () => {
  test('BB-M01: the workspace menu has a Scheduled jobs… item, and it opens the dialog', async ({
    env
  }) => {
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      expect(await menuItemTexts(page)).toContain('Scheduled jobs…')
      const shape = await page
        .locator('.menu')
        .evaluate((el) =>
          Array.from(el.children).map((c) => (c.classList.contains('sep') ? 'sep' : 'mi'))
        )
      expect(shape).toEqual(['mi', 'mi', 'mi', 'mi', 'mi', 'sep', 'mi'])

      await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
      await expect(cronDialog(page)).toBeVisible()
      await expect(cronDialog(page).locator('.modal-header')).toHaveText('Scheduled jobs · ws-a')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M02: a job is created through the form and read back in words', async ({ env }) => {
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      const dlg = await openCron(page, 'ws-a')
      await expect(dlg.locator('.job-row')).toHaveCount(0)

      await dlg.locator('button.mini', { hasText: 'New job' }).click()
      await expect(dlg.locator('.modal-header')).toHaveText('Scheduled jobs · ws-a · new')
      await expect(dlg.locator('.fnote')).toHaveText(gitWhere('job'))

      await dlg.locator('input[aria-label="Name"]').fill('Nightly report')
      await expect(dlg.locator('.fnote')).toHaveText(gitWhere('nightly-report'))

      await dlg.locator('[aria-label="What to run"]').fill('/daily-report')
      await dlg.locator('.chip', { hasText: 'Every day' }).click()
      await dlg.locator('input[aria-label="at"]').fill('21:00')
      // PLATFORM§24
      expect(
        await dlg.locator('input[aria-label="at"]').evaluate((e) => getComputedStyle(e).colorScheme)
      ).toBe('dark')
      await dlg.locator('.chip', { hasText: 'Default' }).click()
      await dlg.locator('.chip', { hasText: 'Same as my other sessions' }).click()
      await dlg.locator('.modal-foot .btn-primary').click()

      await expect(dlg.locator('.fgrid')).toHaveCount(0)
      await expect(dlg.locator('.modal-header')).toHaveText('Scheduled jobs · ws-a')

      const c = card(page, 'Nightly report')
      await expect(c).toHaveCount(1)
      await expect(c.locator('.job-name')).toHaveText('Nightly report')
      await expect(c.locator('.job-task')).toHaveText('/daily-report')
      await expect(c.locator('.job-when')).toHaveText(
        /^Every day at 21:00 · next (today|tomorrow) 21:00$/
      )
      await expect(c.locator('.job-last')).toHaveText('never run')
      await expect(jobSwitch(page, 'Nightly report')).toBeChecked()

      const [job] = await storedJobs(env, 1)
      expect(job.schedule).toEqual({ kind: 'daily', at: '21:00' })
      expect(Object.prototype.hasOwnProperty.call(job, 'model')).toBe(false)
      expect(job.permission).toBe('same')
      expect(job.enabled).toBe(true)
      expect(job.history).toEqual([])

      await c.locator('button.ibtn[aria-label="Edit Nightly report"]').click()
      await expect(dlg.locator('.modal-header')).toHaveText('Scheduled jobs · ws-a · edit')
      await expect(dlg.locator('input[aria-label="Name"]')).toHaveValue('Nightly report')
      await expect(dlg.locator('[aria-label="What to run"]')).toHaveValue('/daily-report')
      await expect(dlg.locator('input[aria-label="at"]')).toHaveValue('21:00')
      await expect(dlg.locator('.chip', { hasText: 'Every day' })).toHaveClass(/\bon\b/)
      await expect(dlg.locator('.chip', { hasText: 'Default' })).toHaveClass(/\bon\b/)
      await expect(dlg.locator('.chip', { hasText: 'Same as my other sessions' })).toHaveClass(
        /\bon\b/
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M03: Run now starts a real session in a fresh worktree, behind your work', async ({
    env
  }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      await startSessionIn(page, 'ws-a')
      const rows = wsRows(page, 'ws-a')
      await expect(rows).toHaveCount(1)
      const before = readCalls(env).length

      const dlg = await openCron(page, 'ws-a')
      await createJob(page, dlg, { name: 'Nightly report', task: '/daily-report' })
      await clickRunNow(page, 'Nightly report')
      await expect(page.locator('.modal.wspicker, .modal.worktreesess')).toHaveCount(0)
      await expect(toastMsg(page)).toHaveText('⏰ Nightly report started')
      await closeCron(page)

      await expect(rows).toHaveCount(2, { timeout: 60_000 })
      await expect(cronRows(page, 'ws-a')).toHaveCount(1)

      const call = await waitNewCall(env, before)
      const wt = worktreeOf(call)
      expect(wt).toMatch(/^nightly-report-/)
      await expect(cronRows(page, 'ws-a').locator('.ws-tab-sub')).toHaveText(wt, {
        timeout: 30_000
      })
      expect(
        fs.statSync(path.join(env.workspaces.a, '.claude', 'worktrees', wt)).isDirectory()
      ).toBe(true)

      await expect(plainRows(page, 'ws-a')).toHaveClass(/\bactive\b/)
      await expect(page.locator('.ws-tab.active .ws-tab-cron')).toHaveCount(0)
      await expect.poll(() => tabDisplays(page), { timeout: 30_000 }).toEqual(['block', 'none'])

      expect(call.argv).toContain('--session-id')
      expect(call.argv[call.argv.indexOf('--name') + 1]).toBe('Nightly report')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test("BB-M04: the run's first message is the task text", async ({ env }) => {
    test.setTimeout(120_000)
    const TASK = '/daily-report please "quote" $HOME'
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      const dlg = await openCron(page, 'ws-a')
      await createJob(page, dlg, { name: 'Nightly report', task: TASK })
      await clickRunNow(page, 'Nightly report')

      const call = await waitNewCall(env, 0)
      expect(call.firstPrompt).toBe(TASK)

      // CC§2
      const jsonl = path.join(
        env.home,
        '.claude',
        'projects',
        encodeCwd(env.workspaces.a),
        `${call.sessionId}.jsonl`
      )
      await expect
        .poll(
          () => {
            try {
              return fs
                .readFileSync(jsonl, 'utf8')
                .split('\n')
                .filter(Boolean)
                .map((l) => JSON.parse(l) as { type?: string; message?: { content?: unknown } })
                .some((r) => r.type === 'user' && r.message?.content === TASK)
            } catch {
              return false
            }
          },
          { timeout: 40_000 }
        )
        .toBe(true)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M05: a finished run waits for you', async ({ env }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      const dlg = await openCron(page, 'ws-a')
      await createJob(page, dlg, { name: 'Nightly report', task: '/daily-report' })
      await clickRunNow(page, 'Nightly report')

      const call = await waitNewCall(env, 0)
      const wt = worktreeOf(call)
      const row = cronRows(page, 'ws-a')
      await expect(row).toHaveCount(1, { timeout: 60_000 })
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })

      await page.waitForTimeout(A_LATER_END_OF_THE_FINISHED_RUN_WOULD_HAVE_SHOWN_BY_MS)
      await expect(row).toHaveClass(/\bst-waiting\b/)
      await expect.poll(() => tabDisplays(page), { timeout: 15_000 }).toHaveLength(1)

      await expect(card(page, 'Nightly report').locator('.job-last')).toContainText(
        'done — waiting for you'
      )
      await expect
        .poll(async () => (await histLines(page))[0]?.state, { timeout: 20_000 })
        .toBe('Done — waiting for you')
      expect((await histLines(page))[0].wt).toBe(` · ${wt}`)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M06: closing a finished run yourself, and resuming it from the sidebar', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      const dlg = await openCron(page, 'ws-a')
      await createJob(page, dlg, { name: 'Nightly report', task: '/daily-report' })
      await clickRunNow(page, 'Nightly report')

      const call = await waitNewCall(env, 0)
      const wt = worktreeOf(call)
      const row = cronRows(page, 'ws-a')
      await expect(row).toHaveCount(1, { timeout: 60_000 })
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      await closeCron(page)

      await row.click()
      await expect(row).toHaveClass(/\bactive\b/)
      await sendShortcut(app, 'shortcut:close-tab')

      await expect.poll(() => tabDisplays(page), { timeout: 30_000 }).toHaveLength(0)
      await expect(page.locator('.modal')).toHaveCount(0)
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await expect(row.locator('.ws-tab-cron')).toHaveCount(1)

      const dlg2 = await openCron(page, 'ws-a')
      await expect(dlg2).toBeVisible()
      await expect
        .poll(async () => (await histLines(page))[0]?.state, { timeout: 20_000 })
        .toBe('Closed by you')
      expect((await histLines(page))[0].wt).toBe(` · ${wt}`)
      await closeCron(page)

      await page.waitForTimeout(ROOM_FOR_A_WRONG_WORKTREE_REMOVAL_MS)
      expect(fs.existsSync(path.join(env.workspaces.a, '.claude', 'worktrees', wt))).toBe(true)

      const before = readCalls(env).length
      await row.click()
      const resume = await waitNewCall(env, before)
      expect(resumedId(resume)).toBe(call.sessionId)
      await waitRunStateBound(row)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M07: the clock fires on its own, and takes nothing from you', async ({ env }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      await startSessionIn(page, 'ws-a')
      const rows = wsRows(page, 'ws-a')
      await expect(rows).toHaveCount(1)

      const dlg = await openCron(page, 'ws-a')
      await createJob(page, dlg, {
        name: 'Nightly report',
        task: '/daily-report',
        when: { kind: 'every', n: 1, unit: 'minutes' }
      })
      await closeCron(page)

      await centerTerm(page).click()
      expect(await focusOwner(page)).toBe('tui')

      await expect.poll(() => rows.count(), { timeout: EVERY_MINUTE_DUE_PLUS_TICK_MS }).toBe(2)
      await expect(cronRows(page, 'ws-a')).toHaveCount(1)

      await expect(plainRows(page, 'ws-a')).toHaveClass(/\bactive\b/)
      expect(await focusOwner(page)).toBe('tui')
      await expect.poll(() => tabDisplays(page), { timeout: 30_000 }).toEqual(['block', 'none'])
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M08: jobs survive a relaunch; live runs are closed out, never stored', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const WHEN_NEXT_TODAY_OR_TOMORROW = /^Every day at 21:00 · next (today|tomorrow) 21:00$/
    const app1 = await launchApp(env)
    try {
      const page = await app1.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      const dlg = await openCron(page, 'ws-a')
      await createJob(page, dlg, { name: 'Nightly report', task: '/daily-report' })
      await clickRunNow(page, 'Nightly report')
      await waitNewCall(env, 0)
      await expect(cronRows(page, 'ws-a')).toHaveCount(1, { timeout: 60_000 })
      await expect(card(page, 'Nightly report').locator('.job-when')).toHaveText(
        WHEN_NEXT_TODAY_OR_TOMORROW
      )
      await waitTurnStopSoTheTranscriptExistsBeforeClose(page, 'Nightly report')
    } finally {
      await app1.close().catch(() => {})
    }

    const store = readStore(env)
    expect(store?.version).toBe(1)
    expect(store?.jobs).toHaveLength(1)
    expect(JSON.stringify(store)).not.toContain('"live"')
    expect(store?.jobs[0].history[0].state).toBe('ended')

    const app2 = await launchApp(env)
    try {
      const page = await app2.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      await expect(nextRow(page, 'ws-a')).toHaveCount(1, { timeout: 20_000 })
      await expect(nextRow(page, 'ws-a').locator('.ws-next-name')).toHaveText('Nightly report')

      const dlg = await openCron(page, 'ws-a')
      await expect(card(page, 'Nightly report')).toHaveCount(1)
      await expect(card(page, 'Nightly report').locator('.job-when')).toHaveText(
        WHEN_NEXT_TODAY_OR_TOMORROW
      )
      await expect
        .poll(async () => (await histLines(page))[0]?.state, { timeout: 20_000 })
        .toBe('Ended — Koloft quit')

      await waitColdRowMarkedBeforeRunNowSoTheCountsAfterMeanSomething(page)

      const before = readCalls(env).length
      await clickRunNow(page, 'Nightly report')
      await expect(toastMsg(page)).toHaveText('⏰ Nightly report started')
      await waitNewCall(env, before)
      await expect(dlg).toBeVisible()
      await expect(wsRows(page, 'ws-a')).toHaveCount(2, { timeout: 60_000 })
      await expect(cronRows(page, 'ws-a')).toHaveCount(2, { timeout: 60_000 })
    } finally {
      await app2.close().catch(() => {})
    }
  })

  test('BB-M09: switching a job off is shown; on again counts from now', async ({ env }) => {
    test.setTimeout(300_000)
    const now = new Date()
    test.skip(
      now.getHours() === 23 && now.getMinutes() >= 50,
      'a time 2 minutes from now would fall on the next day'
    )
    const at = hhmm(new Date(now.getTime() + 2 * 60_000))

    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      const dlg = await openCron(page, 'ws-a')
      await createJob(page, dlg, {
        name: 'Nightly report',
        task: '/daily-report',
        when: { kind: 'daily', at }
      })

      await jobSwitch(page, 'Nightly report').click()
      await expect(card(page, 'Nightly report').locator('.job-when')).toHaveText(
        `Every day at ${unpaddedHour(at)} · off`
      )
      await expect.poll(() => readStore(env)?.jobs[0].enabled, { timeout: 15_000 }).toBe(false)

      await page.waitForTimeout(DUE_PLUS_WINDOW_FIRST_TICKS_MS)
      expect(await wsRows(page, 'ws-a').count()).toBe(0)
      expect(readCalls(env)).toHaveLength(0)

      await jobSwitch(page, 'Nightly report').click()
      await expect(card(page, 'Nightly report').locator('.job-when')).toHaveText(
        `Every day at ${unpaddedHour(at)} · next tomorrow ${at}`,
        { timeout: 20_000 }
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M10: editing a job re-words it and recomputes the next run', async ({ env }) => {
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      const dlg = await openCron(page, 'ws-a')
      await createJob(page, dlg, {
        name: 'Nightly report',
        task: '/daily-report',
        when: { kind: 'daily', at: '21:00' }
      })

      await card(page, 'Nightly report')
        .locator('button.ibtn[aria-label="Edit Nightly report"]')
        .click()
      await expect(dlg.locator('.fgrid')).toBeVisible()
      await dlg.locator('.chip', { hasText: 'Pick days' }).click()
      for (const d of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
        await dlg.locator('.chip.day', { hasText: d }).click()
      }
      await dlg.locator('input[aria-label="at"]').fill('09:00')
      await dlg.locator('.modal-foot .btn-primary').click()
      await expect(dlg.locator('.fgrid')).toHaveCount(0)

      await expect(card(page, 'Nightly report').locator('.job-when')).toHaveText(
        /^Weekdays at 9:00 · next (today|tomorrow|Mon|Tue|Wed|Thu|Fri) 09:00$/
      )
      const [job] = await storedJobs(env, 1)
      expect(job.schedule).toEqual({ kind: 'weekly', days: [1, 2, 3, 4, 5], at: '09:00' })
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M11: deleting a job asks first, with the exact words; History follows the card', async ({
    env
  }) => {
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      await createJob(page, await openCron(page, 'ws-a'), { name: 'A', task: '/a' })
      await createJob(page, cronDialog(page), { name: 'B', task: '/b' })
      await closeCron(page)
      const dlg = await openCron(page, 'ws-a')

      await expect(dlg.locator('.hist .flabel')).toHaveText('History · A')
      await card(page, 'B').click()
      await expect(dlg.locator('.hist .flabel')).toHaveText('History · B')

      await card(page, 'B').locator('button.ibtn[aria-label="Delete B"]').click()
      const acts = card(page, 'B').locator('.job-acts')
      await expect(acts).toContainText('Delete "B"? Its runs stay in the sidebar.')
      await expect(acts.locator('button.mini.danger')).toHaveText('Delete')
      await expect(acts.locator('button.mini').nth(1)).toHaveText('Keep')

      await acts.locator('button.mini', { hasText: 'Keep' }).click()
      await expect(dlg.locator('.job-row')).toHaveCount(2)

      await card(page, 'B').locator('button.ibtn[aria-label="Delete B"]').click()
      await card(page, 'B').locator('.job-acts button.mini.danger').click()
      await expect(dlg.locator('.job-row')).toHaveCount(1)
      await expect(card(page, 'A')).toHaveCount(1)
      const jobs = await storedJobs(env, 1)
      expect(jobs[0].name).toBe('A')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M12: model and permission choices reach claude, once each', async ({ env }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    seedSettings(env, {
      multiAccount: true,
      skipPermissions: true,
      accounts: [
        { name: 'alpha', kind: 'oauth', enabled: true, fable: 'unknown', status: 'ok', addedAt: 1 }
      ]
    })
    fs.writeFileSync(
      env.keychainFile,
      JSON.stringify({ 'koloft-dev-claude-oauth': { alpha: 'sk-ant-oat01-fixture-alpha' } })
    )

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      const dlg = await openCron(page, 'ws-a')
      await createJob(page, dlg, {
        name: 'Job A',
        task: '/job-a',
        model: 'Sonnet',
        effort: 'Extra high',
        permission: 'Never ask'
      })
      await createJob(page, dlg, {
        name: 'Job B',
        task: '/job-b',
        permission: 'Let it edit files without asking'
      })
      await createJob(page, dlg, {
        name: 'Job C',
        task: '/job-c',
        permission: 'Same as my other sessions'
      })

      for (const [i, name] of ['Job A', 'Job B', 'Job C'].entries()) {
        const before = readCalls(env).length
        await clickRunNow(page, name)
        await waitNewCall(env, before)
        expect(readCalls(env)).toHaveLength(i + 1)
      }

      const calls = readCalls(env) as CallWithToken[]
      for (const c of calls) expect(c.oauthToken).toBe('sk-ant-oat01-fixture-alpha')
      const byTask = (t: string): CallWithToken => calls.find((c) => c.firstPrompt === t)!
      const count = (c: CallWithToken, flag: string): number =>
        c.argv.filter((a) => a === flag).length

      const a = byTask('/job-a')
      expect(a.argv[a.argv.indexOf('--model') + 1]).toBe('sonnet')
      expect(count(a, '--model')).toBe(1)
      expect(a.argv[a.argv.indexOf('--effort') + 1]).toBe('xhigh')
      expect(count(a, '--effort')).toBe(1)
      expect(count(a, '--dangerously-skip-permissions')).toBe(1)

      const b = byTask('/job-b')
      expect(b.argv[b.argv.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
      expect(count(b, '--model')).toBe(0)
      expect(count(b, '--effort')).toBe(0)
      expect(count(b, '--dangerously-skip-permissions')).toBe(0)

      const c = byTask('/job-c')
      expect(count(c, '--model')).toBe(0)
      expect(count(c, '--permission-mode')).toBe(0)
      expect(count(c, '--dangerously-skip-permissions')).toBe(1)

      await expect(card(page, 'Job A').locator('.job-task')).toHaveText('/job-a · sonnet · xhigh')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M13: the workspace forecast row shows the nearest next run', async ({ env }) => {
    const now = new Date()
    test.skip(
      now.getHours() * 60 + now.getMinutes() < 15 ||
        now.getHours() * 60 + now.getMinutes() > 24 * 60 - 15,
      'the case needs a time earlier today AND a time later today'
    )
    const later = hhmm(new Date(now.getTime() + 10 * 60_000))
    const past = hhmm(new Date(now.getTime() - 10 * 60_000))

    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      const dlg = await openCron(page, 'ws-a')
      await createJob(page, dlg, {
        name: 'Earlier today',
        task: '/earlier',
        when: { kind: 'daily', at: past }
      })
      await createJob(page, dlg, {
        name: 'Later today',
        task: '/later',
        when: { kind: 'daily', at: later }
      })
      await closeCron(page)

      const head = page.locator('.ws-head', { hasText: 'ws-a' })
      await expect(head.locator('.ws-badge.cron')).toHaveCount(0)

      const row = nextRow(page, 'ws-a')
      await expect(row).toHaveCount(1)
      await expect(row.locator('.ws-next-name')).toHaveText('Later today')
      await expect(row.locator('.ws-next-more')).toHaveText('+1')
      await expect(row.locator('.ws-next-at')).toHaveText(`today ${later}`)
      await expect(row.locator('.ws-next-at')).toHaveClass(/\bsoon\b/)
      await expect(row).toHaveAttribute(
        'title',
        `Later today · today ${later}\nEarlier today · tomorrow ${past}\nScheduled jobs…`
      )
      expect(
        await page
          .locator('.ws')
          .filter({ has: page.locator('.ws-head', { hasText: 'ws-a' }) })
          .locator('.ws-tabs')
          .evaluate((el) => (el.firstElementChild as HTMLElement | null)?.className ?? '')
      ).toBe('ws-next')

      await row.click()
      await expect(cronDialog(page)).toBeVisible({ timeout: 15_000 })
      await expect(cronDialog(page).locator('.hist .flabel')).toHaveText('History · Later today')
      await closeCron(page)

      await head.locator('.fico').click()
      await expect(row).toHaveCount(0)
      await head.locator('.fico').click()
      await expect(row).toHaveCount(1)

      const dlg2 = await openCron(page, 'ws-a')
      await jobSwitch(page, 'Later today').click()
      await expect(dlg2.locator('.job-row.off')).toHaveCount(1)
      await closeCron(page)
      await expect(row.locator('.ws-next-name')).toHaveText('Earlier today')
      await expect(row.locator('.ws-next-more')).toHaveCount(0)
      await expect(row.locator('.ws-next-at')).toHaveText(`tomorrow ${past}`)
      await expect(row.locator('.ws-next-at')).not.toHaveClass(/\bsoon\b/)

      const dlg3 = await openCron(page, 'ws-a')
      await jobSwitch(page, 'Earlier today').click()
      await expect(dlg3.locator('.job-row.off')).toHaveCount(2)
      await closeCron(page)
      await expect(row).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M15: the job card counts the run folders on disk', async ({ env }) => {
    gitInit(env.workspaces.a)
    const wtRoot = path.join(env.workspaces.a, '.claude', 'worktrees')
    const made: string[] = []
    for (let i = 1; i <= 11; i++) {
      const dir = path.join(wtRoot, `nightly-report-2609${String(i).padStart(2, '0')}-0900`)
      fs.mkdirSync(dir, { recursive: true })
      made.push(dir)
    }

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      const dlg = await openCron(page, 'ws-a')
      await createJob(page, dlg, { name: 'Nightly report', task: '/daily-report' })

      const last = card(page, 'Nightly report').locator('.job-last')
      await expect(last).toContainText('11 run folders on disk')
      await expect(last.locator('.am')).toHaveText('11 run folders on disk')

      for (const dir of made.slice(0, 8)) fs.rmSync(dir, { recursive: true, force: true })
      await closeCron(page)
      await openCron(page, 'ws-a')

      await expect(last).toContainText('3 run folders on disk')
      await expect(last.locator('.am')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-M16: typing / suggests skill names; nothing else is listed; any name still saves', async ({
    env
  }) => {
    gitInit(env.workspaces.a)
    fs.mkdirSync(path.join(env.workspaces.a, '.claude', 'skills', 'zeta'), { recursive: true })
    fs.writeFileSync(
      path.join(env.workspaces.a, '.claude', 'skills', 'zeta', 'SKILL.md'),
      '---\nname: zeta\ndescription: Last one\n---\n'
    )
    fs.mkdirSync(path.join(env.home, '.claude', 'commands'), { recursive: true })
    fs.writeFileSync(path.join(env.home, '.claude', 'commands', 'beta.md'), '# beta\n')

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      const dlg = await openCron(page, 'ws-a')
      await dlg.locator('button.mini', { hasText: 'New job' }).click()
      await expect(dlg.locator('.fgrid')).toBeVisible()
      await expect(dlg.locator('.wt-list')).toHaveCount(0)

      const task = dlg.locator('[aria-label="What to run"]')
      await task.fill('/')
      await expect(dlg.locator('.wt-list .cb-row .wt-name')).toHaveText(['/zeta', '/beta'])
      await expect(dlg.locator('.wt-list .cb-row').first().locator('.note')).toHaveText('Last one')

      await task.fill('/ze')
      await expect(dlg.locator('.wt-list .cb-row .wt-name')).toHaveText(['/zeta'])
      await page.keyboard.press('Enter')
      await expect(task).toHaveValue('/zeta ')
      await expect(dlg.locator('.wt-list')).toHaveCount(0)

      await dlg.locator('input[aria-label="Name"]').fill('Any name')
      await task.fill('/gamma')
      await task.press('Enter')
      await page.keyboard.type('and more')
      await expect(dlg.locator('.fgrid')).toBeVisible()
      await expect(task).toHaveValue('/gamma\nand more')
      await dlg.locator('input[aria-label="Name"]').press('Enter')
      await expect(dlg.locator('.fgrid')).toBeVisible()
      await expect(dlg.locator('.field-hint.bad')).toHaveCount(0)
      await dlg.locator('.modal-foot .btn-primary').click()
      await expect(dlg.locator('.fgrid')).toHaveCount(0)

      const [job] = await storedJobs(env, 1)
      expect(job.task).toBe('/gamma\nand more')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-N04: a run is an ordinary session to everything else in Koloft', async ({ env }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      const dlg = await openCron(page, 'ws-a')
      await createJob(page, dlg, { name: 'Nightly report', task: '/daily-report' })
      await clickRunNow(page, 'Nightly report')
      const runCall = await waitNewCall(env, 0)
      const run = cronRows(page, 'ws-a')
      await expect(run).toHaveCount(1, { timeout: 60_000 })
      await expect(run).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      await closeCron(page)

      const wtDlg = await openWorktreeSession(page, 'ws-a')
      await wtDlg.getByRole('textbox').click()
      await page.keyboard.type('byhand')
      await page.keyboard.press('Enter')
      await expect(wtDlg).toHaveCount(0)
      const hand = plainRows(page, 'ws-a')
      await expect(hand).toHaveCount(1, { timeout: 60_000 })
      await expect(hand).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })

      await openMenu(page, run)
      const runMenu = await menuItemTexts(page)
      await closeMenu(page)
      await openMenu(page, hand)
      const handMenu = await menuItemTexts(page)
      await closeMenu(page)
      expect(runMenu).toEqual(handMenu)

      await hand.click()
      await expect(hand).toHaveClass(/\bactive\b/)
      await expect(auxIcon(page, 'Workbench')).toHaveAttribute('aria-disabled', 'false')
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(page.locator('.modal')).toHaveCount(0)
      await expect(hand).toHaveClass(/\bcold\b/, { timeout: 30_000 })

      await run.click()
      await expect(run).toHaveClass(/\bactive\b/)
      await expect(auxIcon(page, 'Workbench')).toHaveAttribute('aria-disabled', 'false')
      const before = readCalls(env).length
      await clickAppMenuItem(app, page, 'restart-session')
      const restart = await waitNewCall(env, before)
      expect(resumedId(restart)).toBe(runCall.sessionId)

      await expect(run).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(page.locator('.modal')).toHaveCount(0)
      await expect.poll(() => tabDisplays(page), { timeout: 30_000 }).toHaveLength(0)
    } finally {
      await app.close().catch(() => {})
    }
  })
})
