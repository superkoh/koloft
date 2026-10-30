import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import {
  MachineCodexUpstream,
  machineAppServerCmd,
  ownerWordsLines
} from '../../src/main/remote/codexMachine'
import { CODEX_REPLY_LANGUAGE_SCRIPT, seedHandedOverOwnerWords } from '../../src/main/hooks'
import { DEFAULT_MAX_FRAME } from '../../src/main/codexTransport'

const FAKE_CODEX = path.join(__dirname, '..', 'e2e', 'fixtures', 'fake-codex.js')
const PLUGIN_LIST_PAST_32_MB = 33 * 1024 * 1024

type Frame = Record<string, unknown>

async function machineServer(): Promise<{
  sock: string
  got: Frame[]
  send(frame: Frame): void
  close(): void
}> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-'))
  const sock = path.join(dir, 's.sock')
  const got: Frame[] = []
  let peer: WebSocket | undefined
  const server = http.createServer()
  const wss = new WebSocketServer({ server })
  wss.on('connection', (ws) => {
    peer = ws
    ws.on('message', (data) => got.push(JSON.parse(String(data)) as Frame))
  })
  await new Promise<void>((resolve) => server.listen(sock, resolve))
  return {
    sock,
    got,
    send: (frame) => peer!.send(JSON.stringify(frame)),
    close: () => {
      wss.close()
      server.close()
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

const stops: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop()
})

