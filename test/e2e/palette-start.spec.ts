import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  agyCalls,
  installAgy,
  installCodex,
  installFakeGh,
  installMuse,
  setGithubFixture,
  type E2EEnv
} from './helpers/env'
import {
  butlerHelperRows,
  butlerRow,
  gitInit,
  readAllCalls,
  sendShortcut,
  setNextSessionTitle,
  settingsOnDisk,
  startSessionIn,
  terminalText,
  waitBooted,
  waitForAllCalls,
  wsRows,
  type ClaudeCall
} from './helpers/p1'
import { answerFileDialog } from './helpers/workbench'
import { setupGitFixture } from './helpers/gitFixture'
import { messagingOf } from '../../src/shared/sessionBackend'
import {
  installFakeRemote,
  killFakeRemote,
  machineHome,
  REMOTE_HOST,
  remoteDir,
  seedRemoteWorkspace
} from './helpers/remote'

test.afterEach(({ env }) => killFakeRemote(env))

const PROMPT = 'Fold the session search into the command palette'
const BUSY_ROW = /\bst-(working|approval)\b/

const palette = (page: Page): Locator => page.locator('.modal.palette')
const askBox = (page: Page): Locator => palette(page).getByRole('textbox', { name: 'Ask or jump' })

function assistAnswers(env: E2EEnv, answer: object | string, waitMs?: number): void {
  fs.writeFileSync(
    path.join(env.home, 'fake-claude-assist-reply'),
    typeof answer === 'string' ? answer : JSON.stringify(answer)
  )
  const wait = path.join(env.home, 'fake-claude-assist-ms')
  if (waitMs) fs.writeFileSync(wait, String(waitMs))
  else fs.rmSync(wait, { force: true })
}

function assistWasAsked(env: E2EEnv): string {
  const f = path.join(env.home, 'fake-claude-assist-asked.txt')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
}

async function ask(app: ElectronApplication, page: Page, text: string): Promise<void> {
  await sendShortcut(app, 'shortcut:command-palette')
  await expect(askBox(page)).toBeFocused()
  await askBox(page).fill(text)
}

function textAfterDashes(call: ClaudeCall): string {
  return call.argv[call.argv.indexOf('--') + 1] ?? ''
}

function nameOf(call: ClaudeCall): string | undefined {
  const i = call.argv.indexOf('--name')
  return i >= 0 ? call.argv[i + 1] : undefined
}

// PLATFORM§28
const REGISTRATION_SWEPT_BEFORE_THE_FIRST_HOOK_MS = 2000

function peerLines(env: E2EEnv): string {
  const f = path.join(env.home, 'fake-claude-peer.jsonl')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
}

function butlerFolder(env: E2EEnv): string {
  return path.join(env.userData, 'conductors', 'global')
}

function codexWireText(env: E2EEnv): string {
  const f = path.join(env.home, 'fake-codex-wire.jsonl')
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : ''
}

