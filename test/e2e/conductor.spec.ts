import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, pendingAttention, quitAndClose } from './helpers/app'
import { installCodex, seedSettings, type E2EEnv } from './helpers/env'
import {
  centerTerm,
  notesIsland,
  openMenu,
  readCalls,
  runIn,
  settingsOnDisk,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import type { ConductorBinding, DiscordSettings } from '../../src/shared/types'

test.setTimeout(120_000)

const LINK_A = 'https://discord.com/channels/111/222'
const LINK_B = 'https://discord.com/channels/111/333'
const ROWS_RESCAN_AND_PUSH_SETTLE_MS = 1500
const KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS = 30_000

function bindingsOnDisk(env: E2EEnv): ConductorBinding[] {
  return (settingsOnDisk(env).discord as DiscordSettings | undefined)?.bindings ?? []
}

function island(page: Page): Locator {
  return page.locator('.isl-conductors')
}

function conductorRow(page: Page, name: string): Locator {
  return island(page).locator('.ws-tab', { has: page.locator('.ws-tab-title', { hasText: name }) })
}

async function bindFromWorkspaceMenu(
  page: Page,
  wsName: string,
  opts: { scope?: string; backend?: 'Claude' | 'Codex'; link: string }
): Promise<void> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'Bind Discord channel…' }).click()
  const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
  await expect(dlg).toBeVisible()
  if (opts.scope) await dlg.locator('.cb-row', { hasText: opts.scope }).click()
  if (opts.backend) await dlg.getByRole('button', { name: opts.backend }).click()
  await dlg.getByLabel('Channel link').fill(opts.link)
  await dlg.locator('.modal-foot .btn-primary').click()
  await expect(dlg).toHaveCount(0)
}

async function openConductor(page: Page, name: string): Promise<void> {
  if (await island(page).getByRole('button', { name: 'Unfold' }).count())
    await island(page).getByRole('button', { name: 'Unfold' }).click()
  await conductorRow(page, name).click()
  await expect(conductorRow(page, name)).toHaveClass(/st-waiting/, { timeout: 60_000 })
}

async function conductorTabId(page: Page, binding: ConductorBinding): Promise<string> {
  const sessions = await page.evaluate(() => window.api.sessions.list())
  const live = sessions.find((s) => s.alive && binding.sessionIds.includes(s.sessionId))
  if (!live) throw new Error('the conductor has no live tab')
  return live.tabId
}

function shownTermText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const terms =
      (
        window as unknown as {
          __koloftTerms?: Record<
            string,
            {
              element?: HTMLElement
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
    for (const t of Object.values(terms)) {
      const wrap = t.element?.closest('.term-island .term-wrap')
      if (!t.element || !wrap || wrap.getClientRects().length === 0) continue
      const b = t.buffer.active
      let text = ''
      for (let i = 0; i < b.length; i++)
        text += (b.getLine(i)?.translateToString(true) ?? '') + '\n'
      return text
    }
    return ''
  })
}

async function launched(env: E2EEnv): Promise<{ page: Page; close: () => Promise<void> }> {
  seedSettings(env, { hintsOff: true })
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  return { page, close: () => quitAndClose(app) }
}

