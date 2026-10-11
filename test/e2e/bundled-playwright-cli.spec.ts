import fs from 'fs'
import path from 'path'
import { test, expect } from './helpers/app'
import { startSessionIn, terminalText, waitBooted, wsRows } from './helpers/p1'
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
      const run = async (command: string, marks: number): Promise<string> => {
        await page.evaluate(
          ([id, line]) => window.api.terminal.write(id, line),
          [tabId, `/sh ${command}\r`]
        )
        await expect
          .poll(async () => (await terminalText(page, tabId)).split('sh exit=').length - 1, {
            timeout: A_CLI_STEP_FINISHES_WITHIN_MS
          })
          .toBe(marks)
        return terminalText(page, tabId)
      }

      expect(
        await run(
          "command -v playwright-cli | grep -c '/playwright-cli/[0-9a-f]*/bin/playwright-cli$'",
          1
        )
      ).toMatch(/^1$/m)
      expect(await run(`playwright-cli open ${url}`, 2)).toContain(`Page Title: ${title}`)
      const screen = await run('playwright-cli eval document.title', 3)
      expect(screen).toContain(`"${title}"`)
      expect(screen).not.toContain("the user's own playwright-cli")
      expect(screen).toMatch(/sh exit=0[\s\S]*sh exit=0[\s\S]*sh exit=0/)
      expect(server.count('/bundled')).toBeGreaterThanOrEqual(1)
      await run('playwright-cli close', 4)
    } finally {
      await server.close()
    }
  })
})
