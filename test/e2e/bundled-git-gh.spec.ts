import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import {
  agentShell,
  openSessionTerminal,
  panelTerm,
  runIn,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'

const A_SHELL_STEP_FINISHES_WITHIN_MS = 30_000

test.describe('the git and gh Koloft ships, as a Claude Code session on this computer and its terminal find them', () => {
  test('on a Mac with no git of its own the agent and the terminal run the git Koloft ships, and with no gh of the user’s the agent runs the gh Koloft ships', async ({
    env
  }) => {
    test.setTimeout(180_000)
    env.launchEnv.KOLOFT_TEST_CLT = 'missing'
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const tabId = (await wsRows(page, 'ws-a').getAttribute('data-tab-id'))!
      const run = agentShell(page, tabId, A_SHELL_STEP_FINISHES_WITHIN_MS)

      expect(await run('git --version')).toContain('git version 2.53.0')
      expect(await run('gh --version')).toContain('gh version 2.102.0')

      await openSessionTerminal(app, page)
      await runIn(page, panelTerm(page), 'git --version | sed "s/^/TERM_/"')
      await expect(panelTerm(page)).toContainText('TERM_git version 2.53.0', { timeout: 25_000 })
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('a Mac with its own git and gh keeps both: the agent runs the user’s gh and the user’s git', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    fs.writeFileSync(path.join(env.fakeBin, 'gh'), '#!/bin/sh\necho "the user\'s own gh"\n', {
      mode: 0o755
    })
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const tabId = (await wsRows(page, 'ws-a').getAttribute('data-tab-id'))!
    const run = agentShell(page, tabId, A_SHELL_STEP_FINISHES_WITHIN_MS)

    expect(await run('gh --version')).toContain("the user's own gh")
    expect(await run('git --version')).not.toContain('git version 2.53.0')
  })
})
