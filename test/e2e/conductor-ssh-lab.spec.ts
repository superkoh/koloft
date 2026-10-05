import fs from 'fs'
import { execFileSync } from 'child_process'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { defaultControlDir } from '../../src/main/remote/ssh'
import { addWorkspace, openMenu, startSessionIn, waitBooted, wsGroup } from './helpers/p1'
import {
  dockerAvailable,
  installLabSsh,
  installOnTarget,
  remoteKeyFor,
  runOnTarget,
  startSshLab,
  stopSshLab,
  type SshLab
} from './helpers/docker'
import { startFakeDiscord, type FakeDiscord } from './helpers/fakeDiscord'

function claudeTokenFromKeychain(): string {
  const account = process.env.KOLOFT_SMOKE_ACCOUNT
  if (!account) return ''
  const service = process.env.KOLOFT_SMOKE_KEYCHAIN_SERVICE ?? 'koloft-claude-oauth'
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).replace(/\n$/, '')
  } catch {
    return ''
  }
}

const LINUX_CLAUDE = process.env.KOLOFT_SMOKE_CLAUDE_LINUX ?? ''
const CLAUDE_TOKEN = process.env.KOLOFT_SMOKE_OAUTH_TOKEN || claudeTokenFromKeychain()
const HAVE_LINUX_CLAUDE = fs.existsSync(LINUX_CLAUDE) && !!CLAUDE_TOKEN

const OWNER = { id: '555', username: 'letian' }
const CHANNEL = '222'
const CHANNEL_NAME = 'koloft-all'
const REMOTE_HOME = '/home/kuser'
const REMOTE_WORKSPACE = `${REMOTE_HOME}/proj`
const BACKGROUND_CONNECT_MS = 45_000
const A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS = 60_000
const A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS = 180_000
const CONDUCTOR_SCREEN_DRAWS_AFTER_IT_IS_SHOWN_MS = 2000
const PAST_THE_PASTE_THAT_SWALLOWS_AN_EARLY_ENTER_MS = 1000

test.describe.configure({ timeout: 420_000 })
test.beforeAll(() =>
  test.skip(!dockerAvailable(), 'needs a running Docker (for example `colima start`)')
)

function said(fake: FakeDiscord): string[] {
  return fake.posted.filter((p) => p.channelId === CHANNEL).map((p) => p.content)
}

function notices(fake: FakeDiscord): string[] {
  return said(fake)
    .flatMap((p) => p.split('\n'))
    .filter((l) => /^(🔔|❓|⏹|▶)/.test(l))
}

function channelRow(dlg: Locator, name: string): Locator {
  return dlg.locator('.cb-row', {
    has: dlg.page().locator('.wt-name', { hasText: new RegExp(`^#${name}$`) })
  })
}

async function bindChannel(page: Page, wsName: string): Promise<void> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'Bind Discord channel…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
  await expect(dlg).toBeVisible()
  await channelRow(dlg, CHANNEL_NAME).click()
  await dlg.locator('.modal-foot .btn-primary').click()
  await expect(dlg).toHaveCount(0)
}

async function allTerminals(page: Page): Promise<string> {
  const unfold = page.locator('.isl-conductors').getByRole('button', { name: 'Unfold' })
  if (await unfold.count()) await unfold.click()
  await page
    .locator('.isl-conductors .ws-tab')
    .click({ timeout: 5000 })
    .catch(() => undefined)
  await page.waitForTimeout(CONDUCTOR_SCREEN_DRAWS_AFTER_IT_IS_SHOWN_MS)
  return page
    .evaluate(() => {
      const terms =
        (
          window as unknown as {
            __koloftTerms?: Record<
              string,
              {
                buffer: {
                  active: {
                    length: number
                    getLine(i: number): { translateToString(trim?: boolean): string } | undefined
                  }
                }
              }
            >
          }
        ).__koloftTerms ?? {}
      return Object.entries(terms)
        .map(([id, t]) => {
          const b = t.buffer.active
          const lines: string[] = []
          for (let i = 0; i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '')
          return `── ${id}\n${lines.join('\n').trimEnd()}`
        })
        .join('\n\n')
    })
    .catch(() => '(no terminals)')
}

