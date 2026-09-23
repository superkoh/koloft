import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import {
  addWorkspace,
  centerTerm,
  chooseBackend,
  clickAppMenuItem,
  dialogPrimary,
  gitInit,
  newSessionInWith,
  openMenu,
  pickerDialog,
  processAlive,
  readCalls,
  runIn,
  sendShortcut,
  snap,
  startSessionIn,
  termIds,
  waitBooted,
  worktreeDialog,
  wsRows
} from './helpers/p1'

test.setTimeout(120_000)

const LONGER_THAN_OLD_15S_RESUME_DEADLINE_MS = 16_000
const SLOW_VERSION_PROBE_MS = 10_000
const LAUNCH_MUST_NOT_WAIT_FOR_PROBE_MS = 4000

interface CodexCall {
  pid: number
  argv: string[]
  cwd: string
  sessionId: string
}
function installCodex(env: E2EEnv): void {
  const binary = path.join(env.fakeBin, 'codex')
  fs.symlinkSync(path.join(__dirname, 'fixtures', 'fake-codex.js'), binary)
  env.launchEnv.KOLOFT_CODEX_CMD = binary
  env.launchEnv.CODEX_HOME = path.join(env.home, '.codex')
}
function codexCalls(env: E2EEnv): CodexCall[] {
  const file = path.join(env.home, 'fake-codex-calls.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as CodexCall]
      } catch {
        return []
      }
    })
}
function codexRows(page: Page): Locator {
  return wsRows(page, 'ws-a').filter({
    hasNot: page.getByRole('img', { name: 'Claude', exact: true })
  })
}
async function newIn(
  page: Page,
  worktree = false,
  method: 'Claude' | 'Codex' | null = 'Claude'
): Promise<void> {
  await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
  const item = worktree ? 'New worktree session' : method ? `New ${method} session` : 'New session'
  await page.locator('.menu .mi', { hasText: item }).click()
}
async function startCodex(page: Page, env: E2EEnv): Promise<void> {
  const before = codexCalls(env).length
  await newSessionInWith(page, 'ws-a', 'Codex')
  await expect.poll(() => codexCalls(env).length).toBe(before + 1)
  await expect(codexRows(page).filter({ hasText: 'Starting…' })).toHaveCount(0)
  await expect(codexRows(page).and(page.locator('.active'))).toHaveClass(/st-waiting/)
}

