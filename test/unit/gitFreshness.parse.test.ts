import { describe, it, expect } from 'vitest'
import { credentialGuardEnv, parseLeftRight, pullErrorReason } from '../../src/main/gitFreshness'

describe('parseLeftRight', () => {
  it('reads ahead from the left column and behind from the right', () => {
    expect(parseLeftRight('1\t2\n')).toEqual({ ahead: 1, behind: 2 })
    expect(parseLeftRight('0\t0')).toEqual({ ahead: 0, behind: 0 })
    expect(parseLeftRight('  3\t40  \n')).toEqual({ ahead: 3, behind: 40 })
  })

  it('rejects anything that is not two counts', () => {
    expect(parseLeftRight('')).toBeNull()
    expect(parseLeftRight('7')).toBeNull()
    expect(parseLeftRight('fatal: bad revision\n')).toBeNull()
  })
})

describe('pullErrorReason', () => {
  it('takes the LAST fatal/error line, never the first progress line', () => {
    const stderr = [
      'From /tmp/origin',
      ' * branch            main       -> FETCH_HEAD',
      'fatal: Not possible to fast-forward, aborting.'
    ].join('\n')
    expect(pullErrorReason(stderr)).toBe('fatal: Not possible to fast-forward, aborting.')
  })

  it('skips hint: lines and keeps the error above them', () => {
    const stderr = [
      'error: Your local changes to the following files would be overwritten by merge:',
      '\ta.txt',
      'hint: use git stash',
      'hint: or commit them'
    ].join('\n')
    expect(pullErrorReason(stderr)).toBe(
      'error: Your local changes to the following files would be overwritten by merge:'
    )
  })

  it('falls back to the last meaningful line when nothing is tagged', () => {
    expect(pullErrorReason('something odd happened\n\n')).toBe('something odd happened')
    expect(pullErrorReason('hint: only hints\n')).toBe('pull failed')
    expect(pullErrorReason('')).toBe('pull failed')
  })

  it('uses stdout only when stderr carries nothing', () => {
    expect(pullErrorReason('', 'fatal: from stdout')).toBe('fatal: from stdout')
  })
})

describe('credentialGuardEnv', () => {
  it('closes every interactive prompt path, and leaves the credential helper on', () => {
    const env = credentialGuardEnv({ PATH: '/usr/bin' })
    expect(env.GIT_TERMINAL_PROMPT).toBe('0')
    expect(env.GIT_ASKPASS).toBe('/usr/bin/false')
    expect(env.SSH_ASKPASS).toBe('/usr/bin/false')
    expect(env.SSH_ASKPASS_REQUIRE).toBe('never')
    expect(env.PATH).toBe('/usr/bin')
    expect(env.GIT_CONFIG_PARAMETERS).toBeUndefined()
  })

  it('appends BatchMode to the user GIT_SSH_COMMAND, or supplies one', () => {
    expect(credentialGuardEnv({}).GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes')
    expect(credentialGuardEnv({ GIT_SSH_COMMAND: 'ssh -i /k/id' }).GIT_SSH_COMMAND).toBe(
      'ssh -i /k/id -o BatchMode=yes'
    )
  })

  it('leaves an explicit user BatchMode alone', () => {
    expect(credentialGuardEnv({ GIT_SSH_COMMAND: 'ssh -o BatchMode=no' }).GIT_SSH_COMMAND).toBe(
      'ssh -o BatchMode=no'
    )
  })
})