function transcriptOnTarget(lab: SshLab, sessionId: string): string {
  try {
    return runOnTarget(lab, 'kuser', `cat .claude/projects/*/${sessionId}.jsonl`)
  } catch {
    return ''
  }
}

async function statusOf(page: Page, tabId: string): Promise<string | undefined> {
  const all = await page.evaluate(() => window.api.sessions.list())
  return all.find((s) => s.tabId === tabId)?.status
}

interface ConductorLab {
  page: Page
  lab: SshLab
  fake: FakeDiscord
}

async function withRemoteWorkspaceConductor(
  env: E2EEnv,
  beforeLaunch: (lab: SshLab, fake: FakeDiscord) => void,
  body: (ctx: ConductorLab) => Promise<void>
): Promise<void> {
  seedSettings(env, {
    hintsOff: true,
    discord: { userId: OWNER.id, userName: OWNER.username, bindings: [] }
  })
  const fake = await startFakeDiscord(env)
  const lab = await startSshLab(env)
  let app: ElectronApplication | null = null
  let page: Page | null = null
  try {
    installLabSsh(env, lab)
    beforeLaunch(lab, fake)
    app = await launchApp(env)
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    expect((await addWorkspace(page, remoteKeyFor('kt-key', 'kuser'))).code).toBe('added')
    await expect(wsGroup(page, 'kt-key').locator('.ws-conn')).toHaveClass(/\bon\b/, {
      timeout: BACKGROUND_CONNECT_MS
    })
    await bindChannel(page, 'kt-key')
    await body({ page, lab, fake })
  } finally {
    await test.info().attach('channel', { body: said(fake).join('\n────\n') || '(nothing)' })
    if (page) await test.info().attach('terminals', { body: await allTerminals(page) })
    if (app) await quitAndClose(app)
    stopSshLab(lab, defaultControlDir())
    await fake.close()
  }
}

function useRealClaudeOnTheMachine(env: E2EEnv, lab: SshLab): void {
  installOnTarget(lab, LINUX_CLAUDE, '/usr/local/bin/claude')
  // CC§9 CC§10
  runOnTarget(
    lab,
    'kuser',
    `printf '%s' ${JSON.stringify(
      JSON.stringify({
        hasCompletedOnboarding: true,
        bypassPermissionsModeAccepted: true,
        projects: { [REMOTE_WORKSPACE]: { hasTrustDialogAccepted: true } }
      })
    )} > .claude.json`
  )
  seedSettings(env, {
    multiAccount: true,
    skipPermissions: true,
    accounts: [
      { name: 'alpha', kind: 'oauth', enabled: true, fable: 'unknown', status: 'ok', addedAt: 1 }
    ]
  })
  const keychain = JSON.parse(fs.readFileSync(env.keychainFile, 'utf8')) as Record<string, unknown>
  keychain['koloft-dev-claude-oauth'] = { alpha: CLAUDE_TOKEN }
  fs.writeFileSync(env.keychainFile, JSON.stringify(keychain))
}

async function typeIntoRemote(page: Page, tabId: string, text: string): Promise<void> {
  await page.evaluate(([id, line]) => window.api.terminal.write(id, line), [tabId, text])
  await page.waitForTimeout(PAST_THE_PASTE_THAT_SWALLOWS_AN_EARLY_ENTER_MS)
  await page.evaluate((id) => window.api.terminal.write(id, '\r'), tabId)
}

