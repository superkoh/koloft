import { execFileSync, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import { readCalls, startSessionIn, waitBooted } from './helpers/p1'
import { BROWSER, cdpEndpointOf, openBrowser, openTabs } from './helpers/browser'
import { openSettings } from './helpers/extensions'
import { startEchoServer } from './helpers/fixtureServer'

const BIN = process.env.KOLOFT_SMOKE_TOOLS_DIR ?? ''
const HAVE_TOOLS = !!BIN && fs.existsSync(path.join(BIN, 'playwright-mcp'))

test.skip(
  !HAVE_TOOLS,
  'real-tool smoke: set KOLOFT_SMOKE_TOOLS_DIR to a node_modules/.bin holding @playwright/cli and @playwright/mcp'
)

const MACHINE_WIDE_BROWSER_COUNT_NEEDS_ONE_CASE_AT_A_TIME = { mode: 'serial' } as const
test.describe.configure(MACHINE_WIDE_BROWSER_COUNT_NEEDS_ONE_CASE_AT_A_TIME)

const endpointOf = cdpEndpointOf
const LARGER_THAN_A_BLANK_SCREENSHOT_BYTES = 4000

async function startSession(page: Page): Promise<void> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
}

async function drivenSession(page: Page, env: E2EEnv): Promise<string> {
  await startSession(page)
  return await endpointOf(env)
}

// PLATFORM§17
function browsersWithPlaywrightLaunchFlags(): string[] {
  const out = execFileSync('/bin/sh', [
    '-c',
    "ps ax -o command= | grep -e '--disable-field-trial-config' | grep -v grep | grep -v Zoom || true"
  ])
    .toString()
    .trim()
  return out ? out.split('\n') : []
}

function collect(p: ChildProcess): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = ''
    p.stdout?.on('data', (d) => (out += String(d)))
    p.stderr?.on('data', (d) => (out += String(d)))
    p.on('close', (code) => resolve({ code, out }))
  })
}

function cli(
  args: string[],
  cwd: string,
  extraEnv: NodeJS.ProcessEnv = {}
): Promise<{ code: number | null; out: string }> {
  return collect(
    spawn(path.join(BIN, 'playwright-cli'), args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...extraEnv }
    })
  )
}

interface McpReply {
  id?: number
  result?: { content?: { type: string; text: string }[]; isError?: boolean }
}

function mcpReplies(proc: ChildProcess, wanted: number): Promise<McpReply[]> {
  return new Promise((resolve) => {
    const replies: McpReply[] = []
    let buf = ''
    proc.stdout?.on('data', (d) => {
      buf += String(d)
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (!line) continue
        try {
          replies.push(JSON.parse(line) as McpReply)
        } catch {}
        if (replies.length >= wanted) return resolve(replies)
      }
    })
    setTimeout(() => resolve(replies), 120_000)
  })
}

function mcpNavigate(
  env: E2EEnv,
  url: string,
  opts: { endpoint?: string; args?: string[] }
): { proc: ChildProcess; replies: Promise<McpReply[]> } {
  const childEnv = { ...process.env }
  delete childEnv.PLAYWRIGHT_MCP_CDP_ENDPOINT
  if (opts.endpoint) childEnv.PLAYWRIGHT_MCP_CDP_ENDPOINT = opts.endpoint
  const proc = spawn(path.join(BIN, 'playwright-mcp'), opts.args ?? [], {
    cwd: env.home,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const replies = mcpReplies(proc, 2)
  const send = (m: object): void => void proc.stdin?.write(`${JSON.stringify(m)}\n`)
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'koloft-smoke', version: '1' }
    }
  })
  send({ jsonrpc: '2.0', method: 'notifications/initialized' })
  send({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'browser_navigate', arguments: { url } }
  })
  return { proc, replies }
}

function toolText(replies: McpReply[]): string {
  return replies
    .flatMap((r) => r.result?.content ?? [])
    .map((c) => c.text)
    .join('\n')
}

