import { afterEach, describe, expect, it } from 'vitest'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { parseSessionPorts, scanPortsHere, SESSION_PORTS_SH } from '../../src/main/sessionPorts'

const run = promisify(execFile)

const SERVER = `require('http').createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', function () { console.log(this.address().port) })`

const started: ChildProcess[] = []
const fakeBins: string[] = []

afterEach(() => {
  for (const child of started.splice(0)) process.kill(-(child.pid as number), 'SIGKILL')
  for (const bin of fakeBins.splice(0)) fs.rmSync(bin, { recursive: true, force: true })
})

async function serve(tag: string): Promise<{ shellPid: number; port: number }> {
  const shell = spawn(
    '/bin/sh',
    ['-c', `KOLOFT_TAB_ID=${tag} "${process.execPath}" -e "$0"; :`, SERVER],
    {
      env: { ...process.env, KOLOFT_TAB_ID: '' },
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore']
    }
  )
  started.push(shell)
  const port = await new Promise<number>((resolve) =>
    shell.stdout?.once('data', (b: Buffer) => resolve(Number(String(b).trim())))
  )
  return { shellPid: shell.pid as number, port }
}

const portsOf = async (tags: string[]): Promise<number[] | undefined> =>
  parseSessionPorts(await scanPortsHere(tags))?.map((p) => p.port)

async function portsWithFakes(
  fakes: Record<string, string>,
  tags: string,
  tmuxName: string
): Promise<number[] | null> {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-bin-'))
  fakeBins.push(bin)
  for (const [name, body] of Object.entries(fakes))
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}`, { mode: 0o755 })
  const r = await run('/bin/sh', ['-c', SESSION_PORTS_SH, 'ports', tags, tmuxName], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  }).catch((e: { stdout: string }) => e)
  const found = parseSessionPorts(r.stdout)
  return found && found.map((p) => p.port)
}

describe('a session tab’s listening ports', () => {
  it('lists the servers of processes carrying the tab’s id or one of its terminals’ ids, and no other tab’s', async () => {
    const tab = `pty-t${randomUUID().slice(0, 8)}-1`
    const terminal = `pty-t${randomUUID().slice(0, 8)}-2`
    const own = await serve(tab)
    const ofTerminal = await serve(terminal)
    const otherTab = await serve(`pty-t${randomUUID().slice(0, 8)}-3`)
    const ports = await portsOf([tab, terminal])
    expect(ports).toEqual([own.port, ofTerminal.port].sort((a, b) => a - b))
    expect(ports).not.toContain(otherTab.port)
  })

  it('lists, for a tab reattached to a tmux session after a restart, the servers started under the id the session first ran with, in the pane or gone from it', async () => {
    const firstId = `pty-t${randomUUID().slice(0, 8)}-1`
    const reattached = `pty-t${randomUUID().slice(0, 8)}-1`
    const tmuxName = `k-${randomUUID()}`
    const inPane = await serve(firstId)
    const leftThePane = await serve(firstId)
    const tmux = `[ "$3 $6" = "list-panes =${tmuxName}:" ] && echo ${inPane.shellPid} && exit 0\nexit 1\n`
    expect(await portsWithFakes({ tmux }, reattached, '')).toEqual([])
    expect(await portsWithFakes({ tmux }, reattached, tmuxName)).toEqual(
      [inPane.port, leftThePane.port].sort((a, b) => a - b)
    )
  })

  it('lists nothing for a tab no process carries', async () => {
    expect(await portsOf([`pty-none-${randomUUID()}`])).toEqual([])
  })

  it('reads a scan whose process table could not be read as unknown, not as no ports', async () => {
    const tab = `pty-t${randomUUID().slice(0, 8)}-1`
    await serve(tab)
    expect(await portsWithFakes({ ps: 'exit 1\n' }, tab, '')).toBeNull()
  })

  it('reads a scan that did not finish as unknown, not as no ports', () => {
    expect(parseSessionPorts('')).toBeNull()
    expect(parseSessionPorts('P 200 python3 -m http.server 8000\np200\n')).toBeNull()
  })

  it('leaves out the agent program’s own ports and lists a port held on two addresses once', () => {
    const scan = [
      'P 100 /Users/me/.local/bin/agy --gemini_dir=/x --csrf_token=t',
      'P 200 /usr/bin/python3 -m http.server 8000',
      'p100',
      'n127.0.0.1:58781',
      'p200',
      'n*:8000',
      'n[::]:8000',
      'scanned'
    ].join('\n')
    expect(parseSessionPorts(scan)).toEqual([{ port: 8000, pid: 200, process: 'python3' }])
  })
})
