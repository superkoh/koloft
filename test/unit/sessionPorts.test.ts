import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import { parseSessionPorts, scanPortsHere } from '../../src/main/sessionPorts'

const SERVER = `require('http').createServer((q, s) => s.end('ok')).listen(0, '127.0.0.1', function () { console.log(this.address().port) })`

const started: ChildProcess[] = []

afterEach(() => {
  for (const child of started.splice(0)) child.kill('SIGKILL')
})

async function serve(tag: string): Promise<{ pid: number; port: number }> {
  const child = spawn(process.execPath, ['-e', SERVER], {
    env: { ...process.env, KOLOFT_TAB_ID: tag },
    detached: true,
    stdio: ['ignore', 'pipe', 'ignore']
  })
  started.push(child)
  const port = await new Promise<number>((resolve) =>
    child.stdout?.once('data', (b: Buffer) => resolve(Number(String(b).trim())))
  )
  return { pid: child.pid as number, port }
}

const portsOf = async (tags: string[]): Promise<number[] | undefined> =>
  parseSessionPorts(await scanPortsHere(tags))?.map((p) => p.port)

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

  it('lists nothing for a tab no process carries', async () => {
    expect(await portsOf([`pty-none-${randomUUID()}`])).toEqual([])
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
