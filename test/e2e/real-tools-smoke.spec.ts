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

/**
 * Issue · P1 acceptance ② — the smoke the rest of the suite cannot stand in for:
 * the REAL third-party tools, unmodified, connecting to Koloft through the endpoint its
 * shim injects. Everything else about the relay is tested against Playwright's own
 * `connectOverCDP`; this is the only place that answers "does playwright-mcp, the
 * package a user actually installs, work here with nothing configured".
 *
 * OPT-IN, because a repo's test suite must not depend on the network or on a package
 * outside it. Install the tools once, anywhere, and point at them:
 *
 *   mkdir -p /tmp/koloft-smoke && cd /tmp/koloft-smoke && npm init -y
 *   npm install @playwright/cli @playwright/mcp
 *   KOLOFT_SMOKE_TOOLS_DIR=/tmp/koloft-smoke/node_modules/.bin npm run test:e2e
 *
 * Without that variable every case here skips, and says so.
 *
 * Cases: BB-56, BB-57 (+ a multi-step task), BB-58, BB-63, BB-64.
 */

const BIN = process.env.KOLOFT_SMOKE_TOOLS_DIR ?? ''
const HAVE_TOOLS = !!BIN && fs.existsSync(path.join(BIN, 'playwright-mcp'))

test.skip(
  !HAVE_TOOLS,
  'real-tool smoke: set KOLOFT_SMOKE_TOOLS_DIR to a node_modules/.bin holding @playwright/cli and @playwright/mcp'
)

// "did the tool start a browser of its own" can only be asked of the whole machine, and
// BB-58 answers it by deliberately starting one. Run these one at a time, or that browser
// is alive inside another case's before/after comparison and the count lies.
test.describe.configure({ mode: 'serial' })

const endpointOf = cdpEndpointOf

/** `startSessionIn` waits for the session to bind, which is the barrier the old
 *  Preview-icon gate was — and the fake claude still records its launch env, because the
 *  product path launches through the real shim. */
async function startSession(page: Page): Promise<void> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
}

async function drivenSession(page: Page, env: E2EEnv): Promise<string> {
  await startSession(page)
  return await endpointOf(env)
}

/**
 * Browsers on this machine that some automation started. The tell is Playwright's own
 * launch flags, NOT the binary path: a tool sent back to its own browser reaches for the
 * machine's Google Chrome, not for the ms-playwright bundle, so a
 * path-shaped check would quietly match nothing and make every "no second browser"
 * assertion here vacuous.
 */
function automationBrowsers(): string[] {
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

/** one `playwright-cli` command, run to completion */
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

/** collect `wanted` JSON-RPC replies from an MCP server on stdio */
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
        } catch {
          /* not a json frame */
        }
        if (replies.length >= wanted) return resolve(replies)
      }
    })
    setTimeout(() => resolve(replies), 120_000)
  })
}

/** start a real playwright-mcp and ask it to navigate once */
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

// BB-56 — the headline claim of the whole feature: nothing to configure.
test('BB-56: playwright-mcp drives Koloft with nothing configured', async ({ page, env }) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    const url = await drivenSession(page, env)
    const before = automationBrowsers().length

    const target = server.page('/mcp', '<title>Mcp</title><body>mcp</body>')
    // the ONLY configuration is the variable Koloft's shim already injected — no flags
    const { proc, replies } = mcpNavigate(env, target, { endpoint: url })
    const text = toolText(await replies)

    expect(text).toContain(target)
    expect(text).toContain('Mcp')
    // it drove OUR browser rather than starting one of its own
    expect(automationBrowsers().length).toBe(before)
    await openBrowser(page)
    await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
    // still connected at this point: the mark goes away with the client (BB-54), so it
    // has to be read before the server is killed
    await expect(page.locator(BROWSER.drivenTab)).toHaveCount(1, { timeout: 30_000 })
    proc.kill()
  } finally {
    await server.close()
  }
})

// BB-57 — the generic variable, through the real CLI, including a screenshot: an
// offscreen stage that produces no frames would return a blank or hang here.
test('BB-57: the Playwright CLI attaches, drives, and gets a real screenshot', async ({
  page,
  env
}) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    const url = await drivenSession(page, env)
    const before = automationBrowsers().length

    const attach = cli(['attach', `--cdp=${url}`], env.home)
    expect((await attach).code).toBe(0)

    const target = server.page('/cli', '<title>Cli</title><body><h1>cli page</h1></body>')
    expect((await cli(['goto', target], env.home)).code).toBe(0)
    const snap = await cli(['snapshot'], env.home)
    expect(snap.code).toBe(0)
    expect((await cli(['screenshot'], env.home)).code).toBe(0)

    // a real image, not a blank one: a solid-colour PNG of this size is ~2KB
    const shots = fs
      .readdirSync(path.join(env.home, '.playwright-cli'))
      .filter((f) => f.endsWith('.png'))
    expect(shots.length).toBeGreaterThan(0)
    const bytes = fs.statSync(path.join(env.home, '.playwright-cli', shots[0])).size
    expect(bytes).toBeGreaterThan(4000)

    expect(automationBrowsers().length).toBe(before)
    await openBrowser(page)
    await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
    await cli(['close'], env.home)
  } finally {
    await server.close()
  }
})

