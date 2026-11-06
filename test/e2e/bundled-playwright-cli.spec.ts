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
    test(`${backend}: drives the tab's own Workbench page, wins over a playwright-cli the user installed, and writes its snapshots to the tab's own temp folder, leaving the workspace clean`, async ({
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
            `realpath "$(command -v playwright-cli)" | grep -c '/commands/[0-9a-f]*/bin/playwright-cli$'`
          )
        ).toMatch(/^(> )?1$/m)
        const outputDirFile = path.join(env.home, 'playwright-output-dir.txt')
        await run(`printenv PLAYWRIGHT_MCP_OUTPUT_DIR > '${outputDirFile}'`)
        const tabOutputDir = fs.readFileSync(outputDirFile, 'utf8').trim()
        expect(tabOutputDir).toMatch(new RegExp(`/koloft-playwright/${tabId}$`))
        expect(await run(`playwright-cli open ${url}`)).toContain(`Page Title: ${title}`)
        expect(fs.readdirSync(tabOutputDir).some((f) => f.endsWith('.yml'))).toBe(true)
        expect(fs.existsSync(path.join(env.workspaces.a, '.playwright-cli'))).toBe(false)
        const screen = await run('playwright-cli eval document.title')
        expect(screen).toContain(`"${title}"`)
        expect(screen).not.toContain("the user's own playwright-cli")
        expect(screen.match(/sh exit=0/g)).toHaveLength(4)
        await run('playwright-cli close')
      } finally {
        await quitAndClose(app)
        await server.close()
      }
    })
  }
})
