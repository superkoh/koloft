import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, runInTerminal } from './helpers/app'
import { writeClaudeWrapper, type E2EEnv } from './helpers/env'
import {
  centerTerm,
  openMenu,
  runIn,
  setNextSessionTitle,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import { WORKBENCH, showBrowse } from './helpers/workbench'

const SESSION_TITLE = 'Fake session: project notes'
const FAKE_CLAUDE_READLINE_ATTACH_MS = 1500
const SECOND_RESTART_WOULD_LAND_WITHIN_MS = 8000
const UNBOUND_WINDOW_OUTLASTS_ASSERTIONS_MS = 20_000
const SHIM_REGISTRATION_SETTLE_MS = 2000
const OLD_PTY_REVERT_CAN_TRAIL_RELAUNCH_MS = 5000
const TITLE_SAMPLE_INTERVAL_MS = 150
const SHELL_COMMAND_NOT_FOUND_TOAST = 'exit code 127'

interface ClaudeCall {
  pid: number
  argv: string[]
  cwd: string
  sessionId: string
  ts: number
}

function readCalls(env: E2EEnv): ClaudeCall[] {
  if (!fs.existsSync(env.claudeCalls)) return []
  return fs
    .readFileSync(env.claudeCalls, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ClaudeCall]
      } catch {
        return []
      }
    })
}

async function waitForCalls(env: E2EEnv, count: number, timeout = 40_000): Promise<ClaudeCall[]> {
  await expect.poll(() => readCalls(env).length, { timeout }).toBeGreaterThanOrEqual(count)
  return readCalls(env)
}

function resumedId(call: ClaudeCall): string | undefined {
  const i = call.argv.indexOf('--resume')
  return i >= 0 ? call.argv[i + 1] : undefined
}

function hasMalformedResume(calls: ClaudeCall[]): boolean {
  return calls.some((c) => {
    const i = c.argv.indexOf('--resume')
    if (i < 0) return false
    const id = c.argv[i + 1]
    return !id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  })
}

function processAlive(pid: number): boolean {
  const res = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  if (res.status !== 0) return false
  const stat = res.stdout.trim()
  return stat.length > 0 && !stat.startsWith('Z')
}

interface MenuEntry {
  top: string
  id: string
  label: string
  role: string
  accelerator: string
}

async function menuEntries(app: ElectronApplication): Promise<MenuEntry[]> {
  return app.evaluate(({ Menu }) => {
    const out: { top: string; id: string; label: string; role: string; accelerator: string }[] = []
    const menu = Menu.getApplicationMenu()
    if (!menu) return out
    for (const top of menu.items) {
      const stack = top.submenu ? [...top.submenu.items] : []
      while (stack.length) {
        const item = stack.shift()!
        out.push({
          top: top.label ?? '',
          id: item.id ?? '',
          label: item.label ?? '',
          role: String(item.role ?? ''),
          accelerator: String(item.accelerator ?? '')
        })
        if (item.submenu) stack.unshift(...item.submenu.items)
      }
    }
    return out
  })
}

function normalizeAccelerator(accel: string): string {
  return accel
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .sort()
    .join('+')
}

async function triggerRestart(app: ElectronApplication, times = 1): Promise<void> {
  await app.evaluate(({ Menu }, count) => {
    for (let i = 0; i < count; i++) {
      const item = Menu.getApplicationMenu()?.getMenuItemById('restart-session')
      if (!item) throw new Error('no application-menu item with id "restart-session"')
      item.click()
    }
  }, times)
}

// PLATFORM§6
async function waitForShortcutsReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady === true,
    undefined,
    { timeout: 20_000 }
  )
}

