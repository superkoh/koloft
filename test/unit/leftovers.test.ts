import { describe, it, expect } from 'vitest'
import { scanLeftovers, stopLeftover } from '../../src/main/leftovers'

const SID = '1b6fa18b-8f8d-44ae-8ff1-718bb0f9556d'
const OTHER = 'bfa0a674-0000-4000-8000-000000000000'
const QEMU =
  '/Users/me/Library/Android/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd nb'

// CC§9 PLATFORM§3
const WITH_ENV = [
  `    1     0 /sbin/launchd`,
  ` 7541     1 ${QEMU} HOME=/Users/me CLAUDECODE=1 CLAUDE_CODE_SESSION_ID=${SID} CLAUDE_PID=6451`,
  ` 8000  6451 /bin/zsh -c sleep 900 CLAUDECODE=1 CLAUDE_CODE_SESSION_ID=${SID}`,
  ` 8100     1 /usr/sbin/cfprefsd agent HOME=/Users/me`,
  ` 8200     1 adb -L tcp:5037 fork-server CLAUDE_CODE_SESSION_ID=${OTHER}`
].join('\n')

const PLAIN = [
  `    1 /sbin/launchd`,
  ` 7541 ${QEMU}`,
  ` 8000 /bin/zsh -c sleep 900`,
  ` 8100 /usr/sbin/cfprefsd agent`,
  ` 8200 adb -L tcp:5037 fork-server`
].join('\n')

const exec = async (_cmd: string, args: string[]): Promise<string> =>
  args[0] === 'eww' ? WITH_ENV : PLAIN

describe('programs a session left running on their own', () => {
  it('are the ones launchd adopted that still name the session, listed by their clean command line', async () => {
    const found = await scanLeftovers(exec)
    expect(found.get(SID)).toEqual([{ pid: 7541, command: QEMU }])
    expect(found.get(OTHER)).toEqual([{ pid: 8200, command: 'adb -L tcp:5037 fork-server' }])
    expect(found.size).toBe(2)
  })

  it('a shell claude still owns is not left over', async () => {
    const found = await scanLeftovers(exec)
    expect(found.get(SID)?.some((p) => p.pid === 8000)).toBe(false)
  })

  it('stops one only while it is still that session’s leftover (a reused pid or another session is refused)', async () => {
    const killed: number[] = []
    const kill = (pid: number): void => void killed.push(pid)
    expect(await stopLeftover(SID, 7541, exec, kill)).toBe(true)
    expect(await stopLeftover(SID, 8200, exec, kill)).toBe(false)
    expect(await stopLeftover(SID, 9999, exec, kill)).toBe(false)
    expect(killed).toEqual([7541])
  })
})
