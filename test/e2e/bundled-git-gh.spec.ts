import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex } from './helpers/env'
import { startLocalSession } from './helpers/codex'
import { agentShell, openSessionTerminal, panelTerm, runIn, waitBooted, wsRows } from './helpers/p1'

const A_SHELL_STEP_FINISHES_WITHIN_MS = 30_000

test.describe('the git and gh Koloft ships, as a Claude Code or Codex session on this computer and its terminal find them', () => {
  for (const backend of ['claude', 'codex'] as const) {
    test(`${backend}: on a Mac with no git of its own the agent and the terminal run the git Koloft ships, and the gh Koloft ships sits in the last folder on the PATH, behind any gh of the user’s`, async ({
      env
    }) => {
      test.setTimeout(180_000)
      env.launchEnv.KOLOFT_TEST_CLT = 'missing'
      if (backend === 'codex') installCodex(env)
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await page.waitForLoadState('domcontentloaded')
        await waitBooted(page)
        await startLocalSession(page, env, backend)
        const tabId = (await wsRows(page, 'ws-a').getAttribute('data-tab-id'))!
        const run = agentShell(page, tabId, A_SHELL_STEP_FINISHES_WITHIN_MS)

        expect(await run('git --version')).toContain('git version 2.53.0')
        expect(
          await run('last=$(printf "%s" "$PATH" | tr ":" "\\n" | tail -n 1); "$last/gh" --version')
        ).toContain('gh version 2.102.0')

        await openSessionTerminal(app, page)
        await runIn(page, panelTerm(page), 'git --version | sed "s/^/TERM_/"')
        await expect(panelTerm(page)).toContainText('TERM_git version 2.53.0', { timeout: 25_000 })
      } finally {
        await quitAndClose(app)
      }
    })

    test(`${backend}: a Mac with its own git and gh keeps both: the agent runs a gh and a git that are not the ones Koloft ships`, async ({
      env
    }) => {
      test.setTimeout(180_000)
      fs.writeFileSync(path.join(env.fakeBin, 'gh'), '#!/bin/sh\necho "the user\'s own gh"\n', {
        mode: 0o755
      })
      if (backend === 'codex') installCodex(env)
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await startLocalSession(page, env, backend)
        const tabId = (await wsRows(page, 'ws-a').getAttribute('data-tab-id'))!
        const run = agentShell(page, tabId, A_SHELL_STEP_FINISHES_WITHIN_MS)

        const gh = await run('gh --version')
        expect(gh).toMatch(/the user's own gh|gh version \d/)
        expect(gh).not.toContain('gh version 2.102.0')
        expect(await run('git --version')).not.toContain('git version 2.53.0')
      } finally {
        await quitAndClose(app)
      }
    })
  }
})
