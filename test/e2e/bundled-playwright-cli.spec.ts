import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex } from './helpers/env'
import { startLocalSession } from './helpers/codex'
import { agentShell, waitBooted, wsRows } from './helpers/p1'
import { startEchoServer } from './helpers/fixtureServer'

const A_CLI_STEP_FINISHES_WITHIN_MS = 60_000

test.describe('the playwright-cli Koloft ships, run from a Claude Code or Codex session on this computer', () => {
  for (const backend of ['claude', 'codex'] as const) {
    test(`${backend}: drives the tab's own Workbench page, and wins over a playwright-cli the user installed`, async ({
      env
    }) => {
      test.setTimeout(180_000)
      if (backend === 'codex') installCodex(env)
      fs.writeFileSync(
        path.join(env.fakeBin, 'playwright-cli'),
        '#!/bin/sh\necho "the user\'s own playwright-cli"\n',
        { mode: 0o755 }
      )
      const server = await startEchoServer()
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await startLocalSession(page, env, backend)
        const tabId = (await wsRows(page, 'ws-a').getAttribute('data-tab-id'))!
        const title = `bundled-${Date.now().toString(36)}`
        const url = server.page('/bundled', `<title>${title}</title><body>bundled cli</body>`)
        const run = agentShell(page, tabId, A_CLI_STEP_FINISHES_WITHIN_MS)

        expect(
          await run(
            `found=$(command -v playwright-cli); { echo "$found"; readlink "$found"; } | grep -c '/commands/[0-9a-f]*/bin/playwright-cli$'`
          )
        ).toMatch(/^(> )?1$/m)
        expect(await run(`playwright-cli open ${url}`)).toContain(`Page Title: ${title}`)
        const screen = await run('playwright-cli eval document.title')
        expect(screen).toContain(`"${title}"`)
        expect(screen).not.toContain("the user's own playwright-cli")
        expect(screen).toMatch(/sh exit=0[\s\S]*sh exit=0[\s\S]*sh exit=0/)
        await run('playwright-cli close')
      } finally {
        await quitAndClose(app)
        await server.close()
      }
    })
  }
})
