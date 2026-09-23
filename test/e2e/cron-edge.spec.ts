import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, pendingAttention } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import {
  addWorkspace,
  closeMenu,
  gitInit,
  menuItemTexts,
  openMenu,
  processAlive,
  readCalls,
  setNextSessionTitle,
  startSessionIn,
  termIds,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { setupChangeFixture } from './helpers/filesFixture'
import { seedEditFixture, type EditFixture } from './helpers/editFixture'
import { EDIT, closeDiscardingEdits, editReady, typeAtEnd } from './helpers/editPane'
import { showBrowse } from './helpers/workbench'

const JOB = 'Nightly report'
const TASK = '/daily-report'

const MINUTES_A_COLD_LAUNCH_MAY_CROSS = 3
const APPROVAL_MARKER_MUST_SURVIVE_MS = 10_000
const NO_LEFTOVER_ROW_SETTLE_MS = 5_000
const CLEAR_OF_BOOT_TICK_MISS_WINDOW_MS = 30 * 60_000
const HOLD_REBIND_MS = 60_000

interface EdSeedJob {
  id?: string
  name: string
  task?: string
  schedule: unknown
  workspacePath?: string
  model?: string
  createdAt?: number
  enabled?: boolean
  history?: unknown[]
}

interface EdStoredJob {
  id: string
  workspacePath: string
  name: string
  history?: { state: string }[]
  [key: string]: unknown
}

function edStoreFile(env: E2EEnv): string {
  return path.join(env.userData, 'cron.json')
}

function edStore(env: E2EEnv): { version?: number; jobs: EdStoredJob[] } {
  return JSON.parse(fs.readFileSync(edStoreFile(env), 'utf8')) as {
    version?: number
    jobs: EdStoredJob[]
  }
}

function edWriteStore(env: E2EEnv, jobs: EdSeedJob[]): void {
  const doc = {
    version: 1,
    jobs: jobs.map((j, i) => ({
      id: j.id ?? `ed-job-${i + 1}`,
      workspacePath: j.workspacePath ?? env.workspaces.a,
      name: j.name,
      task: j.task ?? TASK,
      schedule: j.schedule,
      permission: 'same',
      enabled: j.enabled ?? true,
      createdAt: j.createdAt ?? 1000 + i,
      history: j.history ?? [],
      ...(j.model === undefined ? {} : { model: j.model })
    }))
  }
  fs.writeFileSync(edStoreFile(env), JSON.stringify(doc, null, 2))
}

function edPad(n: number): string {
  return String(n).padStart(2, '0')
}

function edHHMM(t: Date): string {
  return `${edPad(t.getHours())}:${edPad(t.getMinutes())}`
}

function edStamp(t: Date): string {
  return (
    `${edPad(t.getFullYear() % 100)}${edPad(t.getMonth() + 1)}${edPad(t.getDate())}` +
    `-${edPad(t.getHours())}${edPad(t.getMinutes())}`
  )
}

async function edLaunch(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app, page }
}

function edDialog(page: Page): Locator {
  return page.locator('.modal.cronjobs')
}

async function edOpenDialog(page: Page, wsName: string): Promise<Locator> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
  const dlg = edDialog(page)
  await expect(dlg).toBeVisible({ timeout: 15_000 })
  return dlg
}

function edSaveBtn(page: Page): Locator {
  return page.locator('.modal.cronjobs .modal-foot .btn-primary')
}

function edField(page: Page, label: string): Locator {
  return page.locator(`.modal.cronjobs .fgrid [aria-label="${label}"]`)
}

function edFormRow(page: Page, label: string): Locator {
  return page
    .locator('.modal.cronjobs .fgrid .flabel', { hasText: label })
    .locator('xpath=following-sibling::div[1]')
}

function edChip(page: Page, row: string, text: string): Locator {
  return edFormRow(page, row).locator('.chip', { hasText: text })
}

