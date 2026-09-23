import { describe, it, expect } from 'vitest'
import { scanLeftovers, stopLeftover } from '../../src/main/leftovers'

const SID = '1b6fa18b-8f8d-44ae-8ff1-718bb0f9556d'
const OTHER = 'bfa0a674-0000-4000-8000-000000000000'
const QEMU =
  '/Users/me/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd nb'

// CC§9 PLATFORM§3
const PROCS: { pid: number; ppid: number; command: string; env: string }[] = [
  { pid: 1, ppid: 0, command: '/sbin/launchd', env: '' },
  { pid: 7541, ppid: 1, command: QEMU, env: `CLAUDECODE=1 CLAUDE_CODE_SESSION_ID=${SID}` },
  { pid: 8000, ppid: 6451, command: '/bin/zsh -c sleep 900', env: `CLAUDE_CODE_SESSION_ID=${SID}` },
  { pid: 8100, ppid: 1, command: '/usr/sbin/cfprefsd agent', env: 'HOME=/Users/me' },
  {
    pid: 8200,
    ppid: 1,
    command: 'adb -L tcp:5037 fork-server',
    env: `CLAUDE_CODE_SESSION_ID=${OTHER}`
  }
]

const asked: string[][] = []
const exec = async (_cmd: string, args: string[]): Promise<string> => {
  asked.push(args)
  if (args[0] === '-Ao') return PROCS.map((p) => ` ${p.pid} ${p.ppid} ${p.command}`).join('\n')
  const pids = args[args.length - 1].split(',').map(Number)
  const withPpid = args[2] === 'ppid=,command='
  return PROCS.filter((p) => pids.includes(p.pid))
    .map((p) => ` ${withPpid ? p.ppid : p.pid} ${p.command} HOME=/Users/me ${p.env}`)
    .join('\n')
}

describe('programs a session left running on their own', () => {
  it('are the ones launchd adopted that still name the session, listed by their clean command line', async () => {
    const found = await scanLeftovers(exec)
    expect(found).toEqual({
      [SID]: [{ pid: 7541, command: QEMU }],
      [OTHER]: [{ pid: 8200, command: 'adb -L tcp:5037 fork-server' }]
    })
  })

  it('reads the environment only of the adopted processes, never the whole table', async () => {
    asked.length = 0
    await scanLeftovers(exec)
    expect(asked[1]).toEqual(['eww', '-o', 'pid=,command=', '-p', '7541,8100,8200'])
  })

  it('stops one only while it is still that session’s leftover (a reused pid or another session is refused)', async () => {
    const killed: number[] = []
    const kill = (pid: number): void => void killed.push(pid)
    expect(await stopLeftover(SID, 7541, exec, kill)).toBe(true)
    expect(await stopLeftover(SID, 8200, exec, kill)).toBe(false)
    expect(await stopLeftover(SID, 8000, exec, kill)).toBe(false)
    expect(await stopLeftover(SID, 9999, exec, kill)).toBe(false)
    expect(killed).toEqual([7541])
  })
})
