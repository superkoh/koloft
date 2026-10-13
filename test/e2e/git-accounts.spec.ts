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
import { startFakeForge } from './helpers/fakeForge'
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
const GITEA_BOB_TOKEN = 'gitea_e2e_bob_token'
const GITLAB_ALICE_TOKEN = 'glpat_e2e_alice'
const GHES_ERIN_TOKEN = 'ghp_e2e_enterprise_erin'
const FAKE_GCM = path.join(__dirname, 'fixtures', 'fake-gcm.js')
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

function keychainOf(env: E2EEnv, service: string, login: string): string | undefined {
  const all = JSON.parse(fs.readFileSync(env.keychainFile, 'utf8')) as Record<
    string,
    Record<string, string>
  >
  return all[service]?.[login]
}

function keychainEntry(env: E2EEnv, login: string): string | undefined {
  return keychainOf(env, GIT_ACCOUNT_KEYCHAIN_SERVICE, login)
}

function withFakeGcm(env: E2EEnv): void {
  env.launchEnv.KOLOFT_TEST_GCM = FAKE_GCM
  env.launchEnv.KOLOFT_FAKE_GCM_HOME = env.home
  seedSettings(env, { gitAutoFetch: false })
}

function repoOn(dir: string, remote: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, '.gitignore'), 'NOTES.md\n')
  gitInit(dir)
  execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: dir })
  execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: dir })
  execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main'], {
    cwd: dir
  })
}

interface GcmCall {
  op: string
  namespace: string
  interactive: boolean
  host: string
  wwwauth: string | null
  env: Record<string, string | null>
}

function gcmCalls(env: E2EEnv): GcmCall[] {
  const file = path.join(env.home, 'fake-gcm-calls.txt')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as GcmCall)
}

function gcmStore(env: E2EEnv): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(env.home, 'fake-gcm-store.json'), 'utf8')) as Record<
    string,
    unknown
  >
}

function seedGcmAccount(
  env: E2EEnv,
  platform: string,
  url: string,
  login: string,
  token: string,
  picks: string[]
): void {
  const namespace = `koloft-dev-git-e2e-${login}`
  fs.writeFileSync(
    path.join(env.home, 'fake-gcm-store.json'),
    JSON.stringify({ [namespace]: { username: 'OAUTH_USER', password: token } })
  )
  const id = `${new URL(url).host}/${login}`
  seedSettings(env, {
    gitAccounts: [
      { platform, url, login, gcmNamespace: namespace, default: true, status: 'ok', addedAt: 1 }
    ],
    gitPicks: picks.map((ws) => ({ repo: fs.realpathSync(path.join(ws, '.git')), account: id }))
  })
}