async function edErrors(page: Page): Promise<string[]> {
  return page.locator('.modal.cronjobs .fgrid p.field-hint.bad').allTextContents()
}

async function edOpenForm(page: Page): Promise<void> {
  await page.locator('.modal.cronjobs .modal-body > button.mini', { hasText: 'New job' }).click()
  await expect(page.locator('.modal.cronjobs .fgrid')).toBeVisible({ timeout: 10_000 })
}

function edCard(page: Page, name: string): Locator {
  return page
    .locator('.modal.cronjobs .job-row')
    .filter({ has: page.locator('.job-name', { hasText: name }) })
}

async function edCreateJob(page: Page, name = JOB, task = TASK): Promise<void> {
  await edOpenForm(page)
  await edField(page, 'Name').fill(name)
  await edField(page, 'What to run').fill(task)
  await edSaveBtn(page).click()
  await expect(edCard(page, name)).toBeVisible({ timeout: 15_000 })
}

async function edRunNow(page: Page, name = JOB): Promise<void> {
  await edCard(page, name).locator('button.mini', { hasText: 'Run now' }).click()
}

function edToast(page: Page): Locator {
  return page.locator('.toast .toast-msg')
}

async function edExpectToast(page: Page, text: string): Promise<void> {
  await expect(edToast(page)).toHaveText(text, { timeout: 20_000 })
}

function edHistRows(page: Page): Locator {
  return page.locator('.modal.cronjobs .hist-row')
}

async function edHistStates(page: Page): Promise<string[]> {
  return page.locator('.modal.cronjobs .hist-state').allTextContents()
}

async function expectNoToastAtAnyMomentOfAWindow(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    expect(await page.locator('.toast').count()).toBe(0)
    await page.waitForTimeout(200)
  }
}

async function addWorkspaceToForceRescan(page: Page, env: E2EEnv, name: string): Promise<void> {
  const dir = path.join(env.home, name)
  fs.mkdirSync(dir)
  expect(await addWorkspace(page, dir)).toEqual({ code: 'added', path: dir })
}

function napWithinOneCalendarDay(now: Date): { due: Date; until: Date } {
  let due = new Date(now.getTime() - 2 * 60 * 60_000)
  let until = new Date(now.getTime() - 60 * 60_000)
  if (due.getDate() !== now.getDate()) {
    due = new Date(now)
    due.setHours(12, 0, 0, 0)
    until = new Date(now)
    until.setHours(13, 0, 0, 0)
  }
  due.setSeconds(0, 0)
  until.setSeconds(0, 0)
  return { due, until }
}

function edCronRows(page: Page): Locator {
  return wsRows(page, 'ws-a').filter({ has: page.locator('.ws-tab-cron') })
}

function edWorktreeArg(argv: string[]): string | undefined {
  const i = argv.indexOf('-w')
  return i >= 0 ? argv[i + 1] : undefined
}

