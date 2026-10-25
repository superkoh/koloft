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
import {
  MACHINE_PLAYWRIGHT_CLI,
  PLAYWRIGHT_CLI_JS_UNDER_ITS_FOLDER,
  PLAYWRIGHT_CLI_UNDER_KOLOFT_HOME,
  PLAYWRIGHT_CLI_VERSION
} from '../../src/main/remote/playwrightCli'
import type { RunResult } from '../../src/main/remote/ssh'

const HOST = 'devbox'
const PATH_A = 'a'.repeat(32)
const PATH_B = 'b'.repeat(32)
const relay = (port: number, p: string): string => `ws://127.0.0.1:${port}/cdp/${p}`
const ok = (stdout = '', stderr = ''): RunResult => ({ code: 0, stdout, stderr })
const TIMED_OUT: RunResult = { code: null, stdout: '', stderr: '' }
const SSHD_REFUSES: RunResult = {
  code: 255,
  stdout: '',
  stderr:
    'mux_client_forward: forwarding request failed: remote port forwarding failed for listen port 0'
}

interface Machine {
  pid: string | null
  forwardAnswer?: RunResult
  nextPort: number
  live: { spec: string; port: number }[]
  ops: string[]
  outlivingKoloft: string[]
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

const forwardsAsked = (): number => m.ops.filter((o) => o.startsWith('forward')).length

function newMaster(pid: string): void {
  m.pid = pid
  m.live = []
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-tunnel-'))
  m = { pid: '100', nextPort: 40001, live: [], ops: [], outlivingKoloft: [], writes: 0 }
  deps = {
    master: async (_host, op) => {
      m.ops.push(`${op[1]} ${op[3] ?? ''}`.trim())
      if (op[1] === 'check')
        return m.pid
          ? ok('', `Master running (pid=${m.pid})`)
          : { code: 255, stdout: '', stderr: 'No such file' }
      if (op[1] === 'forward') {
        if (m.forwardAnswer === SSHD_REFUSES) return SSHD_REFUSES
        const port = m.nextPort++
        m.live.push({ spec: op[3], port })
        return m.forwardAnswer ?? ok(`${port}\n`)
      }
      m.live = m.live.filter((f) => f.spec !== op[3])
      return ok()
    },
    masterOutlivingKoloft: (_host, op) => m.outlivingKoloft.push(op.join(' ')),
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
    expect(m.live).toEqual([{ spec: '0:127.0.0.1:5000', port: 40001 }])
    expect(forwardsAsked()).toBe(1)
    expect(filesOnMachine()).toEqual({
      'tab1.cdp': relay(40001, PATH_A),
      'tab2.cdp': relay(40001, PATH_B)
    })
    expect(m.writes).toBe(1)
  })

  it('a new master (the link came back) gets a new forward, every open tab is rewritten and a tab closed meanwhile loses its file', async () => {
    const t = new BrowserTunnels(deps)
    await t.sync(HOST, [
      { tabId: 'tab1', endpoint: relay(5000, PATH_A) },
      { tabId: 'tab2', endpoint: relay(5000, PATH_B) }
    ])
    m.pid = null
    await t.sync(HOST, [{ tabId: 'tab1', endpoint: relay(5000, PATH_A) }])
    newMaster('200')
    await t.sync(HOST, [{ tabId: 'tab1', endpoint: relay(5000, PATH_A) }])
    expect(m.live).toEqual([{ spec: '0:127.0.0.1:5000', port: 40002 }])
    expect(filesOnMachine()).toEqual({ 'tab1.cdp': relay(40002, PATH_A) })
  })

  it('a Koloft restart on the same master cancels the old forward with the spec exactly as asked, then forwards the new relay', async () => {
    await new BrowserTunnels(deps).sync(HOST, [{ tabId: 'tab1', endpoint: relay(5000, PATH_A) }])
    await new BrowserTunnels(deps).sync(HOST, [{ tabId: 'tab1', endpoint: relay(6000, PATH_B) }])
    expect(m.live).toEqual([{ spec: '0:127.0.0.1:6000', port: 40002 }])
    expect(filesOnMachine()).toEqual({ 'tab1.cdp': relay(40002, PATH_B) })
  })