// BB-57, the zero-configuration half for the CLI. It shares playwright-mcp's config
// loader, so the one variable the shim injects is enough: `playwright-cli open` connects
// to Koloft instead of launching a browser of its own — no flag, no `attach`. This is the
// path an agent following the stock playwright-cli skill actually takes, `--headed` and
// all (that flag is about a browser it would launch, and it launches none).
test('BB-57: `playwright-cli open` with only the injected variable drives Koloft, not a browser of its own', async ({
  page,
  env
}) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    const url = await drivenSession(page, env)
    const before = automationBrowsers().length
    const injected = { PLAYWRIGHT_MCP_CDP_ENDPOINT: url }
    const target = server.page('/opened', '<title>Opened</title><body><h1>opened</h1></body>')

    const opened = cli(['open', '--headed', target], env.home, injected)
    expect((await opened).code).toBe(0)
    expect((await cli(['eval', 'document.title'], env.home, injected)).out).toContain('Opened')

    expect(automationBrowsers().length).toBe(before) // it drove OUR browser
    await openBrowser(page)
    await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
    await cli(['close'], env.home, injected)
  } finally {
    await server.close()
  }
})

// BB-57, the task-shaped half — what an agent actually does with the CLI is not one
// screenshot but a chain: read the page, fill a form, submit it, read the answer, move
// on and come back. Every link of that chain is a different CDP surface the relay
// forwards (DOM/accessibility for the snapshot, Input for fill and click,
// Runtime.evaluate for the read, Page navigation + history for the rest), so one
// automation of a real page is the case that says "a tool can DO things here", not
// merely "a tool can connect".
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
    const next = server.page('/thanks', '<title>Thanks</title><body><h1 id="t">thanks</h1></body>')

    const attach = cli(['attach', `--cdp=${url}`], env.home)
    expect((await attach).code).toBe(0)
    expect((await cli(['goto', form], env.home)).code).toBe(0)

    // the refs come off the tool's own snapshot, the way an agent finds them
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

    // …and the page's own history works through the relay like a browser's
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

// BB-58 — the switch is the way out, and "out" means the tool goes back to its own
// browser: with it off there is nothing in the env for the tool to find.
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
    // the positive barrier before acting on "off": a session started while the click
    // is still landing is launched with the endpoint, and the case then fails on the
    // injection it was supposed to prove absent (measured, under parallel load)
    await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 10_000 })
    await page.keyboard.press('Escape')

    await startSession(page)
    const call = readCalls(env).at(-1)
    expect(call?.cdpEndpoint ?? null).toBeNull()
    expect(call?.playwrightMcpEndpoint ?? null).toBeNull()

    const before = automationBrowsers().length
    const target = server.page('/own', '<title>Own</title><body>own</body>')
    // --headless: this runs on the developer's own Mac, and a window must never surface
    const { proc, replies } = mcpNavigate(env, target, { args: ['--headless'] })
    const text = toolText(await replies)
    expect(text).toContain(target)
    expect(automationBrowsers().length).toBeGreaterThan(before)
    proc.kill()

    await openBrowser(page)
    await expect(openTabs(page)).toHaveCount(0)
  } finally {
    await server.close()
  }
})

// BB-63 — an explicit endpoint flag beats the injected variable, so one tool can be sent
// elsewhere without touching the switch. Pointed at a dead port, the tool fails THERE:
// Koloft is never asked to hand anything over.
test('BB-63: an explicit --cdp-endpoint overrides the injected variable', async ({ page, env }) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    const url = await drivenSession(page, env)
    const { proc, replies } = mcpNavigate(
      env,
      server.page('/never', '<title>Never</title><body>n</body>'),
      { endpoint: url, args: ['--cdp-endpoint=ws://127.0.0.1:9/cdp/deadbeefdeadbeefdeadbeefdead'] }
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

// BB-64 — the documented limit. `--isolated` asks for a private browser context, and this
// endpoint has none to give: the tool connects to Koloft anyway (the variable wins) and then
// fails on its first command. It is NOT a way out — the switch is.
test('BB-64: --isolated does not escape the endpoint; it fails against it', async ({
  page,
  env
}) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    const url = await drivenSession(page, env)
    const before = automationBrowsers().length
    const { proc, replies } = mcpNavigate(
      env,
      server.page('/iso', '<title>Iso</title><body>i</body>'),
      { endpoint: url, args: ['--isolated'] }
    )
    const text = toolText(await replies)
    proc.kill()

    expect(text).toContain('createBrowserContext')
    expect(automationBrowsers().length).toBe(before) // it did not go get its own browser
  } finally {
    await server.close()
  }
})
