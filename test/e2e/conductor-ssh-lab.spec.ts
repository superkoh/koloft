import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { defaultControlDir } from '../../src/main/remote/ssh'
import { ownerSays } from '../../src/shared/agentGuide'
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
import { startFakeDiscord, type FakeDiscord } from './helpers/fakeDiscord'

const OWNER = { id: '555', username: 'letian' }
const CHANNEL = '222'
const CHANNEL_NAME = 'koloft-all'
const BACKGROUND_CONNECT_MS = 45_000
const A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS = 60_000
const A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS = 180_000
const PAST_TWO_IDLE_MIRROR_PULLS_YET_BEFORE_CLAUDES_IDLE_NOTICE_MS = 45_000
const CONDUCTOR_SCREEN_DRAWS_AFTER_IT_IS_SHOWN_MS = 2000
const PAST_THE_PASTE_THAT_SWALLOWS_AN_EARLY_ENTER_MS = 1000

test.describe.configure({ timeout: 420_000 })
test.beforeAll(() =>
  test.skip(!dockerAvailable(), 'needs a running Docker (for example `colima start`)')
)

function said(fake: FakeDiscord): string[] {
  return fake.posted.filter((p) => p.channelId === CHANNEL).map((p) => p.content)
}

function handedToTheButler(env: E2EEnv): string[] {
  const file = path.join(env.home, 'fake-claude-peer.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { message: { content: string } }).message.content)
}

function channelRow(dlg: Locator, name: string): Locator {
  return dlg.locator('.cb-row', {
    has: dlg.page().locator('.wt-name', { hasText: new RegExp(`^#${name}$`) })
  })
}

async function bindButlerChannel(page: Page): Promise<void> {
  await openMenu(page, page.locator('.isl-butler > .ws-tab'))
  await page.locator('.menu .mi', { hasText: 'Bind Discord channel…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
  await expect(dlg).toBeVisible()
  await channelRow(dlg, CHANNEL_NAME).click()
  await dlg.locator('.modal-foot .btn-primary').click()
  await expect(dlg).toHaveCount(0)
}

async function allTerminals(page: Page): Promise<string> {
  await page
    .locator('.isl-butler > .ws-tab')
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
    assist: { on: true, backend: 'claude' },
    discord: { userId: OWNER.id, userName: OWNER.username }
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
    await bindButlerChannel(page)
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

test.describe('The butler on this Mac looking after a Claude session on an SSH machine (Docker)', () => {
  test('E-SSH-C1: the butler types a message into the remote session; the session’s question shows its row waiting for approval and is answered by the butler with koloft session answer, and the next with koloft session keys, pressed through ssh and tmux; the reply that ends that turn is handed to the butler, whose answer reaches the channel; the only card that reaches it is the ⌨️ result card of the fake’s /koloft session send (the fake’s /koloft runs no model turn, unlike the real claude’s koloft skill, whose answer takes that card’s place)', async ({
    env
  }) => {
    await withRemoteWorkspaceConductor(
      env,
      () => undefined,
      async ({ page, lab, fake }) => {
        await startSessionIn(page, 'kt-key', { remote: true })
        const remote = (await page.evaluate(() => window.api.sessions.list())).find(
          (s) => s.alive && !s.butler
        )!
        const transcript = (): string => transcriptOnTarget(lab, remote.sessionId)
        const remoteStatus = async (): Promise<string | undefined> =>
          (await page.evaluate(() => window.api.sessions.list())).find(
            (s) => s.sessionId === remote.sessionId
          )?.status

        fake.say(OWNER, `/koloft session send ${remote.sessionId} hello from Discord`)
        await expect
          .poll(transcript, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toContain(ownerSays('hello from Discord'))
        await expect
          .poll(remoteStatus, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toMatch(/^(waiting|idle)$/)

        await page.evaluate(
          ([id, line]) => window.api.terminal.write(id, line),
          [remote.tabId, '/ask Which colour?|Red|Green\r']
        )
        await expect
          .poll(remoteStatus, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toBe('approval')
        fake.say(OWNER, `/koloft session answer ${remote.sessionId} 2`)
        await expect
          .poll(transcript, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toContain('Picked: Green')
        await expect
          .poll(remoteStatus, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toMatch(/^(waiting|idle)$/)

        await page.evaluate(
          ([id, line]) => window.api.terminal.write(id, line),
          [remote.tabId, '/ask Which size?|Small|Large\r']
        )
        await expect
          .poll(remoteStatus, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toBe('approval')
        fake.say(OWNER, `/koloft session keys ${remote.sessionId} 1`)
        await expect
          .poll(transcript, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toContain('Picked: Small')
        await expect
          .poll(
            () => said(fake).some((s) => s.includes(`, id ${remote.sessionId}:) Picked: Small`)),
            { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS }
          )
          .toBe(true)
        expect(fake.posted.filter((p) => p.card).map((p) => p.content.split('\n')[0])).toEqual([
          `⌨️ **Alfred** ran /koloft session send ${remote.sessionId} hello from Discord:`
        ])
      }
    )
  })

  test('E-SSH-C3: the butler’s koloft session command types /context and /compact into the remote session, and what it printed comes back to the butler through the mirror', async ({
    env
  }) => {
    await withRemoteWorkspaceConductor(
      env,
      () => undefined,
      async ({ page, fake }) => {
        await startSessionIn(page, 'kt-key', { remote: true })
        const remote = (await page.evaluate(() => window.api.sessions.list())).find(
          (s) => s.alive && !s.butler
        )!

        fake.say(OWNER, `/koloft session command ${remote.sessionId} /context`)
        await expect
          .poll(() => handedToTheButler(env), {
            timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS
          })
          .toContainEqual(
            expect.stringMatching(/\(From Koloft:\) ⌨️ .+ ran \/context:\n## Context Usage/)
          )

        fake.say(OWNER, `/koloft session command ${remote.sessionId} /compact`)
        await expect
          .poll(() => handedToTheButler(env), {
            timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS
          })
          .toContainEqual(expect.stringMatching(/\(From Koloft:\) ⌨️ .+ ran \/compact:\nCompacted/))
      }
    )
  })

  test('E-SSH-C2: the same with a REAL claude on the machine (opt-in, spends real money): a typed message is answered, its own question is answered by koloft session answer, and after a /compact it shows done again, not working', async ({
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
                (s) => s.alive && !s.butler && s.sessionId
              )?.sessionId ?? '',
            { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS }
          )
          .not.toBe('')
        const remote = (await page.evaluate(() => window.api.sessions.list())).find(
          (s) => s.alive && !s.butler
        )!
        const transcript = (): string => transcriptOnTarget(lab, remote.sessionId)
        const remoteStatus = async (): Promise<string | undefined> =>
          (await page.evaluate(() => window.api.sessions.list())).find(
            (s) => s.sessionId === remote.sessionId
          )?.status

        fake.say(
          OWNER,
          `/koloft session send ${remote.sessionId} Say the word MANGO and nothing else.`
        )
        await expect
          .poll(transcript, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS })
          .toContain(ownerSays('Say the word MANGO'))
        await expect
          .poll(transcript, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS })
          .toMatch(/"type":"text","text":"MANGO/)

        await typeIntoRemote(
          page,
          remote.tabId,
          'Call your AskUserQuestion tool once, with the single question "Which colour?" and exactly two options, Red then Green. After I answer, reply with only the colour I picked, in capitals.'
        )
        await expect
          .poll(remoteStatus, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS })
          .toBe('approval')
        fake.say(OWNER, `/koloft session answer ${remote.sessionId} 2`)
        await expect
          .poll(transcript, { timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS })
          .toMatch(/"type":"text","text":"GREEN/)
        await expect
          .poll(remoteStatus, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toMatch(/^(waiting|idle)$/)

        fake.say(OWNER, `/koloft session command ${remote.sessionId} /compact`)
        await expect
          .poll(() => handedToTheButler(env), {
            timeout: A_REAL_MODEL_TURN_THROUGH_THE_MIRROR_MS
          })
          .toContainEqual(
            expect.stringMatching(/ran \/compact:\nCompacted \(ctrl\+o to see full summary\)/)
          )
        await expect
          .poll(remoteStatus, { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS })
          .toMatch(/^(waiting|idle)$/)
        await page.waitForTimeout(PAST_TWO_IDLE_MIRROR_PULLS_YET_BEFORE_CLAUDES_IDLE_NOTICE_MS)
        expect(await remoteStatus()).toMatch(/^(waiting|idle)$/)
      }
    )
  })
})
