import fs from 'fs'
import path from 'path'
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  E2E_AGY_ACCOUNT,
  UNPACKAGED_BUILD_AGY_SVC,
  agyCalls,
  installAgy,
  ownersGemini,
  seedSettings,
  trustInAgy,
  type AgyCall,
  type E2EEnv
} from './helpers/env'
import {
  agentRow,
  centerTerm,
  gitCommitAll,
  gitInit,
  newSessionInWith,
  openMenu,
  processAlive,
  readCalls,
  runIn,
  sendShortcut,
  waitBooted,
  waitConductorStarted,
  wsGroup,
  wsRows
} from './helpers/p1'
import { startFakeDiscord, type FakeDiscord, type FakePost } from './helpers/fakeDiscord'
import { WORKBENCH, workbenchIcon, workbenchPanel } from './helpers/workbench'

test.setTimeout(120_000)

const FAKE_AGY = path.join(__dirname, 'fixtures', 'fake-agy.js')
const TURN_LONG_ENOUGH_TO_SEE_WORKING_MS = '1500'
const COMPACTION_LONGER_THAN_THE_HALF_SECOND_BEFORE_IT_SHOWS_MS = '3000'
const OWNER = { id: '555', username: 'letian' }
const CHANNEL = '222'
const CONDUCTOR_STARTS_AND_ANSWERS_MS = 60_000

const accountHome = (env: E2EEnv): string => path.join(env.userData, 'agy-homes', E2E_AGY_ACCOUNT)
const ownersApp = (env: E2EEnv): string => path.join(ownersGemini(env), 'antigravity-cli')

function agyRows(page: Page): Locator {
  return wsRows(page, 'ws-a').filter({
    hasNot: page.getByRole('img', { name: 'Claude', exact: true })
  })
}

