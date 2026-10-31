import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { chromium, type Locator, type Page } from '@playwright/test'
import {
  BROWSER,
  PICKED_LABEL,
  PICK_PAGE,
  isPng,
  newWebTab,
  openBrowser,
  openPickPage,
  pickIntoSession,
  picturePath
} from './helpers/browser'
import { startEchoServer } from './helpers/fixtureServer'
import {
  test,
  expect,
  launchApp,
  osOutlets,
  pendingAttention,
  pretendWindowFocused,
  quitAndClose
} from './helpers/app'
import {
  E2E_CODEX_ACCOUNT,
  installCodex,
  installFakeGh,
  seedNoClaudeAccountButStillSetUp,
  seededAccount,
  seedSettings,
  setGithubFixture,
  type E2EEnv
} from './helpers/env'
import {
  FAILED_LOG,
  ONE_FAILING_OF_FIVE,
  WORKBENCH,
  commentOnFirstHunk,
  expectOnePromptFromTheChecks,
  expectOnePromptFromTheComment,
  sendFailingChecks,
  showBrowse,
  wbActiveTab,
  wbUnreadTabs
} from './helpers/workbench'
import { setupChangeFixture } from './helpers/filesFixture'
import {
  claudeRows,
  codexAnswers,
  codexCalls,
  codexRows,
  fakeCodexLog,
  startCodex,
  type CodexCall,
  type CodexWireLine
} from './helpers/codex'
import { portOffset } from '../../src/shared/worktreeName'
import {
  addWorkspace,
  centerTerm,
  closeKeptTab,
  agentRow,
  chooseBackend,
  clickAppMenuItem,
  dialogPrimary,
  gitCommitAll,
  gitInit,
  gitRepoWithAnIncludedEnv,
  newSessionInWith,
  oneStillRunning,
  openMenu,
  pickerDialog,
  processAlive,
  readCalls,
  restoreOffered,
  runIn,
  sendShortcut,
  settingsOnDisk,
  snap,
  startSessionIn,
  staysOnTheFolderPageNotTheButler,
  switchToRow,
  termIds,
  waitBooted,
  worktreeDialog,
  wsRows
} from './helpers/p1'

test.setTimeout(120_000)

const LONGER_THAN_OLD_15S_RESUME_DEADLINE_MS = 16_000
const SLOW_VERSION_PROBE_MS = 10_000
const LAUNCH_MUST_NOT_WAIT_FOR_PROBE_MS = 4000
const CODEX_TRANSPORT_STOP_WORST_CASE_MS = 4000
const WAITING_TO_IDLE_MS = 1000
const IDLE_TO_SLEEP_MS = 3000
const A_REMOVAL_WOULD_HAVE_FINISHED_MS = 3000

