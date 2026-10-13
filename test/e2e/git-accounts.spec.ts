import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  GIT_ACCOUNT_KEYCHAIN_SERVICE,
  fakeGhEnvFile,
  installCodex,
  installFakeGh,
  seedGitAccount,
  seedSettings,
  setGithubFixture,
  type E2EEnv
} from './helpers/env'
import { startFakeGithub, type FakeGithub } from './helpers/fakeGithub'
import { openSettings } from './helpers/extensions'
import {
  addWorkspace,
  agentShell,
  gitInit,
  openGitPanel,
  settingsOnDisk,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'

const A_SHELL_STEP_FINISHES_WITHIN_MS = 30_000
const ACCOUNT_SHOWS_WITHIN_MS = 20_000
const FAKE_LOGIN = path.join(__dirname, 'fixtures', 'fake-gh-login.js')
const BOB_TOKEN = 'gho_e2e_bob_token'
const SHORT_WINDOW_HEIGHT = 360
const TERMINAL_LINE_WRAPS = /\n/g

async function withFakeGithub(env: E2EEnv): Promise<FakeGithub> {
  const github = await startFakeGithub()
  env.launchEnv.KOLOFT_GITHUB_URL = github.url
  env.launchEnv.KOLOFT_GITHUB_API_URL = github.url
  env.launchEnv.KOLOFT_TEST_GH_LOGIN = FAKE_LOGIN
  env.launchEnv.KOLOFT_FAKE_GH_LOGIN_HOME = env.home
  seedSettings(env, { gitAutoFetch: false })
  return github
}

function repoOnFakeGithub(env: E2EEnv, dir: string, remote: string, name = 'app'): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.gitignore'), 'NOTES.md\n')
  gitInit(dir)
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir })
  setGithubFixture(env, {
    ...JSON.parse(env.launchEnv.KOLOFT_GITHUB_FIXTURE ?? '{}'),
    [fs.realpathSync(dir)]: { owner: 'acme', repo: name, issues: 1, prs: 0 }
  })
}

function keychainEntry(env: E2EEnv, login: string): string | undefined {
  const all = JSON.parse(fs.readFileSync(env.keychainFile, 'utf8')) as Record<
    string,
    Record<string, string>
  >
  return all[GIT_ACCOUNT_KEYCHAIN_SERVICE]?.[login]
}

function masterConfig(env: E2EEnv): string {
  return fs.readFileSync(path.join(env.userData, 'git-accounts', 'config'), 'utf8')
}

function accountHead(panel: Locator): Locator {
  return panel.locator('.tbu-pop-head', { hasText: 'GitHub' }).locator('.age')
}

function gitAccountRow(page: Page, login: string): Locator {
  return page.locator('.acct-row', { has: page.locator('.acct-name', { hasText: login }) })
}

async function launched(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app, page }
}

async function startAddingGithubAccount(page: Page): Promise<void> {
  await openSettings(page)
  await page.getByRole('button', { name: 'Add account', exact: true }).click()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
}