function rowOn(page: Page, login: string, hostLabel: string): Locator {
  return page.locator('.acct-row', {
    has: page
      .locator('.acct-main', {
        has: page.locator('.acct-name', { hasText: new RegExp(`^${login}$`) })
      })
      .filter({
        has: page.locator('.acct-note', { hasText: new RegExp(`^${escape(hostLabel)}$`) })
      })
  })
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
        'koloft: this repository uses the Koloft git account github.com/bob'
      )
      await run(`PATH="${env.shimDir}:${env.fakeBin}:$PATH" gh pr view 1`)
      expect(fs.readFileSync(fakeGhEnvFile(env), 'utf8')).toContain(
        `GH_TOKEN=${BOB_TOKEN} GH_ENTERPRISE_TOKEN= GH_HOST=github.com`
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

  test('GA-07: a Gitea account on a server with a port signs in through the login tool and sits next to a GitHub account of the same name; picking it makes Koloft’s own fetch send its token; removing it erases what the login tool kept', async ({
    env
  }) => {
    test.setTimeout(120_000)
    const github = await withFakeGithub(env)
    withFakeGcm(env)
    const forge = await startFakeForge('gitea')
    forge.addUser(GITEA_BOB_TOKEN, { login: 'bob' })
    repoOn(env.workspaces.a, `${forge.url}/acme/app.git`)
    seedGitAccount(env, 'bob', BOB_TOKEN)
    const host = new URL(forge.url).host
    const { app, page } = await launched(env)
    try {
      await openSettings(page)
      await page.getByRole('button', { name: 'Add account', exact: true }).click()
      await page.getByRole('button', { name: 'Gitea / Forgejo / Codeberg' }).click()
      await page.getByPlaceholder('Server URL (e.g. https://codeberg.org)').fill(forge.url)
      await page.getByRole('button', { name: 'Next', exact: true }).click()
      await expect(page.getByText('Finish signing in in your browser.')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Open page again' })).toBeEnabled()
      fs.writeFileSync(
        path.join(env.home, 'approve-gcm-login'),
        JSON.stringify({ username: 'OAUTH_USER', password: GITEA_BOB_TOKEN })
      )
      const giteaBob = rowOn(page, 'bob', `${host} · Gitea`)
      await expect(giteaBob).toBeVisible({ timeout: ACCOUNT_SHOWS_WITHIN_MS })
      await expect(giteaBob.locator('.acct-badge')).toHaveText('DEFAULT')
      await expect(rowOn(page, 'bob', 'github.com').locator('.acct-badge')).toHaveText('DEFAULT')
      const signIn = gcmCalls(env).find((c) => c.interactive)!
      expect(signIn).toMatchObject({
        host,
        wwwauth: 'Basic realm="Gitea"',
        env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_COUNT: null, GCM_PROVIDER: 'generic' }
      })
      await page.keyboard.press('Escape')

      const panel = await openGitPanel(page, 'ws-a')
      await panel.locator('.tbu-act', { hasText: 'Pick account' }).click()
      await expect(panel.locator('.tbu-pop-head', { hasText: `Account · ${host}` })).toBeVisible()
      await expect(panel.locator('.tbu-act', { hasText: /^bob/ })).toHaveCount(1)
      await panel.locator('.tbu-act', { hasText: /^bob/ }).click()
      await expect(panel.locator('.tbu-act', { hasText: `bob · ${host}` })).toBeVisible({
        timeout: ACCOUNT_SHOWS_WITHIN_MS
      })
      await expect(panel.locator('.fx-note', { hasText: 'Commits as bob' })).toContainText(
        'bob@noreply.127.0.0.1'
      )
      await panel.locator('.tbu-act', { hasText: 'Fetch now' }).click()
      await expect
        .poll(() => forge.hits.map((h) => h.basic).filter(Boolean))
        .toContainEqual({ username: 'bob', password: GITEA_BOB_TOKEN })
      const quiet = gcmCalls(env).filter((c) => c.op === 'get' && !c.interactive)
      expect(quiet.length).toBeGreaterThan(0)
      expect(quiet.every((c) => c.namespace === signIn.namespace && c.wwwauth)).toBe(true)
      await page.mouse.move(1, 1)

      await openSettings(page)
      await giteaBob.locator('.acct-x').click()
      await giteaBob.getByRole('button', { name: 'Remove', exact: true }).click()
      await expect(giteaBob).toHaveCount(0)
      expect(
        gcmCalls(env)
          .filter((c) => c.op === 'erase')
          .map((c) => c.namespace)
      ).toContain(signIn.namespace)
      expect(gcmStore(env)[signIn.namespace]).toBeUndefined()
      await expect(rowOn(page, 'bob', 'github.com')).toBeVisible()
    } finally {
      await quitAndClose(app)
      await github.close()
      await forge.close()
    }
  })

  test('GA-08: a self-managed GitLab takes a pasted token, turned down when it lacks a permission; a new workspace whose address names that user is picked for it, and a session’s git sends the token', async ({
    env
  }) => {
    test.setTimeout(180_000)
    seedSettings(env, { gitAutoFetch: false })
    const forge = await startFakeForge('gitlab')
    forge.addUser('glpat_narrow', { login: 'alice', scopes: ['write_repository'] })
    forge.addUser(GITLAB_ALICE_TOKEN, { login: 'alice' })
    forge.setAccess(GITLAB_ALICE_TOKEN, 'grp/sub/app', 'push')
    const host = new URL(forge.url).host
    const mine = path.join(env.home, 'mine')
    repoOn(mine, `http://alice@${host}/grp/sub/app.git`)
    const { app, page } = await launched(env)
    try {
      await openSettings(page)
      await page.getByRole('button', { name: 'Add account', exact: true }).click()
      await page.getByRole('button', { name: 'GitLab', exact: true }).click()
      await page.getByPlaceholder('Server URL — leave empty for gitlab.com').fill(forge.url)
      await page.getByRole('button', { name: 'Next', exact: true }).click()
      await expect(page.locator('.acct-add-title')).toHaveText(`Add account · ${host} (GitLab)`)
      const box = page.getByPlaceholder('Paste a token (glpat-…)')
      await box.fill('glpat_narrow')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(page.locator('.acct-add-err')).toContainText('lacks the read_api permission')
      await box.fill(GITLAB_ALICE_TOKEN)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(rowOn(page, 'alice', `${host} · GitLab`)).toBeVisible({
        timeout: ACCOUNT_SHOWS_WITHIN_MS
      })
      expect(keychainOf(env, `koloft-dev-git-${host}`, 'alice')).toBe(GITLAB_ALICE_TOKEN)
      await page.keyboard.press('Escape')

      await addWorkspace(page, mine)
      const panel = await openGitPanel(page, 'mine')
      await expect(panel.locator('.tbu-act', { hasText: `alice · ${host}` })).toBeVisible({
        timeout: ACCOUNT_SHOWS_WITHIN_MS
      })
      await page.mouse.move(1, 1)

      await startSessionIn(page, 'mine')
      const tabId = (await wsRows(page, 'mine').getAttribute('data-tab-id'))!
      const shell = agentShell(page, tabId, A_SHELL_STEP_FINISHES_WITHIN_MS)
      expect(await shell('git ls-remote origin')).toContain('refs/heads/main')
      expect(forge.hits.map((h) => h.basic)).toContainEqual({
        username: 'alice',
        password: GITLAB_ALICE_TOKEN
      })
    } finally {
      await quitAndClose(app)
      await forge.close()
    }
  })

  test('GA-09: a Codex tab in a repository picked for a Gitea account on a server with a port may reach the network; one in another repository stays offline', async ({
    env
  }) => {
    test.setTimeout(180_000)
    installCodex(env)
    withFakeGcm(env)
    const forge = await startFakeForge('gitea')
    repoOn(env.workspaces.a, `${forge.url}/acme/app.git`)
    repoOn(env.workspaces.b, `${forge.url}/acme/other.git`)
    seedGcmAccount(env, 'gitea', forge.url, 'bob', GITEA_BOB_TOKEN, [env.workspaces.a])
    seedSettings(env, { browserControl: false })
    const { app, page } = await launched(env)
    try {
      await startSessionIn(page, 'ws-a', { method: 'Codex' })
      await startSessionIn(page, 'ws-b', { method: 'Codex' })
      const servers = fs
        .readFileSync(path.join(env.home, 'fake-codex-server-calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { argv: string[]; cwd: string })
      const at = (ws: string): { argv: string[] } =>
        servers.find((s) => fs.realpathSync(s.cwd) === ws)!
      expect(at(env.workspaces.a).argv).toContain('sandbox_workspace_write.network_access=true')
      expect(at(env.workspaces.b).argv).not.toContain('sandbox_workspace_write.network_access=true')
    } finally {
      await quitAndClose(app)
      await forge.close()
    }
  })

  test('GA-10: a GitHub Enterprise server with a port takes a pasted token; in a repository picked for it, git sends that token and gh gets it as the Enterprise token for that server', async ({
    env
  }) => {
    test.setTimeout(180_000)
    seedSettings(env, { gitAutoFetch: false })
    const ghes = await startFakeGithub()
    ghes.addUser(GHES_ERIN_TOKEN, { login: 'erin' })
    const host = new URL(ghes.url).host
    repoOn(env.workspaces.a, `${ghes.url}/acme/app.git`)
    installFakeGh(env, {})
    const { app, page } = await launched(env)
    try {
      await openSettings(page)
      await page.getByRole('button', { name: 'Add account', exact: true }).click()
      await page.getByRole('button', { name: 'GitHub Enterprise', exact: true }).click()
      await page.getByPlaceholder('Server URL (e.g. https://github.example.com)').fill(ghes.url)
      await page.getByRole('button', { name: 'Next', exact: true }).click()
      await page.getByPlaceholder('Paste a token (ghp_…)').fill(GHES_ERIN_TOKEN)
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(rowOn(page, 'erin', `${host} · GitHub Enterprise`)).toBeVisible({
        timeout: ACCOUNT_SHOWS_WITHIN_MS
      })
      await page.keyboard.press('Escape')

      const panel = await openGitPanel(page, 'ws-a')
      await panel.locator('.tbu-act', { hasText: 'Pick account' }).click()
      await panel.locator('.tbu-act', { hasText: /^erin/ }).click()
      await expect(panel.locator('.tbu-act', { hasText: `erin · ${host}` })).toBeVisible({
        timeout: ACCOUNT_SHOWS_WITHIN_MS
      })
      await expect(panel.locator('.fx-note', { hasText: 'Commits keep your own' })).toBeVisible()
      await page.mouse.move(1, 1)

      await startSessionIn(page, 'ws-a')
      const tabId = (await wsRows(page, 'ws-a').getAttribute('data-tab-id'))!
      const shell = agentShell(page, tabId, A_SHELL_STEP_FINISHES_WITHIN_MS)
      const run = async (command: string): Promise<string> =>
        (await shell(command)).replace(TERMINAL_LINE_WRAPS, '')
      expect(await run('git ls-remote origin')).toContain('refs/heads/main')
      expect(ghes.hits.map((h) => h.basic)).toContainEqual({
        username: 'erin',
        password: GHES_ERIN_TOKEN
      })
      expect(await run('gh auth login --web')).toContain(
        `koloft: this repository uses the Koloft git account ${host}/erin`
      )
      await run(`PATH="${env.shimDir}:${env.fakeBin}:$PATH" gh pr view 1`)
      expect(fs.readFileSync(fakeGhEnvFile(env), 'utf8')).toContain(
        `GH_TOKEN= GH_ENTERPRISE_TOKEN=${GHES_ERIN_TOKEN} GH_HOST=${host}`
      )
    } finally {
      await quitAndClose(app)
      await ghes.close()
    }
  })

  test('GA-11: an account on any other server is a username and a token, kept without checking; when the server turns its token down during a git call, it is marked to sign in again, and Sign in again keeps its username so the new token goes on the same row', async ({
    env
  }) => {
    test.setTimeout(180_000)
    seedSettings(env, { gitAutoFetch: false })
    const forge = await startFakeForge('gitea')
    const host = new URL(forge.url).host
    repoOn(env.workspaces.a, `${forge.url}/acme/app.git`)
    const { app, page } = await launched(env)
    try {
      await openSettings(page)
      await page.getByRole('button', { name: 'Add account', exact: true }).click()
      await page.getByRole('button', { name: 'Other server', exact: true }).click()
      await page.getByPlaceholder('Server URL (e.g. https://git.example.com)').fill(forge.url)
      await page.getByRole('button', { name: 'Next', exact: true }).click()
      await page.getByPlaceholder('Your username on that server').fill('carol')
      await page.getByPlaceholder('Paste a token', { exact: true }).fill('stale_token')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      const carol = rowOn(page, 'carol', host)
      await expect(carol).toBeVisible({ timeout: ACCOUNT_SHOWS_WITHIN_MS })
      await page.keyboard.press('Escape')

      const panel = await openGitPanel(page, 'ws-a')
      await panel.locator('.tbu-act', { hasText: 'Pick account' }).click()
      await panel.locator('.tbu-act', { hasText: /^carol/ }).click()
      await expect(panel.locator('.tbu-act', { hasText: `carol · ${host}` })).toBeVisible({
        timeout: ACCOUNT_SHOWS_WITHIN_MS
      })
      await page.mouse.move(1, 1)

      await startSessionIn(page, 'ws-a')
      const tabId = (await wsRows(page, 'ws-a').getAttribute('data-tab-id'))!
      const shell = agentShell(page, tabId, A_SHELL_STEP_FINISHES_WITHIN_MS)
      await shell('GIT_TERMINAL_PROMPT=0 git ls-remote origin')
      expect(forge.hits.map((h) => h.basic)).toContainEqual({
        username: 'carol',
        password: 'stale_token'
      })
      await openSettings(page)
      await expect(carol.locator('.acct-status')).toHaveText('NEEDS SIGN-IN AGAIN', {
        timeout: ACCOUNT_SHOWS_WITHIN_MS
      })

      await carol.locator('.acct-relogin', { hasText: 'Sign in again' }).click()
      await expect(page.getByPlaceholder('Your username on that server')).toHaveValue('carol')
      await page.getByPlaceholder('Paste a token', { exact: true }).fill('fresh_token')
      await page.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(carol.locator('.acct-status')).not.toHaveText('NEEDS SIGN-IN AGAIN', {
        timeout: ACCOUNT_SHOWS_WITHIN_MS
      })
      await expect(
        page.locator('.acct-row', { has: page.locator('.acct-name', { hasText: /^carol$/ }) })
      ).toHaveCount(1)
    } finally {
      await quitAndClose(app)
      await forge.close()
    }
  })
})