  it('a Koloft restart with no Claude Code tab left on the machine still cancels the forward the last run left on its master, then asks nothing more', async () => {
    await new BrowserTunnels(deps).sync(HOST, [{ tabId: 'tab1', endpoint: relay(5000, PATH_A) }])
    const afterRestart = new BrowserTunnels(deps)
    await afterRestart.sync(HOST, [])
    expect(m.live).toEqual([])
    const asked = m.ops.length
    await afterRestart.sync(HOST, [])
    await new BrowserTunnels(deps).sync(HOST, [])
    expect(m.ops).toHaveLength(asked)
  })

  it('quitting Koloft cancels the forward with a command that outlives Koloft', async () => {
    const t = new BrowserTunnels(deps)
    await t.sync(HOST, [{ tabId: 'tab1', endpoint: relay(5000, PATH_A) }])
    t.cancelOnQuit()
    expect(m.outlivingKoloft).toEqual(['-O cancel -R 0:127.0.0.1:5000'])
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
    expect(m.live).toEqual([])
    expect(filesOnMachine()).toEqual({})
    const asked = m.ops.length
    await t.sync(HOST, [{ tabId: 'tab1', endpoint: '' }])
    expect(m.ops).toHaveLength(asked)
  })

  it('a machine whose sshd refuses forwarding is asked once per master, and its tabs get no file', async () => {
    m.forwardAnswer = SSHD_REFUSES
    const t = new BrowserTunnels(deps)
    const tabs = [{ tabId: 'tab1', endpoint: relay(5000, PATH_A) }]
    await t.sync(HOST, tabs)
    await t.sync(HOST, tabs)
    expect(forwardsAsked()).toBe(1)
    expect(filesOnMachine()).toEqual({})
  })

  it('a forward that timed out is asked for again, and one it may have left on the master is cancelled first', async () => {
    m.forwardAnswer = TIMED_OUT
    const t = new BrowserTunnels(deps)
    const tabs = [{ tabId: 'tab1', endpoint: relay(5000, PATH_A) }]
    await t.sync(HOST, tabs)
    m.forwardAnswer = undefined
    await t.sync(HOST, tabs)
    expect(m.live).toEqual([{ spec: '0:127.0.0.1:5000', port: 40002 }])
    expect(filesOnMachine()).toEqual({ 'tab1.cdp': relay(40002, PATH_A) })
  })

  it('a machine with no Claude Code tab is never asked anything', async () => {
    await new BrowserTunnels(deps).sync(HOST, [])
    expect(m.ops).toEqual([])
    expect(m.writes).toBe(0)
  })

  it('the address file is written so no other account on the machine can read it', () => {
    expect(runOnMachine(addressFilesCmd([['tab1', relay(1, PATH_A)]])).code).toBe(0)
    const mode = fs.statSync(path.join(dir, 'machine', '.koloft', 'tabs', 'tab1.cdp')).mode & 0o777
    expect(mode).toBe(0o600)
  })
})