function fileLines(file: string): Record<string, unknown>[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const sessionCalls = (env: E2EEnv): AgyCall[] =>
  agyCalls(env).filter((c) => c.argv[0]?.startsWith('--gemini_dir=') && !c.argv.includes('-p'))

const apiCalls = (env: E2EEnv): Record<string, unknown>[] =>
  fileLines(path.join(env.home, 'fake-agy-api.jsonl'))
const injected = (env: E2EEnv): Record<string, unknown>[] =>
  fileLines(path.join(env.home, 'fake-agy-injected.jsonl'))

function transcriptOf(env: E2EEnv, conversationId: string): string {
  const file = path.join(
    ownersApp(env),
    'brain',
    conversationId,
    '.system_generated',
    'logs',
    'transcript.jsonl'
  )
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

async function startAgy(page: Page, env: E2EEnv): Promise<AgyCall> {
  const before = sessionCalls(env).length
  await newSessionInWith(page, 'ws-a', 'Antigravity')
  await expect.poll(() => sessionCalls(env).length).toBe(before + 1)
  return sessionCalls(env)[before]
}

async function boundAgy(page: Page): Promise<{ tabId: string; id: string }> {
  let found: { tabId: string; id: string } | undefined
  await expect
    .poll(
      async () => {
        const all = await page.evaluate(() => window.api.sessions.list())
        const s = all.find((x) => x.backendId === 'agy' && x.alive && x.nativeSessionId)
        found = s && { tabId: s.tabId, id: s.nativeSessionId! }
        return !!found
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  return found!
}

function lockHolders(lock: string): string {
  try {
    return execFileSync('lsof', ['-t', lock]).toString().trim()
  } catch {
    return ''
  }
}

function seedConductor(env: E2EEnv): void {
  seedSettings(env, {
    hintsOff: true,
    assist: { on: true, backend: 'claude' },
    discord: {
      userId: OWNER.id,
      userName: OWNER.username,
      bindings: [
        {
          id: 'b1',
          scope: env.workspaces.a,
          backend: 'claude',
          channel: { guildId: '111', channelId: CHANNEL, name: 'koloft-all' },
          sessionIds: [],
          touched: []
        }
      ]
    }
  })
}

function threadPosts(fake: FakeDiscord): FakePost[] {
  const ids = fake.threads.filter((t) => t.parentId === CHANNEL).map((t) => t.id)
  return fake.posted.filter((p) => ids.includes(p.channelId))
}

async function connected(
  env: E2EEnv,
  fake: FakeDiscord
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  await expect.poll(() => fake.identifies).toBe(1)
  await waitConductorStarted(env, CONDUCTOR_STARTS_AND_ANSWERS_MS)
  return { app, page }
}

async function showChanges(page: Page): Promise<void> {
  const panel = workbenchPanel(page)
  if (!(await panel.isVisible())) {
    await workbenchIcon(page).click()
    await expect(panel).toBeVisible({ timeout: 20_000 })
  }
  const pinned = page.locator(WORKBENCH.tabFiles)
  if (!(await pinned.getAttribute('class'))?.split(/\s+/).includes('on')) await pinned.click()
  const changes = page
    .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
    .filter({ hasText: 'Changes' })
  await expect(changes).toBeVisible({ timeout: 20_000 })
  if ((await changes.getAttribute('aria-pressed')) !== 'true') await changes.click()
}

function shownPaths(page: Page): Promise<string[]> {
  return page
    .locator('.wb-panel .cv-row')
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.path ?? ''))
}

async function onlyThisSessionsFiles(page: Page): Promise<void> {
  const menu = page.locator('.wb-bar .fv-menu')
  await page.locator('.wb-bar .seg button', { hasText: 'Filter' }).click()
  await expect(menu).toBeVisible()
  const chip = page.locator(
    '.fv-filters .fv-fgroup[aria-label="Ownership"] .ft-chip[data-chip="session"]'
  )
  await chip.click()
  await expect(chip).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
}

test.describe('Antigravity CLI sessions through the real agent chooser, OSC 7501 status, title script, hooks and local API, with only the CLI faked', () => {
  // AGY§1 AGY§7
  test("an Antigravity session picked from the split button's agent list runs agy on the account's own folder with Koloft's API token, the first prompt as -i, the per-folder sign-in switch and the Gemini key; the tab binds to agy's conversation, its row takes agy's title, and its light goes working then done", async ({
    env
  }) => {
    const PROMPT = 'Tidy the agy readme'
    installAgy(env)
    trustInAgy(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true, assist: { on: true, backend: 'claude' } })
    fs.writeFileSync(
      path.join(env.home, 'fake-claude-assist-reply'),
      JSON.stringify({ workspace: 1, worktree: 'main', title: 'Agy readme', why: 'ws-a.' })
    )
    fs.writeFileSync(path.join(env.home, 'fake-agy-delay'), TURN_LONG_ENOUGH_TO_SEE_WORKING_MS)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await sendShortcut(app, 'shortcut:command-palette')
      const palette = page.locator('.modal.palette')
      const askBox = palette.getByRole('textbox', { name: 'Ask or jump' })
      await expect(askBox).toBeFocused()
      await askBox.fill(PROMPT)
      await palette.getByRole('button', { name: 'Pick an agent' }).click()
      await agentRow(page, 'Antigravity').click()

      await expect.poll(() => sessionCalls(env).length, { timeout: 40_000 }).toBe(1)
      const [call] = sessionCalls(env)
      expect(fs.realpathSync(call.cwd)).toBe(env.workspaces.a)
      expect(call.argv[0]).toBe(`--gemini_dir=${accountHome(env)}`)
      expect(call.argv[1]).toMatch(/^--csrf_token=[0-9a-f]{48}$/)
      expect(call.argv.slice(2)).toEqual(['-i', PROMPT])
      expect(call.env.WSL_INTEROP).toBe('koloft')
      expect(call.env.GEMINI_API_KEY).toBe(true)
      expect(readCalls(env)).toHaveLength(0)

      const row = agyRows(page)
      await expect(row).toHaveClass(/st-working/, { timeout: 30_000 })
      await expect(row).toHaveClass(/st-waiting/, { timeout: 30_000 })
      await expect(row).toContainText(PROMPT, { timeout: 30_000 })
      const { id } = await boundAgy(page)
      expect(transcriptOf(env, id)).toContain(`Answer to: ${PROMPT}`)
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§4 AGY§11 AGY§12
  test("the account's folder links the owner's ~/.gemini conversations, brain, annotations, presence, summaries and config files, holds Koloft's koloft hook entry and title command, and Koloft's guide and the reply-language reminder quoting the prompt reach the model", async ({
    env
  }) => {
    installAgy(env)
    trustInAgy(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startAgy(page, env)
      await runIn(page, centerTerm(page), 'first words here')
      await expect(agyRows(page)).toContainText('first words here', { timeout: 30_000 })
      await expect(agyRows(page)).toHaveClass(/st-waiting/)
      await runIn(page, centerTerm(page), 'second words here')
      await expect
        .poll(() => injected(env).filter((r) => r.event === 'request').length, { timeout: 30_000 })
        .toBe(2)

      const home = accountHome(env)
      for (const shared of [
        'antigravity-cli/conversations',
        'antigravity-cli/brain',
        'antigravity-cli/annotations',
        'antigravity-cli/presence',
        'antigravity-cli/conversation_summaries.db',
        'config/projects',
        'config/GEMINI.md',
        'config/config.json',
        'GEMINI.md'
      ]) {
        const own = path.join(home, shared)
        expect(fs.lstatSync(own).isSymbolicLink(), shared).toBe(true)
        expect(fs.readlinkSync(own), shared).toBe(path.join(ownersGemini(env), shared))
      }
      const hooks = JSON.parse(
        fs.readFileSync(path.join(home, 'config', 'hooks.json'), 'utf8')
      ) as Record<string, Record<string, unknown>>
      expect(Object.keys(hooks.koloft).sort()).toEqual([
        'PostToolUse',
        'PreInvocation',
        'PreToolUse',
        'SessionStart',
        'Stop'
      ])
      expect(JSON.stringify(hooks.koloft.SessionStart)).toContain('koloft-agy-hook')
      const settings = JSON.parse(
        fs.readFileSync(path.join(home, 'antigravity-cli', 'settings.json'), 'utf8')
      ) as { title: { command: string }; modelProvider: string; trustedWorkspaces: string[] }
      expect(settings.title.command).toContain('koloft-agy-title')
      expect(settings.modelProvider).toBe('gemini')
      expect(settings.trustedWorkspaces).toContain(env.workspaces.a)

      const starts = injected(env).filter((r) => r.event === 'SessionStart')
      expect(starts).toHaveLength(1)
      expect(String(starts[0].systemMessage)).toContain('koloft help')
      const reminders = injected(env)
        .filter((r) => r.event === 'request')
        .flatMap((r) => r.ephemeralMessages as string[])
      expect(reminders.some((m) => m.includes('second words here'))).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§9
  test('/clear keeps the tab and moves it to the new conversation; the cleared one leaves the list for Restore session, which resumes it with --conversation', async ({
    env
  }) => {
    installAgy(env)
    trustInAgy(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const first = await startAgy(page, env)
      await runIn(page, centerTerm(page), 'first topic')
      await expect(agyRows(page).filter({ hasText: 'first topic' })).toHaveClass(/st-waiting/, {
        timeout: 30_000
      })
      const old = await boundAgy(page)
      await runIn(page, centerTerm(page), '/clear')
      await runIn(page, centerTerm(page), 'second topic')
      await expect(agyRows(page).filter({ hasText: 'second topic' })).toHaveClass(/st-waiting/, {
        timeout: 30_000
      })
      await expect(agyRows(page)).toHaveCount(1)
      const now = await boundAgy(page)
      expect(now.tabId).toBe(old.tabId)
      expect(now.id).not.toBe(old.id)
      expect(sessionCalls(env)).toHaveLength(1)
      expect(sessionCalls(env)[0].pid).toBe(first.pid)

      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Restore session' }).click()
      const history = page.getByRole('dialog', { name: 'Restore session · ws-a', exact: true })
      await history.getByRole('button').filter({ hasText: 'first topic' }).click()
      await expect.poll(() => sessionCalls(env).length).toBe(2)
      expect(sessionCalls(env)[1].argv.slice(2)).toEqual([`--conversation=${old.id}`])
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§14 AGY§16
  test('a file agy asks to write shows the row waiting; the conductor answering yes with koloft session answer allows it through the local API, the file is written, and the Changes list shows it as this session’s', async ({
    env
  }) => {
    installAgy(env)
    trustInAgy(env, env.workspaces.a)
    gitInit(env.workspaces.a)
    gitCommitAll(env.workspaces.a)
    seedConductor(env)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      await startAgy(page, env)
      await runIn(page, centerTerm(page), 'warm up')
      await expect(agyRows(page)).toHaveClass(/st-waiting/, { timeout: 30_000 })
      const { tabId, id } = await boundAgy(page)
      await page.evaluate((t) => window.api.terminal.write(t, '/write agy-notes.txt\r'), tabId)
      const target = path.join(env.workspaces.a, 'agy-notes.txt')
      await expect
        .poll(
          () =>
            threadPosts(fake)
              .map((p) => p.content)
              .join('\n\n'),
          {
            timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS
          }
        )
        .toContain(target)
      expect(fs.existsSync(target)).toBe(false)

      fake.say(OWNER, `/koloft session answer ${id} yes`)
      await expect
        .poll(() => (fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''), {
          timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS
        })
        .toBe('written by fake agy\n')
      const answered = apiCalls(env).filter((c) => c.method === 'HandleCascadeUserInteraction')
      expect(answered).toEqual([
        expect.objectContaining({
          authorized: true,
          body: expect.objectContaining({
            cascadeId: id,
            interaction: expect.objectContaining({ permission: { allow: true } })
          })
        })
      ])
      await expect(agyRows(page)).toHaveClass(/st-waiting/, { timeout: 30_000 })

      await agyRows(page).click()
      await showChanges(page)
      await expect.poll(() => shownPaths(page), { timeout: 30_000 }).toContain('agy-notes.txt')
      await onlyThisSessionsFiles(page)
      await expect.poll(() => shownPaths(page), { timeout: 30_000 }).toEqual(['agy-notes.txt'])
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  // AGY§16
  test('a session that agy started with koloft session new reports back with koloft session send: the message reaches agy through its local API, marked with who sent it, and agy answers it', async ({
    env
  }) => {
    installAgy(env)
    trustInAgy(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startAgy(page, env)
      await runIn(page, centerTerm(page), 'plan the work')
      await expect(agyRows(page)).toHaveClass(/st-waiting/, { timeout: 30_000 })
      const parent = await boundAgy(page)

      await page.evaluate(
        (t) => window.api.terminal.write(t, '!koloft session new -- report back when done\r'),
        parent.tabId
      )
      const kidRow = wsGroup(page, 'ws-a').locator(
        `.ws-tab[data-tab-id="${parent.tabId}"] + .ws-subtabs > .ws-tab`
      )
      await expect(kidRow).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const kidTab = (await kidRow.getAttribute('data-tab-id'))!
      await page.evaluate(
        ([tab, line]) => window.api.terminal.write(tab, line + '\r'),
        [kidTab, `!koloft session send ${parent.id} all done`]
      )

      const sent = (): string[] =>
        apiCalls(env)
          .filter((c) => c.method === 'SendUserCascadeMessage')
          .map((c) => JSON.stringify(c.body))
      await expect
        .poll(() => sent().join('\n'), { timeout: 60_000 })
        .toMatch(/\(From the session \\".+\\", id \S+:\) all done/)
      await expect
        .poll(() => transcriptOf(env, parent.id), { timeout: 30_000 })
        .toMatch(/Answer to: \(From the session .+all done/)
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§12 AGY§17
  test('work agy leaves running in the background shows breathing green with ↻ until it ends; /compact shows the row working while agy compacts and ends done, not working', async ({
    env
  }) => {
    installAgy(env)
    trustInAgy(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    fs.writeFileSync(
      path.join(env.home, 'fake-agy-compact-ms'),
      COMPACTION_LONGER_THAN_THE_HALF_SECOND_BEFORE_IT_SHOWS_MS
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startAgy(page, env)
      const row = agyRows(page)
      await runIn(page, centerTerm(page), '/bg sleep 4')
      await expect(row).toHaveClass(/\bst-bg-run\b/, { timeout: 30_000 })
      await expect(row).toHaveClass(/st-waiting/)
      await expect(row).not.toHaveClass(/\bst-bg-run\b/, { timeout: 20_000 })
      await expect(row).toHaveClass(/st-waiting/, { timeout: 20_000 })

      await runIn(page, centerTerm(page), '/compact')
      await expect(row).toHaveClass(/st-working/)
      await expect(row).toHaveClass(/st-waiting/, { timeout: 20_000 })
      const { id } = await boundAgy(page)
      expect(transcriptOf(env, id)).toContain('Resuming from a compaction')
      expect(apiCalls(env).some((c) => c.method === 'StreamAgentStateUpdates')).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§9 AGY§24
  test('a conversation another agy process holds is refused on resume, with the reason that it is open in another agy window', async ({
    env
  }) => {
    installAgy(env)
    trustInAgy(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    let other: ChildProcess | undefined
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const first = await startAgy(page, env)
      await runIn(page, centerTerm(page), 'held elsewhere')
      await expect(agyRows(page)).toHaveClass(/st-waiting/, { timeout: 30_000 })
      const { id } = await boundAgy(page)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect.poll(() => processAlive(first.pid)).toBe(false)
      await expect(agyRows(page)).toHaveClass(/cold/)

      other = spawn(
        process.execPath,
        [FAKE_AGY, `--gemini_dir=${accountHome(env)}`, `--conversation=${id}`],
        {
          cwd: env.workspaces.a,
          env: { ...env.launchEnv, PWD: env.workspaces.a, GEMINI_API_KEY: 'fake-gemini-key' },
          stdio: ['pipe', 'ignore', 'ignore']
        }
      )
      const lock = path.join(ownersApp(env), 'presence', `${id}.lock`)
      await expect.poll(() => lockHolders(lock), { timeout: 20_000 }).toBe(String(other.pid))

      await agyRows(page).click()
      await expect(page.getByText(/open in another agy window/)).toBeVisible({ timeout: 20_000 })
      expect(sessionCalls(env).filter((c) => c.pid !== other!.pid)).toHaveLength(1)
    } finally {
      other?.kill('SIGTERM')
      await quitAndClose(app)
    }
  })

  test('closing the tab ends agy; its row stays, cold, and clicking it brings the same conversation back', async ({
    env
  }) => {
    installAgy(env)
    trustInAgy(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const first = await startAgy(page, env)
      await runIn(page, centerTerm(page), 'keep me')
      await expect(agyRows(page)).toContainText('keep me', { timeout: 30_000 })
      await expect(agyRows(page)).toHaveClass(/st-waiting/)
      const { id } = await boundAgy(page)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect.poll(() => processAlive(first.pid)).toBe(false)
      await expect(agyRows(page)).toHaveClass(/cold/)
      await agyRows(page).click()
      await expect.poll(() => sessionCalls(env).length).toBe(2)
      expect(sessionCalls(env)[1].argv.slice(2)).toEqual([`--conversation=${id}`])
      await expect.poll(async () => (await boundAgy(page)).id).toBe(id)
    } finally {
      await quitAndClose(app)
    }
  })

  test('an Antigravity tab still open when Koloft quits comes back running the same conversation after a restart', async ({
    env
  }) => {
    installAgy(env)
    trustInAgy(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    let app = await launchApp(env)
    try {
      let page = await app.firstWindow()
      await waitBooted(page)
      const first = await startAgy(page, env)
      await runIn(page, centerTerm(page), 'survive a restart')
      await expect(agyRows(page)).toHaveClass(/st-waiting/, { timeout: 30_000 })
      const { id } = await boundAgy(page)
      await quitAndClose(app)
      await expect.poll(() => processAlive(first.pid)).toBe(false)

      app = await launchApp(env)
      page = await app.firstWindow()
      await waitBooted(page)
      await expect.poll(() => sessionCalls(env).length, { timeout: 30_000 }).toBe(2)
      expect(sessionCalls(env)[1].argv.slice(2)).toEqual([`--conversation=${id}`])
      await expect(agyRows(page)).toHaveCount(1)
      await expect(agyRows(page)).toContainText('survive a restart')
      await expect(agyRows(page)).toHaveClass(/st-(waiting|idle)/, { timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§6
  test('Settings ▸ Sessions lists Antigravity as found; Settings ▸ Accounts shows the Antigravity account signed in, and a pasted Gemini API key adds an account kept in the Keychain, UNVERIFIED until agy onboarding is done', async ({
    env
  }) => {
    installAgy(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await sendShortcut(app, 'shortcut:open-settings')
      await page.getByRole('tab', { name: 'Sessions', exact: true }).click()
      const enable = page.getByRole('switch', { name: 'Enable Antigravity', exact: true })
      await expect(enable).toBeChecked()
      await expect(page.locator('.set-row', { has: enable }).locator('.set-lab')).toContainText(
        '1.4.0 · found'
      )

      await page.getByRole('tab', { name: 'Accounts', exact: true }).click()
      const seeded = page.locator('.acct-row', { hasText: E2E_AGY_ACCOUNT })
      await expect(seeded).toContainText('Signed in')
      await page.getByRole('button', { name: 'Paste Gemini API key' }).click()
      await expect(page.locator('.acct-add-title')).toHaveText('Add Gemini API key')
      await page.locator('.acct-add input[type="text"]').fill('second')
      await page.locator('.acct-add input[type="password"]').fill('AIza-second-key')
      await page.locator('.acct-add-actions button', { hasText: 'Verify and save' }).click()
      const added = page.locator('.acct-row', { hasText: 'second' })
      await expect(added).toBeVisible({ timeout: 15_000 })
      await expect(added.locator('.acct-status.unverified')).toHaveText('UNVERIFIED')
      const kc = JSON.parse(fs.readFileSync(env.keychainFile, 'utf8')) as Record<
        string,
        Record<string, string>
      >
      expect(kc[UNPACKAGED_BUILD_AGY_SVC].second).toBe('AIza-second-key')
      const own = JSON.parse(
        fs.readFileSync(
          path.join(env.userData, 'agy-homes', 'second', 'antigravity-cli', 'settings.json'),
          'utf8'
        )
      ) as { modelProvider?: string }
      expect(own.modelProvider).toBe('gemini')
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§3
  test('with no agy on this Mac, Sign in with Google in Settings ▸ Accounts says it installs it first, then one terminal tab runs the official installer and goes straight on to agy on the new account’s own folder', async ({
    env
  }) => {
    env.launchEnv.KOLOFT_AGY_CMD = path.join(env.home, '.local', 'bin', 'agy')
    env.launchEnv.KOLOFT_TEST_TOOL_INSTALLER = path.join(
      __dirname,
      'fixtures',
      'fake-tool-installer.js'
    )
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await sendShortcut(app, 'shortcut:open-settings')
      await page.getByRole('tab', { name: 'Accounts', exact: true }).click()
      await page.getByRole('button', { name: 'Sign in with Google' }).click()
      const dialog = page.locator('.acct-add')
      await dialog.locator('input[type="text"]').fill('fresh')
      await expect(dialog.locator('.field-hint')).toContainText(
        'Antigravity is not on this Mac yet, so the tab installs it first.'
      )
      await dialog.getByRole('button', { name: 'Sign in', exact: true }).click()

      await expect
        .poll(() => agyCalls(env).map((c) => c.geminiDir), { timeout: 30_000 })
        .toContain(path.join(env.userData, 'agy-homes', 'fresh'))
      expect(fs.readFileSync(path.join(env.home, 'fake-tool-installs.txt'), 'utf8')).toBe('agy\n')
    } finally {
      await quitAndClose(app)
    }
  })

  // AGY§20
  test('Assist set to Antigravity routes a ⌘P start with agy -p in a throwaway Gemini folder, which it removes after, and leaves no Antigravity row in the sidebar', async ({
    env
  }) => {
    const PROMPT = 'Fix the flaky login test'
    installAgy(env)
    seedSettings(env, { hintsOff: true, assist: { on: true, backend: 'agy' } })
    fs.writeFileSync(
      path.join(env.home, 'fake-agy-assist-reply'),
      JSON.stringify({ workspace: 1, worktree: 'main', title: 'Flaky login', why: 'ws-a.' })
    )
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await sendShortcut(app, 'shortcut:command-palette')
      const askBox = page.locator('.modal.palette').getByRole('textbox', { name: 'Ask or jump' })
      await expect(askBox).toBeFocused()
      await askBox.fill(PROMPT)
      await page.keyboard.press('Enter')

      await expect.poll(() => readCalls(env).length, { timeout: 40_000 }).toBe(1)
      const shots = path.join(env.userData, 'agy-one-shots')
      const oneShots = agyCalls(env).filter(
        (c) => c.argv.includes('-p') && !c.argv.includes('/usage')
      )
      expect(oneShots.length).toBeGreaterThanOrEqual(1)
      for (const shot of oneShots) {
        expect(shot.argv[0].startsWith(`--gemini_dir=${shots}${path.sep}agy-`)).toBe(true)
        expect(shot.argv.slice(1, 2)).toEqual(['-p'])
        expect(shot.argv.slice(3)).toEqual(['--output-format', 'json'])
        expect(shot.env.GEMINI_API_KEY).toBe(true)
      }
      expect(oneShots.some((c) => c.argv[2].includes(PROMPT))).toBe(true)
      expect(sessionCalls(env)).toHaveLength(0)
      await expect.poll(() => fs.readdirSync(shots)).toEqual([])
      await expect(wsRows(page, 'ws-a')).toHaveCount(1)
      await expect(
        wsRows(page, 'ws-a').getByRole('img', { name: 'Antigravity', exact: true })
      ).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })
})
