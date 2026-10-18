import { execFileSync, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { GIT_ACCOUNT_KEYCHAIN_SERVICE, seedSettings, type E2EEnv } from './helpers/env'
import { openSettings } from './helpers/extensions'
import { startFakeForge, type FakeForge } from './helpers/fakeForge'
import { startFakeGithub } from './helpers/fakeGithub'
import {
  addWorkspace,
  agentShell,
  gitInit,
  openGitPanel,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import {
  dockerAvailable,
  installLabSsh,
  remoteKeyFor,
  runOnTarget,
  runOnTargetWhileServing,
  startSshLab,
  stopSshLab,
  type LabAlias,
  type SshLab
} from './helpers/docker'
import { defaultControlDir } from '../../src/main/remote/ssh'
import { REMOTE_ENV_LINES } from '../../src/main/remote/install'

const ACCOUNT_SHOWS_WITHIN_MS = 30_000
const A_REMOTE_SHELL_STEP_FINISHES_WITHIN_MS = 60_000
const FAKE_GCM = path.join(__dirname, 'fixtures', 'fake-gcm.js')
const FAKE_LOGIN = path.join(__dirname, 'fixtures', 'fake-gh-login.js')
const LOCAL_BOB_TOKEN = 'gho_e2e_local_bob_never_leaves_the_mac'
const REMOTE_CAROL_TOKEN = 'remote_e2e_carol_token'
const REMOTE_GITEA_TOKEN = 'gitea_e2e_remote_dan_token'
const REMOTE_GH_TOKEN = 'gho_fake_bob'
const THE_MAC_REACHED_FROM_A_LAB_MACHINE = 'host.docker.internal'
const GIT_ACCOUNTS_ON_THE_MACHINE = '.koloft/git-accounts'

test.describe.configure({ timeout: 420_000 })
test.beforeAll(() =>
  test.skip(!dockerAvailable(), 'needs a running Docker (for example `colima start`)')
)

async function withLab(
  env: E2EEnv,
  body: (ctx: { app: ElectronApplication; page: Page; lab: SshLab }) => Promise<void>,
  opts: { oldGit?: boolean; beforeLaunch?: (lab: SshLab) => void } = {}
): Promise<void> {
  const lab = await startSshLab(env, { oldGit: opts.oldGit })
  let app: ElectronApplication | null = null
  try {
    installLabSsh(env, lab)
    opts.beforeLaunch?.(lab)
    app = await launchApp(env)
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    await body({ app, page, lab })
  } finally {
    if (app) await quitAndClose(app)
    stopSshLab(lab, defaultControlDir())
  }
}

function seenFromTheLab(url: string): string {
  const u = new URL(url)
  return `${u.protocol}//${THE_MAC_REACHED_FROM_A_LAB_MACHINE}:${u.port}`
}

function repoOnTheMachine(lab: SshLab, origin: string, container = lab.target): void {
  runOnTarget(
    lab,
    'kuser',
    `cd proj && git init -q && git remote add origin ${origin} && printf 'NOTES.md\\n' > .gitignore`,
    container
  )
}

function seedLocalBob(env: E2EEnv): void {
  fs.mkdirSync(env.workspaces.a, { recursive: true })
  fs.writeFileSync(path.join(env.workspaces.a, '.gitignore'), 'NOTES.md\n')
  gitInit(env.workspaces.a)
  seedSettings(env, {
    gitAutoFetch: false,
    gitAccounts: [
      {
        platform: 'github',
        url: 'https://github.com',
        login: 'bob',
        default: true,
        status: 'ok',
        addedAt: 1
      }
    ],
    gitPicks: [
      { repo: fs.realpathSync(path.join(env.workspaces.a, '.git')), account: 'github.com/bob' }
    ]
  })
  const keychain = fs.existsSync(env.keychainFile)
    ? (JSON.parse(fs.readFileSync(env.keychainFile, 'utf8')) as Record<string, unknown>)
    : {}
  keychain[GIT_ACCOUNT_KEYCHAIN_SERVICE] = { bob: LOCAL_BOB_TOKEN }
  fs.writeFileSync(env.keychainFile, JSON.stringify(keychain))
}

function machineSwitch(page: Page, name: string): Locator {
  return page.getByRole('group', { name: 'Machine' }).getByRole('button', { name, exact: true })
}

function accountRow(page: Page, login: string): Locator {
  return page.locator('.acct-row', {
    has: page.locator('.acct-name', { hasText: new RegExp(`^${login}$`) })
  })
}

async function onMachineInSettings(page: Page, alias: LabAlias): Promise<void> {
  await openSettings(page)
  await machineSwitch(page, alias).click()
  await expect(machineSwitch(page, alias)).toHaveAttribute('aria-pressed', 'true')
}

async function addOtherAccount(
  page: Page,
  url: string,
  login: string,
  token: string
): Promise<void> {
  await page.getByRole('button', { name: 'Add account', exact: true }).click()
  await page.getByRole('button', { name: 'Other server' }).click()
  await page.getByPlaceholder('Server URL (e.g. https://git.example.com)').fill(url)
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await page.getByPlaceholder('Your username on that server').fill(login)
  await page.getByPlaceholder('Paste a token').fill(token)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
}

async function pickInPanel(page: Page, alias: LabAlias, login: string): Promise<void> {
  const panel = await openGitPanel(page, alias)
  await panel.locator('.tbu-act', { hasText: 'Pick account' }).click()
  await expect(panel.locator('.tbu-pop-head', { hasText: `on ${alias}` })).toBeVisible()
  await panel.locator('.tbu-act', { hasText: new RegExp(`^${login}`) }).click()
  await expect(panel.locator('.tbu-act', { hasText: `${login} · ` })).toBeVisible({
    timeout: ACCOUNT_SHOWS_WITHIN_MS
  })
  await page.mouse.move(1, 1)
}

async function sessionShell(
  page: Page,
  alias: LabAlias
): Promise<(command: string) => Promise<string>> {
  await startSessionIn(page, alias, { remote: true })
  const tabId = (await wsRows(page, alias).first().getAttribute('data-tab-id'))!
  return agentShell(page, tabId, A_REMOTE_SHELL_STEP_FINISHES_WITHIN_MS)
}

function filesHolding(root: string, text: string): string[] {
  const out: string[] = []
  for (const rel of fs.readdirSync(root, { recursive: true }) as string[]) {
    const full = path.join(root, rel)
    if (rel.startsWith('ssh-lab') || !fs.statSync(full).isFile()) continue
    if (fs.readFileSync(full).includes(text)) out.push(rel)
  }
  return out
}

function machineFiles(lab: SshLab, container = lab.target): string {
  return runOnTarget(
    lab,
    'kuser',
    `cd ${GIT_ACCOUNTS_ON_THE_MACHINE} && for f in $(find . -type f | sort); do printf '== %s\\n' "$f"; cat "$f"; done`,
    container
  )
}

function forwardOnTheMachine(lab: SshLab, port: string): ChildProcess {
  return spawn(
    'docker',
    [
      'exec',
      lab.target,
      'node',
      '-e',
      `require('net').createServer((c)=>{const u=require('net').connect(${port},'${THE_MAC_REACHED_FROM_A_LAB_MACHINE}');c.pipe(u);u.pipe(c);u.on('error',()=>c.destroy());c.on('error',()=>u.destroy())}).listen(${port},'127.0.0.1')`
    ],
    { stdio: 'ignore' }
  )
}

function basicLogins(forge: FakeForge): { username: string; password: string }[] {
  return forge.hits.flatMap((h) => (h.basic ? [h.basic] : []))
}

test.describe('Git accounts on a remote machine (Docker SSH lab)', () => {
  test("RGA-01: Settings switches to the machine and adds a token account there; it is kept only on the machine (0700/0600) and the Mac keeps no copy; picking it in the remote workspace's panel makes a session's git send it; a Mac account picked for a Mac repository never reaches the machine; removing it deletes the token there", async ({
    env
  }) => {
    const forge = await startFakeForge('gitea')
    forge.addUser(REMOTE_CAROL_TOKEN, { login: 'carol' })
    const url = seenFromTheLab(forge.url)
    seedLocalBob(env)
    try {
      await withLab(env, async ({ page, lab }) => {
        repoOnTheMachine(lab, `${url}/acme/app.git`)
        expect((await addWorkspace(page, remoteKeyFor('kt-key', 'kuser'))).code).toBe('added')

        await onMachineInSettings(page, 'kt-key')
        await expect(page.getByText('No git accounts yet.')).toBeVisible()
        await addOtherAccount(page, url, 'carol', REMOTE_CAROL_TOKEN)
        await expect(accountRow(page, 'carol')).toBeVisible({ timeout: ACCOUNT_SHOWS_WITHIN_MS })
        await expect(accountRow(page, 'bob')).toHaveCount(0)
        await machineSwitch(page, 'This Mac').click()
        await expect(accountRow(page, 'bob')).toBeVisible()
        await expect(accountRow(page, 'carol')).toHaveCount(0)
        await page.keyboard.press('Escape')

        expect(filesHolding(env.home, REMOTE_CAROL_TOKEN)).toEqual([])
        expect(
          runOnTarget(
            lab,
            'kuser',
            `stat -c '%a %U' ${GIT_ACCOUNTS_ON_THE_MACHINE} ${GIT_ACCOUNTS_ON_THE_MACHINE}/secrets/*`
          )
        ).toBe('700 kuser\n600 kuser\n')

        await pickInPanel(page, 'kt-key', 'carol')
        const run = await sessionShell(page, 'kt-key')
        await run('cd ~/proj && git ls-remote origin')
        await expect
          .poll(() => basicLogins(forge))
          .toContainEqual({ username: 'carol', password: REMOTE_CAROL_TOKEN })

        const onMachine = machineFiles(lab)
        expect(onMachine).toContain(REMOTE_CAROL_TOKEN)
        expect(onMachine).not.toContain(LOCAL_BOB_TOKEN)
        expect(onMachine).not.toContain('github.com/bob')

        await onMachineInSettings(page, 'kt-key')
        await accountRow(page, 'carol').locator('.acct-x').click()
        await accountRow(page, 'carol').getByRole('button', { name: 'Remove', exact: true }).click()
        await expect(accountRow(page, 'carol')).toHaveCount(0)
        await expect.poll(() => machineFiles(lab)).not.toContain(REMOTE_CAROL_TOKEN)
      })
    } finally {
      await forge.close()
    }
  })

  test('RGA-02: a Gitea browser sign-in for the machine runs on the Mac into a private folder that is moved whole to the machine and then deleted; the machine’s own sign-in tool answers git there', async ({
    env
  }) => {
    const forge = await startFakeForge('gitea')
    forge.addUser(REMOTE_GITEA_TOKEN, { login: 'dan' })
    env.launchEnv.KOLOFT_TEST_GCM = FAKE_GCM
    env.launchEnv.KOLOFT_FAKE_GCM_HOME = env.home
    seedSettings(env, { gitAutoFetch: false })
    const port = new URL(forge.url).port
    let forward: ChildProcess | null = null
    try {
      await withLab(env, async ({ page, lab }) => {
        forward = forwardOnTheMachine(lab, port)
        runOnTarget(lab, 'kuser', 'mkdir -p .koloft/gcm')
        execFileSync('docker', [
          'cp',
          FAKE_GCM,
          `${lab.target}:/home/kuser/.koloft/gcm/git-credential-manager`
        ])
        execFileSync('docker', [
          'exec',
          lab.target,
          'chown',
          '-R',
          'kuser:kuser',
          '/home/kuser/.koloft'
        ])
        execFileSync('docker', [
          'exec',
          lab.target,
          'chmod',
          '755',
          '/home/kuser/.koloft/gcm/git-credential-manager'
        ])
        repoOnTheMachine(lab, `${forge.url}/acme/app.git`)
        expect((await addWorkspace(page, remoteKeyFor('kt-key', 'kuser'))).code).toBe('added')

        await onMachineInSettings(page, 'kt-key')
        await page.getByRole('button', { name: 'Add account', exact: true }).click()
        await page.getByRole('button', { name: 'Gitea / Forgejo / Codeberg' }).click()
        await page.getByPlaceholder('Server URL (e.g. https://codeberg.org)').fill(forge.url)
        await page.getByRole('button', { name: 'Next', exact: true }).click()
        await expect(page.getByText('Finish signing in in your browser.')).toBeVisible({
          timeout: ACCOUNT_SHOWS_WITHIN_MS
        })
        const signInFolders = path.join(env.userData, 'git-accounts', 'machine-sign-in')
        expect(fs.readdirSync(signInFolders)).toHaveLength(1)
        expect(
          fs.statSync(path.join(signInFolders, fs.readdirSync(signInFolders)[0])).mode & 0o777
        ).toBe(0o700)
        fs.writeFileSync(
          path.join(env.home, 'approve-gcm-login'),
          JSON.stringify({ username: 'OAUTH_USER', password: REMOTE_GITEA_TOKEN })
        )
        await expect(accountRow(page, 'dan')).toBeVisible({ timeout: ACCOUNT_SHOWS_WITHIN_MS })
        expect(fs.readdirSync(signInFolders)).toEqual([])
        expect(filesHolding(env.home, REMOTE_GITEA_TOKEN)).toEqual([])
        await page.keyboard.press('Escape')

        await pickInPanel(page, 'kt-key', 'dan')
        const run = await sessionShell(page, 'kt-key')
        await run('cd ~/proj && git ls-remote origin')
        await expect
          .poll(() => basicLogins(forge))
          .toContainEqual({ username: 'dan', password: REMOTE_GITEA_TOKEN })
      })
    } finally {
      ;(forward as ChildProcess | null)?.kill()
      await forge.close()
    }
  })

  test("RGA-03: a GitHub sign-in for the machine goes through the Mac's sandboxed gh and lands only on the machine; the remote workspace's GitHub counts and its session's gh run on the machine with that token, and gh's own sign-in commands are refused there", async ({
    env
  }) => {
    const github = await startFakeGithub()
    github.addUser(REMOTE_GH_TOKEN, { login: 'bob', id: 42, name: 'Bob Example' })
    env.launchEnv.KOLOFT_GITHUB_URL = github.url
    env.launchEnv.KOLOFT_GITHUB_API_URL = github.url
    env.launchEnv.KOLOFT_TEST_GH_LOGIN = FAKE_LOGIN
    env.launchEnv.KOLOFT_FAKE_GH_LOGIN_HOME = env.home
    seedSettings(env, { gitAutoFetch: false })
    try {
      await withLab(env, async ({ page, lab }) => {
        const fakeGh = path.join(env.home, 'remote-gh')
        fs.writeFileSync(
          fakeGh,
          '#!/bin/sh\nprintf \'%s %s %s\\n\' "$GH_HOST" "$GH_TOKEN" "$*" >> /tmp/gh-calls.txt\n' +
            'case "$1 $2" in "api graphql") echo \'{"data":{"repository":{"issues":{"totalCount":12},"pullRequests":{"totalCount":3}}}}\' ;; *) echo \'[]\' ;; esac\n'
        )
        execFileSync('docker', ['cp', fakeGh, `${lab.target}:/usr/local/bin/gh`])
        execFileSync('docker', ['exec', lab.target, 'chmod', '755', '/usr/local/bin/gh'])
        repoOnTheMachine(lab, 'https://github.com/acme/widget.git')
        expect((await addWorkspace(page, remoteKeyFor('kt-key', 'kuser'))).code).toBe('added')

        await onMachineInSettings(page, 'kt-key')
        await page.getByRole('button', { name: 'Add account', exact: true }).click()
        await page.getByRole('button', { name: 'Next', exact: true }).click()
        await expect(page.getByText('ABCD-1234')).toBeVisible({ timeout: ACCOUNT_SHOWS_WITHIN_MS })
        fs.writeFileSync(path.join(env.home, 'approve-gh-login'), '')
        await expect(accountRow(page, 'bob')).toBeVisible({ timeout: ACCOUNT_SHOWS_WITHIN_MS })
        expect(filesHolding(env.home, REMOTE_GH_TOKEN)).toEqual([])
        await page.keyboard.press('Escape')

        await pickInPanel(page, 'kt-key', 'bob')
        await expect
          .poll(() => runOnTarget(lab, 'kuser', 'cat /tmp/gh-calls.txt 2>/dev/null || true'))
          .toContain(`github.com ${REMOTE_GH_TOKEN} api graphql`)
        const panel = await openGitPanel(page, 'kt-key')
        await expect(panel.locator('.fx-counts')).toContainText('12 open issues')
        await expect(panel.locator('.tbu-pop-head', { hasText: 'GitHub' })).toContainText('as bob')
        await page.mouse.move(1, 1)

        const run = await sessionShell(page, 'kt-key')
        expect(await run('cd ~/proj && gh auth status')).toContain('sh exit=1')
        await run('cd ~/proj && gh issue list')
        const calls = runOnTarget(lab, 'kuser', 'cat /tmp/gh-calls.txt')
        expect(calls).toContain(`github.com ${REMOTE_GH_TOKEN} issue list`)
        expect(calls).not.toContain('auth status')
      })
    } finally {
      await github.close()
    }
  })

  test('RGA-04: a machine with git 2.30 takes an account and its git sends it; a machine whose git is older than 2.13 is told so plainly and keeps no account', async ({
    env
  }) => {
    const forge = await startFakeForge('gitea')
    forge.addUser(REMOTE_CAROL_TOKEN, { login: 'carol' })
    const url = seenFromTheLab(forge.url)
    seedSettings(env, { gitAutoFetch: false })
    try {
      await withLab(
        env,
        async ({ page, lab }) => {
          expect(runOnTarget(lab, 'kuser', 'git --version', lab.oldGit)).toContain('2.30.')
          repoOnTheMachine(lab, `${url}/acme/app.git`, lab.oldGit)
          expect((await addWorkspace(page, remoteKeyFor('kt-oldgit', 'kuser'))).code).toBe('added')
          await onMachineInSettings(page, 'kt-oldgit')
          await addOtherAccount(page, url, 'carol', REMOTE_CAROL_TOKEN)
          await expect(accountRow(page, 'carol')).toBeVisible({ timeout: ACCOUNT_SHOWS_WITHIN_MS })
          await page.keyboard.press('Escape')
          await pickInPanel(page, 'kt-oldgit', 'carol')
          await runOnTargetWhileServing(
            lab,
            'kuser',
            `${REMOTE_ENV_LINES}\ncd proj && git ls-remote origin`,
            lab.oldGit
          )
          expect(basicLogins(forge)).toContainEqual({
            username: 'carol',
            password: REMOTE_CAROL_TOKEN
          })

          expect((await addWorkspace(page, remoteKeyFor('kt-few', 'muser'))).code).toBe('added')
          await onMachineInSettings(page, 'kt-few')
          await addOtherAccount(page, url, 'carol', REMOTE_CAROL_TOKEN)
          await expect(page.locator('.acct-add-err')).toHaveText(
            'git on kt-few is 2.12.0; git accounts need git 2.13 or newer there. Update git on kt-few, then add the account again.'
          )
          await expect(accountRow(page, 'carol')).toHaveCount(0)
        },
        {
          oldGit: true,
          beforeLaunch: (lab) =>
            runOnTarget(
              lab,
              'muser',
              'mkdir -p .local/bin && printf \'#!/bin/sh\\n[ "$1" = --version ] && { echo "git version 2.12.0"; exit 0; }\\nexec /usr/bin/git "$@"\\n\' > .local/bin/git && chmod 755 .local/bin/git'
            )
        }
      )
    } finally {
      await forge.close()
    }
  })
})
