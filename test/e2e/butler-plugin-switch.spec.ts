import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installAgy, installCodex, installMuse, seedSettings, type E2EEnv } from './helpers/env'
import {
  butlerRow,
  butlerSessionOnDisk,
  centerTerm,
  landsOnTheButler,
  runIn,
  terminalText,
  waitBooted
} from './helpers/p1'
import { switchPlugin } from './helpers/extensions'
import { SESSION_BACKENDS } from '../../src/shared/sessionBackend'
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

test.describe('The butler while a plugin switch changes', () => {
  for (const backend of SESSION_BACKENDS)
    // CC§23 CODEX§17 MUSE§9 AGY§8
    test(`a ${backend} butler that is open is told, in its own tab, that the owner turned Todo off in Settings ▸ Plugins`, async ({
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
        await landsOnTheButler(page)
        const tab = (await butlerRow(page).getAttribute('data-tab-id'))!
        // AGY§8
        if (backend === 'agy') await runIn(page, centerTerm(page), 'hello')
        await expect
          .poll(() => butlerSessionOnDisk(env)?.sessionIds.length ?? 0, { timeout: 60_000 })
          .toBe(1)
        await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })

        await switchPlugin(page, 'Todo', false)
        await expect
          .poll(() => heardBy(page, env, tab), { timeout: 60_000 })
          .toContain(TOLD_TODO_IS_OFF)
      } finally {
        await quitAndClose(app)
      }
    })
})