test.describe('Scheduled jobs, edge cases (the main flow is cron.spec.ts): overlaps, misses, failed starts, the start deadline, a broken store, form refusals, workspace removal', () => {
  test('BB-E01: a due while the last run is still open is skipped, and skips fold into one line', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await edCreateJob(page)

      await edRunNow(page)
      await edExpectToast(page, `⏰ ${JOB} started`)
      await waitForCalls(env, 1)
      await expect
        .poll(() => edCard(page, JOB).locator('.job-last').innerText(), { timeout: 90_000 })
        .toContain('done — waiting for you')
      await expect(wsRows(page, 'ws-a')).toHaveCount(1)

      await edRunNow(page)
      await edExpectToast(page, `⏰ ${JOB} skipped: the last run is still open`)
      await expect
        .poll(async () => (await edHistStates(page))[1] ?? '', { timeout: 15_000 })
        .toBe('Skipped — the last run was still open')
      const states = await edHistStates(page)
      expect(states).toHaveLength(2)
      expect(states[0]).toBe('Done — waiting for you')
      await expect(wsRows(page, 'ws-a')).toHaveCount(1)
      expect(readCalls(env)).toHaveLength(1)

      await expect(page.locator('.toast')).toHaveCount(0, { timeout: 6_000 })
      await edRunNow(page)
      await edExpectToast(page, `⏰ ${JOB} skipped: the last run is still open`)
      await expect
        .poll(async () => (await edHistStates(page))[1] ?? '', { timeout: 15_000 })
        .toBe('Skipped 2 times — the last run was still open')
      expect(await edHistRows(page).count()).toBe(2)
      const when = await edHistRows(page).nth(1).locator('.hist-when').innerText()
      expect(when).toMatch(/^today \d\d:\d\d → today \d\d:\d\d$/)
      expect(readCalls(env)).toHaveLength(1)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E02: a workspace that is not a git repo runs in place, and the form says so', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-b')
      await edOpenForm(page)
      await expect(edFormRow(page, 'Where it runs').locator('.fnote')).toHaveText(
        'This folder is not a git repo, so the run works in the folder itself.'
      )

      await edField(page, 'Name').fill(JOB)
      await edField(page, 'What to run').fill(TASK)
      await edSaveBtn(page).click()
      await expect(edCard(page, JOB)).toBeVisible({ timeout: 15_000 })

      await edRunNow(page)
      const [call] = await waitForCalls(env, 1)
      expect(edWorktreeArg(call.argv)).toBeUndefined()
      expect(call.cwd).toBe(env.workspaces.b)
      expect(fs.existsSync(path.join(env.workspaces.b, '.claude', 'worktrees'))).toBe(false)

      const row = wsRows(page, 'ws-b').first()
      await expect(row).toBeVisible({ timeout: 30_000 })
      await expect(row.locator('.ws-tab-sub')).toHaveText('main', { timeout: 30_000 })
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E03: two runs never share a worktree, even when only the branch is left', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const now = new Date()
    for (let i = 0; i <= MINUTES_A_COLD_LAUNCH_MAY_CROSS; i++) {
      const t = new Date(now.getTime() + i * 60_000)
      execFileSync('git', ['branch', `worktree-nightly-report-${edStamp(t)}`], {
        cwd: env.workspaces.a
      })
    }

    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await edCreateJob(page)
      await edRunNow(page)

      const [call] = await waitForCalls(env, 1)
      const name = edWorktreeArg(call.argv)
      expect(name).toMatch(/-2$/)
      await expect
        .poll(
          () => fs.existsSync(path.join(env.workspaces.a, '.claude', 'worktrees', name ?? '')),
          {
            timeout: 30_000
          }
        )
        .toBe(true)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E04: a time that passed while Koloft was not running is a miss, not a catch-up', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const at = edHHMM(new Date(Date.now() - 3 * 60_000))
    edWriteStore(env, [{ name: JOB, schedule: { kind: 'daily', at } }])

    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await expect
        .poll(async () => (await edHistStates(page))[0] ?? '', { timeout: 30_000 })
        .toBe('Missed — Koloft was closed or asleep')

      expect(readCalls(env)).toHaveLength(0)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)
      await expect(edCard(page, JOB).locator('.job-when')).toHaveText(
        new RegExp(`· next (today|tomorrow) ${at}$`)
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E05: the workspace folder is missing at fire time', async ({ env }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await edCreateJob(page)

      fs.renameSync(env.workspaces.a, `${env.workspaces.a}-gone`)
      await edRunNow(page)

      await edExpectToast(page, `⏰ ${JOB} could not start: the folder is missing`)
      await expect
        .poll(async () => (await edHistStates(page))[0] ?? '', { timeout: 15_000 })
        .toBe('Could not start — the folder is missing')
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E06: a permission prompt during a run alerts you, the alert stays up, and nothing closes', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await edCreateJob(page, JOB, '/need-approval')
      await edRunNow(page)
      await waitForCalls(env, 1)

      const row = wsRows(page, 'ws-a').first()
      await expect(row).toHaveClass(/\bst-approval\b/, { timeout: 60_000 })
      await page.waitForTimeout(APPROVAL_MARKER_MUST_SURVIVE_MS)

      const pending = await pendingAttention(page)
      const approvals = pending.filter((p) => p.kind === 'approval')
      expect(approvals).toHaveLength(1)
      expect(await termIds(page)).toEqual([approvals[0].tabId])

      await expect(wsRows(page, 'ws-a')).toHaveCount(1)
      await expect(row).toHaveClass(/\bst-approval\b/)
      const last = await edCard(page, JOB).locator('.job-last').innerText()
      expect(last).toContain('working')
      expect(last).not.toContain('done')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E07: claude dies before it ever binds', async ({ env }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await edCreateJob(page)

      fs.writeFileSync(env.claudeExitFile, '1')
      await edRunNow(page)
      await edExpectToast(page, `⏰ ${JOB} could not start: Claude exited before it started`)
      await expect
        .poll(async () => (await edHistStates(page))[0] ?? '', { timeout: 15_000 })
        .toBe('Could not start — Claude exited before it started')

      await page.waitForTimeout(NO_LEFTOVER_ROW_SETTLE_MS)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)
      await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0)
      await expect(page.locator('.ws-tab-cron')).toHaveCount(0)
      expect(readCalls(env)).toHaveLength(1)

      fs.rmSync(env.claudeExitFile)
      await edRunNow(page)
      await waitForCalls(env, 2)
      await expect(edCronRows(page)).toHaveCount(1, { timeout: 60_000 })
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E08: a run that never starts is stopped at the deadline, without constructing an OS notification in background test mode', async ({
    env
  }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    env.launchEnv.KOLOFT_CRON_BIND_DEADLINE_MS = '5000'
    const hangFile = path.join(env.home, 'fake-claude-hang')

    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await edCreateJob(page)

      const idsBefore = await termIds(page)
      fs.writeFileSync(hangFile, '')
      await edRunNow(page)
      const [call] = await waitForCalls(env, 1)

      await edExpectToast(page, `⏰ ${JOB} could not start: Claude did not start`)
      expect(
        await app.evaluate(
          () => (globalThis as { __koloftOsNotifCount?: number }).__koloftOsNotifCount ?? 0
        )
      ).toBe(0)
      // CC§9
      await expect
        .poll(async () => (await edHistStates(page))[0] ?? '', { timeout: 15_000 })
        .toBe(
          'Could not start — Claude did not start — this folder was never opened in Claude; ' +
            'start one session here first'
        )
      await expect.poll(() => termIds(page), { timeout: 15_000 }).toEqual(idsBefore)
      await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0)
      await expect.poll(() => processAlive(call.pid), { timeout: 15_000 }).toBe(false)

      fs.rmSync(hangFile)
      await edRunNow(page)
      await waitForCalls(env, 2)
      await expect(edCronRows(page)).toHaveCount(1, { timeout: 60_000 })
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E09: no usable account means no launch', async ({ env }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    seedSettings(env, { multiAccount: true, accounts: [] })

    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await edCreateJob(page)
      await edRunNow(page)

      await edExpectToast(page, `⏰ ${JOB} could not start: no usable account`)
      await expect
        .poll(async () => (await edHistStates(page))[0] ?? '', { timeout: 15_000 })
        .toBe('Could not start — no usable account')
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E10: removing a workspace with jobs and no running session asks first, and deletes them', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    edWriteStore(env, [
      { name: 'Job one', schedule: { kind: 'daily', at: '21:00' } },
      { name: 'Job two', schedule: { kind: 'daily', at: '22:00' } }
    ])

    const { app, page } = await edLaunch(env)
    try {
      const head = page.locator('.ws-head', { hasText: 'ws-a' })
      await expect(head).toBeVisible({ timeout: 30_000 })
      await openMenu(page, head)
      await page.locator('.menu .mi', { hasText: 'Remove workspace' }).click()

      const confirm = page.locator('.modal', { hasText: 'Remove workspace' })
      await expect(confirm).toBeVisible({ timeout: 15_000 })
      await expect(confirm.locator('.field-hint')).toHaveText(
        '2 scheduled jobs will be deleted. Jobs do not come back.'
      )

      await confirm.locator('.modal-foot .btn-primary', { hasText: 'Close & remove' }).click()
      await expect
        .poll(() => edStore(env).jobs.filter((j) => j.workspacePath === env.workspaces.a).length, {
          timeout: 20_000
        })
        .toBe(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E10: with a running session too, the confirm names both losses', async ({ env }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    edWriteStore(env, [{ name: 'Job one', schedule: { kind: 'daily', at: '21:00' } }])

    const { app, page } = await edLaunch(env)
    try {
      await startSessionIn(page, 'ws-a')
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Remove workspace' }).click()

      const confirm = page.locator('.modal', { hasText: 'Remove workspace' })
      await expect(confirm).toBeVisible({ timeout: 15_000 })
      await expect(confirm.locator('.field-hint')).toHaveText(
        '1 running session will be closed, and 1 scheduled job will be deleted. ' +
          'Sessions are kept by Claude or Codex — re-adding the folder brings them back as resumable. ' +
          'Jobs do not come back.'
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E12: a renderer reload mid-run brings the run back', async ({ env }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    const { app, page } = await edLaunch(env)
    try {
      setNextSessionTitle(env, 'Owner session')
      await startSessionIn(page, 'ws-a')
      const owner = wsRows(page, 'ws-a').filter({ hasText: 'Owner session' })
      await expect(owner).toBeVisible({ timeout: 30_000 })
      await owner.click()
      await expect(owner).toHaveClass(/\bactive\b/)

      await edOpenDialog(page, 'ws-a')
      await edCreateJob(page)
      await edRunNow(page)
      await waitForCalls(env, 2)
      await page.locator('.modal.cronjobs .modal-close').click()
      await expect(edDialog(page)).toHaveCount(0)

      const runRow = edCronRows(page)
      await expect(runRow).toHaveCount(1, { timeout: 60_000 })
      const sub = await runRow.locator('.ws-tab-sub').innerText()
      const idsBefore = await termIds(page)
      expect(idsBefore).toHaveLength(2)

      await page.reload()
      await waitBooted(page)
      await expect.poll(() => termIds(page), { timeout: 30_000 }).toEqual(idsBefore)

      const runAfter = edCronRows(page)
      await expect(runAfter).toHaveCount(1, { timeout: 30_000 })
      await expect(runAfter.locator('.ws-tab-sub')).toHaveText(sub)
      await expect(wsRows(page, 'ws-a').filter({ hasText: 'Owner session' })).toHaveClass(
        /\bactive\b/,
        { timeout: 30_000 }
      )
      await expect(runAfter).not.toHaveClass(/\bactive\b/)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E13: broken entries in the store are dropped, the rest load; a bad model is reported', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    edWriteStore(env, [
      {
        id: 'good-1',
        name: 'Alpha job',
        schedule: { kind: 'daily', at: '21:00' },
        createdAt: 1000
      },
      {
        id: 'bad-clock',
        name: 'Bad clock',
        schedule: { kind: 'daily', at: '25:99' },
        createdAt: 2000
      },
      {
        id: 'stray-path',
        name: 'Stray path',
        schedule: { kind: 'daily', at: '21:00' },
        workspacePath: path.join(env.home, 'ws-c'),
        createdAt: 3000
      },
      {
        id: 'good-2',
        name: 'Model job',
        schedule: { kind: 'daily', at: '21:00' },
        model: 'not a model',
        createdAt: 4000
      }
    ])

    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await expect(page.locator('.modal.cronjobs .job-row')).toHaveCount(2)
      await expect(
        page.locator('.modal.cronjobs .job-row').nth(1).locator('.field-hint.bad')
      ).toHaveText('The saved model was not valid and was ignored.')
      await expectNoToastAtAnyMomentOfAWindow(page)
      await expect(page.locator('.modal')).toHaveCount(1)
      await expect(page.locator('.modal')).toHaveClass(/\bcronjobs\b/)

      await page.locator('button[aria-label="Edit Alpha job"]').click()
      await expect(page.locator('.modal.cronjobs .fgrid')).toBeVisible()
      await edSaveBtn(page).click()
      await expect(page.locator('.modal.cronjobs .fgrid')).toHaveCount(0, { timeout: 15_000 })

      await expect
        .poll(
          () =>
            edStore(env)
              .jobs.map((j) => j.id)
              .sort(),
          { timeout: 20_000 }
        )
        .toEqual(['good-1', 'good-2'])
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E17: Pick days with no day selected refuses the save', async ({ env }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)
    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await edOpenForm(page)
      await edField(page, 'Name').fill(JOB)
      await edField(page, 'What to run').fill(TASK)
      await edChip(page, 'When', 'Pick days').click()

      await expect
        .poll(() => edErrors(page), { timeout: 10_000 })
        .toContain('Pick at least one day.')
      await expect(edSaveBtn(page)).toBeDisabled()
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E18: the form refuses what the launch could not carry', async ({ env }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await edOpenForm(page)
      const save = edSaveBtn(page)

      await edField(page, 'Name').fill(JOB)
      await edField(page, 'What to run').fill('-p hello')
      await expect
        .poll(() => edErrors(page), { timeout: 10_000 })
        .toContain('The text cannot start with a dash.')
      await expect(save).toBeDisabled()

      await edField(page, 'What to run').fill(TASK)
      await edField(page, 'Name').fill('!!!')
      await expect
        .poll(() => edErrors(page), { timeout: 10_000 })
        .toContain('Use at least one letter or digit in the name.')
      await expect(save).toBeDisabled()

      await edField(page, 'Name').fill('')
      await expect.poll(() => edErrors(page), { timeout: 10_000 }).toContain('Give the job a name.')
      await expect(save).toBeDisabled()

      await edField(page, 'Name').fill(JOB)
      await edChip(page, 'Model', 'Other…').click()
      await edField(page, 'Model name').fill('not a model')
      await expect
        .poll(() => edErrors(page), { timeout: 10_000 })
        .toContain('Use letters, digits, dots, colons, dashes or underscores.')
      await expect(save).toBeDisabled()

      await edChip(page, 'Model', 'Default').click()
      await edChip(page, 'When', 'Repeat every…').click()
      await edField(page, 'Repeat every').fill('90')
      await edFormRow(page, 'When').locator('select[aria-label="unit"]').selectOption('hours')
      await expect
        .poll(() => edErrors(page), { timeout: 10_000 })
        .toContain('Use a whole number from 1 to 720 minutes or 1 to 24 hours.')
      await expect(save).toBeDisabled()

      await edChip(page, 'When', 'Every day').click()
      await edField(page, 'at').fill('')
      await expect
        .poll(() => edErrors(page), { timeout: 10_000 })
        .toContain('Use a time like 09:00.')
      await expect(save).toBeDisabled()
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E21: Esc peels the form before the dialog', async ({ env }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)
    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await edOpenForm(page)

      await page.keyboard.press('Escape')
      await expect(page.locator('.modal.cronjobs .fgrid')).toHaveCount(0)
      await expect(edDialog(page)).toBeVisible()

      await page.keyboard.press('Escape')
      await expect(edDialog(page)).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  const PERMISSION_CHIPS = [
    'Same as my other sessions',
    'Let it edit files without asking',
    'Never ask'
  ]
  const NEVER_ASK =
    '"Never ask" can change files anywhere on this Mac, not only in the run\'s folder.'

  test('BB-E25: with multi-account skipping permissions, the Permissions row says so', async ({
    env
  }) => {
    test.setTimeout(120_000)
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

    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await edOpenForm(page)
      const row = edFormRow(page, 'Permissions')
      await expect(row.locator('.chip')).toHaveText(PERMISSION_CHIPS)
      await expect(row.locator('p.field-hint')).toHaveText(
        `Today that means: skips all permission checks (your Accounts setting). ${NEVER_ASK}`
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E25: without multi-account, the Permissions row says what this Mac really does', async ({
    env
  }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)
    seedSettings(env, { multiAccount: false, skipPermissions: true })

    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await edOpenForm(page)
      const row = edFormRow(page, 'Permissions')
      await expect(row.locator('.chip')).toHaveText(PERMISSION_CHIPS)
      await expect(row.locator('p.field-hint')).toHaveText(
        `Today that means: Claude asks before risky steps, like your other sessions. ${NEVER_ASK}`
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E32: the menu item is hidden for a missing workspace, and the job survives', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    edWriteStore(env, [{ name: JOB, schedule: { kind: 'daily', at: '21:00' } }])

    const { app, page } = await edLaunch(env)
    try {
      const head = page.locator('.ws-head', { hasText: 'ws-a' })
      await expect(head).toBeVisible({ timeout: 30_000 })
      const nextRow = page
        .locator('.ws')
        .filter({ has: page.locator('.ws-head', { hasText: 'ws-a' }) })
        .locator('.ws-next')
      await expect(nextRow).toHaveCount(1, { timeout: 30_000 })

      fs.renameSync(env.workspaces.a, `${env.workspaces.a}-gone`)
      await addWorkspaceToForceRescan(page, env, 'ws-d')
      await expect(head).toHaveClass(/\bmissing\b/, { timeout: 30_000 })
      await expect(nextRow).toHaveCount(0)

      await openMenu(page, head)
      expect(await menuItemTexts(page)).not.toContain('Scheduled jobs…')
      await closeMenu(page)

      fs.renameSync(`${env.workspaces.a}-gone`, env.workspaces.a)
      await addWorkspaceToForceRescan(page, env, 'ws-e')
      await expect(head).not.toHaveClass(/\bmissing\b/, { timeout: 30_000 })
      await expect(nextRow).toHaveCount(1, { timeout: 30_000 })

      await openMenu(page, head)
      expect(await menuItemTexts(page)).toContain('Scheduled jobs…')
      await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
      await expect(edDialog(page)).toBeVisible({ timeout: 15_000 })
      await expect(edCard(page, JOB)).toBeVisible()
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-E33: a folded miss names both its ends, and the card reads the newest one', async ({
    env
  }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)

    const now = new Date()
    const { due, until } = napWithinOneCalendarDay(now)
    const at = edHHMM(new Date(now.getTime() + CLEAR_OF_BOOT_TICK_MISS_WINDOW_MS))
    edWriteStore(env, [
      {
        name: JOB,
        schedule: { kind: 'daily', at },
        history: [{ dueAt: due.getTime(), state: 'missed', count: 85, until: until.getTime() }]
      }
    ])

    const { app, page } = await edLaunch(env)
    try {
      await edOpenDialog(page, 'ws-a')
      await expect(edCard(page, JOB)).toBeVisible({ timeout: 15_000 })
      await expect(edHistRows(page)).toHaveCount(1)

      expect(await edHistStates(page)).toEqual(['Missed 85 times — Koloft was closed or asleep'])
      await expect(edHistRows(page).locator('.hist-when')).toHaveText(
        `today ${edHHMM(due)} → today ${edHHMM(until)}`
      )
      await expect(edHistRows(page).locator('.hist-state > span')).toHaveClass('dot')

      await expect(edCard(page, JOB).locator('.job-last')).toHaveText(
        `last run today ${edHHMM(until)} · missed`
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  async function edDirtyEditor(page: Page, ed: EditFixture): Promise<void> {
    const node = (abs: string): Locator =>
      page.locator(`.wb-panel .bv-sec[data-section="tree"] .ft-node[data-path="${abs}"]`)
    await showBrowse(page)
    const dir = node(ed.configDir)
    await expect(dir).toBeVisible({ timeout: 30_000 })
    if (!(await dir.getAttribute('class'))?.split(/\s+/).includes('open')) await dir.click()
    await node(ed.config).click({ button: 'right' })
    await expect(page.locator(EDIT.ctxMenu)).toBeVisible()
    await page.locator(EDIT.ctxMenu).getByText('Edit', { exact: true }).click()
    await editReady(page, 'koloft-e2e-edit-fixture')
    await typeAtEnd(page, 'KOLOFT_E2E_BB_E34=1')
    await expect(page.locator(EDIT.dirty)).toBeVisible()
  }

  test('BB-E34: removing a workspace mid-resume, with nothing running but a file unsaved, asks about the unsaved file and names the job', async ({
    env
  }) => {
    test.setTimeout(240_000)
    setupChangeFixture(env.workspaces.a)
    const ed = seedEditFixture(env.workspaces.a)
    edWriteStore(env, [{ name: JOB, schedule: { kind: 'daily', at: '21:00' } }])

    const { app, page } = await edLaunch(env)
    try {
      await startSessionIn(page, 'ws-a')
      await edDirtyEditor(page, ed)

      fs.writeFileSync(path.join(env.home, 'fake-claude-delay'), String(HOLD_REBIND_MS))
      await app.evaluate(({ Menu }) => {
        Menu.getApplicationMenu()?.getMenuItemById('restart-session')?.click()
      })
      await waitForCalls(env, 2)
      await expect(wsRows(page, 'ws-a').first()).toHaveClass(/\bst-pending\b/, { timeout: 30_000 })

      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Remove workspace' }).click()

      const dlg = page.locator('.modal.unsaved-modal')
      await expect(dlg).toBeVisible({ timeout: 15_000 })
      const hint = dlg.locator('.field-hint')
      await expect(hint).toContainText('Unsaved changes in config/app.json.')
      await expect(hint).toContainText('1 scheduled job will be deleted. Jobs do not come back.')

      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await expect(dlg).toHaveCount(0, { timeout: 10_000 })
      expect(edStore(env).jobs.filter((j) => j.workspacePath === env.workspaces.a)).toHaveLength(1)
    } finally {
      await closeDiscardingEdits(app).catch(() => {})
    }
  })

  // CC§9
  test('BB-E35: the form warns when claude has never been opened in the folder, and stops warning once it has', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const claudeJson = path.join(env.home, '.claude.json')
    expect(fs.existsSync(claudeJson)).toBe(false)

    const first = await edLaunch(env)
    try {
      await edOpenDialog(first.page, 'ws-a')
      await edOpenForm(first.page)
      await expect(edFormRow(first.page, 'Where it runs').locator('p.field-hint.warn')).toHaveText(
        'Claude has never been opened in this folder. Start one session here first — a ' +
          'scheduled run would stall on Claude\'s "do you trust this project?" question and ' +
          'be stopped at the deadline.'
      )
      expect(await edErrors(first.page)).toEqual([])
      await edField(first.page, 'Name').fill(JOB)
      await edField(first.page, 'What to run').fill(TASK)
      await edSaveBtn(first.page).click()
      await expect(edCard(first.page, JOB)).toBeVisible({ timeout: 15_000 })
    } finally {
      await first.app.close().catch(() => {})
    }

    // CC§9
    fs.writeFileSync(
      claudeJson,
      JSON.stringify({ projects: { [env.workspaces.a]: { hasTrustDialogAccepted: true } } })
    )

    const second = await edLaunch(env)
    try {
      await edOpenDialog(second.page, 'ws-a')
      await edOpenForm(second.page)
      await expect(edFormRow(second.page, 'Where it runs').locator('.fnote')).toBeVisible()
      await expect(second.page.locator('.modal.cronjobs .fgrid p.field-hint.warn')).toHaveCount(0)
    } finally {
      await second.app.close().catch(() => {})
    }
  })
})