async function countConfirmationsInsteadOfShowingThem(
  app: ElectronApplication,
  page: Page
): Promise<void> {
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __koloftDialogCount?: number }
    g.__koloftDialogCount = 0
    const d = dialog as unknown as Record<string, unknown>
    d.showMessageBox = (): Promise<{ response: number }> => {
      g.__koloftDialogCount = (g.__koloftDialogCount ?? 0) + 1
      return Promise.resolve({ response: 0 })
    }
    d.showMessageBoxSync = (): number => {
      g.__koloftDialogCount = (g.__koloftDialogCount ?? 0) + 1
      return 0
    }
  })
  await page.evaluate(() => {
    const w = window as unknown as { __koloftConfirmCount?: number }
    w.__koloftConfirmCount = 0
    window.confirm = (): boolean => {
      w.__koloftConfirmCount = (w.__koloftConfirmCount ?? 0) + 1
      return true
    }
  })
}

async function launch(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function startClaudeTab(
  page: Page,
  env: E2EEnv,
  opts: { wsName?: string; title?: string } = {}
): Promise<void> {
  const title = opts.title ?? SESSION_TITLE
  if (opts.title) setNextSessionTitle(env, opts.title)
  await waitBooted(page)
  await startSessionIn(page, opts.wsName ?? 'ws-a')
  await expect(page.locator('.ws-tab-title', { hasText: title })).toBeVisible({ timeout: 40_000 })
}

async function resumeColdRow(page: Page, title: string): Promise<void> {
  const row = page.locator('.ws-tab', { hasText: title })
  await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
  await row.click()
  await expect(row).not.toHaveClass(/\bcold\b/, { timeout: 40_000 })
}

function transcriptPath(env: E2EEnv, workspace: string, sessionId: string): string {
  const encoded = workspace.replace(/[^a-zA-Z0-9]/g, '-')
  return path.join(env.home, '.claude', 'projects', encoded, `${sessionId}.jsonl`)
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

function describeTranscriptMiss(transcript: string): string {
  const projects = path.dirname(path.dirname(transcript))
  const listing: string[] = []
  try {
    for (const entry of fs.readdirSync(projects)) {
      const full = path.join(projects, entry)
      const files = fs.statSync(full).isDirectory() ? fs.readdirSync(full) : []
      listing.push(`  ${entry}/ -> ${files.join(', ') || '(empty)'}`)
    }
  } catch (err) {
    listing.push(`  <cannot read ${projects}: ${String(err)}>`)
  }
  return (
    `expected transcript: ${transcript}\n` +
    `actual projects dir:\n${listing.join('\n') || '  (no project dirs)'}`
  )
}

async function withTranscriptDiagnostics<T>(transcript: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    throw new Error(`${describeTranscriptMiss(transcript)}\n\n${(err as Error).message}`)
  }
}

async function transcriptBaseline(transcript: string): Promise<number> {
  await withTranscriptDiagnostics(transcript, async () => {
    let previous = -1
    await expect
      .poll(
        () => {
          const size = fileSize(transcript)
          const settled = size > 0 && size === previous
          previous = size
          return settled
        },
        { timeout: 30_000, intervals: [400] }
      )
      .toBe(true)
  })
  return fileSize(transcript)
}

async function waitUntilTranscriptIsOnDiskSoRestartIsNotANoOp(transcript: string): Promise<void> {
  await transcriptBaseline(transcript)
}

async function waitForResumedTurn(
  page: Page,
  transcript: string,
  sizeBefore: number
): Promise<void> {
  await withTranscriptDiagnostics(transcript, () =>
    expect.poll(() => fileSize(transcript), { timeout: 30_000 }).toBeGreaterThan(sizeBefore)
  )
  await page.waitForTimeout(FAKE_CLAUDE_READLINE_ATTACH_MS)
}

test.describe('Restart Session (⇧⌘R / File ▸ Restart Session): a resumable tab relaunches `--resume <same id>` in place, anything else is a silent no-op', () => {
  test.describe('menu structure', () => {
    test('T1: File carries Restart Session (id restart-session, ⇧⌘R)', async ({ app }) => {
      await app.firstWindow()
      const entries = await menuEntries(app)
      const item = entries.find((e) => e.id === 'restart-session')

      expect(item, 'no menu item with id "restart-session"').toBeDefined()
      expect(item!.label).toBe('Restart Session')
      expect(item!.top).toBe('File')
      expect(normalizeAccelerator(item!.accelerator)).toBe(
        normalizeAccelerator('Shift+CmdOrCtrl+R')
      )
    })

    test('T2: Force Reload gave up ⇧⌘R, Reload stayed', async ({ app }) => {
      await app.firstWindow()
      const entries = await menuEntries(app)
      const view = entries.filter((e) => e.top === 'View')
      expect(view.length).toBeGreaterThan(0)

      expect(view.filter((e) => e.role.toLowerCase() === 'forcereload')).toEqual([])
      expect(view.filter((e) => /force\s*reload/i.test(e.label))).toEqual([])
      const shiftCmdR = entries.filter(
        (e) => normalizeAccelerator(e.accelerator) === normalizeAccelerator('Shift+CmdOrCtrl+R')
      )
      expect(shiftCmdR.map((e) => e.id)).toEqual(['restart-session'])

      const reload = view.find(
        (e) => e.role.toLowerCase() === 'reload' || /^reload$/i.test(e.label)
      )
      expect(reload, 'View lost its Reload item').toBeDefined()
      if (reload!.accelerator) {
        expect(normalizeAccelerator(reload!.accelerator)).toBe(normalizeAccelerator('CmdOrCtrl+R'))
      }
    })
  })

  test.describe('the core restart flow', () => {
    test('T3: restart relaunches the SAME session in place and the new terminal works', async ({
      env
    }) => {
      test.setTimeout(240_000)
      const first = await launch(env)
      let sessionId = ''
      try {
        await startClaudeTab(first.page, env)
        const [initial] = await waitForCalls(env, 1)
        sessionId = initial.sessionId
        expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
      } finally {
        await first.app.close().catch(() => {})
      }

      const { app, page } = await launch(env)
      try {
        expect(readCalls(env)).toHaveLength(1)
        await resumeColdRow(page, SESSION_TITLE)
        const restored = await waitForCalls(env, 2)
        expect(resumedId(restored[1])).toBe(sessionId)

        const transcript = transcriptPath(env, env.workspaces.a, sessionId)
        const sizeBefore = await transcriptBaseline(transcript)
        const titlesBefore = await page.locator('.ws-tab .ws-tab-title').allTextContents()
        await triggerRestart(app)

        const calls = await waitForCalls(env, 3)
        expect(calls).toHaveLength(3)
        expect(resumedId(calls[2])).toBe(sessionId)
        expect(calls[2].sessionId).toBe(sessionId)
        expect(calls[2].cwd).toBe(env.workspaces.a)

        await expect(page.locator('.ws-tab')).toHaveCount(titlesBefore.length)
        expect(await page.locator('.ws-tab .ws-tab-title').allTextContents()).toEqual(titlesBefore)

        await expect(page.locator('.ws-tab', { hasText: SESSION_TITLE })).toHaveCount(1)

        await waitForResumedTurn(page, transcript, sizeBefore)
        await runIn(page, centerTerm(page), 'after-restart-marker')
        await expect(centerTerm(page)).toContainText('handled: after-restart-marker', {
          timeout: 20_000
        })
      } finally {
        await app.close().catch(() => {})
      }
    })

    test('T5: restarting a working session is immediate, with no confirmation, and settles back to waiting', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(150_000)
      await startClaudeTab(page, env)
      const [first] = await waitForCalls(env, 1)

      await runIn(page, centerTerm(page), '/busy')
      await expect(page.locator('.ws-tab.st-working')).toBeVisible({ timeout: 20_000 })

      await countConfirmationsInsteadOfShowingThem(app, page)

      await triggerRestart(app)
      const calls = await waitForCalls(env, 2)
      expect(resumedId(calls[1])).toBe(first.sessionId)

      expect(
        await app.evaluate(
          () => (globalThis as { __koloftDialogCount?: number }).__koloftDialogCount ?? -1
        )
      ).toBe(0)
      expect(
        await page.evaluate(
          () => (window as unknown as { __koloftConfirmCount?: number }).__koloftConfirmCount ?? -1
        )
      ).toBe(0)

      await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 40_000 })
    })

    test('T6: the old claude process is dead after a restart', async ({ app, page, env }) => {
      test.setTimeout(150_000)
      await startClaudeTab(page, env)
      const [first] = await waitForCalls(env, 1)
      expect(processAlive(first.pid)).toBe(true)

      await triggerRestart(app)
      const calls = await waitForCalls(env, 2)
      expect(calls[1].pid).not.toBe(first.pid)

      await expect.poll(() => processAlive(first.pid), { timeout: 30_000 }).toBe(false)
      expect(processAlive(calls[1].pid)).toBe(true)
    })
  })

  test.describe('no-op boundaries', () => {
    test('T8: an unbound claude tab is a no-op until it binds, then restarts normally', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(180_000)
      fs.writeFileSync(env.claudeDelayFile, String(UNBOUND_WINDOW_OUTLASTS_ASSERTIONS_MS))
      await waitBooted(page)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'New session' }).click()

      const [first] = await waitForCalls(env, 1, 30_000)
      await page.waitForTimeout(SHIM_REGISTRATION_SETTLE_MS)
      await expect(page.locator('.ws-tab-title', { hasText: SESSION_TITLE })).toHaveCount(0)

      await triggerRestart(app, 2)
      await page.waitForTimeout(4000)
      expect(readCalls(env)).toHaveLength(1)
      expect(hasMalformedResume(readCalls(env))).toBe(false)
      await expect(page.locator('.ws-tab')).toHaveCount(1)
      await expect(page.locator('.ws-tab.st-pending')).toHaveCount(1)

      fs.rmSync(env.claudeDelayFile, { force: true })
      await expect(page.locator('.ws-tab-title', { hasText: SESSION_TITLE })).toBeVisible({
        timeout: 40_000
      })
      await triggerRestart(app)
      const calls = await waitForCalls(env, 2)
      expect(resumedId(calls[1])).toBe(first.sessionId)
      expect(hasMalformedResume(calls)).toBe(false)
    })

    test('T9: with no claude tab at all the trigger does nothing and nothing breaks', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(120_000)
      await expect(page.locator('.center')).toContainText('No running session', { timeout: 20_000 })
      await waitForShortcutsReady(page)

      await triggerRestart(app, 3)
      await page.waitForTimeout(3000)
      await expect(page.locator('.center')).toContainText('No running session')
      await expect(page.locator('.ws-tab')).toHaveCount(0)
      expect(readCalls(env)).toHaveLength(0)

      await triggerRestart(app, 3)
      await page.waitForTimeout(3000)
      await expect(page.locator('.ws-tab')).toHaveCount(0)
      expect(readCalls(env)).toHaveLength(0)
      await startClaudeTab(page, env)
      expect(readCalls(env)).toHaveLength(1)
    })
  })

  test.describe('concurrency and de-duplication', () => {
    test('T10: two rapid triggers restart the session exactly once', async ({ app, page, env }) => {
      test.setTimeout(150_000)
      await startClaudeTab(page, env)
      const [first] = await waitForCalls(env, 1)

      await triggerRestart(app, 2)
      const calls = await waitForCalls(env, 2)
      expect(resumedId(calls[1])).toBe(first.sessionId)

      await page.waitForTimeout(SECOND_RESTART_WOULD_LAND_WITHIN_MS)
      expect(readCalls(env)).toHaveLength(2)
      await expect(page.locator('.ws-tab')).toHaveCount(1)
      await expect(page.locator('.ws-tab', { hasText: SESSION_TITLE })).toHaveCount(1)

      await runInTerminal(page, 'double-press-marker')
      await expect(page.locator('.term-wrap:visible .xterm')).toContainText(
        'handled: double-press-marker',
        { timeout: 15_000 }
      )
      await expect(page.locator('.term-wrap:visible .xterm')).not.toContainText('fatal:')
    })

    test('T11: restarting one session leaves a sibling session untouched', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(180_000)
      await startClaudeTab(page, env, { title: 'Sibling session' })
      const [tabA] = await waitForCalls(env, 1)

      await startClaudeTab(page, env, { wsName: 'ws-b' })
      const afterB = await waitForCalls(env, 2)
      const tabB = afterB[1]
      await expect(page.locator('.ws-tab')).toHaveCount(2)

      await waitUntilTranscriptIsOnDiskSoRestartIsNotANoOp(
        transcriptPath(env, env.workspaces.a, tabA.sessionId)
      )

      await triggerRestart(app)
      const calls = await waitForCalls(env, 3)
      expect(resumedId(calls[2])).toBe(tabB.sessionId)
      await expect.poll(() => processAlive(tabB.pid), { timeout: 30_000 }).toBe(false)
      expect(processAlive(tabA.pid)).toBe(true)
      await expect(page.locator('.ws-tab')).toHaveCount(2)

      await expect(centerTerm(page)).toContainText('ready in', {
        timeout: 20_000
      })
      await page.waitForTimeout(FAKE_CLAUDE_READLINE_ATTACH_MS)
      await runIn(page, centerTerm(page), 'tab-b-marker')
      await expect(centerTerm(page)).toContainText('handled: tab-b-marker', {
        timeout: 20_000
      })
      await expect(page.locator('.ws-tab', { hasText: 'Sibling session' })).toHaveCount(1)
    })
  })

  test.describe('state kept across the swap', () => {
    test('T12: an open preview pane survives the restart, still on screen and not merely loaded behind a reset view', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(150_000)
      await startClaudeTab(page, env)
      const [first] = await waitForCalls(env, 1)

      await showBrowse(page)
      const notes = page.locator(`${WORKBENCH.panel} .ft-node.ft-file`, { hasText: 'NOTES.md' })
      await expect(notes).toBeVisible({ timeout: 20_000 })
      await notes.click()
      await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')

      await triggerRestart(app)
      const calls = await waitForCalls(env, 2)
      expect(resumedId(calls[1])).toBe(first.sessionId)

      await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')
      await expect(page.locator(WORKBENCH.readingBody)).toContainText('Written by the fake claude')
    })

    test('T13: restarting the middle session keeps every row, in place, each with its title', async ({
      app,
      page,
      env
    }) => {
      test.setTimeout(240_000)
      const titles = ['Alpha session', 'Bravo session', 'Charlie session']
      for (const title of titles) {
        await startClaudeTab(page, env, { title })
      }
      const calls = await waitForCalls(env, 3)
      const bravo = calls[1]

      const orderBefore = await page.locator('.ws-tab .ws-tab-title').allTextContents()
      expect(orderBefore).toEqual(expect.arrayContaining(titles))

      await page.locator('.ws-tab', { hasText: 'Bravo session' }).click()
      await triggerRestart(app)
      const after = await waitForCalls(env, 4)
      expect(resumedId(after[3])).toBe(bravo.sessionId)

      await expect(page.locator('.ws-tab')).toHaveCount(3)
      expect(await page.locator('.ws-tab .ws-tab-title').allTextContents()).toEqual(orderBefore)
      await expect(page.locator('.ws-tab', { hasText: 'Bravo session' })).toHaveCount(1)
    })

    test('T12/T13 on a claude-kind tab: a resumed tab never flashes a default title and keeps its pane across a restart', async ({
      env
    }) => {
      test.setTimeout(240_000)
      const first = await launch(env)
      let sessionId = ''
      try {
        await startClaudeTab(first.page, env)
        const [initial] = await waitForCalls(env, 1)
        sessionId = initial.sessionId
      } finally {
        await first.app.close().catch(() => {})
      }

      const { app, page } = await launch(env)
      try {
        await resumeColdRow(page, SESSION_TITLE)
        await waitForCalls(env, 2)

        await showBrowse(page)
        const notes = page.locator(`${WORKBENCH.panel} .ft-node.ft-file`, { hasText: 'NOTES.md' })
        await expect(notes).toBeVisible({ timeout: 25_000 })
        await notes.click()
        await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')

        const transcript = transcriptPath(env, env.workspaces.a, sessionId)
        const sizeBefore = await transcriptBaseline(transcript)
        await triggerRestart(app)

        let sawRelaunch = false
        let stopAt = 0
        const hardDeadline = Date.now() + 45_000
        while (Date.now() < hardDeadline) {
          expect(
            await page.locator('.ws-tab', { hasText: SESSION_TITLE }).count(),
            'the tab lost its session title during the restart'
          ).toBe(1)
          if (!sawRelaunch && readCalls(env).length >= 3) {
            sawRelaunch = true
            stopAt = Date.now() + OLD_PTY_REVERT_CAN_TRAIL_RELAUNCH_MS
          }
          if (sawRelaunch && Date.now() >= stopAt) break
          await page.waitForTimeout(TITLE_SAMPLE_INTERVAL_MS)
        }
        expect(sawRelaunch, 'the restart never launched claude again').toBe(true)

        const calls = readCalls(env)
        expect(resumedId(calls[2])).toBe(sessionId)
        await expect(page.locator('.ws-tab')).toHaveCount(1)
        await expect(page.locator('.ws-tab', { hasText: SESSION_TITLE })).toHaveCount(1)

        await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')
        await expect(page.locator(WORKBENCH.readingBody)).toContainText(
          'Written by the fake claude'
        )

        await waitForResumedTurn(page, transcript, sizeBefore)
      } finally {
        await app.close().catch(() => {})
      }
    })

    test('T14: a restarted session is still listed and resumable after an app restart', async ({
      env
    }) => {
      test.setTimeout(240_000)
      const first = await launch(env)
      let sessionId = ''
      try {
        await startClaudeTab(first.page, env)
        const [initial] = await waitForCalls(env, 1)
        sessionId = initial.sessionId

        await triggerRestart(first.app)
        const calls = await waitForCalls(env, 2)
        expect(resumedId(calls[1])).toBe(sessionId)
      } finally {
        await first.app.close().catch(() => {})
      }

      const second = await launch(env)
      try {
        await resumeColdRow(second.page, SESSION_TITLE)
        const calls = await waitForCalls(env, 3)
        expect(resumedId(calls[2])).toBe(sessionId)
      } finally {
        await second.app.close().catch(() => {})
      }
    })
  })

  test.describe('fault tolerance', () => {
    test('T15: a respawn that dies at exec says so, and the row still resumes', async ({ env }) => {
      test.setTimeout(180_000)
      const wrapper = writeClaudeWrapper(env)
      env.launchEnv.KOLOFT_CLAUDE_CMD = wrapper

      const { app, page } = await launch(env)
      try {
        await startClaudeTab(page, env)
        const [first] = await waitForCalls(env, 1)

        fs.rmSync(path.join(env.fakeBin, wrapper), { force: true })
        await triggerRestart(app)

        await expect(page.locator('.toast-msg')).toContainText(SHELL_COMMAND_NOT_FOUND_TOAST, {
          timeout: 30_000
        })
        expect(readCalls(env)).toHaveLength(1)
        await expect(page.locator('.term-island .term-wrap')).toHaveCount(0, { timeout: 20_000 })

        writeClaudeWrapper(env, wrapper)
        await resumeColdRow(page, SESSION_TITLE)
        const calls = await waitForCalls(env, 2)
        expect(resumedId(calls[1])).toBe(first.sessionId)
        expect(fs.readFileSync(env.wrapperCalls, 'utf8')).toContain(`--resume ${first.sessionId}`)
      } finally {
        await app.close().catch(() => {})
      }
    })
  })
})
