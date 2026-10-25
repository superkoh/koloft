import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { spawnSync } from 'child_process'
import {
  BrowserTunnels,
  addressFilesCmd,
  type BrowserTunnelDeps
} from '../../src/main/remote/browserTunnel'
import { MACHINE_PLAYWRIGHT_CLI, PLAYWRIGHT_CLI_VERSION } from '../../src/main/remote/playwrightCli'
import type { RunResult } from '../../src/main/remote/ssh'

const HOST = 'devbox'
const PATH_A = 'a'.repeat(32)
const PATH_B = 'b'.repeat(32)
const relay = (port: number, p: string): string => `ws://127.0.0.1:${port}/cdp/${p}`
const ok = (stdout = '', stderr = ''): RunResult => ({ code: 0, stdout, stderr })

interface Machine {
  pid: string | null
  refuse: boolean
  nextPort: number
  forwards: string[]
  cancels: string[]
  files: Map<string, string>
  writes: number
}

let dir: string
let m: Machine
let deps: BrowserTunnelDeps

function runOnMachine(cmd: string): RunResult {
  const home = path.join(dir, 'machine')
  fs.mkdirSync(home, { recursive: true })
  const r = spawnSync('/bin/sh', ['-c', cmd], {
    encoding: 'utf8',
    env: { HOME: home, PATH: '/usr/bin:/bin' }
  })
  return { code: r.status, stdout: r.stdout, stderr: r.stderr }
}

function filesOnMachine(): Record<string, string> {
  const tabs = path.join(dir, 'machine', '.koloft', 'tabs')
  if (!fs.existsSync(tabs)) return {}
  return Object.fromEntries(
    fs.readdirSync(tabs).map((f) => [f, fs.readFileSync(path.join(tabs, f), 'utf8')])
  )
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-tunnel-'))
  m = {
    pid: '100',
    refuse: false,
    nextPort: 40001,
    forwards: [],
    cancels: [],
    files: new Map(),
    writes: 0
  }
  deps = {
    master: async (_host, op) => {
      if (op[1] === 'check')
        return m.pid
          ? ok('', `Master running (pid=${m.pid})`)
          : { code: 255, stdout: '', stderr: 'No such file' }
      if (op[1] === 'forward') {
        m.forwards.push(op[3])
        return m.refuse
          ? { code: 255, stdout: '', stderr: 'remote port forwarding failed for listen port 0' }
          : ok(`${m.nextPort++}\n`)
      }
      m.cancels.push(op[3])
      return ok()
    },
    run: async (_host, cmd) => {
      m.writes++
      return runOnMachine(cmd)
    },
    forwardFile: (host) => path.join(dir, 'mac', host, 'browser-forward.json')
  }
})