test.describe('A conductor on this Mac looking after a Claude session on an SSH machine (Docker)', () => {
  test('E-SSH-C1: the conductor types a message into the remote session and hears it finished; the session’s question reaches the channel whole, and koloft session answer presses the key that answers it', async ({
    env
  }) => {
    await withRemoteWorkspaceConductor(
      env,
      () => undefined,
      async ({ page, lab, fake }) => {
        await startSessionIn(page, 'kt-key', { remote: true })
        const remote = (await page.evaluate(() => window.api.sessions.list())).find(
          (s) => s.alive && !s.conductor
        )!
        const transcript = (): string => transcriptOnTarget(lab, remote.sessionId)

        fake.say(OWNER, `/koloft session send ${remote.sessionId} hello from Discord`)
        await expect
          .poll(transcript, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toContain('(Your owner, via the Koloft conductor:) hello from Discord')
        await expect
          .poll(() => notices(fake), { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toEqual([expect.stringMatching(/^🔔 .+ finished\.$/)])

        await page.evaluate(
          ([id, line]) => window.api.terminal.write(id, line),
          [remote.tabId, '/ask Which colour?|Red|Green\r']
        )
        await expect
          .poll(() => said(fake).join('\n'), {
            timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS
          })
          .toMatch(
            /(^|\n)❓ .+ is waiting for you: Which colour\?\n1\. Red — The Red one\n2\. Green — The Green one(\n|$)/
          )
        await expect
          .poll(() => statusOf(page, remote.tabId), {
            timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS
          })
          .toBe('approval')
        fake.say(OWNER, `/koloft session answer ${remote.sessionId} 2`)
        await expect
          .poll(transcript, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toContain('Picked: Green')
        await expect
          .poll(() => notices(fake), { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toEqual([
            expect.stringMatching(/^🔔 /),
            expect.stringMatching(/^❓ /),
            expect.stringMatching(/^🔔 .+ finished\.$/)
          ])
      }
    )
  })

  test('E-SSH-C2: the same with a REAL claude on the machine (opt-in, spends real money): a typed message is answered, and its own question is answered by koloft session answer', async ({
    env
  }) => {
    test.skip(
      !HAVE_LINUX_CLAUDE,
      'set KOLOFT_SMOKE_CLAUDE_LINUX (a Linux claude binary for the lab machine’s CPU) and KOLOFT_SMOKE_OAUTH_TOKEN or KOLOFT_SMOKE_ACCOUNT'
    )
    test.setTimeout(4 * A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS + 180_000)
    await withRemoteWorkspaceConductor(
      env,
      (lab) => useRealClaudeOnTheMachine(env, lab),
      async ({ page, lab, fake }) => {
        await openMenu(page, page.locator('.ws-head', { hasText: 'kt-key' }))
        await page.locator('.menu .mi', { hasText: 'New session' }).click()
        await expect
          .poll(
            async () =>
              (await page.evaluate(() => window.api.sessions.list())).find(
                (s) => s.alive && !s.conductor && s.sessionId
              )?.sessionId ?? '',
            { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS }
          )
          .not.toBe('')
        const remote = (await page.evaluate(() => window.api.sessions.list())).find(
          (s) => s.alive && !s.conductor
        )!
        const transcript = (): string => transcriptOnTarget(lab, remote.sessionId)

        fake.say(
          OWNER,
          `/koloft session send ${remote.sessionId} Say the word MANGO and nothing else.`
        )
        await expect
          .poll(transcript, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS })
          .toContain('(Your owner, via the Koloft conductor:) Say the word MANGO')
        await expect
          .poll(transcript, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS })
          .toMatch(/"type":"text","text":"MANGO/)
        await expect
          .poll(() => notices(fake), { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS })
          .toContainEqual(expect.stringMatching(/^🔔 .+ finished\.$/))

        await typeIntoRemote(
          page,
          remote.tabId,
          'Call your AskUserQuestion tool once, with the single question "Which colour?" and exactly two options, Red then Green. After I answer, reply with only the colour I picked, in capitals.'
        )
        await expect
          .poll(() => said(fake).join('\n'), {
            timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
          })
          .toMatch(/(^|\n)❓ .+ is waiting for you: Which colour\?\n1\. Red.*\n2\. Green/)
        await expect
          .poll(() => statusOf(page, remote.tabId), {
            timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
          })
          .toBe('approval')
        fake.say(OWNER, `/koloft session answer ${remote.sessionId} 2`)
        await expect
          .poll(transcript, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS })
          .toMatch(/"type":"text","text":"GREEN/)
        await expect
          .poll(() => notices(fake).filter((l) => /^🔔 .+ finished\.$/.test(l)).length, {
            timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
          })
          .toBe(2)
      }
    )
  })
})