test.describe('Codex sessions through the real method chooser, process transport, saved history and UI lifecycle, with only the external CLI faked', () => {
  test('two saved Codex sessions remain switchable through native startup prompts and a new session', async ({
    env
  }) => {
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const saved: { title: string; id: string; tabId?: string }[] = []
      for (const title of ['Saved Codex A', 'Saved Codex B']) {
        fs.writeFileSync(path.join(env.home, 'fake-codex-next-title'), title)
        await startCodex(page, env)
        saved.push({ title, id: codexCalls(env).at(-1)!.sessionId })
        await sendShortcut(app, 'shortcut:close-tab')
        await expect(codexRows(page).filter({ hasText: title })).toHaveClass(/cold/)
      }
      fs.writeFileSync(path.join(env.home, 'fake-codex-confirm-resume'), '')
      for (const old of saved) {
        const before = await termIds(page)
        await codexRows(page).filter({ hasText: old.title }).click()
        await expect
          .poll(async () => (await termIds(page)).filter((id) => !before.includes(id)).length)
          .toBe(1)
        old.tabId = (await termIds(page)).find((id) => !before.includes(id))!
      }
      await startCodex(page, env)
      for (const old of saved) {
        await codexRows(page).filter({ hasText: old.title }).click()
        await expect
          .poll(() =>
            page.evaluate((id) => {
              const terms = (
                window as unknown as { __koloftTerms?: Record<string, { element?: HTMLElement }> }
              ).__koloftTerms
              const wrap = terms?.[id!]?.element?.closest('.term-wrap')
              return !!wrap?.getClientRects().length
            }, old.tabId)
          )
          .toBe(true)
        await expect(page.locator('.term-wrap:visible > .empty')).toHaveCount(0)
        await expect(page.locator('.term-wrap:visible')).toContainText(
          `Resume ${old.id}: press Enter`
        )
      }
      await page.waitForTimeout(LONGER_THAN_OLD_15S_RESUME_DEADLINE_MS)
      for (const [index, old] of saved.entries()) {
        await codexRows(page).filter({ hasText: old.title }).click()
        await expect(page.locator('.term-wrap:visible')).toContainText(
          `Resume ${old.id}: press Enter`
        )
        await centerTerm(page).click()
        await page.keyboard.press('Enter')
        await expect.poll(() => codexCalls(env).length).toBe(4 + index)
        expect(codexCalls(env).at(-1)!.sessionId).toBe(old.id)
        await expect(page.locator('.term-wrap:visible')).toContainText(
          `Codex fixture ready ${old.id}`
        )
      }
      expect(await termIds(page)).toHaveLength(3)
      expect(codexCalls(env).filter((call) => call.argv.includes('resume'))).toHaveLength(2)
    } finally {
      await quitAndClose(app)
    }
  })

  test('the workspace entrance starts the default method straight away', async ({ env }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect(
        page.locator('.w-empty').getByRole('button', { name: 'New Codex session' })
      ).toBeVisible()
      const menu = await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await expect(menu.locator('.mi', { hasText: 'New Codex session' })).toBeVisible()
      await menu.locator('.mi', { hasText: 'New Claude session' }).click()

      await expect.poll(() => readCalls(env).length).toBe(1)
      await expect(page.locator('.modal')).toHaveCount(0)
      expect(codexCalls(env)).toHaveLength(0)
      await expect(
        wsRows(page, 'ws-a').getByRole('img', { name: 'Claude', exact: true })
      ).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('the second method has its own entrance and does not become the default', async ({
    env
  }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      await expect(page.locator('.modal')).toHaveCount(0)
      expect(readCalls(env)).toHaveLength(0)

      await newIn(page)
      await expect.poll(() => readCalls(env).length).toBe(1)
      expect(codexCalls(env)).toHaveLength(1)
    } finally {
      await quitAndClose(app)
    }
  })

  test('with no claude on this Mac the plain entrance starts Codex', async ({ env }) => {
    installCodex(env)
    env.launchEnv.KOLOFT_TEST_CLAUDE_PROBE = 'missing'
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const menu = await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await expect(menu.locator('.mi', { hasText: 'New Codex session' })).toHaveCount(0)
      await menu.locator('.mi', { hasText: 'New session' }).click()
      await expect.poll(() => codexCalls(env).length).toBe(1)
      await expect(page.locator('.modal')).toHaveCount(0)
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('the worktree dialog still asks, and its buttons name both methods', async ({ env }) => {
    installCodex(env)
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newIn(page, true)
      const dialog = worktreeDialog(page)
      await expect(dialog.getByRole('textbox', { name: 'Worktree', exact: true })).toBeFocused()
      await page.keyboard.press('Enter')
      expect(codexCalls(env).length + readCalls(env).length).toBe(0)

      await page.keyboard.type('feat-x')
      await expect(dialogPrimary(dialog)).toContainText('Create · Claude')
      await expect(dialog.locator('.modal-foot button[data-default="false"]')).toHaveText(
        'Create · Codex⇧⏎'
      )
      const screenshots = path.join(__dirname, '../../test-results/codex-ui')
      fs.mkdirSync(screenshots, { recursive: true })
      await page.screenshot({
        path: path.join(screenshots, 'new-worktree.png'),
        animations: 'disabled'
      })

      await chooseBackend(page, 'other')
      await expect.poll(() => codexCalls(env).length).toBe(1)
      expect(codexCalls(env)[0].cwd).toContain('feat-x')
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('⌘N ⏎ launches while the Codex probe is still out', async ({ env }) => {
    installCodex(env)
    fs.writeFileSync(path.join(env.home, 'fake-codex-version-delay'), String(SLOW_VERSION_PROBE_MS))
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await addWorkspace(page, env.workspaces.b)
      await clickAppMenuItem(app, page, 'new-session')
      await expect(pickerDialog(page)).toBeVisible({ timeout: 15_000 })
      await expect(
        pickerDialog(page).locator('.modal-foot button[data-default="false"]')
      ).toHaveCount(0)
      await page.keyboard.press('Enter')
      await expect
        .poll(() => readCalls(env).length, { timeout: LAUNCH_MUST_NOT_WAIT_FOR_PROBE_MS })
        .toBe(1)
      expect(codexCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('in the picker ⇧⏎ starts the other method', async ({ env }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await addWorkspace(page, env.workspaces.b)
      await clickAppMenuItem(app, page, 'new-session')
      const dlg = pickerDialog(page)
      await expect(dlg).toBeVisible({ timeout: 15_000 })
      await expect(dlg.locator('.modal-foot button[data-default=false]')).toBeVisible()
      await page.keyboard.press('Shift+Enter')
      await expect.poll(() => codexCalls(env).length).toBe(1)
      await expect(dlg).toHaveCount(0)
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('Codex and Claude coexist; Codex closes, resumes and restarts without Workbench', async ({
    env
  }) => {
    installCodex(env)
    const configFile = path.join(env.home, '.codex', 'config.toml')
    const userConfig = '[tui]\nstatus_line = ["thread-id"]\n'
    fs.mkdirSync(path.dirname(configFile), { recursive: true })
    fs.writeFileSync(configFile, userConfig)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a', { method: 'Claude' })
      const toggle = page.getByRole('button', { name: 'Workbench', exact: true })
      if (!(await toggle.getAttribute('class'))?.includes(' on')) await toggle.click()
      await clickAppMenuItem(app, page, 'toggle-focus-mode')
      await expect(page.locator('.term-col')).toBeHidden()
      await startCodex(page, env)
      const first = codexCalls(env)[0]
      await expect(wsRows(page, 'ws-a')).toHaveCount(2)
      await expect(
        wsRows(page, 'ws-a').getByRole('img', { name: 'Claude', exact: true })
      ).toHaveCount(1)
      await expect(
        wsRows(page, 'ws-a').getByRole('img', { name: 'Codex', exact: true })
      ).toHaveCount(1)
      await expect(codexRows(page)).toHaveClass(/active/)
      await expect(page.locator('.term-island')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Workbench', exact: true })).toHaveCount(0)
      await expect(page.locator('.wb-col:visible')).toHaveCount(0)
      await clickAppMenuItem(app, page, 'toggle-browser')
      await expect(page.locator('.wb-col:visible')).toHaveCount(0)

      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page)).toHaveClass(/cold/)
      await codexRows(page).click()
      await expect.poll(() => codexCalls(env).length).toBe(2)
      await expect(codexRows(page)).toHaveClass(/st-waiting|st-idle/)
      expect(codexCalls(env)[1].sessionId).toBe(first.sessionId)
      await clickAppMenuItem(app, page, 'restart-session')
      await expect.poll(() => codexCalls(env).length).toBe(3)
      await expect(codexRows(page)).toHaveClass(/st-waiting|st-idle/)
      expect(codexCalls(env)[2].sessionId).toBe(first.sessionId)
      await expect(wsRows(page, 'ws-a')).toHaveCount(2)
      expect(readCalls(env)).toHaveLength(1)
      await expect(page.getByRole('button', { name: 'Workbench', exact: true })).toHaveCount(0)
      await wsRows(page, 'ws-a')
        .filter({ has: page.getByRole('img', { name: 'Claude', exact: true }) })
        .click()
      await expect(page.getByRole('button', { name: 'Workbench', exact: true })).toBeVisible()

      const statusOverride = (argv: string[]): string | undefined =>
        argv.find(
          (value, index) => value.startsWith('tui.status_line=') && argv[index - 1] === '-c'
        )
      const preset = statusOverride(first.argv)
      expect(preset).toBeDefined()
      expect(JSON.parse(preset!.slice('tui.status_line='.length))).toEqual(
        expect.arrayContaining([
          'context-used',
          'git-branch',
          'model-with-reasoning',
          'current-dir'
        ])
      )
      expect(codexCalls(env).map((call) => statusOverride(call.argv))).toEqual([
        preset,
        preset,
        preset
      ])
      const servers = fs
        .readFileSync(path.join(env.home, 'fake-codex-server-calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { argv: string[] })
      expect(servers.map((call) => statusOverride(call.argv)).filter(Boolean)).toEqual([
        preset,
        preset,
        preset
      ])
      expect(readCalls(env).some((call) => statusOverride(call.argv))).toBe(false)
      expect(fs.readFileSync(configFile, 'utf8')).toBe(userConfig)
    } finally {
      await quitAndClose(app)
    }
  })

  test('Codex worktree survives close and can be rebuilt on resume', async ({ env }) => {
    installCodex(env)
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newIn(page, true)
      const dialog = worktreeDialog(page)
      await expect(dialog).toBeVisible()
      await dialog.locator('input').fill('codex-feature')
      await chooseBackend(page, 'other')
      await expect.poll(() => codexCalls(env).length).toBe(1)
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      const first = codexCalls(env)[0]
      expect(first.cwd).not.toBe(env.workspaces.a)
      expect(fs.existsSync(first.cwd)).toBe(true)
      let menu = await openMenu(page, codexRows(page))
      await expect(menu.locator('.mi', { hasText: 'Reveal in Finder' })).not.toHaveClass(/disabled/)
      await page.keyboard.press('Escape')
      const marker = path.join(first.cwd, 'unfinished.txt')
      fs.writeFileSync(marker, 'retain my edits')
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page)).toHaveClass(/cold/)
      expect(fs.readFileSync(marker, 'utf8')).toBe('retain my edits')
      menu = await openMenu(page, codexRows(page))
      await expect(menu.locator('.mi', { hasText: 'Reveal in Finder' })).not.toHaveClass(/disabled/)
      await page.keyboard.press('Escape')
      await codexRows(page).click()
      await expect.poll(() => codexCalls(env).length).toBe(2)
      await expect(codexRows(page)).toHaveClass(/st-waiting|st-idle/)
      expect(fs.readFileSync(marker, 'utf8')).toBe('retain my edits')
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page)).toHaveClass(/cold/)
      execFileSync('git', ['worktree', 'remove', '--force', first.cwd], { cwd: env.workspaces.a })
      await codexRows(page).click()
      await expect.poll(() => codexCalls(env).length).toBe(3)
      await expect(codexRows(page)).toHaveClass(/st-waiting|st-idle/)
      expect(codexCalls(env)[2].cwd).toBe(first.cwd)
      expect(codexCalls(env)[2].sessionId).toBe(first.sessionId)
      expect(fs.existsSync(first.cwd)).toBe(true)
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('mixed sessions receive worktree and Codex approval hints without Claude-only guidance', async ({
    env
  }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a', { method: 'Claude' })
      await startCodex(page, env)
      const worktreeHint = page.locator('.hint-card[data-hint="worktree"]')
      await expect(worktreeHint.locator('.h')).toHaveText('Two sessions on one folder?')
      await worktreeHint.getByRole('button', { name: 'Got it', exact: true }).click()
      const tabId = await codexRows(page).getAttribute('data-tab-id')
      expect(tabId).toBeTruthy()
      await wsRows(page, 'ws-a')
        .filter({ has: page.getByRole('img', { name: 'Claude', exact: true }) })
        .click()
      await page.evaluate((id) => window.api.terminal.write(id!, 'approve\r'), tabId)
      const approvalHint = page.locator('.hint-card[data-hint="approval"]')
      await expect(approvalHint.locator('.h')).toHaveText('Amber means a session needs you')
      await expect(codexRows(page)).toHaveClass(/st-approval/)
      await approvalHint.getByRole('button', { name: 'Got it', exact: true }).click()
      await codexRows(page).click()
      await expect(page.locator('.term-island .term-wrap:visible')).toContainText(
        'Approve command?'
      )
      await runIn(page, centerTerm(page), 'y')
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      await expect(page.getByRole('button', { name: 'Workbench', exact: true })).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('Codex unavailable status uses the existing detail badge and keeps the terminal accessible', async ({
    env
  }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      await runIn(page, centerTerm(page), '/resume 00000000-0000-4000-8000-000000000099')
      const row = codexRows(page)
      const badge = row.getByRole('button', { name: 'Status unavailable', exact: true })
      await expect(badge).toBeVisible()
      await expect(row).not.toHaveClass(/st-approval|st-working|st-waiting|st-idle|cold/)
      await badge.click()
      await expect(page.locator('.tbu-pop.parked')).toContainText('may still be running')
      await snap(page, 'UI-audit-status-unavailable')
      await page.keyboard.press('Escape')
      await row.click()
      await expect(centerTerm(page)).toBeVisible()
      await runIn(page, centerTerm(page), '/new')
      await expect(row).toHaveClass(/st-waiting/)
      await expect(badge).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('Codex approval, interruption and close confirmation use the shared session controls', async ({
    env
  }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      await runIn(page, centerTerm(page), 'approve')
      await expect(codexRows(page)).toHaveClass(/st-approval/)
      await sendShortcut(app, 'shortcut:close-tab')
      const confirm = page.locator('.lifecycle-modal')
      await expect(confirm).toContainText('pending permission prompt')
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(codexRows(page)).toHaveClass(/st-approval/)
      await runIn(page, centerTerm(page), 'y')
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      await runIn(page, centerTerm(page), 'hold')
      await expect(codexRows(page)).toHaveClass(/st-working/)
      await page.keyboard.press('Control+C')
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      await runIn(page, centerTerm(page), 'hold')
      await expect(codexRows(page)).toHaveClass(/st-working/)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(confirm).toContainText('still working')
      await confirm.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(codexRows(page)).toHaveClass(/cold/)
      expect(codexCalls(env)).toHaveLength(1)
    } finally {
      await quitAndClose(app)
    }
  })

  test('Codex list removal and native exit preserve restorable CLI history', async ({ env }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      const first = codexCalls(env)[0]
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page)).toHaveClass(/cold/)
      await openMenu(page, codexRows(page))
      await page.locator('.menu .mi', { hasText: 'Remove from list' }).click()
      await expect(codexRows(page)).toHaveCount(0)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Restore session' }).click()
      const history = page.getByRole('dialog', { name: 'Restore session · ws-a', exact: true })
      const row = history.getByRole('button').filter({ hasText: 'Codex fixture session' })
      await snap(page, 'UI-audit-history')
      await row.click()
      await expect.poll(() => codexCalls(env).length).toBe(2)
      await expect(codexRows(page)).toHaveClass(/st-idle|st-waiting/)
      expect(codexCalls(env)[1].sessionId).toBe(first.sessionId)
      await runIn(page, centerTerm(page), '/exit')
      await expect(codexRows(page)).toHaveCount(0)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Restore session' }).click()
      await expect(
        history.getByRole('button').filter({ hasText: 'Codex fixture session' })
      ).toBeVisible()
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('renderer reload adopts the same Codex process and keeps the terminal usable', async ({
    env
  }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      const first = codexCalls(env)[0]
      const ids = await termIds(page)
      expect(ids).toHaveLength(1)
      await page.reload()
      await waitBooted(page)
      await expect.poll(() => termIds(page)).toEqual(ids)
      await expect(codexRows(page)).not.toHaveClass(/cold/)
      await codexRows(page).click()
      await runIn(page, centerTerm(page), 'hold after reload')
      await expect(codexRows(page)).toHaveClass(/st-working/)
      await page.keyboard.press('Control+C')
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      expect(codexCalls(env)).toHaveLength(1)
      expect(processAlive(first.pid)).toBe(true)
      await expect(page.getByRole('button', { name: 'Workbench', exact: true })).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('app restart leaves Codex members cold and restores removed history with its native identity', async ({
    env
  }) => {
    installCodex(env)
    let app = await launchApp(env)
    try {
      let page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      const historyId = codexCalls(env)[0].sessionId
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page)).toHaveClass(/cold/)
      await openMenu(page, codexRows(page))
      await page.locator('.menu .mi', { hasText: 'Remove from list' }).click()
      await expect(codexRows(page)).toHaveCount(0)
      await startCodex(page, env)
      const member = codexCalls(env)[1]
      await quitAndClose(app)
      await expect.poll(() => processAlive(member.pid)).toBe(false)

      app = await launchApp(env)
      page = await app.firstWindow()
      await waitBooted(page)
      await expect(codexRows(page)).toHaveCount(1)
      await expect(codexRows(page)).toHaveClass(/cold/)
      expect(await termIds(page)).toHaveLength(0)
      expect(codexCalls(env)).toHaveLength(2)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Restore session' }).click()
      const history = page.getByRole('dialog', { name: 'Restore session · ws-a', exact: true })
      await history.getByRole('button').filter({ hasText: 'Codex fixture session' }).click()
      await expect.poll(() => codexCalls(env).length).toBe(3)
      expect(codexCalls(env)[2].sessionId).toBe(historyId)
      await expect(codexRows(page)).toHaveCount(2)
      await codexRows(page).and(page.locator('.cold')).click()
      await expect.poll(() => codexCalls(env).length).toBe(4)
      expect(codexCalls(env)[3].sessionId).toBe(member.sessionId)
      await expect(codexRows(page)).toHaveCount(2)
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('workspace removal counts and stops both CLI runs while preserving their histories', async ({
    env
  }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a', { method: 'Claude' })
      await startCodex(page, env)
      const claude = readCalls(env)[0]
      const codex = codexCalls(env)[0]
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi.danger', { hasText: 'Remove workspace' }).click()
      const confirm = page.locator('.modal')
      await expect(confirm).toContainText('2 running sessions')
      await confirm.getByRole('button', { name: 'Close & remove', exact: true }).click()
      await expect(page.locator('.ws-head .ws-name', { hasText: 'ws-a' })).toHaveCount(0)
      await expect.poll(() => processAlive(claude.pid)).toBe(false)
      await expect.poll(() => processAlive(codex.pid)).toBe(false)
      await addWorkspace(page, env.workspaces.a)
      await expect(wsRows(page, 'ws-a')).toHaveCount(2)
      await expect(wsRows(page, 'ws-a').and(page.locator('.cold'))).toHaveCount(2)
      await codexRows(page).click()
      await expect.poll(() => codexCalls(env).length).toBe(2)
      expect(codexCalls(env)[1].sessionId).toBe(codex.sessionId)
      expect(readCalls(env)).toHaveLength(1)
    } finally {
      await quitAndClose(app)
    }
  })

  test('Codex recovers a worktree preparation interrupted before any session bound', async ({
    env
  }) => {
    installCodex(env)
    gitInit(env.workspaces.a)
    const resourceId = randomUUID()
    const name = 'interrupted-codex'
    const cwd = path.join(env.workspaces.a, '.claude', 'worktrees', name)
    const baseline = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: env.workspaces.a,
      encoding: 'utf8'
    }).trim()
    fs.writeFileSync(
      path.join(env.userData, 'sessions.json'),
      JSON.stringify({
        version: 1,
        members: {},
        resources: {
          [resourceId]: {
            id: resourceId,
            originalCwd: env.workspaces.a,
            worktreePath: cwd,
            worktreeName: name,
            worktreeBranch: 'worktree-' + name,
            originalHeadCommit: baseline,
            state: 'creating',
            managed: true
          }
        }
      })
    )
    execFileSync(
      'git',
      [
        '-c',
        'user.email=e2e@koloft.test',
        '-c',
        'user.name=koloft-e2e',
        'commit',
        '--allow-empty',
        '-qm',
        'Advance main'
      ],
      { cwd: env.workspaces.a }
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newIn(page, true)
      const dialog = worktreeDialog(page)
      await expect(dialog.locator('.wt-list .cb-row', { hasText: name })).toContainText(
        'Recover worktree'
      )
      await page.getByRole('textbox', { name: 'Worktree', exact: true }).fill(name)
      await expect(
        dialog.locator('.field-hint').filter({ hasText: 'Recover the saved' })
      ).toContainText('Codex')
      await expect(dialog.locator('.modal-foot button')).toHaveCount(2)
      await expect(dialogPrimary(dialog)).toContainText('Recover · Codex')
      await expect(dialog.locator('.fresh-line')).toHaveCount(0)
      await dialog.locator('.wt-list .cb-row', { hasText: name }).click()
      await expect.poll(() => codexCalls(env).length).toBe(1)
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      expect(codexCalls(env)[0].cwd).toBe(cwd)
      expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()).toBe(
        baseline
      )
      const saved = JSON.parse(fs.readFileSync(path.join(env.userData, 'sessions.json'), 'utf8'))
      expect(Object.keys(saved.resources)).toEqual([resourceId])
      expect(saved.resources[resourceId].state).toBe('ready')
      expect(Object.values(saved.members)).toEqual([
        expect.objectContaining({ worktreeResourceId: resourceId })
      ])
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('the saved default method is what an entrance starts, across a restart and a switch-off that refuses new Codex sessions but still resumes and restarts old ones', async ({
    env
  }) => {
    installCodex(env)
    gitInit(env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    let app = await launchApp(env)
    try {
      let page = await app.firstWindow()
      await waitBooted(page)
      await sendShortcut(app, 'shortcut:open-settings')
      await expect(page.locator('.set-main')).toContainText('Codex uses its own login on this Mac.')
      await page.getByRole('tab', { name: 'Sessions', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Use Claude by default' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await expect(page.getByRole('switch', { name: 'Enable Claude', exact: true })).toBeDisabled()
      const screenshots = path.join(__dirname, '../../test-results/codex-ui')
      fs.mkdirSync(screenshots, { recursive: true })
      await page.screenshot({
        path: path.join(screenshots, 'session-methods.png'),
        animations: 'disabled'
      })
      await page.getByRole('button', { name: 'Use Codex by default' }).click()
      await page.keyboard.press('Escape')

      await newIn(page, false, 'Codex')
      await expect.poll(() => codexCalls(env).length).toBe(1)
      await expect(page.locator('.modal')).toHaveCount(0)
      expect(readCalls(env)).toHaveLength(0)
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      await quitAndClose(app)
      app = await launchApp(env)
      page = await app.firstWindow()
      await waitBooted(page)
      await newIn(page, true)
      const primary = page.locator('.modal-foot button[data-default=true]')
      await expect(primary).toContainText('Create')
      await expect(primary).toContainText('Codex')
      await expect(primary).toBeDisabled()
      await expect(primary).not.toHaveAttribute('title', 'Checking…')
      await page.getByRole('textbox', { name: 'Worktree', exact: true }).fill('default-worktree')
      await expect(primary).toBeEnabled()
      await page.keyboard.press('Enter')
      await expect.poll(() => codexCalls(env).length).toBe(2)
      expect(codexCalls(env)[1].cwd).toContain('default-worktree')
      await expect(codexRows(page)).toHaveCount(2)
      await sendShortcut(app, 'shortcut:open-settings')
      await page.getByRole('tab', { name: 'Sessions', exact: true }).click()
      await expect(page.getByRole('button', { name: 'Use Codex by default' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await page.getByRole('switch', { name: 'Enable Codex', exact: true }).uncheck()
      await expect(page.getByRole('button', { name: 'Use Claude by default' })).toHaveAttribute(
        'aria-pressed',
        'true'
      )
      await expect(page.getByRole('button', { name: 'Use Codex by default' })).toBeDisabled()
      await page.keyboard.press('Escape')

      const menu = await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await expect(menu.locator('.mi', { hasText: 'New Codex session' })).toHaveCount(0)
      await menu.locator('.mi', { hasText: 'New session' }).click()
      await expect.poll(() => readCalls(env).length).toBe(1)
      await expect(page.locator('.modal')).toHaveCount(0)
      expect(codexCalls(env)).toHaveLength(2)
      const refusal = await page.evaluate(async (cwd) => {
        try {
          await window.api.terminal.create({ kind: 'codex', cwd })
          return ''
        } catch (e) {
          return String(e)
        }
      }, env.workspaces.a)
      expect(refusal).toContain('disabled')
      const row = codexRows(page).filter({ hasText: 'default-worktree' })
      await row.click()
      await clickAppMenuItem(app, page, 'restart-session')
      await expect.poll(() => codexCalls(env).length).toBe(3)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(row).toHaveClass(/cold/)
      await row.click()
      await expect.poll(() => codexCalls(env).length).toBe(4)
      await expect(row).toHaveClass(/st-waiting|st-idle/)
    } finally {
      await quitAndClose(app)
    }
  })
})
