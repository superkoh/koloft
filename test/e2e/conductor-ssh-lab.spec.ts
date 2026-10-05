import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings } from './helpers/env'
import { defaultControlDir } from '../../src/main/remote/ssh'
import { addWorkspace, openMenu, startSessionIn, waitBooted, wsGroup } from './helpers/p1'
import {
  dockerAvailable,
  installLabSsh,
  remoteKeyFor,
  runOnTarget,
  startSshLab,
  stopSshLab
} from './helpers/docker'
import { startFakeDiscord, type FakeDiscord } from './helpers/fakeDiscord'

const OWNER = { id: '555', username: 'letian' }
const CHANNEL = '222'
const CHANNEL_NAME = 'koloft-all'
const BACKGROUND_CONNECT_MS = 45_000
const A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS = 60_000

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

async function bindChannel(page: Page, wsName: string): Promise<void> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'Bind Discord channel…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
  await expect(dlg).toBeVisible()
  await channelRow(dlg, CHANNEL_NAME).click()
  await dlg.locator('.modal-foot .btn-primary').click()
  await expect(dlg).toHaveCount(0)
}

async function allTerminals(app: ElectronApplication): Promise<string> {
  const page = await app.firstWindow()
  const unfold = page.locator('.isl-conductors').getByRole('button', { name: 'Unfold' })
  if (await unfold.count()) await unfold.click()
  await page
    .locator('.isl-conductors .ws-tab')
    .click({ timeout: 5000 })
    .catch(() => undefined)
  await page.waitForTimeout(2000)
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

function channelRow(dlg: Locator, name: string): Locator {
  return dlg.locator('.cb-row', {
    has: dlg.page().locator('.wt-name', { hasText: new RegExp(`^#${name}$`) })
  })
}

test.describe('A conductor on this Mac looking after a Claude session on an SSH machine (Docker)', () => {
  test('E-SSH-C1: the conductor types a message into the remote session and hears it finished; the session’s question reaches the channel whole, and koloft session answer presses the key that answers it', async ({
    env
  }) => {
    seedSettings(env, {
      hintsOff: true,
      discord: { userId: OWNER.id, userName: OWNER.username, bindings: [] }
    })
    const fake = await startFakeDiscord(env)
    const lab = await startSshLab(env)
    let app: ElectronApplication | null = null
    try {
      installLabSsh(env, lab)
      app = await launchApp(env)
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      expect((await addWorkspace(page, remoteKeyFor('kt-key', 'kuser'))).code).toBe('added')
      await expect(wsGroup(page, 'kt-key').locator('.ws-conn')).toHaveClass(/\bon\b/, {
        timeout: BACKGROUND_CONNECT_MS
      })
      await bindChannel(page, 'kt-key')
      await startSessionIn(page, 'kt-key', { remote: true })
      const remote = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.alive && !s.conductor
      )!
      const transcript = (): string => {
        try {
          return runOnTarget(lab, 'kuser', `cat .claude/projects/*/${remote.sessionId}.jsonl`)
        } catch {
          return ''
        }
      }

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
        .poll(
          async () =>
            (await page.evaluate(() => window.api.sessions.list())).find(
              (s) => s.tabId === remote.tabId
            )?.status,
          { timeout: A_LINE_THROUGH_SSH_AND_BACK_BY_THE_MIRROR_MS }
        )
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
    } finally {
      await test.info().attach('channel', { body: said(fake).join('\n────\n') })
      if (app) await test.info().attach('terminals', { body: await allTerminals(app) })
      if (app) await quitAndClose(app)
      stopSshLab(lab, defaultControlDir())
      await fake.close()
    }
  })
})
