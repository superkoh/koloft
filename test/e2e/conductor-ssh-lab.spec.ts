import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { defaultControlDir } from '../../src/main/remote/ssh'
import { addWorkspace, openMenu, startSessionIn, waitBooted, wsGroup } from './helpers/p1'
import {
  HAVE_LINUX_CLAUDE,
  NEEDS_LINUX_CLAUDE,
  dockerAvailable,
  installLabSsh,
  remoteKeyFor,
  startSshLab,
  stopSshLab,
  transcriptOnTarget,
  useRealClaudeOnTheMachine,
  type SshLab
} from './helpers/docker'
import { openerNow, startFakeDiscord, type FakeDiscord, type FakePost } from './helpers/fakeDiscord'

const OWNER = { id: '555', username: 'letian' }
const CHANNEL = '222'
const CHANNEL_NAME = 'koloft-all'
const BACKGROUND_CONNECT_MS = 45_000
const A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS = 60_000
const A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS = 180_000
const CONDUCTOR_SCREEN_DRAWS_AFTER_IT_IS_SHOWN_MS = 2000
const PAST_THE_PASTE_THAT_SWALLOWS_AN_EARLY_ENTER_MS = 1000

test.describe.configure({ timeout: 420_000 })
test.beforeAll(() =>
  test.skip(!dockerAvailable(), 'needs a running Docker (for example `colima start`)')
)

function heard(fake: FakeDiscord): FakePost[] {
  const threads = fake.threads.filter((t) => t.parentId === CHANNEL).map((t) => t.id)
  return fake.posted.filter((p) => p.channelId === CHANNEL || threads.includes(p.channelId))
}

function said(fake: FakeDiscord): string[] {
  return heard(fake).map((p) => p.content)
}

function notices(fake: FakeDiscord): string[] {
  return said(fake)
    .map((p) => p.split('\n')[0])
    .filter((l) => /^(🔔|❓|⏹)/.test(l))
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

async function typeIntoRemote(page: Page, tabId: string, text: string): Promise<void> {
  await page.evaluate(([id, line]) => window.api.terminal.write(id, line), [tabId, text])
  await page.waitForTimeout(PAST_THE_PASTE_THAT_SWALLOWS_AN_EARLY_ENTER_MS)
  await page.evaluate((id) => window.api.terminal.write(id, '\r'), tabId)
}

test.describe('A conductor on this Mac looking after a Claude session on an SSH machine (Docker)', () => {
  test('E-SSH-C1: the conductor types a message into the remote session and hears it finished in the session’s thread; the session’s question reaches the thread whole, and its button presses the key that answers it; the owner’s message in the thread is typed into the remote session and its reply comes back there', async ({
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
        const question = (): FakePost | undefined =>
          heard(fake).find((p) =>
            /^❓ .+ is waiting for you\.\nWhich colour\?\n1\. Red — The Red one\n2\. Green — The Green one\n/.test(
              p.content
            )
          )
        await expect
          .poll(question, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toBeTruthy()
        const thread = question()!.channelId
        expect(fake.threads.map((t) => t.id)).toContain(thread)
        const opener = (): string | undefined => openerNow(fake, CHANNEL, thread)
        await expect
          .poll(opener, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toMatch(/^❓ \*\*.+\*\* · needs you, asked <t:\d+:R>\n-# .+ · Claude$/)
        fake.press(OWNER, question()!.buttons![1], thread)
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

        fake.say(OWNER, '[Discord] typed in the thread', { channelId: thread })
        await expect
          .poll(() => said(fake).join('\n'), {
            timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS
          })
          .toContain('finished.\nAnswer to: [Discord] typed in the thread')
        expect(fake.typing).toContain(thread)
        await expect
          .poll(opener, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toMatch(/^✅ \*\*.+\*\* · turn done <t:\d+:R>/)
      }
    )
  })

  test('E-SSH-C3: the owner’s /run and /compact are typed into the remote session, and what it printed comes back through the mirror', async ({
    env
  }) => {
    await withRemoteWorkspaceConductor(
      env,
      () => undefined,
      async ({ page, fake }) => {
        await startSessionIn(page, 'kt-key', { remote: true })
        const remote = (await page.evaluate(() => window.api.sessions.list())).find(
          (s) => s.alive && !s.conductor
        )!
        const ran = (): string[] => said(fake).filter((p) => p.startsWith('⌨️ '))

        fake.interact(OWNER, 'run', { command: '/context', session: remote.sessionId })
        await expect
          .poll(ran, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toEqual([expect.stringMatching(/ran \/context:\n## Context Usage/)])

        fake.interact(OWNER, 'compact', { session: remote.sessionId })
        await expect
          .poll(() => ran().at(-1), { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toMatch(/ran \/compact:\nCompacted/)
      }
    )
  })

  test('E-SSH-C4: the conductor answers the remote session’s question with koloft session keys, pressed through ssh and tmux', async ({
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
        await page.evaluate(
          ([id, line]) => window.api.terminal.write(id, line),
          [remote.tabId, '/ask Which colour?|Red|Green\r']
        )
        await expect
          .poll(() => notices(fake), { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toContainEqual(expect.stringMatching(/^❓ /))
        fake.say(OWNER, `/koloft session keys ${remote.sessionId} 2`)
        await expect
          .poll(() => transcriptOnTarget(lab, remote.sessionId), {
            timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS
          })
          .toContain('Picked: Green')
      }
    )
  })

  test('E-SSH-C2: the same with a REAL claude on the machine (opt-in, spends real money): a typed message is answered, and its own question is answered by koloft session answer', async ({
    env
  }) => {
    test.skip(!HAVE_LINUX_CLAUDE, NEEDS_LINUX_CLAUDE)
    test.setTimeout(5 * A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS + 180_000)
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
          .toMatch(/(^|\n)❓ .+ is waiting for you\.\nWhich colour\?\n1\. Red.*\n2\. Green/)
        fake.say(OWNER, `/koloft session answer ${remote.sessionId} 2`)
        await expect
          .poll(transcript, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS })
          .toMatch(/"type":"text","text":"GREEN/)
        await expect
          .poll(() => notices(fake).filter((l) => /^🔔 .+ finished\.$/.test(l)).length, {
            timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
          })
          .toBe(2)

        fake.interact(OWNER, 'compact', { session: remote.sessionId })
        await expect
          .poll(
            () =>
              said(fake)
                .filter((p) => p.startsWith('⌨️ '))
                .at(-1),
            {
              timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
            }
          )
          .toMatch(/ran \/compact:\nCompacted \(ctrl\+o to see full summary\)$/)
      }
    )
  })
})