test.describe('real third-party tools (playwright-mcp, playwright-cli), unmodified, drive Koloft through the endpoint its shim injects', () => {
  test('BB-56: playwright-mcp drives Koloft with nothing configured', async ({ page, env }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      const url = await drivenSession(page, env)
      const before = browsersWithPlaywrightLaunchFlags().length

      const target = server.page('/mcp', '<title>Mcp</title><body>mcp</body>')
      const { proc, replies } = mcpNavigate(env, target, { endpoint: url })
      const text = toolText(await replies)

      expect(text).toContain(target)
      expect(text).toContain('Mcp')
      expect(browsersWithPlaywrightLaunchFlags().length).toBe(before)
      await openBrowser(page)
      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
      await expect(page.locator(BROWSER.drivenTab)).toHaveCount(1, { timeout: 30_000 })
      proc.kill()
    } finally {
      await server.close()
    }
  })

  test('BB-57: the Playwright CLI attaches, drives, and gets a real (non-blank) screenshot', async ({
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      const url = await drivenSession(page, env)
      const before = browsersWithPlaywrightLaunchFlags().length

      const attach = cli(['attach', `--cdp=${url}`], env.home)
      expect((await attach).code).toBe(0)

      const target = server.page('/cli', '<title>Cli</title><body><h1>cli page</h1></body>')
      expect((await cli(['goto', target], env.home)).code).toBe(0)
      const snap = await cli(['snapshot'], env.home)
      expect(snap.code).toBe(0)
      expect((await cli(['screenshot'], env.home)).code).toBe(0)

      const shots = fs
        .readdirSync(path.join(env.home, '.playwright-cli'))
        .filter((f) => f.endsWith('.png'))
      expect(shots.length).toBeGreaterThan(0)
      const bytes = fs.statSync(path.join(env.home, '.playwright-cli', shots[0])).size
      expect(bytes).toBeGreaterThan(LARGER_THAN_A_BLANK_SCREENSHOT_BYTES)

      expect(browsersWithPlaywrightLaunchFlags().length).toBe(before)
      await openBrowser(page)
      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
      await cli(['close'], env.home)
    } finally {
      await server.close()
    }
  })

  test('BB-57: `playwright-cli open` with only the injected variable drives Koloft, not a browser of its own', async ({
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      const url = await drivenSession(page, env)
      const before = browsersWithPlaywrightLaunchFlags().length
      const injected = { PLAYWRIGHT_MCP_CDP_ENDPOINT: url }
      const target = server.page('/opened', '<title>Opened</title><body><h1>opened</h1></body>')

      const opened = cli(['open', '--headed', target], env.home, injected)
      expect((await opened).code).toBe(0)
      expect((await cli(['eval', 'document.title'], env.home, injected)).out).toContain('Opened')

      expect(browsersWithPlaywrightLaunchFlags().length).toBe(before)
      await openBrowser(page)
      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
      await cli(['close'], env.home, injected)
    } finally {
      await server.close()
    }
  })

  test('BB-57: a multi-step task through the real CLI — fill a form, read the result, move on and back', async ({
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      const url = await drivenSession(page, env)
      const form = server.page(
        '/order',
        '<title>Order</title><body><h1>Order form</h1>' +
          '<form id="f"><label>Name <input id="name" name="name"></label> ' +
          '<button id="go" type="submit">Place order</button></form>' +
          '<p>Result: <b id="out">nothing yet</b></p>' +
          '<script>document.getElementById("f").addEventListener("submit",function(e){e.preventDefault();' +
          'document.getElementById("out").textContent="Order for "+document.getElementById("name").value})' +
          '</script></body>'
      )
      const next = server.page(
        '/thanks',
        '<title>Thanks</title><body><h1 id="t">thanks</h1></body>'
      )

      const attach = cli(['attach', `--cdp=${url}`], env.home)
      expect((await attach).code).toBe(0)
      expect((await cli(['goto', form], env.home)).code).toBe(0)

      const snap = await cli(['snapshot'], env.home)
      expect(snap.code).toBe(0)
      const nameRef = /textbox "Name"[^\n]*\[ref=(e\d+)\]/.exec(snap.out)?.[1]
      const goRef = /button "Place order"[^\n]*\[ref=(e\d+)\]/.exec(snap.out)?.[1]
      expect(nameRef, snap.out).toBeTruthy()
      expect(goRef, snap.out).toBeTruthy()

      expect((await cli(['fill', nameRef!, 'Koloft'], env.home)).code).toBe(0)
      expect((await cli(['click', goRef!], env.home)).code).toBe(0)
      const read = await cli(['eval', 'document.getElementById("out").textContent'], env.home)
      expect(read.code).toBe(0)
      expect(read.out).toContain('Order for Koloft')

      expect((await cli(['goto', next], env.home)).code).toBe(0)
      expect((await cli(['eval', 'document.title'], env.home)).out).toContain('Thanks')
      expect((await cli(['go-back'], env.home)).code).toBe(0)
      expect((await cli(['eval', 'document.title'], env.home)).out).toContain('Order')

      await openBrowser(page)
      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
      await cli(['close'], env.home)
    } finally {
      await server.close()
    }
  })

  test('BB-58: with browser control off, nothing is injected and the tool goes elsewhere', async ({
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      await openSettings(page)
      await page.locator('.set-ni', { hasText: 'Extensions' }).click()
      const toggle = page
        .locator('.set-row', { hasText: 'Let agents drive this Browser' })
        .locator('button[role="switch"], input[type="checkbox"], .switch')
        .first()
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 10_000 })
      await page.keyboard.press('Escape')

      await startSession(page)
      const call = readCalls(env).at(-1)
      expect(call?.cdpEndpoint ?? null).toBeNull()
      expect(call?.playwrightMcpEndpoint ?? null).toBeNull()

      const before = browsersWithPlaywrightLaunchFlags().length
      const target = server.page('/own', '<title>Own</title><body>own</body>')
      const { proc, replies } = mcpNavigate(env, target, { args: ['--headless'] })
      const text = toolText(await replies)
      expect(text).toContain(target)
      expect(browsersWithPlaywrightLaunchFlags().length).toBeGreaterThan(before)
      proc.kill()

      await openBrowser(page)
      await expect(openTabs(page)).toHaveCount(0)
    } finally {
      await server.close()
    }
  })

  test('BB-63: an explicit --cdp-endpoint overrides the injected variable', async ({
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      const url = await drivenSession(page, env)
      const { proc, replies } = mcpNavigate(
        env,
        server.page('/never', '<title>Never</title><body>n</body>'),
        {
          endpoint: url,
          args: ['--cdp-endpoint=ws://127.0.0.1:9/cdp/deadbeefdeadbeefdeadbeefdead']
        }
      )
      const text = toolText(await replies)
      proc.kill()

      expect(text).toContain('127.0.0.1:9')
      await openBrowser(page)
      await expect(openTabs(page)).toHaveCount(0)
    } finally {
      await server.close()
    }
  })

  test('BB-64: --isolated does not escape the endpoint; it fails against it (only the switch is a way out)', async ({
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const server = await startEchoServer()
    try {
      const url = await drivenSession(page, env)
      const before = browsersWithPlaywrightLaunchFlags().length
      const { proc, replies } = mcpNavigate(
        env,
        server.page('/iso', '<title>Iso</title><body>i</body>'),
        { endpoint: url, args: ['--isolated'] }
      )
      const text = toolText(await replies)
      proc.kill()

      expect(text).toContain('createBrowserContext')
      expect(browsersWithPlaywrightLaunchFlags().length).toBe(before)
    } finally {
      await server.close()
    }
  })
})