describe("the playwright-cli on the machine reads its tab's address each time it runs", () => {
  const ME = process.getuid?.() ?? 0
  const cliJs = (home: string): string =>
    path.join(home, '.koloft', PLAYWRIGHT_CLI_UNDER_KOLOFT_HOME, PLAYWRIGHT_CLI_JS_UNDER_ITS_FOLDER)
  const NPM = (exitCode: number): string => `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/npm.log"
prev=""; for a in "$@"; do [ "$prev" = --prefix ] && p="$a"; prev="$a"; done
mkdir -p "$p/lib"
[ ${exitCode} = 0 ] || exit ${exitCode}
mkdir -p "$p/lib/node_modules/@playwright/cli" && : > "$p/lib/node_modules/@playwright/cli/playwright-cli.js"
`
  const procNetTcp = (listeners: { port: number; uid: number }[]): string =>
    [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      ...listeners.map(
        (l, i) =>
          `   ${i}: 0100007F:${l.port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${l.uid}        0 ${1000 + i} 1 0000000000000000 100 0 0 10 0`
      )
    ].join('\n') + '\n'

  function machine(
    opts: {
      installed?: boolean
      npmExit?: number
      address?: string
      listeners?: { port: number; uid: number }[]
    } = {}
  ): {
    home: string
    run: () => { status: number | null; env: string; stderr: string }
    npmCalls: () => string[]
  } {
    const home = path.join(dir, 'home')
    const bin = path.join(dir, 'bin')
    fs.mkdirSync(path.join(home, '.koloft', 'tabs'), { recursive: true })
    if (opts.installed) {
      fs.mkdirSync(path.dirname(cliJs(home)), { recursive: true })
      fs.writeFileSync(cliJs(home), '')
    }
    if (opts.address) fs.writeFileSync(path.join(home, '.koloft', 'tabs', 'tab1.cdp'), opts.address)
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(path.join(bin, 'node'), `#!/bin/sh\necho "$*" >&2\nenv\n`, { mode: 0o755 })
    if (opts.npmExit !== undefined)
      fs.writeFileSync(path.join(bin, 'npm'), NPM(opts.npmExit), { mode: 0o755 })
    const tcp = path.join(dir, 'tcp')
    if (opts.listeners) fs.writeFileSync(tcp, procNetTcp(opts.listeners))
    const script = path.join(dir, 'playwright-cli')
    fs.writeFileSync(script, MACHINE_PLAYWRIGHT_CLI, { mode: 0o755 })
    return {
      home,
      run: () => {
        const r = spawnSync('/bin/sh', [script, 'snapshot'], {
          encoding: 'utf8',
          env: {
            HOME: home,
            PATH: `${bin}:/usr/bin:/bin`,
            KOLOFT_TAB_ID: 'tab1',
            ...(opts.listeners && { KOLOFT_TEST_PROC_NET_TCP: tcp })
          }
        })
        return { status: r.status, env: r.stdout, stderr: r.stderr }
      },
      npmCalls: () => {
        const log = path.join(home, 'npm.log')
        return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
      }
    }
  }

  it('drives the Workbench browser at the address Koloft last wrote, in a cli session of its own tab', () => {
    const r = machine({ installed: true, address: relay(40001, PATH_A) }).run()
    expect(r.env).toContain(`PLAYWRIGHT_MCP_CDP_ENDPOINT=${relay(40001, PATH_A)}`)
    expect(r.env).toContain('PLAYWRIGHT_CLI_SESSION=koloft-tab1')
    expect(r.env).toContain('PLAYWRIGHT_MCP_ALLOW_UNRESTRICTED_FILE_ACCESS=1')
    expect(r.stderr).toContain('playwright-cli.js snapshot')
  })

  it('on Linux, uses the address only while its port is held by this account, as the ssh forward is, and not once another account took the freed port', () => {
    const held = machine({
      installed: true,
      address: relay(40001, PATH_A),
      listeners: [{ port: 40001, uid: ME }]
    }).run()
    expect(held.env).toContain(`PLAYWRIGHT_MCP_CDP_ENDPOINT=${relay(40001, PATH_A)}`)
    const taken = machine({
      installed: true,
      address: relay(40001, PATH_A),
      listeners: [{ port: 40001, uid: ME + 1 }]
    }).run()
    expect(taken.env).not.toContain('PLAYWRIGHT_MCP_CDP_ENDPOINT')
    expect(taken.stderr).toContain('not held by Koloft')
  })

  it('with no address says why, and still runs', () => {
    const r = machine({ installed: true }).run()
    expect(r.env).not.toContain('PLAYWRIGHT_MCP_CDP_ENDPOINT')
    expect(r.stderr).toContain('no way to the Workbench browser')
    expect(r.stderr).toContain('playwright-cli.js snapshot')
  })

  it('fetches the version this Koloft ships with npm on first use, into a folder of its own, and never again', () => {
    const mc = machine({ npmExit: 0 })
    expect(mc.run().status).toBe(0)
    expect(mc.run().status).toBe(0)
    expect(fs.existsSync(cliJs(mc.home))).toBe(true)
    expect(mc.npmCalls()).toHaveLength(1)
    expect(mc.npmCalls()[0]).toContain(`@playwright/cli@${PLAYWRIGHT_CLI_VERSION}`)
  })

  it('a fetch that fails says so, and leaves no half-made folder behind', () => {
    const mc = machine({ npmExit: 1 })
    const r = mc.run()
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('playwright-cli could not be installed')
    expect(fs.readdirSync(path.join(mc.home, '.koloft'))).toEqual(['tabs'])
  })
})