describe("the browser tunnel to a machine: one ssh -R per master, each Claude Code tab's address in a file there", () => {
  it('forwards the relay once and writes each tab its own address on the machine port', async () => {
    const t = new BrowserTunnels(deps)
    const tabs = [
      { tabId: 'tab1', endpoint: relay(5000, PATH_A) },
      { tabId: 'tab2', endpoint: relay(5000, PATH_B) }
    ]
    await t.sync(HOST, tabs)
    await t.sync(HOST, tabs)
    expect(m.forwards).toEqual(['0:127.0.0.1:5000'])
    expect(filesOnMachine()).toEqual({
      'tab1.cdp': relay(40001, PATH_A),
      'tab2.cdp': relay(40001, PATH_B)
    })
    expect(m.writes).toBe(1)
  })

  it('a new master (the link came back) gets a new forward and every file is rewritten', async () => {
    const t = new BrowserTunnels(deps)
    const tabs = [{ tabId: 'tab1', endpoint: relay(5000, PATH_A) }]
    await t.sync(HOST, tabs)
    m.pid = null
    await t.sync(HOST, tabs)
    m.pid = '200'
    await t.sync(HOST, tabs)
    expect(m.forwards).toEqual(['0:127.0.0.1:5000', '0:127.0.0.1:5000'])
    expect(m.cancels).toEqual([])
    expect(filesOnMachine()).toEqual({ 'tab1.cdp': relay(40002, PATH_A) })
  })

  it('a Koloft restart on the same master cancels the old forward with the spec exactly as asked, then forwards the new relay', async () => {
    await new BrowserTunnels(deps).sync(HOST, [{ tabId: 'tab1', endpoint: relay(5000, PATH_A) }])
    const afterRestart = new BrowserTunnels(deps)
    await afterRestart.sync(HOST, [{ tabId: 'tab1', endpoint: relay(6000, PATH_B) }])
    expect(m.cancels).toEqual(['0:127.0.0.1:5000'])
    expect(m.forwards).toEqual(['0:127.0.0.1:5000', '0:127.0.0.1:6000'])
    expect(filesOnMachine()).toEqual({ 'tab1.cdp': relay(40002, PATH_B) })
  })

  it('browser control switched off cancels the forward and removes the files; a closed tab loses its file', async () => {
    const t = new BrowserTunnels(deps)
    await t.sync(HOST, [
      { tabId: 'tab1', endpoint: relay(5000, PATH_A) },
      { tabId: 'tab2', endpoint: relay(5000, PATH_B) }
    ])
    await t.sync(HOST, [{ tabId: 'tab1', endpoint: relay(5000, PATH_A) }])
    expect(Object.keys(filesOnMachine())).toEqual(['tab1.cdp'])
    await t.sync(HOST, [{ tabId: 'tab1', endpoint: '' }])
    expect(m.cancels).toEqual(['0:127.0.0.1:5000'])
    expect(filesOnMachine()).toEqual({})
  })

  it('a machine whose sshd refuses forwarding is asked once per master, and its tabs get no file', async () => {
    m.refuse = true
    const t = new BrowserTunnels(deps)
    const tabs = [{ tabId: 'tab1', endpoint: relay(5000, PATH_A) }]
    await t.sync(HOST, tabs)
    await t.sync(HOST, tabs)
    expect(m.forwards).toHaveLength(1)
    expect(filesOnMachine()).toEqual({})
  })

  it('a machine with no Claude Code tab is never asked anything', async () => {
    await new BrowserTunnels(deps).sync(HOST, [])
    expect(m.forwards).toEqual([])
    expect(m.writes).toBe(0)
  })

  it('the address file is written so no other account on the machine can read it', () => {
    expect(runOnMachine(addressFilesCmd([['tab1', relay(1, PATH_A)]])).code).toBe(0)
    const mode = fs.statSync(path.join(dir, 'machine', '.koloft', 'tabs', 'tab1.cdp')).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe("the playwright-cli on the machine reads its tab's address each time it runs", () => {
  function run(env: Record<string, string>, address?: string): { env: string; stderr: string } {
    const home = path.join(dir, 'home')
    const bin = path.join(dir, 'bin')
    const js = path.join(
      home,
      '.koloft',
      `playwright-cli-${PLAYWRIGHT_CLI_VERSION}`,
      'lib/node_modules/@playwright/cli/playwright-cli.js'
    )
    fs.mkdirSync(path.dirname(js), { recursive: true })
    fs.writeFileSync(js, '')
    fs.mkdirSync(path.join(home, '.koloft', 'tabs'), { recursive: true })
    if (address) fs.writeFileSync(path.join(home, '.koloft', 'tabs', 'tab1.cdp'), address)
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho "$1 $*" >&2\nenv\n`, { mode: 0o755 })
    const script = path.join(dir, 'playwright-cli')
    fs.writeFileSync(script, MACHINE_PLAYWRIGHT_CLI, { mode: 0o755 })
    const r = spawnSync('/bin/sh', [script, 'snapshot'], {
      encoding: 'utf8',
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, ...env }
    })
    return { env: r.stdout, stderr: r.stderr }
  }

  it('drives the Workbench browser at the address Koloft last wrote, in a cli session of its own tab', () => {
    const r = run({ KOLOFT_TAB_ID: 'tab1' }, relay(40001, PATH_A))
    expect(r.env).toContain(`PLAYWRIGHT_MCP_CDP_ENDPOINT=${relay(40001, PATH_A)}`)
    expect(r.env).toContain(`KOLOFT_BROWSER_CDP=${relay(40001, PATH_A)}`)
    expect(r.env).toContain('PLAYWRIGHT_CLI_SESSION=koloft-tab1')
    expect(r.env).toContain('PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=1')
    expect(r.stderr).toContain('playwright-cli.js snapshot')
  })

  it('with no address says why, and still runs', () => {
    const r = run({ KOLOFT_TAB_ID: 'tab1' })
    expect(r.env).not.toContain('PLAYWRIGHT_MCP_CDP_ENDPOINT')
    expect(r.stderr).toContain('no way to the Workbench browser')
    expect(r.stderr).toContain('playwright-cli.js snapshot')
  })

  it('a Workbench shell never takes its session tab’s browser', () => {
    const r = run({ KOLOFT_TAB_ID: 'tab1', KOLOFT_UTIL: '1' }, relay(40001, PATH_A))
    expect(r.env).not.toContain('PLAYWRIGHT_MCP_CDP_ENDPOINT')
  })
})