function codexCalls(env: E2EEnv): { argv: string[]; cwd: string }[] {
  const file = path.join(env.home, 'fake-codex-calls.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
}

test.describe('starting work from ⌘P: Koloft Assist picks the workspace, worktree and title, and ⏎ or ⌘⏎ starts the session straight away', () => {
  test('local Claude: ⏎ on a request sends folder names only and starts Claude at once in the new worktree, with the title and first prompt, no dialog in between', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    assistAnswers(env, {
      workspace: 1,
      worktree: { new: 'palette-search' },
      title: 'Palette search',
      sure: true,
      why: 'The palette lives in ws-a.'
    })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ask(app, page, PROMPT)
      await page.keyboard.press('Enter')

      const [call] = await waitForAllCalls(env, 1, 30_000)
      await expect(palette(page)).toHaveCount(0)
      await expect(page.locator('.modal')).toHaveCount(0)
      expect(call.argv.join(' ')).toContain('-w palette-search')
      expect(nameOf(call)).toBe('Palette search')
      expect(textAfterDashes(call)).toBe(PROMPT)
      const asked = assistWasAsked(env)
      expect(asked).toContain('| ws-a |')
      expect(asked).toContain(PROMPT)
      expect(asked).not.toContain(env.home)
    } finally {
      await quitAndClose(app)
    }
  })

  test('local Codex: ⌘⏎ starts the other method — Codex in a folder that is not git, with the first prompt and no --name flag', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installCodex(env)
    assistAnswers(env, { workspace: 2, worktree: 'main', title: 'Bravo work', why: 'ws-b.' })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ask(app, page, PROMPT)
      await expect(palette(page).getByRole('button', { name: 'Pick an agent' })).toBeVisible()
      await page.keyboard.press('Meta+Enter')

      await expect.poll(() => codexCalls(env).length, { timeout: 40_000 }).toBe(1)
      await expect(page.locator('.modal')).toHaveCount(0)
      const [call] = codexCalls(env)
      expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(env.workspaces.b))
      expect(call.argv).not.toContain('--name')
      expect(call.argv[call.argv.length - 1]).toBe(PROMPT)
      expect(readAllCalls(env)).toHaveLength(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('@ names the workspace: typing @ offers the workspaces with the first one picked, Esc puts the offer away and leaves the words, ↓ and ⏎ fill a name in, ⇧⏎ breaks the line, and ⏎ starts there at once without the @ word — past the picker with Assist off, and with Assist on without asking it; once one workspace is named a second @ offers none, two workspaces keep Start off, and one named twice does not', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await page.evaluate(() =>
        window.api.settings.set({ assist: { on: false, backend: 'claude' } })
      )
      await ask(app, page, 'fix the footer ')
      await page.keyboard.type('@ws')
      const suggested = palette(page).getByRole('group', { name: 'Workspaces' })
      await expect(suggested.locator('.cb-row.hot')).toContainText('ws-a')
      await page.keyboard.press('Escape')
      await expect(suggested).toHaveCount(0)
      await expect(askBox(page)).toHaveValue('fix the footer @ws')
      await askBox(page).fill('fix the footer ')
      await page.keyboard.type('@ws')
      await expect(suggested.locator('.cb-row.hot')).toContainText('ws-a')
      await expect(palette(page).getByRole('group', { name: 'Sessions' })).toHaveCount(0)
      await page.keyboard.press('ArrowDown')
      await expect(suggested.locator('.cb-row.hot')).toContainText('ws-b')
      await page.keyboard.press('Enter')
      await expect(askBox(page)).toHaveValue('fix the footer @ws-b ')
      await expect(suggested).toHaveCount(0)
      await page.keyboard.press('Shift+Enter')
      await page.keyboard.type('and the header')
      await expect(askBox(page)).toHaveValue('fix the footer @ws-b \nand the header')
      await page.keyboard.press('Enter')

      const [call] = await waitForAllCalls(env, 1, 30_000)
      expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(env.workspaces.b))
      expect(textAfterDashes(call)).toBe('fix the footer\nand the header')
      await expect(page.locator('.modal')).toHaveCount(0)
      expect(assistWasAsked(env)).toBe('')

      await page.evaluate(() =>
        window.api.settings.set({ assist: { on: true, backend: 'claude' } })
      )
      assistAnswers(env, { hand: 'koloft', title: 'Readme', why: 'rule 8' })
      await ask(app, page, '@ws-a tidy the readme, and ')
      await page.keyboard.type('@ws')
      await expect(askBox(page)).toHaveValue('@ws-a tidy the readme, and @ws')
      await expect(palette(page).getByRole('group', { name: 'Workspaces' })).toHaveCount(0)
      await page.keyboard.type('-b too')
      await expect(palette(page).locator('.pal-tips')).toHaveText('Name one workspace · Esc')
      await expect(palette(page).locator('.pal-pill', { hasText: 'Start' })).toBeDisabled()
      await page.keyboard.press('Enter')
      await expect(askBox(page)).toHaveValue('@ws-a tidy the readme, and @ws-b too')

      await askBox(page).fill('@ws-a tidy the readme, as @ws-a does')
      await page.keyboard.press('Enter')
      const calls = await waitForAllCalls(env, 2, 30_000)
      expect(fs.realpathSync(calls[1].cwd)).toBe(fs.realpathSync(env.workspaces.a))
      expect(textAfterDashes(calls[1])).toBe('tidy the readme, as @ws-a does')
      expect(assistWasAsked(env)).toBe('')
      expect(readAllCalls(env)).toHaveLength(2)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a git workspace never starts in its main checkout: when Assist answers main, or the picker is used with Assist off, the session starts in a fresh worktree of its own', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const fresh = /-w (session-\d{6}-\d{4}(?:-\d+)?) /

      assistAnswers(env, { workspace: 1, worktree: 'main', title: 'Look', sure: true })
      await ask(app, page, 'look at the build')
      await page.keyboard.press('Enter')
      const [atOnce] = await waitForAllCalls(env, 1, 30_000)
      expect(fs.realpathSync(atOnce.cwd)).toBe(fs.realpathSync(env.workspaces.a))
      const first = atOnce.argv.join(' ').match(fresh)?.[1]
      expect(first).toBeDefined()

      const picker = page.getByRole('dialog', { name: 'New Session in…' })
      await page.evaluate(() =>
        window.api.settings.set({ assist: { on: false, backend: 'claude' } })
      )
      await ask(app, page, 'read the readme')
      await page.keyboard.press('Enter')
      await picker.locator('.cb-row', { hasText: 'ws-a' }).click()
      const calls = await waitForAllCalls(env, 2, 30_000)
      const second = calls[1].argv.join(' ').match(fresh)?.[1]
      expect(second).toBeDefined()
      expect(second).not.toBe(first)
    } finally {
      await quitAndClose(app)
    }
  })

  test('an issue Assist names starts in a new worktree named for it, and the first prompt carries the issue first, then a blank line, then what was typed; the same issue again never reuses that worktree, it starts in issue-218-2', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    setGithubFixture(env, { [env.workspaces.a]: { owner: 'acme', repo: 'app' } })
    installFakeGh(env, {
      issues: [
        {
          number: 218,
          title: 'Start a session from an issue',
          url: 'https://github.com/acme/app/issues/218',
          updatedAt: '2026-10-09T00:00:00Z'
        }
      ],
      prs: []
    })
    assistAnswers(env, { workspace: 1, worktree: { issue: 218 }, title: 'Issue 218', why: '#218' })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ask(app, page, 'handle #218 and add a test')
      await page.keyboard.press('Enter')

      const [call] = await waitForAllCalls(env, 1, 30_000)
      expect(call.argv.join(' ')).toContain('-w issue-218')
      expect(nameOf(call)).toBe('Issue 218')
      const sent = textAfterDashes(call)
      expect(sent.split('\n').slice(0, 2)).toEqual([
        '#218 Start a session from an issue',
        'https://github.com/acme/app/issues/218'
      ])
      expect(sent.endsWith('--comments), then work on it.\n\nhandle #218 and add a test')).toBe(
        true
      )

      const made = path.join(env.workspaces.a, '.claude', 'worktrees', 'issue-218')
      await expect.poll(() => fs.existsSync(made), { timeout: 30_000 }).toBe(true)
      await ask(app, page, 'more on #218')
      await page.keyboard.press('Enter')
      const calls = await waitForAllCalls(env, 2, 30_000)
      expect(calls[1].argv.join(' ')).toContain('-w issue-218-2 ')
    } finally {
      await quitAndClose(app)
    }
  })

  test('⏎ asks AI even when a name matches, since no row is picked until ↓; Esc while it thinks keeps the words; an answer it cannot use hands the words to a helper of the butler’s on the agent the owner picked, not on the butler’s own, and with Assist off the workspace picker opens and the session starts on the pick', async ({
    env
  }) => {
    test.setTimeout(240_000)
    installAgy(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)

      assistAnswers(env, { workspace: 2, worktree: 'main' }, 20_000)
      await ask(app, page, 'ws-b')
      await expect(palette(page).locator('.cb-row')).not.toHaveCount(0)
      await expect(palette(page).locator('.cb-row.hot')).toHaveCount(0)
      await page.keyboard.press('Enter')
      await expect(palette(page).locator('.fresh-line.busy')).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(palette(page).locator('.fresh-line.busy')).toHaveCount(0)
      await expect(askBox(page)).toHaveValue('ws-b')
      await page.keyboard.press('Escape')
      await expect(palette(page)).toHaveCount(0)

      const picker = page.getByRole('dialog', { name: 'New Session in…' })
      assistAnswers(env, 'not an answer')
      await ask(app, page, 'fix the build')
      await page.keyboard.press('Meta+Enter')
      const [butler] = await waitForAllCalls(env, 1, 30_000)
      expect(butler.cwd).toBe(butlerFolder(env))
      expect(textAfterDashes(butler)).not.toContain('fix the build')
      const helper = butlerHelperRows(page)
      await expect(helper).toHaveCount(1, { timeout: 60_000 })
      await expect(helper).toHaveClass(/\bactive\b/)
      await expect
        .poll(
          () =>
            JSON.stringify(agyCalls(env).filter((c) => c.cwd === butlerFolder(env))).replace(
              /\s+/g,
              ''
            ),
          { timeout: 60_000 }
        )
        .toContain('Theownertypedthisin⌘P:fixthebuild')
      await expect(page.locator('.modal')).toHaveCount(0)

      await page.evaluate(() =>
        window.api.settings.set({ assist: { on: false, backend: 'claude' } })
      )
      await ask(app, page, 'tidy the changelog')
      await page.keyboard.press('Enter')
      await expect(page.locator('.toast')).toContainText('Koloft Assist is off')
      await expect(picker).toBeVisible()
      await page.keyboard.press('Enter')
      const calls = await waitForAllCalls(env, 2)
      expect(textAfterDashes(calls[1])).toBe('tidy the changelog')
      expect(readAllCalls(env)).toHaveLength(2)
    } finally {
      await quitAndClose(app)
    }
  })

  // ADR-0031
  test('what ⌘P cannot do itself always starts a helper of the butler’s, opening the butler first when it is not open, and never reaches the butler: the helper gets the owner’s words, the workspace they were in unless they were on a helper, and the workspace Koloft took it to be about — words about Koloft, "ask <workspace> …" and "set up Discord" alike, with the owner’s words saved as the helper’s and never as the butler’s', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')

      fs.writeFileSync(env.claudeDelayFile, String(REGISTRATION_SWEPT_BEFORE_THE_FIRST_HOOK_MS))
      assistAnswers(env, { hand: 'koloft', title: 'Dark mode', why: 'A Koloft setting.' })
      await ask(app, page, 'turn on dark mode')
      await page.keyboard.press('Enter')
      const [, butler, darkMode] = await waitForAllCalls(env, 3, 60_000)
      expect(butler.cwd).toBe(butlerFolder(env))
      expect(darkMode.cwd).toBe(butlerFolder(env))
      await expect(page.locator('.modal')).toHaveCount(0)
      expect(textAfterDashes(butler)).not.toContain('turn on dark mode')
      expect(textAfterDashes(darkMode)).toMatch(
        /The owner typed this in ⌘P: turn on dark mode \(The owner was in the workspace \S*ws-a at the time\.\) \(The owner picked Claude for it: a session you start for it runs with --backend claude\.\)$/
      )
      const helpers = butlerHelperRows(page)
      await expect(helpers).toHaveCount(1, { timeout: 60_000 })
      await expect(helpers).toHaveClass(/\bactive\b/)
      const helperTab = await helpers.getAttribute('data-tab-id')
      const said = path.join(env.userData, 'hook-sessions', `${helperTab}.said`)
      await expect
        .poll(() => (fs.existsSync(said) ? fs.readFileSync(said, 'utf8').trim() : ''), {
          timeout: 30_000
        })
        .toBe('turn on dark mode')
      const butlerTab = await butlerRow(page).getAttribute('data-tab-id')
      const butlerSaid = path.join(env.userData, 'hook-sessions', `${butlerTab}.said`)
      expect(fs.existsSync(butlerSaid) ? fs.readFileSync(butlerSaid, 'utf8') : '').not.toContain(
        'dark mode'
      )
      fs.rmSync(env.claudeDelayFile, { force: true })

      await ask(app, page, 'and dim the sidebar too')
      await page.keyboard.press('Enter')
      const dim = (await waitForAllCalls(env, 4, 60_000))[3]
      expect(dim.cwd).toBe(butlerFolder(env))
      expect(textAfterDashes(dim)).toContain('The owner typed this in ⌘P: and dim the sidebar too')
      expect(textAfterDashes(dim)).not.toContain('The owner was in')
      expect(textAfterDashes(dim)).not.toContain('turn on dark mode')
      await expect(helpers).toHaveCount(2, { timeout: 60_000 })

      assistAnswers(env, { hand: 'assist', workspace: 2, title: 'Ask ws-b' })
      await ask(app, page, 'ask ws-b about the release')
      await page.keyboard.press('Enter')
      const release = (await waitForAllCalls(env, 5, 60_000))[4]
      expect(release.cwd).toBe(butlerFolder(env))
      expect(textAfterDashes(release)).toContain(
        'The owner typed this in ⌘P: ask ws-b about the release'
      )
      expect(textAfterDashes(release)).toMatch(
        /Koloft took this to be about the workspace [^"]*ws-b\./
      )

      assistAnswers(env, { hand: 'discord', title: 'Discord' })
      await ask(app, page, 'set up Discord')
      await page.keyboard.press('Enter')
      const discord = (await waitForAllCalls(env, 6, 60_000))[5]
      expect(discord.cwd).toBe(butlerFolder(env))
      expect(textAfterDashes(discord)).toContain(
        'The owner asked: set up Discord (Koloft: run koloft discord setup'
      )
      await expect(helpers).toHaveCount(4, { timeout: 60_000 })
      expect(peerLines(env)).not.toMatch(/The owner (typed this in ⌘P|asked)/)
      expect(readAllCalls(env)).toHaveLength(6)
    } finally {
      await quitAndClose(app)
    }
  })

  const keepsBusy: Record<
    'claude' | 'codex' | 'muse' | 'agy',
    { install: (env: E2EEnv) => void; busy: string }
  > = {
    claude: { install: () => {}, busy: '/busy' },
    codex: { install: installCodex, busy: 'hold this turn open' },
    muse: { install: installMuse, busy: '/approve' },
    agy: { install: installAgy, busy: '/busy' }
  }

  for (const backend of ['claude', 'codex', 'muse', 'agy'] as const) {
    const { install, busy } = keepsBusy[backend]
    test(`a ${backend} butler: what ⌘P cannot do opens the butler when it is closed, on Koloft's note that a helper has it, and starts in a helper of the butler's, under its row, which the screen moves to; while the butler is busy the next one starts in a second helper`, async ({
      env
    }) => {
      test.setTimeout(180_000)
      install(env)
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await page.evaluate(
          (b) =>
            window.api.settings.set({
              assist: { on: true, backend: b },
              sessionMethods: {
                defaultBackend: b,
                enabled: { claude: true, codex: true, muse: true, agy: true }
              }
            }),
          backend
        )
        const helpers = butlerHelperRows(page)
        const sent = async (tab: string): Promise<string> =>
          (
            JSON.stringify([readAllCalls(env), codexCalls(env)]) +
            codexWireText(env) +
            (await terminalText(page, tab))
          ).replace(/\s+/g, '')
        await ask(app, page, 'turn on dark mode')
        await page.keyboard.press('Enter')
        await expect(helpers).toHaveCount(1, { timeout: 60_000 })
        await expect(helpers).toHaveClass(/\bactive\b/)
        const first = (await helpers.getAttribute('data-tab-id')) ?? ''
        await expect
          .poll(() => sent(first), { timeout: 60_000 })
          .toContain('Theownertypedthisin⌘P:turnondarkmode')
        const butlerTab = (await butlerRow(page).getAttribute('data-tab-id')) ?? ''
        if (messagingOf(backend, false) === 'typed')
          await expect
            .poll(() => sent(butlerTab), { timeout: 60_000 })
            .toContain('(Fromthesession"Theownertypedthisin⌘P:turnondark')
        await expect(butlerRow(page)).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
        await page.evaluate(
          ([id, line]) => window.api.terminal.write(id, line + '\r'),
          [butlerTab, busy]
        )
        await expect(butlerRow(page)).toHaveClass(BUSY_ROW, { timeout: 30_000 })

        await ask(app, page, 'and dim the sidebar too')
        await page.keyboard.press('Enter')
        await expect(helpers).toHaveCount(2, { timeout: 60_000 })
        const second = helpers.and(page.locator('.active'))
        await expect(second).toHaveCount(1)
        const secondTab = (await second.getAttribute('data-tab-id')) ?? ''
        expect([first, butlerTab]).not.toContain(secondTab)
        await expect
          .poll(() => sent(secondTab), { timeout: 60_000 })
          .toContain('Theownertypedthisin⌘P:anddimthesidebartoo')
        await expect(butlerRow(page)).toHaveClass(BUSY_ROW)
        expect(await sent(butlerTab)).toContain(
          '(FromKoloft:theowneraskedforsomething,andKolofthandsittoahelperofyours'
        )
      } finally {
        await quitAndClose(app)
      }
    })
  }

  test('the AI can name a Koloft feature, which opens at once on its own Settings page, or one existing session, which ⌘P jumps to without starting anything', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)

      assistAnswers(env, { hand: 'feature', feature: 'settings-shortcuts', title: 'Keys' })
      await ask(app, page, '我想改快捷键')
      await page.keyboard.press('Enter')
      const settings = page.getByRole('dialog', { name: 'Settings' })
      await expect(settings.getByRole('tab', { selected: true })).toHaveText('Shortcuts', {
        timeout: 30_000
      })
      await page.keyboard.press('Escape')
      await expect(settings).toHaveCount(0)
      expect(readAllCalls(env)).toHaveLength(0)

      setNextSessionTitle(env, 'Alpha jump target')
      await startSessionIn(page, 'ws-a')
      await expect(wsRows(page, 'ws-a')).toContainText('Alpha jump target')
      await startSessionIn(page, 'ws-b')
      await expect(wsRows(page, 'ws-b')).toHaveClass(/\bactive\b/)
      assistAnswers(env, { hand: 'session', session: '1.1', title: 'Alpha' })
      await ask(app, page, 'take me to the alpha work')
      await page.keyboard.press('Enter')
      await expect(wsRows(page, 'ws-a')).toHaveClass(/\bactive\b/, { timeout: 30_000 })
      expect(assistWasAsked(env)).toContain('[1.1] Alpha jump target')
      expect(readAllCalls(env)).toHaveLength(2)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a new worktree off a main checkout that is behind origin goes through Pull & Start first, then starts in that worktree with the prompt', async ({
    env
  }) => {
    test.setTimeout(180_000)
    setupGitFixture(env).originAhead(2)
    assistAnswers(env, { workspace: 1, worktree: { new: 'catch-up' }, title: 'Catch up' })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect(page.locator('.ws-behind')).toHaveText('2', { timeout: 30_000 })
      await ask(app, page, 'catch up with main')
      await page.keyboard.press('Enter')

      const gate = page.getByRole('dialog', { name: 'New Session in…' })
      await expect(gate.locator('.modal-foot')).toContainText('Pull & Start', { timeout: 30_000 })
      await page.keyboard.press('Enter')
      await expect(page.locator('.toast')).toHaveText(/fast-forwarded 2 commits/, {
        timeout: 30_000
      })
      const [call] = await waitForAllCalls(env, 1)
      expect(call.argv.join(' ')).toContain('-w catch-up')
      expect(nameOf(call)).toBe('Catch up')
      expect(textAfterDashes(call)).toBe('catch up with main')
    } finally {
      await quitAndClose(app)
    }
  })

  test('local new project: Assist gives only a name, the folder is picked once in the New Project dialog and remembered, after which a new project starts at once, its name counting up rather than reuse a folder', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(env.home, 'projects-')))
    assistAnswers(env, { workspace: null, machine: 'local', newFolder: 'ledger', title: 'Ledger' })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ask(app, page, 'start a new bookkeeping site')
      await page.keyboard.press('Enter')

      const dlg = page.getByRole('dialog', { name: 'New Project' })
      await expect(dlg).toBeVisible({ timeout: 30_000 })
      await expect(dlg.getByRole('textbox', { name: 'Folder name' })).toHaveValue('ledger')
      await expect(dlg.getByRole('textbox', { name: 'In' })).toHaveValue('')
      await expect(dlg.locator('.modal-foot .btn-primary')).toBeDisabled()
      answerFileDialog(env, parent)
      await dlg.getByRole('button', { name: 'Choose folder…' }).click()
      await expect(dlg.locator('.modal-foot .btn-primary')).toBeEnabled()
      await dlg.getByRole('textbox', { name: 'Folder name' }).press('Enter')
      await expect(dlg).toHaveCount(0)

      const [call] = await waitForAllCalls(env, 1)
      expect(fs.realpathSync(call.cwd)).toBe(path.join(parent, 'ledger'))
      expect(textAfterDashes(call)).toBe('start a new bookkeeping site')
      await expect(wsRows(page, 'ledger')).toHaveCount(1, { timeout: 30_000 })
      await expect
        .poll(() => (settingsOnDisk(env).newProjectFolders as Record<string, string>)?.local)
        .toBe(parent)

      await ask(app, page, 'another bookkeeping site')
      await page.keyboard.press('Enter')
      const calls = await waitForAllCalls(env, 2, 30_000)
      await expect(dlg).toHaveCount(0)
      expect(fs.realpathSync(calls[1].cwd)).toBe(path.join(parent, 'ledger-2'))
      expect(textAfterDashes(calls[1])).toBe('another bookkeeping site')
      await expect(wsRows(page, 'ledger-2')).toHaveCount(1, { timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test.describe('remote', () => {
    test('remote Claude: @ offers the ssh workspace by host:name, and the work starts on that machine with Assist on, without asking it', async ({
      env
    }) => {
      test.setTimeout(300_000)
      installFakeRemote(env)
      seedRemoteWorkspace(env)
      assistAnswers(env, { hand: 'koloft', title: 'Logs', why: 'rule 8' })
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await ask(app, page, `@${REMOTE_HOST}`)
        const suggested = palette(page).getByRole('group', { name: 'Workspaces' })
        await expect(suggested.locator('.cb-row')).toHaveCount(1)
        await page.keyboard.press('Tab')
        await expect(askBox(page)).toHaveValue(new RegExp(`^@${REMOTE_HOST}:\\S+ $`))
        await page.keyboard.type('read the logs')
        await page.keyboard.press('Enter')
        const [onRemote] = await waitForAllCalls(env, 1, 90_000)
        expect(onRemote.cwd).toBe(remoteDir(env))
        expect(textAfterDashes(onRemote)).toBe('read the logs')
        expect(assistWasAsked(env)).toBe('')
      } finally {
        await quitAndClose(app)
      }
    })

    test('remote Claude: a request starts at once in the ssh workspace with its title and first prompt, and a new project is made on the machine, added, and started there', async ({
      env
    }) => {
      test.setTimeout(300_000)
      installFakeRemote(env)
      seedRemoteWorkspace(env)
      const remoteParent = path.join(machineHome(env), 'projects')
      fs.mkdirSync(remoteParent, { recursive: true })
      assistAnswers(env, { workspace: 3, worktree: 'main', title: 'Deploy check', why: 'proj' })
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await ask(app, page, 'check the deploy script')
        await page.keyboard.press('Enter')
        const [onRemote] = await waitForAllCalls(env, 1, 90_000)
        expect(onRemote.cwd).toBe(remoteDir(env))
        expect(textAfterDashes(onRemote)).toBe('check the deploy script')
        expect(nameOf(onRemote)).toBe('Deploy check')

        assistAnswers(env, { workspace: null, machine: REMOTE_HOST, newFolder: 'crawler' })
        await ask(app, page, `on ${REMOTE_HOST}, a new price crawler`)
        await page.keyboard.press('Enter')
        const made = page.getByRole('dialog', { name: 'New Project' })
        await expect(made.locator('.ws-remote')).toHaveText(REMOTE_HOST, { timeout: 30_000 })
        await made.getByRole('textbox', { name: 'In' }).fill(remoteParent)
        await made.getByRole('textbox', { name: 'In' }).press('Enter')
        await expect(made).toHaveCount(0)

        const calls = await waitForAllCalls(env, 2, 90_000)
        expect(calls[1].cwd).toBe(path.join(remoteParent, 'crawler'))
        expect(fs.statSync(path.join(remoteParent, 'crawler')).isDirectory()).toBe(true)
        await expect(wsRows(page, 'crawler')).toHaveCount(1, { timeout: 60_000 })
      } finally {
        await quitAndClose(app)
      }
    })
  })
})