describe('a Codex session that another session starts on a machine', () => {
  // ADR-0031
  it('gets the owner’s-words files a Codex session on this Mac gets, so its reply-language hook there answers the handed-over English task as one here does, whatever characters the words hold', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-said-'))
    const ownerWords = '帮我看看 "侧栏" 为什么\n变宽了 \'« » \\ 😀'
    const seed = path.join(dir, 'seed.sh')
    fs.writeFileSync(
      seed,
      `S=${JSON.stringify(path.join(dir, 'machine'))}\n${ownerWordsLines(ownerWords)}`
    )
    expect(spawnSync('/bin/sh', [seed]).status).toBe(0)
    seedHandedOverOwnerWords(path.join(dir, 'mac.said'), ownerWords)
    const script = path.join(dir, 'reply-language.bash')
    fs.writeFileSync(script, CODEX_REPLY_LANGUAGE_SCRIPT)
    const hook = (said: string, event: string, payload: unknown): string =>
      spawnSync('bash', [script, event], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, KOLOFT_CODEX_SAID: path.join(dir, said) }
      }).stdout
    const answers = (said: string): string[] => [
      hook(said, 'prompt', { prompt: 'Fix the sidebar width.' }),
      hook(said, 'tool', {})
    ]
    const mac = answers('mac.said')
    expect(mac[0]).toContain('Chinese')
    expect(answers('machine.said')).toEqual(mac)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('the side app-server on a machine', () => {
  // CODEX§16
  it('ends the one a dropped ssh line left running there before it starts, so a machine keeps at most one per Koloft', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-side-'))
    const bin = path.join(home, '.koloft', 'codex-cli', 'bin')
    fs.mkdirSync(bin, { recursive: true })
    fs.writeFileSync(
      path.join(bin, 'codex'),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} -e 'setInterval(() => {}, 1000)' "$@"\n`,
      { mode: 0o755 }
    )
    const pidFile = path.join(home, '.koloft', 'cx', 'inst', 'side.pid')
    const start = async (): Promise<number> => {
      const child = spawn('/bin/sh', ['-c', `exec ${machineAppServerCmd('inst')}`], {
        env: { ...process.env, HOME: home },
        stdio: 'ignore'
      })
      stops.push(() => void child.kill('SIGKILL'))
      await vi.waitFor(
        () =>
          expect(fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8')).toBe(`${child.pid}\n`),
        { timeout: 10_000 }
      )
      return child.pid!
    }
    const left = await start()
    const next = await start()
    await vi.waitFor(() => expect(() => process.kill(left, 0)).toThrow())
    expect(() => process.kill(next, 0)).not.toThrow()
    fs.rmSync(home, { recursive: true, force: true })
  })
})

describe('MachineCodexUpstream: the relay between a Codex TUI on this Mac and its app-server on a machine', () => {
  // ADR-0039 CODEX§16
  it("signs the server in with the Mac account's token once the TUI says initialized, holds the TUI's frames until that login completes, answers a token refresh itself, and runs the TUI's command in the machine's folder", async () => {
    const machine = await machineServer()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-home-'))
    const toTui: Frame[] = []
    const upstream = new MachineCodexUpstream(
      {
        connect: () =>
          spawn(process.execPath, [FAKE_CODEX, 'app-server', 'proxy', '--sock', machine.sock], {
            stdio: 'pipe',
            env: { ...process.env, HOME: home, CODEX_HOME: home }
          }),
        login: {
          params: async () => ({
            type: 'chatgptAuthTokens',
            accessToken: 'mac-token-1',
            chatgptAccountId: 'acct'
          }),
          refreshed: async (stale) => ({
            accessToken: stale === 'mac-token-1' ? 'mac-token-2' : 'wrong',
            chatgptAccountId: 'acct',
            chatgptPlanType: null
          })
        },
        macCwd: '/Users/someone',
        machineCwd: () => '/home/someone/proj',
        stopServer: async () => {},
        maxFrameBytes: 1 << 20,
        report: () => {}
      },
      ({ parse }) => toTui.push(parse()),
      (error) => {
        throw error
      }
    )
    stops.push(() => upstream.stop(), machine.close)
    const methodsGot = (): unknown[] => machine.got.map((f) => f.method ?? f.id)

    upstream.write(JSON.stringify({ id: 1, method: 'initialize', params: {} }))
    await vi.waitFor(() => expect(methodsGot()).toEqual(['initialize']))
    upstream.write(JSON.stringify({ method: 'initialized' }))
    upstream.write(JSON.stringify({ id: 2, method: 'thread/start', params: {} }))
    await vi.waitFor(() =>
      expect(machine.got.at(-1)).toMatchObject({
        method: 'account/login/start',
        params: { type: 'chatgptAuthTokens', accessToken: 'mac-token-1', chatgptAccountId: 'acct' }
      })
    )
    const loginId = machine.got.at(-1)!.id
    machine.send({ id: loginId, result: {} })
    await new Promise((r) => setTimeout(r, 200))
    expect(methodsGot()).toEqual(['initialize', 'initialized', 'account/login/start'])

    machine.send({ method: 'account/login/completed', params: { success: true } })
    await vi.waitFor(() => expect(methodsGot().at(-1)).toBe('thread/start'))
    expect(toTui.map((f) => f.method ?? f.id)).toEqual(['account/login/completed'])

    machine.send({ id: 7, method: 'account/chatgptAuthTokens/refresh', params: {} })
    await vi.waitFor(() =>
      expect(machine.got.at(-1)).toEqual({
        id: 7,
        result: { accessToken: 'mac-token-2', chatgptAccountId: 'acct', chatgptPlanType: null }
      })
    )

    upstream.write(
      JSON.stringify({
        id: 3,
        method: 'command/exec',
        params: { command: ['git', 'branch', '--show-current'], cwd: '/Users/someone' }
      })
    )
    await vi.waitFor(() =>
      expect(machine.got.at(-1)).toMatchObject({
        method: 'command/exec',
        params: { cwd: '/home/someone/proj' }
      })
    )
    expect(toTui.map((f) => f.method ?? f.id)).toEqual(['account/login/completed'])
  })

  // CODEX§1
  it('hands the TUI a reply past 32 MB from the machine whole, as the plugin list a signed-in TUI asks for keeps growing toward, without dropping the line', async () => {
    const machine = await machineServer()
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcm-home-'))
    const toTui: Frame[] = []
    let lines = 0
    const upstream = new MachineCodexUpstream(
      {
        connect: () => {
          lines++
          return spawn(
            process.execPath,
            [FAKE_CODEX, 'app-server', 'proxy', '--sock', machine.sock],
            {
              stdio: 'pipe',
              env: { ...process.env, HOME: home, CODEX_HOME: home }
            }
          )
        },
        login: { params: async () => undefined, refreshed: async () => ({}) },
        macCwd: '/Users/someone',
        machineCwd: () => '/home/someone/proj',
        stopServer: async () => {},
        maxFrameBytes: DEFAULT_MAX_FRAME,
        report: () => {}
      },
      ({ parse }) => toTui.push(parse()),
      (error) => {
        throw error
      }
    )
    stops.push(() => upstream.stop(), machine.close)

    upstream.write(JSON.stringify({ id: 1, method: 'initialize', params: {} }))
    await vi.waitFor(() => expect(machine.got.map((f) => f.method)).toEqual(['initialize']))
    machine.send({ id: 1, result: { pad: 'x'.repeat(PLUGIN_LIST_PAST_32_MB) } })
    await vi.waitFor(() => expect(toTui).toHaveLength(1), { timeout: 20_000 })
    expect((toTui[0].result as { pad: string }).pad).toHaveLength(PLUGIN_LIST_PAST_32_MB)
    expect(lines).toBe(1)
  }, 30_000)
})
