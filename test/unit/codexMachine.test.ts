import fs from 'fs'
import http from 'http'
import os from 'os'
import path from 'path'
import { spawn } from 'child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { MachineCodexUpstream } from '../../src/main/remote/codexMachine'

const FAKE_CODEX = path.join(__dirname, '..', 'e2e', 'fixtures', 'fake-codex.js')

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

describe('MachineCodexUpstream: the relay between a Codex TUI on this Mac and its app-server on a machine', () => {
  // ADR-0038 CODEX§16
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
      (_raw, frame) => toTui.push(frame),
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
})