test.describe('Git accounts · sign in, pick per repository, and git and gh use the pick', () => {
  test('GA-01: signing in shows the one-time code, hands the device page to a sign-in window, and the account lands with its token in the Keychain; gh ran with no token, an empty PATH and its own folder, which is gone afterwards', async ({
    env
  }) => {
    const github = await withFakeGithub(env)
    github.addUser('gho_fake_bob', { login: 'bob', id: 42, name: 'Bob Example' })
    env.launchEnv.GH_TOKEN = 'the-users-own-token'
    env.launchEnv.GITHUB_TOKEN = 'the-users-own-token'
    const { app, page } = await launched(env)
    try {
      await startAddingGithubAccount(page)
      await expect(page.getByText('ABCD-1234')).toBeVisible({ timeout: ACCOUNT_SHOWS_WITHIN_MS })
      await expect
        .poll(() =>
          fs.existsSync(env.externalOpens) ? fs.readFileSync(env.externalOpens, 'utf8') : ''
        )
        .toContain('https://github.com/login/device')

      fs.writeFileSync(path.join(env.home, 'approve-gh-login'), '')
      const row = gitAccountRow(page, 'bob')
      await expect(row).toBeVisible({ timeout: ACCOUNT_SHOWS_WITHIN_MS })
      await expect(row.locator('.acct-badge')).toHaveText('DEFAULT')
      expect(keychainEntry(env, 'bob')).toBe('gho_fake_bob')

      const ran = fs.readFileSync(path.join(env.home, 'fake-gh-login-env.txt'), 'utf8')
      const keys = /^keys (.*)$/m.exec(ran)![1].split(' ')
      expect(keys).not.toContain('GH_TOKEN')
      expect(keys).not.toContain('GITHUB_TOKEN')
      expect(ran).toContain('--insecure-storage')
      const loginPath = /^PATH (.*)$/m.exec(ran)![1]
      expect(path.basename(loginPath)).toBe('emptybin')
      expect(loginPath.startsWith(env.userData)).toBe(true)
      expect(fs.readdirSync(env.userData).filter((n) => n.startsWith('gh-login-'))).toEqual([])
      expect(fs.existsSync(path.join(env.home, '.config', 'gh'))).toBe(false)
    } finally {
      await quitAndClose(app)
      await github.close()
    }
  })

  test('GA-02: a fine-grained token is turned down naming the permission it lacks, and a classic token adds the account it belongs to', async ({
    env
  }) => {
    const github = await withFakeGithub(env)
    github.addUser('github_pat_fine', { login: 'carol', scopes: null })
    github.addUser('ghp_classic_dave', { login: 'dave' })
    const { app, page } = await launched(env)
    try {
      await startAddingGithubAccount(page)
      await page.getByRole('button', { name: 'Use a token instead' }).click()
      const box = page.getByPlaceholder('Paste a token (ghp_…)')
      await box.fill('github_pat_fine')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.locator('.acct-add-err')).toContainText('lacks the repo permission')
      expect(keychainEntry(env, 'carol')).toBeUndefined()

      await box.fill('ghp_classic_dave')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(gitAccountRow(page, 'dave')).toBeVisible({ timeout: ACCOUNT_SHOWS_WITHIN_MS })
      expect(keychainEntry(env, 'dave')).toBe('ghp_classic_dave')
    } finally {
      await quitAndClose(app)
      await github.close()
    }
  })

  test("GA-03: picking bob for a repository makes the session's git send bob's token and its gh run as bob; gh's own sign-in is refused there; another repository keeps the user's own setup; removing bob takes it all back", async ({
    env
  }) => {
    test.setTimeout(180_000)
    const github = await withFakeGithub(env)
    github.addUser(BOB_TOKEN, { login: 'bob', id: 42 })
    github.setAccess(BOB_TOKEN, 'acme/app', 'push')
    repoOnFakeGithub(env, env.workspaces.a, `${github.url}/acme/app.git`)
    repoOnFakeGithub(env, env.workspaces.b, `${github.url}/acme/other.git`, 'other')
    seedGitAccount(env, 'bob', BOB_TOKEN)
    installFakeGh(env, {})
    const { app, page } = await launched(env)
    try {
      const size = await app.evaluate(({ BrowserWindow }, height) => {
        const win = BrowserWindow.getAllWindows()[0]
        const was = win.getContentSize()
        win.setContentSize(was[0], height)
        return was
      }, SHORT_WINDOW_HEIGHT)
      const panel = await openGitPanel(page, 'ws-a')
      await panel.locator('.tbu-act', { hasText: 'Pick account' }).click()
      await expect(panel.locator('.tbu-act', { hasText: /^bob/ })).toBeVisible()
      await expect
        .poll(async () => {
          const box = (await panel.boundingBox())!
          return box.y + box.height <= (await page.evaluate(() => window.innerHeight))
        })
        .toBe(true)
      await panel.locator('.tbu-act', { hasText: /^bob/ }).click()
      await expect(accountHead(panel)).toHaveText('as bob', {
        timeout: ACCOUNT_SHOWS_WITHIN_MS
      })
      expect(masterConfig(env)).toContain(
        `gitdir:${fs.realpathSync(path.join(env.workspaces.a, '.git'))}`
      )
      await page.mouse.move(1, 1)
      await app.evaluate(({ BrowserWindow }, [w, h]) => {
        BrowserWindow.getAllWindows()[0].setContentSize(w, h)
      }, size)

      await startSessionIn(page, 'ws-a')
      const tabId = (await wsRows(page, 'ws-a').getAttribute('data-tab-id'))!
      const shell = agentShell(page, tabId, A_SHELL_STEP_FINISHES_WITHIN_MS)
      const run = async (command: string): Promise<string> =>
        (await shell(command)).replace(TERMINAL_LINE_WRAPS, '')

      expect(await run('git ls-remote origin')).toContain('refs/heads/main')
      expect(github.hits.filter((h) => h.basic).map((h) => h.basic)).toContainEqual({
        username: 'bob',
        password: BOB_TOKEN
      })
      expect(await run('command -v gh')).toContain(path.join(env.shimDir, 'gh'))
      expect(await run('gh auth login --web')).toContain(
        'koloft: this repository uses the Koloft git account bob'
      )
      await run(`PATH="${env.shimDir}:${env.fakeBin}:$PATH" gh pr view 1`)
      expect(fs.readFileSync(fakeGhEnvFile(env), 'utf8')).toContain(
        `GH_TOKEN=${BOB_TOKEN} GH_HOST=github.com`
      )

      expect(
        await run(`git -C ${env.workspaces.b} config --get koloft.account; echo "other=[$?]"`)
      ).toContain('other=[1]')

      await openSettings(page)
      const row = gitAccountRow(page, 'bob')
      await expect(row.locator('.acct-note').last()).toContainText('used by 1 workspace')
      await row.locator('.acct-x').click()
      await expect(row.locator('.acct-confirm')).toContainText('ws-a')
      await row.getByRole('button', { name: 'Remove', exact: true }).click()
      await expect(row).toHaveCount(0)
      expect(keychainEntry(env, 'bob')).toBeUndefined()
      expect(masterConfig(env)).toBe('')
    } finally {
      await quitAndClose(app)
      await github.close()
    }
  })

  test('GA-04: an account GitHub no longer accepts is marked to sign in again, in Settings and in the workspace panel', async ({
    env
  }) => {
    const github = await withFakeGithub(env)
    repoOnFakeGithub(env, env.workspaces.a, `${github.url}/acme/app.git`)
    seedGitAccount(env, 'bob', 'gho_revoked', [env.workspaces.a])
    const { app, page } = await launched(env)
    try {
      const panel = await openGitPanel(page, 'ws-a')
      await expect(
        panel.locator('.fx-note.warn', { hasText: 'bob needs to sign in again' })
      ).toBeVisible({
        timeout: ACCOUNT_SHOWS_WITHIN_MS
      })
      await page.mouse.move(1, 1)
      await openSettings(page)
      await expect(gitAccountRow(page, 'bob').locator('.acct-status')).toHaveText(
        'NEEDS SIGN-IN AGAIN'
      )
    } finally {
      await quitAndClose(app)
      await github.close()
    }
  })

  test('GA-05: a new workspace whose address names bob picks bob by itself; one that names alice, who is not in Koloft, only offers to add her, and Not now is remembered', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const github = await withFakeGithub(env)
    github.addUser(BOB_TOKEN, { login: 'bob', id: 42 })
    github.setAccess(BOB_TOKEN, 'acme/app', 'push')
    const host = new URL(github.url).host
    const mine = path.join(env.home, 'mine')
    const hers = path.join(env.home, 'hers')
    repoOnFakeGithub(env, mine, `http://bob@${host}/acme/app.git`)
    repoOnFakeGithub(env, hers, `http://alice@${host}/acme/her.git`, 'her')
    seedGitAccount(env, 'bob', BOB_TOKEN)
    const { app, page } = await launched(env)
    try {
      await addWorkspace(page, mine)
      const minePanel = await openGitPanel(page, 'mine')
      await expect(accountHead(minePanel)).toHaveText('as bob', {
        timeout: ACCOUNT_SHOWS_WITHIN_MS
      })
      await page.mouse.move(1, 1)

      await addWorkspace(page, hers)
      const hersPanel = await openGitPanel(page, 'hers')
      await expect(hersPanel.locator('.fx-note').last()).toContainText(
        'This repository was used with alice, who is not in Koloft yet'
      )
      await expect(hersPanel.locator('.tbu-act', { hasText: 'Use bob' })).toHaveCount(0)
      await hersPanel.locator('.tbu-act', { hasText: 'Not now' }).click()
      await expect(hersPanel.locator('.fx-note').last()).toHaveText('Uses your own git setup')
      expect(settingsOnDisk(env).gitSuggestionsDismissed).toEqual([
        fs.realpathSync(path.join(hers, '.git'))
      ])
    } finally {
      await quitAndClose(app)
      await github.close()
    }
  })

  test("GA-06: with the Workbench browser off, a Codex tab in a picked repository loads Koloft's git config and may reach the network; one in another repository loads the config but stays offline", async ({
    env
  }) => {
    test.setTimeout(180_000)
    installCodex(env)
    const github = await withFakeGithub(env)
    repoOnFakeGithub(env, env.workspaces.a, `${github.url}/acme/app.git`)
    repoOnFakeGithub(env, env.workspaces.b, `${github.url}/acme/other.git`, 'other')
    seedGitAccount(env, 'bob', BOB_TOKEN, [env.workspaces.a])
    seedSettings(env, { browserControl: false })
    const { app, page } = await launched(env)
    try {
      await startSessionIn(page, 'ws-a', { method: 'Codex' })
      await startSessionIn(page, 'ws-b', { method: 'Codex' })
      const servers = fs
        .readFileSync(path.join(env.home, 'fake-codex-server-calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { argv: string[]; cwd: string; gitConfigIncludes: string[] })
      const at = (ws: string): { argv: string[]; gitConfigIncludes: string[] } =>
        servers.find((s) => fs.realpathSync(s.cwd) === ws)!
      const master = path.join(env.userData, 'git-accounts', 'config')
      expect(at(env.workspaces.a).argv).toContain('sandbox_workspace_write.network_access=true')
      expect(at(env.workspaces.b).argv).not.toContain('sandbox_workspace_write.network_access=true')
      expect(at(env.workspaces.a).gitConfigIncludes).toContain(master)
      expect(at(env.workspaces.b).gitConfigIncludes).toContain(master)
    } finally {
      await quitAndClose(app)
      await github.close()
    }
  })
})