function codexOpenOutputs(env: E2EEnv): string[] {
  return fs
    .readFileSync(path.join(env.home, 'fake-codex-wire.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line).frame?.params?.item)
    .filter((item) => item?.type === 'commandExecution' && item.id.startsWith('open-'))
    .map((item) => item.aggregatedOutput)
}
function codexPrompts(env: E2EEnv): string[] {
  const file = path.join(env.home, 'fake-codex-wire.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        const { direction, frame } = JSON.parse(line)
        const text = frame?.method === 'turn/start' ? frame.params?.input?.[0]?.text : undefined
        return direction === 'client' && typeof text === 'string' ? [text] : []
      } catch {
        return []
      }
    })
}
async function startCodexInWorktree(page: Page, env: E2EEnv, name: string): Promise<CodexCall> {
  const before = codexCalls(env).length
  await newIn(page, true)
  await worktreeDialog(page).locator('input').fill(name)
  await chooseBackend(page, 'Codex')
  await expect.poll(() => codexCalls(env).length).toBe(before + 1)
  await expect(codexRows(page).filter({ hasText: 'Starting…' })).toHaveCount(0)
  return codexCalls(env)[before]
}
async function restoreFromTheFirstMenuOpenedAfterLaunch(page: Page): Promise<void> {
  await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
  const restore = page.locator('.menu .mi', { hasText: 'Restore session' })
  await expect(restore).not.toHaveClass(/disabled/)
  await restore.click()
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
        await expect
          .poll(() => fs.existsSync(path.join(env.home, 'fake-codex-next-title')))
          .toBe(false)
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

  test('/new in a Codex tab binds its one row to the new thread, as /clear does in Claude, and the old thread waits in Restore session, which resumes it', async ({
    env
  }) => {
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      fs.writeFileSync(path.join(env.home, 'fake-codex-next-title'), 'Before new')
      const before = await startCodex(page, env)
      await expect(codexRows(page).filter({ hasText: 'Before new' })).toHaveCount(1)
      const tabs = await termIds(page)

      fs.writeFileSync(path.join(env.home, 'fake-codex-next-title'), 'After new')
      await runIn(page, centerTerm(page), '/new')
      await expect.poll(() => codexCalls(env).length).toBe(2)
      const after = codexCalls(env)[1]
      expect(after.method).toBe('thread/start')
      expect(after.sessionId).not.toBe(before.sessionId)

      await expect(codexRows(page)).toHaveText(/After new/)
      await expect(codexRows(page)).toHaveClass(/\bactive\b/)
      await expect(codexRows(page)).toHaveCount(1)
      expect(await termIds(page)).toEqual(tabs)

      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Restore session' }).click()
      const history = page.getByRole('dialog', { name: 'Restore session · ws-a', exact: true })
      await expect(history.getByRole('button').filter({ hasText: 'After new' })).toHaveCount(0)
      await history.getByRole('button').filter({ hasText: 'Before new' }).click()
      await expect.poll(() => codexCalls(env).length).toBe(3)
      expect(codexCalls(env)[2]).toMatchObject({
        method: 'thread/resume',
        sessionId: before.sessionId
      })
      await expect(codexRows(page)).toHaveCount(2)
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
      const empty = page.locator('.w-empty')
      await expect(empty.locator('button[data-default="true"]')).toHaveText('＋ New Claude session')
      await expect(empty.getByRole('button', { name: 'Pick an agent' })).toBeVisible()
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

  // ADR-0030
  test('with no Codex account, Codex is shut as "No account" in the agent list of the empty workspace and of the ⌘N picker, where ⇧⏎ opens that list and Esc shuts only the list, under a line that stays and whose Settings part opens Settings ▸ Accounts', async ({
    env
  }) => {
    installCodex(env)
    const accounts = settingsOnDisk(env).accounts as { kind: string }[]
    seedSettings(env, { accounts: accounts.filter((a) => a.kind !== 'codex-home') })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const empty = page.locator('.w-empty')
      const line = /^No Codex account yet — add one in Settings ▸ Accounts\.$/
      await expect(empty.getByRole('button', { name: /New Claude session/ })).toBeEnabled()
      await empty.getByRole('button', { name: 'Pick an agent' }).click()
      await expect(agentRow(page, 'Codex')).toHaveAttribute('aria-disabled', 'true')
      await expect(agentRow(page, 'Codex')).toContainText('No account')
      await expect(empty.locator('.field-hint.bad')).toHaveText(line)
      await snap(page, 'codex-no-account-empty-workspace')
      await agentRow(page, 'Codex').click({ force: true })
      await page.keyboard.press('Escape')
      await expect(page.getByRole('listbox', { name: 'Agents' })).toHaveCount(0)

      await clickAppMenuItem(app, page, 'new-session')
      const dlg = pickerDialog(page)
      await expect(dlg).toBeVisible({ timeout: 15_000 })
      await expect(dlg.locator('.field-hint.bad')).toHaveText(line)
      await page.keyboard.press('Shift+Enter')
      await expect(agentRow(page, 'Codex')).toHaveAttribute('aria-disabled', 'true')
      await snap(page, 'codex-no-account-picker')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('listbox', { name: 'Agents' })).toHaveCount(0)
      await expect(dlg).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(dlg).toHaveCount(0)

      await empty.getByRole('button', { name: 'Settings ▸ Accounts' }).click()
      await expect(page.getByRole('tab', { name: 'Accounts', exact: true })).toHaveAttribute(
        'aria-selected',
        'true'
      )
      await expect(page.getByRole('button', { name: 'Sign in to Codex' })).toBeVisible()
      expect(codexCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  // ADR-0030
  test('with no Codex account, the workspace menu shuts "New Codex session" and leaves Claude open, and a Codex start that still reaches Koloft is refused with the line the shut buttons show', async ({
    env
  }) => {
    installCodex(env)
    const accounts = settingsOnDisk(env).accounts as { kind: string }[]
    seedSettings(env, { accounts: accounts.filter((a) => a.kind !== 'codex-home') })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const menu = await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      const codexItem = menu.locator('.mi', { hasText: 'New Codex session' })
      await expect(codexItem).toHaveClass(/\bdisabled\b/)
      await expect(menu.locator('.mi', { hasText: 'New Claude session' })).not.toHaveClass(
        /\bdisabled\b/
      )
      await snap(page, 'codex-no-account-workspace-menu')
      await codexItem.click({ force: true })

      const refusal = await page.evaluate(async (cwd) => {
        try {
          await window.api.terminal.create({ kind: 'codex', cwd })
          return ''
        } catch (e) {
          return String(e)
        }
      }, env.workspaces.a)
      expect(refusal).toContain('No Codex account yet — add one in Settings ▸ Accounts.')
      expect(codexCalls(env)).toHaveLength(0)
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

  test('the worktree dialog still asks, and its agent list names both methods', async ({ env }) => {
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
      await dialog.getByRole('button', { name: 'Pick an agent' }).click()
      await expect(page.getByRole('listbox', { name: 'Agents' }).getByRole('option')).toHaveText([
        '1Claudedefault',
        '2Codex'
      ])
      const screenshots = path.join(__dirname, '../../test-results/codex-ui')
      fs.mkdirSync(screenshots, { recursive: true })
      await page.screenshot({
        path: path.join(screenshots, 'new-worktree.png'),
        animations: 'disabled'
      })

      await agentRow(page, 'Codex').click()
      await expect(dialog).toHaveCount(0)
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
      await expect(pickerDialog(page).getByRole('button', { name: 'Pick an agent' })).toHaveCount(0)
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
      await expect(dlg.getByRole('button', { name: 'Pick an agent' })).toBeVisible()
      await page.keyboard.press('Shift+Enter')
      await expect.poll(() => codexCalls(env).length).toBe(1)
      await expect(dlg).toHaveCount(0)
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a restarted or resumed Codex session stays on the account it ran on until that account is past 95% used, even when another is lighter', async ({
    env
  }) => {
    installCodex(env)
    const homeOf = (name: string) => path.join(env.userData, 'codex-homes', name)
    const setUsed = (name: string, usedPercent: number) => {
      fs.mkdirSync(homeOf(name), { recursive: true })
      fs.writeFileSync(path.join(homeOf(name), 'auth.json'), JSON.stringify({ usedPercent }))
    }
    const accounts = settingsOnDisk(env).accounts as Record<string, unknown>[]
    seedSettings(env, { accounts: [...accounts, seededAccount('other', 'codex-home')] })
    setUsed('e2e-codex', 10)
    setUsed('other', 50)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await page.evaluate(() => window.api.accounts.probe())
      await startCodex(page, env)
      const first = codexCalls(env)[0]
      expect(first.codexHome).toBe(homeOf('e2e-codex'))

      setUsed('e2e-codex', 95)
      setUsed('other', 5)
      await page.evaluate(() => window.api.accounts.probe())
      await clickAppMenuItem(app, page, 'restart-session')
      await expect.poll(() => codexCalls(env).length).toBe(2)
      await expect(codexRows(page)).toHaveClass(/st-waiting|st-idle/)
      expect(codexCalls(env)[1]).toMatchObject({
        sessionId: first.sessionId,
        codexHome: homeOf('e2e-codex')
      })

      setUsed('e2e-codex', 96)
      await page.evaluate(() => window.api.accounts.probe())
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page)).toHaveClass(/cold/)
      await codexRows(page).click()
      await expect.poll(() => codexCalls(env).length).toBe(3)
      expect(codexCalls(env)[2]).toMatchObject({
        sessionId: first.sessionId,
        codexHome: homeOf('other')
      })
    } finally {
      await quitAndClose(app)
    }
  })

  test('restarting a Codex session once no Codex account can be used says why, keeps the running Codex, and starts no other', async ({
    env
  }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      await page.evaluate(
        (name) => window.api.accounts.toggle(name, 'codex-home', false),
        E2E_CODEX_ACCOUNT
      )
      await clickAppMenuItem(app, page, 'restart-session')
      await expect(page.locator('.toast-msg')).toHaveText(
        'No Codex account can be used — check Settings ▸ Accounts.'
      )
      await expect(codexRows(page)).toHaveClass(/\bst-(waiting|idle)\b/)
      await expect(codexRows(page)).not.toHaveClass(/\bcold\b/)
      expect(codexCalls(env)).toHaveLength(1)
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§15
  test('with only a Codex account, opening Koloft reads its limits with no tab started and nothing clicked; its panel lists the account under Codex with its balance and saved resets, and a walled account uses a saved reset only after a yes, then reads its limits again', async ({
    env
  }) => {
    installCodex(env)
    seedNoClaudeAccountButStillSetUp(env)
    const home = path.join(env.userData, 'codex-homes', 'e2e-codex')
    fs.writeFileSync(
      path.join(home, 'auth.json'),
      JSON.stringify({ usedPercent: 100, balance: '62500.0000000000', resets: 3 })
    )
    const resetCalls = (): unknown[] => fakeCodexLog(env, 'fake-codex-reset-calls.jsonl')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const capsule = page.locator('.tbu')
      await expect(capsule.locator('.tbu-bar')).toHaveCount(1)
      await expect(capsule.locator('.tbu-fill.bad')).toHaveCount(1)

      await capsule.click()
      const pop = page.locator('.tbu-pop')
      await expect(pop.locator('.tbu-pop-head', { hasText: /^Codex$/ })).toBeVisible()
      await expect(pop.locator('.tbu-pop-head', { hasText: /^Claude$/ })).toHaveCount(0)
      const row = pop.locator('.tbu-row', { hasText: 'e2e-codex' })
      await expect(row.locator('.acct-status.walled')).toBeVisible()
      await expect(row.locator('.acct-meter[data-win="7d"] .m-pct')).toHaveText('100%')
      await expect(row.locator('.tbu-row-note .acct-note')).toHaveText(
        /^62,500 credits · 3 resets saved, first expires /
      )

      await row.getByRole('button', { name: 'Use a reset' }).click()
      await row.getByRole('button', { name: 'Cancel' }).click()
      await expect(row.getByRole('button', { name: 'Use a reset' })).toBeVisible()
      expect(resetCalls()).toEqual([])

      await row.getByRole('button', { name: 'Use a reset' }).click()
      await row.getByRole('button', { name: 'Use', exact: true }).click()
      await expect(row.locator('.acct-meter[data-win="7d"] .m-pct')).toHaveText('0%')
      await expect(row.locator('.tbu-row-note .acct-note')).toHaveText(
        /^62,500 credits · 2 resets saved/
      )
      await expect(row.locator('.acct-status.walled')).toHaveCount(0)
      await expect(row.getByRole('button', { name: 'Use a reset' })).toHaveCount(0)
      expect(resetCalls()).toEqual([
        { codexHome: home, params: { idempotencyKey: expect.any(String) } }
      ])
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§15
  test('two Codex accounts get a Codex pool like the Claude one: a leading total bar in the capsule and a Pool row that averages them and counts the walled one', async ({
    env
  }) => {
    installCodex(env)
    seedSettings(env, {
      accounts: [seededAccount('e2e-codex', 'codex-home'), seededAccount('other', 'codex-home')]
    })
    for (const [name, usedPercent] of [
      ['e2e-codex', 100],
      ['other', 40]
    ] as const) {
      const home = path.join(env.userData, 'codex-homes', name)
      fs.mkdirSync(home, { recursive: true })
      fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ usedPercent }))
    }
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await page.evaluate(() => window.api.accounts.probe())
      const capsule = page.locator('.tbu')
      await expect(capsule.locator('.tbu-bar.total')).toHaveCount(1)
      await expect(capsule.locator('.tbu-bar:not(.total)')).toHaveCount(2)

      await capsule.click()
      const pool = page.locator('.tbu-pop .tbu-row.pool')
      await expect(pool.locator('.tbu-pool-meta')).toHaveText('2 measured · 1 usable')
      await expect(pool.locator('.acct-meter[data-win="7d"] .m-pct')).toHaveText('70%')
      await expect(pool.locator('.tbu-cell-sub.alarm')).toHaveText('1 walled')
    } finally {
      await quitAndClose(app)
    }
  })

  test('Codex and Claude coexist; Codex has its own Workbench, and closes, resumes and restarts with it', async ({
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
      await expect(toggle).toBeVisible()
      if (!(await toggle.getAttribute('class'))?.includes(' on')) await toggle.click()
      await expect(page.locator('.wb-col:visible')).toHaveCount(1)

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
      await expect(page.locator('.wb-col:visible')).toHaveCount(1)
      await claudeRows(page).click()
      await expect(page.getByRole('button', { name: 'Workbench', exact: true })).toBeVisible()

      const statusOverride = (argv: string[]): string | undefined =>
        argv.find(
          (value, index) => value.startsWith('tui.status_line=') && argv[index - 1] === '-c'
        )
      const preset = statusOverride(first.argv)
      expect(preset).toBeDefined()
      const items: string[] = JSON.parse(preset!.slice('tui.status_line='.length))
      expect(items.slice(0, 3)).toEqual(['context-used', 'five-hour-limit', 'weekly-limit'])
      expect(items).toEqual(
        expect.arrayContaining(['git-branch', 'model-with-reasoning', 'current-dir'])
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
      expect(new Set(servers.map((call) => statusOverride(call.argv)).filter(Boolean))).toEqual(
        new Set([preset])
      )
      expect(readCalls(env).some((call) => statusOverride(call.argv))).toBe(false)
      const config = fs.readFileSync(configFile, 'utf8')
      expect(config.startsWith(userConfig)).toBe(true)
      expect(
        config
          .slice(userConfig.length)
          .split('\n')
          .filter(
            (line) => line.trim() && !/^(\[hooks\.state\."[^"]+"\]|trusted_hash = )/.test(line)
          )
      ).toEqual([])
    } finally {
      await quitAndClose(app)
    }
  })

  test("a file Codex opens with `open` reaches its own Workbench reading area through Koloft's open shim, so the frame does not open it a second time", async ({
    env
  }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      await runIn(page, centerTerm(page), 'open README.md')
      await page
        .locator('.wb-bar .seg[aria-label="Files view"] button', { hasText: 'Browse' })
        .click()
      await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md')
      await expect(page.locator(WORKBENCH.readingBody)).toContainText('koloft-e2e-alpha')
      expect(codexOpenOutputs(env)).toEqual(['koloft-open:sent\n'])
      expect(fs.existsSync(path.join(env.home, 'open-calls.txt'))).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a page Codex opens with `open` comes up in front in its own Workbench, and the agent-web hint and an empty web tab name Codex', async ({
    env
  }) => {
    installCodex(env)
    seedSettings(env, { onboardingSeen: true, hintsSeen: ['workbench'] })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      await runIn(page, centerTerm(page), 'open http://127.0.0.1:1/codex-opened')
      const hint = page.locator('.hint-card[data-hint="agent-web"] .h')
      await expect(hint).toContainText('Codex')
      await expect(hint).not.toContainText('Claude')
      await expect(wbActiveTab(page)).toHaveAttribute('title', /codex-opened/)
      await expect(wbUnreadTabs(page)).toHaveCount(0)

      await newWebTab(page)
      await expect(page.locator('.bempty')).toContainText('Or let Codex open one')
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§26
  test("a Codex tab hands the owner's Playwright MCP entry its own browser endpoint, keeping the entry's env_vars; a client there drives that tab's Workbench, and after /new the old client is sent away so a new one drives the new thread", async ({
    env
  }) => {
    installCodex(env)
    fs.writeFileSync(
      path.join(env.home, 'fake-codex-mcp-servers.json'),
      JSON.stringify({
        playwright: { command: 'npx', args: ['@playwright/mcp@latest'], env_vars: ['MINE'] },
        github: { command: 'github-mcp', args: [] }
      })
    )
    seedSettings(env, { onboardingSeen: true, hintsSeen: ['workbench'] })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      const tabServers = fs
        .readFileSync(path.join(env.home, 'fake-codex-server-calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { argv: string[]; playwrightMcpEndpoint: string })
        .filter((call) => call.argv.some((a) => a.startsWith('tui.status_line=')))
      for (const server of tabServers)
        expect(server.argv.filter((a) => a.startsWith('mcp_servers.'))).toEqual([
          'mcp_servers.playwright.env_vars=["MINE","PLAYWRIGHT_MCP_CDP_ENDPOINT","PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS"]'
        ])
      const url = tabServers.at(-1)!.playwrightMcpEndpoint
      expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/cdp\/[a-f0-9]{32}$/)

      const first = await chromium.connectOverCDP(url)
      let sentAway = false
      first.on('disconnected', () => {
        sentAway = true
      })
      try {
        await first.contexts()[0].newPage()
        await openBrowser(page)
        await expect(page.locator(BROWSER.drivenTab)).toHaveCount(1, { timeout: 30_000 })
        await runIn(page, centerTerm(page), '/new')
        await expect.poll(() => sentAway, { timeout: 30_000 }).toBe(true)
      } finally {
        await first.close().catch(() => {})
      }
      const second = await chromium.connectOverCDP(url)
      try {
        const driven = await second.contexts()[0].newPage()
        expect(await driven.evaluate('1 + 1')).toBe(2)
      } finally {
        await second.close()
      }
    } finally {
      await quitAndClose(app)
    }
  })

  test('Codex worktree survives close and can be rebuilt on resume; each time it is made it gets the .worktreeinclude files, and every run in it the same port offset', async ({
    env
  }) => {
    installCodex(env)
    gitRepoWithAnIncludedEnv(env.workspaces.a)
    const includedIn = (dir: string): boolean => fs.existsSync(path.join(dir, '.env'))
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newIn(page, true)
      const dialog = worktreeDialog(page)
      await expect(dialog).toBeVisible()
      await dialog.locator('input').fill('codex-feature')
      await chooseBackend(page, 'Codex')
      await expect.poll(() => codexCalls(env).length).toBe(1)
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      const first = codexCalls(env)[0]
      expect(first.cwd).not.toBe(env.workspaces.a)
      expect(fs.existsSync(first.cwd)).toBe(true)
      expect(includedIn(first.cwd)).toBe(true)
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
      expect(includedIn(first.cwd)).toBe(true)
      expect(readCalls(env)).toHaveLength(0)
      const offsets = fs
        .readFileSync(path.join(env.home, 'fake-codex-server-calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => (JSON.parse(line) as { portOffset: string | null }).portOffset)
        .filter((offset) => offset !== null)
      const offset = String(portOffset('codex-feature'))
      expect(offsets.length).toBeGreaterThanOrEqual(3)
      expect(new Set(offsets)).toEqual(new Set([offset]))
    } finally {
      await quitAndClose(app)
    }
  })

  test('an untouched Codex worktree goes with its tab, folder and worktree-<name> branch, clicking the cold row makes it again in place for the same thread, and a restart after that resumes the same thread in that same folder', async ({
    env
  }) => {
    installCodex(env)
    gitInit(env.workspaces.a)
    const branches = (): string =>
      execFileSync('git', ['branch', '--list', 'worktree-codex-clean'], {
        cwd: env.workspaces.a,
        encoding: 'utf8'
      }).trim()
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const first = await startCodexInWorktree(page, env, 'codex-clean')
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      expect(fs.existsSync(first.cwd)).toBe(true)
      expect(branches()).not.toBe('')

      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page)).toHaveClass(/cold/)
      await expect.poll(() => fs.existsSync(first.cwd)).toBe(false)
      expect(branches()).toBe('')

      await codexRows(page).click()
      await expect.poll(() => codexCalls(env).length).toBe(2)
      await expect(codexRows(page)).toHaveClass(/st-waiting|st-idle/)
      expect(codexCalls(env)[1]).toMatchObject({ cwd: first.cwd, sessionId: first.sessionId })
      const madeAgain = fs.statSync(first.cwd).ino

      await clickAppMenuItem(app, page, 'restart-session')
      await expect.poll(() => codexCalls(env).length).toBe(3)
      await expect(codexRows(page)).toHaveClass(/st-waiting|st-idle/)
      expect(codexCalls(env)[2]).toMatchObject({ cwd: first.cwd, sessionId: first.sessionId })
      expect(fs.statSync(first.cwd).ino).toBe(madeAgain)
      expect(branches()).not.toBe('')
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Codex session whose .claude/worktrees folder was deleted and whose worktree Koloft has no record of is rebuilt there from its branch on a click, for the same thread', async ({
    env
  }) => {
    installCodex(env)
    gitInit(env.workspaces.a)
    let app = await launchApp(env)
    let first: CodexCall
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      first = await startCodexInWorktree(page, env, 'codex-lost')
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      fs.writeFileSync(path.join(first.cwd, 'kept.txt'), 'committed on the branch')
      gitCommitAll(first.cwd)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page)).toHaveClass(/cold/)
    } finally {
      await quitAndClose(app)
    }
    const storeFile = path.join(env.userData, 'sessions.json')
    const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'))
    store.resources = {}
    for (const member of Object.values<{ worktreeResourceId?: string }>(store.members))
      delete member.worktreeResourceId
    fs.writeFileSync(storeFile, JSON.stringify(store))
    fs.rmSync(first.cwd, { recursive: true, force: true })

    app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await codexRows(page).click()
      await expect.poll(() => codexCalls(env).length).toBe(2)
      await expect(codexRows(page)).toHaveClass(/st-waiting|st-idle/)
      expect(codexCalls(env)[1]).toMatchObject({ cwd: first.cwd, sessionId: first.sessionId })
      expect(fs.readFileSync(path.join(first.cwd, 'kept.txt'), 'utf8')).toBe(
        'committed on the branch'
      )
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Codex worktree another session still runs in stays when one tab closes, and goes when the last one does', async ({
    env
  }) => {
    installCodex(env)
    gitInit(env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const tree = (await startCodexInWorktree(page, env, 'codex-shared')).cwd
      expect((await startCodexInWorktree(page, env, 'codex-shared')).cwd).toBe(tree)
      await expect(codexRows(page).and(page.locator('.st-waiting'))).toHaveCount(2)

      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page).and(page.locator('.cold'))).toHaveCount(1)
      await page.waitForTimeout(A_REMOVAL_WOULD_HAVE_FINISHED_MS)
      expect(fs.existsSync(tree)).toBe(true)

      await codexRows(page).and(page.locator('.st-waiting')).click()
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page).and(page.locator('.cold'))).toHaveCount(2)
      await expect.poll(() => fs.existsSync(tree)).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Codex worktree a Claude session was opened in stays while that Claude session runs, and goes when Codex is the last to leave it', async ({
    env
  }) => {
    installCodex(env)
    gitInit(env.workspaces.a)
    fs.writeFileSync(path.join(env.workspaces.a, '.gitignore'), 'NOTES.md\n')
    gitCommitAll(env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const tree = (await startCodexInWorktree(page, env, 'codex-mixed')).cwd
      await newIn(page, true)
      await worktreeDialog(page).locator('input').fill('codex-mixed')
      await chooseBackend(page, 'default')
      await expect(claudeRows(page)).toHaveClass(/st-waiting/)
      const notes = path.join(tree, 'NOTES.md')
      await expect.poll(() => fs.existsSync(notes)).toBe(true)
      fs.copyFileSync(notes, path.join(env.workspaces.a, 'NOTES.md'))

      await codexRows(page).click()
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page)).toHaveClass(/cold/)
      await page.waitForTimeout(A_REMOVAL_WOULD_HAVE_FINISHED_MS)
      expect(fs.existsSync(tree)).toBe(true)

      await claudeRows(page).click()
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(claudeRows(page)).toHaveClass(/cold/)
      await codexRows(page).click()
      await expect(codexRows(page)).toHaveClass(/st-waiting|st-idle/)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page)).toHaveClass(/cold/)
      await expect.poll(() => fs.existsSync(tree)).toBe(false)
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
      await claudeRows(page).click()
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
    } finally {
      await quitAndClose(app)
    }
  })

  test('an idle Codex session goes to sleep: its CLI ends while its row and tab stay, and clicking it wakes the same thread in that tab', async ({
    env
  }) => {
    installCodex(env)
    env.launchEnv.KOLOFT_IDLE_MS = String(WAITING_TO_IDLE_MS)
    env.launchEnv.KOLOFT_IDLE_CLOSE_MS = String(IDLE_TO_SLEEP_MS)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      const first = codexCalls(env)[0]
      await startSessionIn(page, 'ws-b', { method: 'Claude' })
      await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(2)
      await codexRows(page).click()
      await wsRows(page, 'ws-b').first().click()
      await expect.poll(() => processAlive(first.pid), { timeout: 40_000 }).toBe(false)
      const asleepTab = await codexRows(page).getAttribute('data-tab-id')
      await expect(codexRows(page)).toHaveClass(/\bst-idle\b/)
      expect(await termIds(page)).toContain(asleepTab)
      expect(codexCalls(env)).toHaveLength(1)

      await codexRows(page).click()
      await expect.poll(() => codexCalls(env).length).toBe(2)
      expect(codexCalls(env)[1].sessionId).toBe(first.sessionId)
      await expect(codexRows(page)).not.toHaveAttribute('data-tab-id', asleepTab ?? '')
      await expect(codexRows(page)).toHaveClass(/st-waiting|st-idle/, { timeout: 30_000 })
      await expect.poll(() => termIds(page), { timeout: 30_000 }).not.toContain(asleepTab)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Codex worktree tab that goes to sleep keeps its untouched worktree and wakes in it, and closing it while asleep takes the worktree with it', async ({
    env
  }) => {
    installCodex(env)
    gitInit(env.workspaces.a)
    env.launchEnv.KOLOFT_IDLE_MS = String(WAITING_TO_IDLE_MS)
    env.launchEnv.KOLOFT_IDLE_CLOSE_MS = String(IDLE_TO_SLEEP_MS)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const first = await startCodexInWorktree(page, env, 'codex-sleepy')
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      await startSessionIn(page, 'ws-b', { method: 'Claude' })
      await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(2)
      await codexRows(page).click()
      await wsRows(page, 'ws-b').first().click()
      await expect.poll(() => processAlive(first.pid), { timeout: 40_000 }).toBe(false)
      await expect(codexRows(page)).toHaveClass(/\bst-idle\b/)
      await page.waitForTimeout(A_REMOVAL_WOULD_HAVE_FINISHED_MS)
      expect(fs.existsSync(first.cwd)).toBe(true)

      await codexRows(page).click()
      await expect.poll(() => codexCalls(env).length).toBe(2)
      const woken = codexCalls(env)[1]
      expect(woken).toMatchObject({ cwd: first.cwd, sessionId: first.sessionId })

      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      await wsRows(page, 'ws-b').first().click()
      await expect.poll(() => processAlive(woken.pid), { timeout: 40_000 }).toBe(false)
      await openMenu(page, codexRows(page))
      await page.locator('.menu .mi', { hasText: /^Close$/ }).click()
      await expect.poll(() => fs.existsSync(first.cwd)).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Codex that fails before any session binds leaves no mark behind once you close its kept tab, so the Dock badge counts nothing no row can show, and you stay on the folder page instead of the butler', async ({
    env
  }) => {
    installCodex(env)
    fs.writeFileSync(path.join(env.home, 'fake-codex-exit'), '3')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, 'ws-a', 'Codex')
      await expect(page.locator('.toast-msg')).toHaveText(
        'Codex closed before the session started (exit code 3)',
        { timeout: 20_000 }
      )
      await closeKeptTab(page, wsRows(page, 'ws-a'))
      await expect.poll(() => termIds(page)).toHaveLength(0)
      await staysOnTheFolderPageNotTheButler(page, env, 'ws-a')
      await page.waitForTimeout(CODEX_TRANSPORT_STOP_WORST_CASE_MS)
      expect(await pendingAttention(page)).toEqual([])
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

  test('a Codex turn that ends while its child agent still runs shows breathing green with ↻, and turn-done — its mark and its OS notification — waits for the child', async ({
    env
  }) => {
    installCodex(env)
    fs.writeFileSync(path.join(env.home, 'fake-codex-child-ms'), '6000')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      const row = codexRows(page)
      await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(1)
      const notifiedBefore = (await osOutlets(app)).notifications.length
      await runIn(page, centerTerm(page), 'spawn child')
      const running = oneStillRunning(row)
      await expect(running).toBeVisible()
      await expect(row).toHaveClass(/st-waiting/)
      await expect(row).toHaveClass(/\bst-bg-run\b/)
      expect(await pendingAttention(page)).toHaveLength(0)
      expect((await osOutlets(app)).notifications).toHaveLength(notifiedBefore)
      await running.click()
      await expect(page.locator('.tbu-pop.parked')).toContainText('Turn done · still running')
      await page.keyboard.press('Escape')
      await expect(running).toHaveCount(0, { timeout: 15_000 })
      await expect(row).toHaveClass(/st-waiting/)
      await expect(row).not.toHaveClass(/\bst-bg-run\b/)
      await expect
        .poll(() => pendingAttention(page), { timeout: 10_000 })
        .toMatchObject([{ kind: 'turn-done' }])
      const [mark] = await pendingAttention(page)
      expect(mark.title).toBeTruthy()
      expect((await osOutlets(app)).notifications.slice(notifiedBefore)).toEqual([
        { title: mark.title, body: 'turn done — your move · ws-a' }
      ])
    } finally {
      await quitAndClose(app)
    }
  })

  // ADR-0031 CODEX§27
  test("a Codex tab's own app-server runs Koloft's reply-language hooks once Koloft has trusted them: the prompt and every tool call hand Codex the owner's words, which a slash command alone does not replace", async ({
    env
  }) => {
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      await runIn(page, centerTerm(page), '/koloft help')
      const handed = (): { event: string; context: string }[] =>
        fs
          .readFileSync(path.join(env.home, 'fake-codex-hook-output.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { event: string; stdout: string })
          .filter((h) => h.stdout)
          .map((h) => ({
            event: h.event,
            context: (JSON.parse(h.stdout) as { hookSpecificOutput: { additionalContext: string } })
              .hookSpecificOutput.additionalContext
          }))
      await expect
        .poll(() => {
          try {
            return handed()
              .slice(1)
              .map((h) => `${h.event} ${h.context.includes('«Codex fixture session»')}`)
          } catch {
            return []
          }
        })
        .toEqual(['UserPromptSubmit true', 'PostToolUse true'])
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
      const line = codexRows(page).locator('.ws-tab-act')
      await runIn(page, centerTerm(page), '/sh echo hi')
      await expect(line).toHaveText('Last: Ran echo hi')
      await runIn(page, centerTerm(page), 'approve')
      await expect(codexRows(page)).toHaveClass(/st-approval/)
      await expect(line).toHaveText('Wants to run: echo approved')
      await sendShortcut(app, 'shortcut:close-tab')
      const confirm = page.locator('.lifecycle-modal')
      await expect(confirm).toContainText('pending permission prompt')
      await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(codexRows(page)).toHaveClass(/st-approval/)
      await runIn(page, centerTerm(page), 'y')
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      await runIn(page, centerTerm(page), 'please ask me')
      await expect(codexRows(page)).toHaveClass(/st-approval/)
      await expect(line).toHaveText('Asks: Which colour do you prefer?')
      await page.keyboard.press('2')
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      await expect(line).toHaveText('Last: Ran echo hi')
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

  // CODEX§34
  test('a Codex screen whose connection drops mid-turn connects again to a new app-server for the same thread: the cut-off turn no longer shows as working, and the tab is live again and answers the next prompt', async ({
    env
  }) => {
    installCodex(env)
    fs.writeFileSync(path.join(env.home, 'fake-codex-reconnects'), '')
    fs.writeFileSync(path.join(env.home, 'fake-codex-busy-ms'), '60000')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      await runIn(page, centerTerm(page), '/busy')
      await expect(codexRows(page)).toHaveClass(/st-working/)
      await runIn(page, centerTerm(page), '/drop')
      await expect.poll(() => fakeCodexLog(env, 'fake-codex-reconnects.jsonl')).toHaveLength(1)
      await expect(codexRows(page)).toHaveClass(/st-waiting/, { timeout: 30_000 })
      await runIn(page, centerTerm(page), 'after the drop')
      const answers = (): string[] =>
        codexAnswers(fakeCodexLog<CodexWireLine>(env, 'fake-codex-wire.jsonl'))
      await expect
        .poll(answers, { timeout: 30_000 })
        .toContain('Codex fixture answered: after the drop')
      const [codex] = (await page.evaluate(() => window.api.sessions.list())).filter(
        (s) => s.alive && s.details?.codex
      )
      expect(codex.details?.codex?.observation).toBe('live')
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
      await switchToRow(page, codexRows(page))
      await runIn(page, centerTerm(page), 'hold after reload')
      await expect(codexRows(page)).toHaveClass(/st-working/)
      await page.keyboard.press('Control+C')
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      expect(codexCalls(env)).toHaveLength(1)
      expect(processAlive(first.pid)).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  test('app restart brings an open Codex member back running with its native identity, and restores removed history with its native identity', async ({
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
      await expect.poll(() => codexCalls(env).length, { timeout: 30_000 }).toBe(3)
      expect(codexCalls(env)[2].sessionId).toBe(member.sessionId)
      await expect(codexRows(page)).toHaveCount(1)
      await expect(codexRows(page)).toHaveClass(/st-(working|waiting|idle)/, { timeout: 30_000 })
      await restoreFromTheFirstMenuOpenedAfterLaunch(page)
      const history = page.getByRole('dialog', { name: 'Restore session · ws-a', exact: true })
      await history.getByRole('button').filter({ hasText: 'Codex fixture session' }).click()
      await expect.poll(() => codexCalls(env).length).toBe(4)
      expect(codexCalls(env)[3].sessionId).toBe(historyId)
      await expect(codexRows(page)).toHaveCount(2)
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('after Koloft crashes, a Codex session that was open comes back running with its native identity', async ({
    env
  }) => {
    installCodex(env)
    let app = await launchApp(env)
    try {
      let page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      const first = codexCalls(env)[0]
      process.kill(app.process().pid!, 'SIGKILL')
      await expect.poll(() => processAlive(first.pid)).toBe(false)
      await app.close().catch(() => {})

      app = await launchApp(env)
      page = await app.firstWindow()
      await waitBooted(page)
      await expect.poll(() => codexCalls(env).length, { timeout: 30_000 }).toBe(2)
      expect(codexCalls(env)[1].sessionId).toBe(first.sessionId)
      await expect(codexRows(page)).toHaveClass(/st-(working|waiting|idle)/, { timeout: 30_000 })
      await expect(codexRows(page)).toHaveClass(/\bactive\b/)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Codex session’s unread red dot survives a Koloft restart on its row, which comes back running, and stays when the row is clicked in a focused window', async ({
    env
  }) => {
    installCodex(env)
    let app = await launchApp(env)
    try {
      let page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      const first = codexCalls(env)[0]
      await expect(codexRows(page).locator('.ws-tab-unread')).toHaveCount(1)
      await quitAndClose(app)

      app = await launchApp(env)
      page = await app.firstWindow()
      await waitBooted(page)
      await expect.poll(() => codexCalls(env).length, { timeout: 30_000 }).toBe(2)
      expect(codexCalls(env)[1].sessionId).toBe(first.sessionId)
      await expect(codexRows(page)).toHaveClass(/st-waiting/, { timeout: 30_000 })
      await expect(codexRows(page).locator('.ws-tab-unread')).toHaveCount(1)

      await pretendWindowFocused(app)
      await codexRows(page).click()
      await expect(codexRows(page)).toHaveClass(/\bactive\b/)
      await expect(codexRows(page).locator('.ws-tab-unread')).toHaveCount(1)
      expect(codexCalls(env)).toHaveLength(2)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Codex session marked Keep running starts again by itself when Koloft reopens even though its tab was closed, with its native identity, and selects nothing', async ({
    env
  }) => {
    installCodex(env)
    let app = await launchApp(env)
    try {
      let page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      const first = codexCalls(env)[0]
      await openMenu(page, codexRows(page))
      await page.locator('.menu .mi', { hasText: 'Keep running' }).click()
      await expect(codexRows(page).locator('.ws-tab-resident')).toBeVisible()
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page)).toHaveClass(/cold/)
      await quitAndClose(app)
      await expect.poll(() => processAlive(first.pid)).toBe(false)

      app = await launchApp(env)
      page = await app.firstWindow()
      await waitBooted(page)
      await expect.poll(() => codexCalls(env).length, { timeout: 30_000 }).toBe(2)
      expect(codexCalls(env)[1].sessionId).toBe(first.sessionId)
      await expect(codexRows(page)).toHaveClass(/st-(working|waiting|idle)/, { timeout: 30_000 })
      await expect(codexRows(page).locator('.ws-tab-resident')).toBeVisible()
      await expect(wsRows(page, 'ws-a').and(page.locator('.active'))).toHaveCount(0)
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
      const saved = (): { resources: Record<string, { state: string }>; members: object } =>
        JSON.parse(fs.readFileSync(path.join(env.userData, 'sessions.json'), 'utf8'))
      await expect
        .poll(() => Object.values(saved().members))
        .toEqual([expect.objectContaining({ worktreeResourceId: resourceId })])
      expect(Object.keys(saved().resources)).toEqual([resourceId])
      expect(saved().resources[resourceId].state).toBe('ready')
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
      await expect(page.locator('.set-main')).toContainText('Sign in to Codex')
      await page.getByRole('tab', { name: 'Sessions', exact: true }).click()
      const defaultMethod = (): Locator =>
        page.getByRole('button', { name: 'Default session method' })
      await expect(defaultMethod()).toHaveText('Claude')
      await expect(page.getByRole('switch', { name: 'Enable Claude', exact: true })).toBeDisabled()
      const screenshots = path.join(__dirname, '../../test-results/codex-ui')
      fs.mkdirSync(screenshots, { recursive: true })
      await page.screenshot({
        path: path.join(screenshots, 'session-methods.png'),
        animations: 'disabled'
      })
      await defaultMethod().click()
      await agentRow(page, 'Codex').click()
      await expect(defaultMethod()).toHaveText('Codex')
      await page.keyboard.press('Escape')

      await newIn(page, false, 'Codex')
      await expect.poll(() => codexCalls(env).length).toBe(1)
      await expect(page.locator('.modal')).toHaveCount(0)
      expect(readCalls(env)).toHaveLength(0)
      await expect(codexRows(page)).toHaveClass(/st-waiting/)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page)).toHaveClass(/cold/)
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
      await expect(defaultMethod()).toHaveText('Codex')
      await page.getByRole('switch', { name: 'Enable Codex', exact: true }).uncheck()
      await expect(defaultMethod()).toHaveText('Claude')
      await defaultMethod().click()
      await expect(agentRow(page, 'Codex')).toHaveAttribute('aria-disabled', 'true')
      await expect(agentRow(page, 'Codex')).toContainText('Off')
      await page.keyboard.press('Escape')
      await expect(page.getByRole('listbox', { name: 'Agents' })).toHaveCount(0)
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

  // CODEX§15
  test('a Codex account signed in from Settings shows its weekly use back in Settings ▸ Accounts once the sign-in tab closes, and a new Codex session runs in its own sign-in folder', async ({
    env
  }) => {
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await sendShortcut(app, 'shortcut:open-settings')
      await page.getByRole('tab', { name: 'Accounts', exact: true }).click()
      await page.getByRole('button', { name: 'Sign in to Codex' }).click()
      await page.getByPlaceholder('Name this account (e.g. work)').fill('work')
      await page.locator('.acct-add').getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(page.locator('.modal')).toHaveCount(0)
      const home = path.join(env.userData, 'codex-homes', 'work')
      await expect
        .poll(() => fs.existsSync(path.join(home, 'auth.json')), { timeout: 30_000 })
        .toBe(true)
      await expect(page.getByRole('tab', { name: 'Accounts', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
        { timeout: 20_000 }
      )
      await expect(
        page.locator('.acct-row', { hasText: 'work' }).locator('.acct-meter[data-win="7d"] .m-pct')
      ).toHaveText('30%', { timeout: 30_000 })
      await snap(page, 'codex-sign-in-back-in-settings')
      await page.keyboard.press('Escape')

      await startCodex(page, env)
      expect(codexCalls(env).at(-1)!.codexHome).toBe(home)
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§15
  test('an OpenAI API key pasted under Codex in Settings ▸ Accounts is logged in with codex login --with-api-key into the new account’s own sign-in folder (a login that fails says Could not save and adds no row), its row reads Signed in with no meters, Codex sessions run in that folder, and starting them does not re-check the account', async ({
    env
  }) => {
    installCodex(env)
    const accounts = settingsOnDisk(env).accounts as { kind: string }[]
    seedSettings(env, {
      hintsOff: true,
      accounts: accounts.filter((a) => a.kind !== 'codex-home')
    })
    const key = 'sk-proj-e2e-made-up-key'
    const home = path.join(env.userData, 'codex-homes', 'metered')
    const accountReads = (): number =>
      fakeCodexLog<{ codexHome: string }>(env, 'fake-codex-account-reads.jsonl').filter(
        (r) => r.codexHome === home
      ).length
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await sendShortcut(app, 'shortcut:open-settings')
      await page.getByRole('tab', { name: 'Accounts', exact: true }).click()
      await page
        .locator('.set-grp', { hasText: /^Codex$/ })
        .locator('xpath=following-sibling::div[1]')
        .getByRole('button', { name: 'Paste API key' })
        .click()
      const dialog = page.locator('.acct-add')
      await expect(dialog.locator('.acct-add-title')).toHaveText('Add OpenAI API key')
      await dialog.getByPlaceholder('Account name (e.g. personal)').fill('metered')
      const loginFails = path.join(env.home, 'fake-codex-key-login-fails')
      fs.writeFileSync(loginFails, '')
      await dialog.locator('input[type="password"]').fill(key)
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog.locator('.acct-add-err')).toHaveText('Could not save', {
        timeout: 30_000
      })
      await expect(page.locator('.acct-name', { hasText: /^metered$/ })).toHaveCount(0)
      fs.rmSync(loginFails)
      await dialog.locator('input[type="password"]').fill(key)
      await dialog.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(dialog).toHaveCount(0, { timeout: 30_000 })

      const row = page.locator('.acct-row', {
        has: page.locator('.acct-name', { hasText: /^metered$/ })
      })
      await expect(row.locator('.acct-note')).toHaveText('Signed in')
      await expect(row.locator('.acct-status')).toHaveCount(0)
      await expect(row.locator('.acct-meter')).toHaveCount(0)
      expect(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'))).toMatchObject({
        OPENAI_API_KEY: key
      })
      expect(fs.readFileSync(path.join(env.userData, 'settings.json'), 'utf8')).not.toContain(key)
      await snap(page, 'codex-api-key-row')
      await page.keyboard.press('Escape')

      const readsAfterAdding = accountReads()
      expect((await startCodex(page, env)).codexHome).toBe(home)
      expect((await startCodex(page, env)).codexHome).toBe(home)
      await page.evaluate(() => window.api.accounts.probe())
      expect(accountReads()).toBe(readsAfterAdding + 1)
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§15
  test('a Codex sign-in that worked but whose first check after it fails keeps the new account’s row and says nothing failed, and a later Refresh usage shows its weekly use', async ({
    env
  }) => {
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    const readFails = path.join(env.home, 'fake-codex-account-read-fails')
    const workHome = path.join(env.userData, 'codex-homes', 'work')
    const signedInReadFailed = (): boolean =>
      fakeCodexLog<{ codexHome: string; signedIn: boolean }>(
        env,
        'fake-codex-account-read-failures.jsonl'
      ).some((r) => r.codexHome === workHome && r.signedIn)
    fs.writeFileSync(readFails, '')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await sendShortcut(app, 'shortcut:open-settings')
      await page.getByRole('tab', { name: 'Accounts', exact: true }).click()
      await page.getByRole('button', { name: 'Sign in to Codex' }).click()
      await page.getByPlaceholder('Name this account (e.g. work)').fill('work')
      await page.locator('.acct-add').getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect.poll(signedInReadFailed, { timeout: 30_000 }).toBe(true)
      fs.rmSync(readFails)

      await page.getByRole('button', { name: 'Refresh usage' }).click()
      const row = page.locator('.acct-row', {
        has: page.locator('.acct-name', { hasText: /^work$/ })
      })
      await expect(row.locator('.acct-meter[data-win="7d"] .m-pct')).toHaveText('30%', {
        timeout: 30_000
      })
      await expect(page.locator('.acct-login-state.bad')).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§15
  test('a Codex sign-in tab still waiting for the browser names itself above the terminal, and its Cancel closes it and brings Settings ▸ Accounts back saying the sign-in did not complete, with no row left for the new account, and Try again opens the tab again', async ({
    env
  }) => {
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    fs.writeFileSync(path.join(env.home, 'fake-codex-login-waits'), '')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await sendShortcut(app, 'shortcut:open-settings')
      await page.getByRole('tab', { name: 'Accounts', exact: true }).click()
      await page.getByRole('button', { name: 'Sign in to Codex' }).click()
      await page.getByPlaceholder('Name this account (e.g. work)').fill('work')
      await page.locator('.acct-add').getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(page.locator('.modal')).toHaveCount(0)

      const bar = page.locator('.term-island > .wb-bar')
      await expect(bar.locator('.wb-title')).toHaveText('Codex sign in: work', { timeout: 20_000 })
      await snap(page, 'codex-sign-in-tab-bar')
      await expect(page.locator('.term-wrap:visible .xterm')).toContainText(
        'Open this page to sign in',
        { timeout: 20_000 }
      )
      await bar.getByRole('button', { name: 'Cancel' }).click()

      await expect(bar).toHaveCount(0)
      await expect(page.getByRole('tab', { name: 'Accounts', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
        { timeout: 20_000 }
      )
      expect(fs.existsSync(path.join(env.userData, 'codex-homes', 'work', 'auth.json'))).toBe(false)
      const dialog = page.locator('.acct-add')
      await expect(dialog.locator('.acct-login-state.bad')).toContainText(
        'Sign-in did not complete.',
        { timeout: 20_000 }
      )
      await expect(dialog.locator('.acct-login-tail')).toHaveText(
        'Open this page to sign in: https://auth.openai.com/oauth/authorize?fake=1'
      )
      await expect(page.locator('.acct-name', { hasText: /^work$/ })).toHaveCount(0)
      await snap(page, 'codex-sign-in-did-not-complete')

      await dialog.getByRole('button', { name: 'Try again' }).click()
      await expect(bar.locator('.wb-title')).toHaveText('Codex sign in: work', { timeout: 20_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§15
  test('a Codex Sign in again that is cancelled says the sign-in did not complete and keeps the account’s row, still asking to sign in again', async ({
    env
  }) => {
    installCodex(env)
    fs.rmSync(path.join(env.userData, 'codex-homes', E2E_CODEX_ACCOUNT, 'auth.json'))
    const settings = JSON.parse(
      fs.readFileSync(path.join(env.userData, 'settings.json'), 'utf8')
    ) as { accounts: Record<string, unknown>[] }
    seedSettings(env, {
      hintsOff: true,
      accounts: settings.accounts.map((a) =>
        a.name === E2E_CODEX_ACCOUNT ? { ...a, status: 'expired' } : a
      )
    })
    fs.writeFileSync(path.join(env.home, 'fake-codex-login-waits'), '')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await sendShortcut(app, 'shortcut:open-settings')
      await page.getByRole('tab', { name: 'Accounts', exact: true }).click()
      const row = page.locator('.acct-row', {
        has: page.locator('.acct-name', { hasText: /^e2e-codex$/ })
      })
      await row.getByRole('button', { name: 'Sign in again' }).click()
      await page.locator('.acct-add').getByRole('button', { name: 'Sign in', exact: true }).click()

      const bar = page.locator('.term-island > .wb-bar')
      await expect(bar.locator('.wb-title')).toHaveText(`Codex sign in: ${E2E_CODEX_ACCOUNT}`, {
        timeout: 20_000
      })
      await bar.getByRole('button', { name: 'Cancel' }).click()

      const dialog = page.locator('.acct-add')
      await expect(dialog.locator('.acct-add-title')).toHaveText(
        `Sign in again ${E2E_CODEX_ACCOUNT}`,
        { timeout: 20_000 }
      )
      await expect(dialog.locator('.acct-login-state.bad')).toContainText(
        'Sign-in did not complete.'
      )
      await expect(row.getByRole('button', { name: 'Sign in again' })).toBeVisible()
      await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await expect(row).toBeVisible()
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§15
  test('with two Codex accounts, once both show their weekly use in Settings ▸ Accounts, every new Codex session runs in the one with more room left, even though it is listed second', async ({
    env
  }) => {
    installCodex(env)
    const busy = path.join(env.userData, 'codex-homes', 'e2e-codex')
    const roomy = path.join(env.userData, 'codex-homes', 'roomy')
    fs.writeFileSync(path.join(busy, 'auth.json'), JSON.stringify({ usedPercent: 90 }))
    fs.mkdirSync(roomy, { recursive: true })
    fs.writeFileSync(path.join(roomy, 'auth.json'), JSON.stringify({ usedPercent: 10 }))
    const settings = JSON.parse(
      fs.readFileSync(path.join(env.userData, 'settings.json'), 'utf8')
    ) as { accounts: Record<string, unknown>[] }
    seedSettings(env, {
      hintsOff: true,
      accounts: [
        ...settings.accounts,
        { ...settings.accounts.find((a) => a.name === 'e2e-codex'), name: 'roomy' }
      ]
    })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await sendShortcut(app, 'shortcut:open-settings')
      await page.getByRole('tab', { name: 'Accounts', exact: true }).click()
      const weekly = (name: string): Locator =>
        page.locator('.acct-row', { hasText: name }).locator('.acct-meter[data-win="7d"] .m-pct')
      await expect(weekly('e2e-codex')).toHaveText('90%', { timeout: 30_000 })
      await expect(weekly('roomy')).toHaveText('10%', { timeout: 30_000 })
      await page.keyboard.press('Escape')

      await startCodex(page, env)
      await startCodex(page, env)
      expect(codexCalls(env).map((c) => c.codexHome)).toEqual([roomy, roomy])
    } finally {
      await quitAndClose(app)
    }
  })

  // CODEX§14
  test('a scheduled job set to run in Codex offers Codex’s models by name and starts Codex with its task, the picked model and thinking level, never asking, and counts as running once Codex binds', async ({
    env
  }) => {
    const TASK = '/daily-report now'
    installCodex(env)
    gitInit(env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    fs.mkdirSync(path.join(env.home, '.codex'), { recursive: true })
    fs.writeFileSync(
      path.join(env.home, '.codex', 'config.toml'),
      `[projects.${JSON.stringify(fs.realpathSync(env.workspaces.a))}]\ntrust_level = "trusted"\n`
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
      const dlg = page.locator('.modal.cronjobs')
      await dlg.locator('button.mini', { hasText: 'New job' }).click()
      await dlg.locator('.chip', { hasText: /^Codex$/ }).click()
      await dlg.locator('input[aria-label="Name"]').fill('Nightly report')
      await dlg.locator('[aria-label="What to run"]').fill(TASK)
      await dlg.locator('.chip', { hasText: /^GPT-6-Luna$/ }).click()
      await dlg.locator('.chip', { hasText: /^High$/ }).click()
      await expect(dlg.locator('.chip', { hasText: 'Opus' })).toHaveCount(0)
      await expect(dlg.locator('.chip.on', { hasText: 'Never ask' })).toHaveCount(1)
      await expect(dlg.locator('.field-hint.warn')).toHaveCount(0)
      await dlg.locator('.modal-foot .btn-primary').click()
      await expect(dlg.locator('.job-task')).toHaveText(`${TASK} · gpt-6-luna · high`)
      await dlg.locator('.job-row button.mini', { hasText: 'Run now' }).click()

      await expect.poll(() => codexCalls(env).length, { timeout: 30_000 }).toBe(1)
      expect(codexCalls(env)[0].argv.slice(-9)).toEqual([
        '-a',
        'never',
        '-s',
        'danger-full-access',
        '-m',
        'gpt-6-luna',
        '-c',
        'model_reasoning_effort="high"',
        TASK
      ])
      await expect
        .poll(
          () => page.evaluate(async () => (await window.api.cron.list()).live.map((l) => l.state)),
          { timeout: 30_000 }
        )
        .toEqual([expect.stringMatching(/^(running|done)$/)])
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Codex job set to "Close it" closes for good once Codex finishes the turn: tab, row and worktree', async ({
    env
  }) => {
    installCodex(env)
    gitInit(env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    fs.mkdirSync(path.join(env.home, '.codex'), { recursive: true })
    fs.writeFileSync(
      path.join(env.home, '.codex', 'config.toml'),
      `[projects.${JSON.stringify(fs.realpathSync(env.workspaces.a))}]\ntrust_level = "trusted"\n`
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
      const dlg = page.locator('.modal.cronjobs')
      await dlg.locator('button.mini', { hasText: 'New job' }).click()
      await dlg.locator('.chip', { hasText: /^Codex$/ }).click()
      await dlg.locator('input[aria-label="Name"]').fill('Nightly report')
      await dlg.locator('[aria-label="What to run"]').fill('/daily-report now')
      await dlg.locator('.chip', { hasText: 'Close it' }).click()
      await dlg.locator('.modal-foot .btn-primary').click()
      await dlg.locator('.job-row button.mini', { hasText: 'Run now' }).click()

      await expect.poll(() => codexCalls(env).length, { timeout: 30_000 }).toBe(1)
      await expect(dlg.locator('.hist-row').first()).toContainText('Done — closed itself', {
        timeout: 30_000
      })
      const tree = codexCalls(env)[0].cwd
      expect(tree).not.toBe(env.workspaces.a)
      await expect(page.locator('.terminals .term-wrap')).toHaveCount(0, { timeout: 30_000 })
      await expect(wsRows(page, 'ws-a')).toHaveCount(0, { timeout: 30_000 })
      await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Codex job left open loses its folder and branch when you close its tab, though the run left an ignored build file Codex itself would keep; its line says so, and clicking its cold row makes the folder again for the same thread', async ({
    env
  }) => {
    installCodex(env)
    gitInit(env.workspaces.a)
    fs.writeFileSync(path.join(env.workspaces.a, '.gitignore'), 'build/\n')
    gitCommitAll(env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    fs.mkdirSync(path.join(env.home, '.codex'), { recursive: true })
    fs.writeFileSync(
      path.join(env.home, '.codex', 'config.toml'),
      `[projects.${JSON.stringify(fs.realpathSync(env.workspaces.a))}]\ntrust_level = "trusted"\n`
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
      const dlg = page.locator('.modal.cronjobs')
      await dlg.locator('button.mini', { hasText: 'New job' }).click()
      await dlg.locator('.chip', { hasText: /^Codex$/ }).click()
      await dlg.locator('input[aria-label="Name"]').fill('Nightly report')
      await dlg.locator('[aria-label="What to run"]').fill('/daily-report now')
      await dlg.locator('.modal-foot .btn-primary').click()
      await dlg.locator('.job-row button.mini', { hasText: 'Run now' }).click()

      await expect.poll(() => codexCalls(env).length, { timeout: 30_000 }).toBe(1)
      const first = codexCalls(env)[0]
      const tree = first.cwd
      expect(path.basename(path.dirname(tree))).toBe('worktrees')
      const branch = `worktree-${path.basename(tree)}`
      const branchListed = (): string =>
        execFileSync('git', ['branch', '--list', branch], {
          cwd: env.workspaces.a,
          encoding: 'utf8'
        }).trim()
      fs.mkdirSync(path.join(tree, 'build'))
      fs.writeFileSync(path.join(tree, 'build', 'out.txt'), 'made by the run')
      await expect(dlg.locator('.job-last')).toContainText('done — waiting for you', {
        timeout: 30_000
      })
      await page.keyboard.press('Escape')
      await expect(dlg).toHaveCount(0)

      await codexRows(page).click()
      await expect(codexRows(page)).toHaveClass(/\bactive\b/)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRows(page)).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
      expect(branchListed()).toBe('')

      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
      await expect(dlg.locator('.hist-row').first().locator('.hist-folder')).toHaveText(
        ' · folder removed',
        { timeout: 30_000 }
      )
      await expect(dlg.locator('.hist-row').first().locator('.hist-state')).toHaveText(
        'Closed by you'
      )
      await page.keyboard.press('Escape')
      await expect(dlg).toHaveCount(0)

      await codexRows(page).click()
      await expect.poll(() => codexCalls(env).length, { timeout: 30_000 }).toBe(2)
      await expect(codexRows(page)).toHaveClass(/st-waiting|st-idle/, { timeout: 30_000 })
      expect(codexCalls(env)[1]).toMatchObject({ cwd: tree, sessionId: first.sessionId })
      expect(fs.existsSync(tree)).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  test('✎ comment on a Changes hunk lands in the Codex composer as a paste with the note typed after it, unsent until the person presses Enter', async ({
    env
  }) => {
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    setupChangeFixture(env.workspaces.a).modifyTracked(1)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      await showBrowse(page)
      await page
        .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
        .filter({ hasText: 'Changes' })
        .click()

      const note = 'Codex keep the old name'
      const head = await commentOnFirstHunk(page, 'src/change-1.ts', note)
      await expectOnePromptFromTheComment(() => codexPrompts(env), head, note)
    } finally {
      await quitAndClose(app)
    }
  })

  test('BP-06: an element picked in a Workbench web tab lands in the Codex composer as one paste with its picture on this Mac, unsent until the person presses Enter', async ({
    env
  }) => {
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      const guest = await openPickPage(app, page, server.page('/pick', PICK_PAGE))

      await pickIntoSession(page, guest, '#buy', ' BP-06 codex')
      const fromPick = (): string[] => codexPrompts(env).filter((p) => p.includes('BP-06'))
      await expect.poll(fromPick, { timeout: 30_000 }).toHaveLength(1)
      const [prompt] = fromPick()
      expect(prompt).toContain('Element picked in the Workbench browser')
      expect(prompt).toContain(`Element: ${PICKED_LABEL}`)
      const picture = picturePath(prompt)
      expect(picture.startsWith(path.join(env.userData, 'element-picks'))).toBe(true)
      expect(isPng(picture)).toBe(true)
    } finally {
      await quitAndClose(app)
      await server.close()
    }
  })

  test('GitHub button ▸ Send failing checks lands in the Codex composer as one paste, unsent until the person presses Enter, with gh run on this Mac', async ({
    env
  }) => {
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    installFakeGh(env, { checks: ONE_FAILING_OF_FIVE, failedLog: FAILED_LOG })
    setGithubFixture(env, {
      [env.workspaces.a]: { owner: 'acme', repo: 'widgets', branch: 'feature/login', pr: 265 }
    })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startCodex(page, env)
      await expect(page.locator('.wb-gh .ci')).toHaveClass(/\bfail\b/, { timeout: 30_000 })
      await sendFailingChecks(page)
      await expectOnePromptFromTheChecks(() => codexPrompts(env))
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Codex session started in a plain terminal while Koloft is open turns Restore session on for its folder with nothing else done, and deleting it there turns it off again', async ({
    env
  }) => {
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      expect(await restoreOffered(page, 'ws-a')).toBe(false)
      const now = Math.floor(Date.now() / 1000)
      const id = randomUUID()
      const rollout = path.join(env.launchEnv.CODEX_HOME!, 'sessions', `${id}.json`)
      fs.writeFileSync(
        rollout,
        JSON.stringify({
          id,
          cwd: fs.realpathSync(env.workspaces.a),
          path: null,
          name: null,
          preview: 'started in a plain terminal',
          createdAt: now,
          updatedAt: now,
          cliVersion: '0.161.0',
          source: 'cli',
          threadSource: 'user',
          ephemeral: false,
          status: { type: 'notLoaded' },
          turns: []
        })
      )
      await expect.poll(() => restoreOffered(page, 'ws-a'), { timeout: 15_000 }).toBe(true)
      fs.unlinkSync(rollout)
      await expect.poll(() => restoreOffered(page, 'ws-a'), { timeout: 15_000 }).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })
})
