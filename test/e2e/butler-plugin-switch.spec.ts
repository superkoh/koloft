import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installAgy, installCodex, installMuse, seedSettings, type E2EEnv } from './helpers/env'
import {
  butlerRow,
  butlerSessionOnDisk,
  centerTerm,
  runIn,
  terminalText,
  waitBooted
} from './helpers/p1'
import { closeSettings, openSettings } from './helpers/extensions'
import type { BackendId } from '../../src/shared/types'

const INSTALL: Record<BackendId, (env: E2EEnv) => void> = {
  claude: () => {},
  codex: installCodex,
  muse: installMuse,
  agy: installAgy
}

const TOLD_TODO_IS_OFF = 'TheownerchangedSettings▸Pluginsafterthisconversationbegan:Todoisnowoff.'

function fileText(env: E2EEnv, name: string): string {
  const file = path.join(env.home, name)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

async function heardBy(page: Page, env: E2EEnv, tab: string): Promise<string> {
  return (
    (await terminalText(page, tab)) +
    fileText(env, 'fake-claude-peer.jsonl') +
    fileText(env, 'fake-codex-wire.jsonl')
  ).replace(/\s+/g, '')
}

async function switchTodo(page: Page, on: boolean): Promise<void> {
  await openSettings(page)
  await page.locator('.set-ni', { hasText: 'Plugins' }).click()
  await page.getByRole('switch', { name: 'Todo', exact: true }).setChecked(on)
  await closeSettings(page)
}

test.describe('The butler while a plugin switch changes', () => {
  for (const backend of ['claude', 'codex', 'muse', 'agy'] as const)
    // CC§23 CODEX§17 MUSE§9 AGY§8
    test(`a ${backend} butler that is open is told at once, in its own tab, that the owner turned Todo off in Settings ▸ Plugins`, async ({
      env
    }) => {
      test.setTimeout(180_000)
      INSTALL[backend](env)
      seedSettings(env, { hintsOff: true, assist: { backend } })
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await butlerRow(page).click()
        await expect(butlerRow(page)).toHaveClass(/\bactive\b/, { timeout: 60_000 })
        const tab = (await butlerRow(page).getAttribute('data-tab-id'))!
        // AGY§8
        if (backend === 'agy') await runIn(page, centerTerm(page), 'hello')
        await expect
          .poll(() => butlerSessionOnDisk(env)?.sessionIds.length ?? 0, { timeout: 60_000 })
          .toBe(1)
        await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })

        await switchTodo(page, false)
        await expect
          .poll(() => heardBy(page, env, tab), { timeout: 60_000 })
          .toContain(TOLD_TODO_IS_OFF)
      } finally {
        await quitAndClose(app)
      }
    })
})
