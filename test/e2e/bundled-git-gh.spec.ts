import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import {
  openSessionTerminal,
  panelTerm,
  runIn,
  startSessionIn,
  terminalText,
  waitBooted,
  wsRows
} from './helpers/p1'

const A_SHELL_STEP_FINISHES_WITHIN_MS = 30_000

function agentShell(page: Page, tabId: string): (command: string) => Promise<string> {
  let steps = 0
  return async (command) => {
    steps += 1
    await page.evaluate(
      ([id, line]) => window.api.terminal.write(id, line),
      [tabId, `/sh ${command}\r`]
    )
    await expect
      .poll(async () => (await terminalText(page, tabId)).split('sh exit=').length - 1, {
        timeout: A_SHELL_STEP_FINISHES_WITHIN_MS
      })
      .toBe(steps)
    return terminalText(page, tabId)
  }
}

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
      const run = agentShell(page, (await wsRows(page, 'ws-a').getAttribute('data-tab-id'))!)

      expect(await run('echo "AGENT_GIT=$(command -v git)"')).toMatch(/AGENT_GIT=\S*\/git-bin\/git/)
      expect(await run('git --version')).toContain('git version 2.53.0')
      expect(await run('echo "AGENT_GH=$(command -v gh)"')).toMatch(
        /AGENT_GH=\S*\/fallback-bin\/gh/
      )

      await openSessionTerminal(app, page)
      await runIn(page, panelTerm(page), 'echo "TERM_GIT=$(command -v git)"')
      await expect(panelTerm(page)).toContainText(/TERM_GIT=\S*\/git-bin\/git/, {
        timeout: 25_000
      })
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('a Mac with its own git and gh keeps both: the agent runs the user’s gh, and Koloft’s git is not on its PATH', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    fs.writeFileSync(path.join(env.fakeBin, 'gh'), '#!/bin/sh\necho "the user\'s own gh"\n', {
      mode: 0o755
    })
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const run = agentShell(page, (await wsRows(page, 'ws-a').getAttribute('data-tab-id'))!)

    expect(await run('gh --version')).toContain("the user's own gh")
    const screen = await run('echo "AGENT_GIT=$(command -v git)"')
    expect(screen).toMatch(/AGENT_GIT=\//)
    expect(screen).not.toContain('/git-bin/')
  })
})