test.describe('Conductors: a session bound to a Discord channel, kept in its own island and out of every workspace list', () => {
  test('a workspace conductor bound through the dialog opens in its workspace folder, stays out of the workspace rows across /clear, raises no turn-done mark, and unbinding closes it', async ({
    env
  }) => {
    const { page, close } = await launched(env)
    try {
      await expect(island(page)).toHaveCount(0)
      await bindFromWorkspaceMenu(page, 'ws-a', { link: LINK_A })
      expect(bindingsOnDisk(env)).toMatchObject([
        {
          scope: env.workspaces.a,
          backend: 'claude',
          channel: { guildId: '111', channelId: '222' }
        }
      ])
      await expect(island(page).locator('.wb-title')).toHaveText('Conductors')
      await expect(island(page).locator('.ws-tab')).toHaveCount(0)

      await openConductor(page, 'ws-a')
      const call = (await waitForCalls(env, 1))[0]
      expect(call.cwd).toBe(env.workspaces.a)
      await expect.poll(() => bindingsOnDisk(env)[0]?.sessionIds.length).toBe(1)
      await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-a')

      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)
      const tabId = await conductorTabId(page, bindingsOnDisk(env)[0])
      expect((await pendingAttention(page)).filter((e) => e.tabId === tabId)).toEqual([])

      await page.evaluate((id) => window.api.terminal.write(id, '/clear\r'), tabId)
      await expect.poll(() => bindingsOnDisk(env)[0]?.sessionIds.length).toBe(2)
      expect(bindingsOnDisk(env)[0].lastSessionKey).toBe(bindingsOnDisk(env)[0].sessionIds[1])
      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)

      await conductorRow(page, 'ws-a').click({ button: 'right' })
      await page.locator('.menu .mi', { hasText: 'Unbind' }).click()
      await expect(island(page)).toHaveCount(0)
      expect(bindingsOnDisk(env)).toEqual([])
      await expect
        .poll(async () =>
          (await page.evaluate(() => window.api.sessions.list())).some((s) => s.tabId === tabId)
        )
        .toBe(false)
    } finally {
      await close()
    }
  })

  test('the global conductor runs in the conductors folder under userData, shows no workspace note, and its koloft note says it has no workspace', async ({
    env
  }) => {
    const { page, close } = await launched(env)
    try {
      await bindFromWorkspaceMenu(page, 'ws-a', { scope: 'Global', link: LINK_A })
      expect(bindingsOnDisk(env)).toMatchObject([{ scope: 'global' }])
      await openConductor(page, 'Global')
      const call = (await waitForCalls(env, 1))[0]
      expect(call.cwd).toBe(path.join(env.userData, 'conductors', 'global'))
      await expect(notesIsland(page)).toHaveCount(0)

      await runIn(page, centerTerm(page), '/koloft note')
      await expect
        .poll(() => shownTermText(page), { timeout: KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS })
        .toContain('The global conductor has no workspace.')
    } finally {
      await close()
    }
  })

  test('removing a workspace drops its conductor binding, and the second binding of a channel is refused', async ({
    env
  }) => {
    const { page, close } = await launched(env)
    try {
      await bindFromWorkspaceMenu(page, 'ws-b', { link: LINK_B })
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Bind Discord channel…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
      await dlg.getByLabel('Channel link').fill(LINK_B)
      await dlg.locator('.modal-foot .btn-primary').click()
      await expect(dlg.locator('.field-hint.bad')).toHaveText(
        'That channel is already bound to the ws-b conductor.'
      )
      await dlg.getByRole('button', { name: 'Cancel' }).click()

      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-b' }))
      await page.locator('.menu .mi', { hasText: 'Remove workspace' }).click()
      await expect(page.locator('.ws-head', { hasText: 'ws-b' })).toHaveCount(0)
      await expect.poll(() => bindingsOnDisk(env)).toEqual([])
      await expect(island(page)).toHaveCount(0)
    } finally {
      await close()
    }
  })

  test('a Codex conductor gets its role as developer instructions and its session stays out of the workspace rows', async ({
    env
  }) => {
    installCodex(env)
    const { page, close } = await launched(env)
    try {
      await bindFromWorkspaceMenu(page, 'ws-a', { backend: 'Codex', link: LINK_A })
      expect(bindingsOnDisk(env)).toMatchObject([{ backend: 'codex' }])
      await openConductor(page, 'ws-a')
      await expect.poll(() => bindingsOnDisk(env)[0]?.sessionIds.length).toBe(1)
      const servers = fs
        .readFileSync(path.join(env.home, 'fake-codex-server-calls.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { argv: string[] })
      expect(
        servers.some((s) =>
          s.argv.some(
            (a) =>
              a.startsWith('developer_instructions=') &&
              a.includes(`conductor for the workspace ${env.workspaces.a}`)
          )
        )
      ).toBe(true)
      expect(readCalls(env)).toEqual([])
      await page.waitForTimeout(ROWS_RESCAN_AND_PUSH_SETTLE_MS)
      await expect(wsRows(page, 'ws-a')).toHaveCount(0)
    } finally {
      await close()
    }
  })
})
