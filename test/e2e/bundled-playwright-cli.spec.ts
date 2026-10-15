import fs from 'fs'
import path from 'path'
import { test, expect } from './helpers/app'
import { agentShell, startSessionIn, waitBooted, wsRows } from './helpers/p1'
import { startEchoServer } from './helpers/fixtureServer'

const A_CLI_STEP_FINISHES_WITHIN_MS = 60_000

test.describe('the playwright-cli Koloft ships, run from a Claude Code session on this computer', () => {
  test("drives the tab's own Workbench page, and wins over a playwright-cli the user installed", async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    fs.writeFileSync(
      path.join(env.fakeBin, 'playwright-cli'),
      '#!/bin/sh\necho "the user\'s own playwright-cli"\n',
      { mode: 0o755 }
    )
    const server = await startEchoServer()
    try {
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const tabId = (await wsRows(page, 'ws-a').getAttribute('data-tab-id'))!
      const title = `bundled-${Date.now().toString(36)}`
      const url = server.page('/bundled', `<title>${title}</title><body>bundled cli</body>`)
      const run = agentShell(page, tabId, A_CLI_STEP_FINISHES_WITHIN_MS)

      expect(
        await run("command -v playwright-cli | grep -c '/commands/[0-9a-f]*/bin/playwright-cli$'")
      ).toMatch(/^(> )?1$/m)
      expect(await run(`playwright-cli open ${url}`)).toContain(`Page Title: ${title}`)
      const screen = await run('playwright-cli eval document.title')
      expect(screen).toContain(`"${title}"`)
      expect(screen).not.toContain("the user's own playwright-cli")
      expect(screen).toMatch(/sh exit=0[\s\S]*sh exit=0[\s\S]*sh exit=0/)
      await run('playwright-cli close')
    } finally {
      await server.close()
    }
  })
})
