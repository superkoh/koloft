import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  formatRemoteKey,
  isRemoteKey,
  parseRemoteKey,
  remoteCopyText
} from '../../src/shared/remoteKey'
import { mirrorHookDir, mirrorProjectsRoot } from '../../src/main/remote/paths'
import { buildMachinePackage } from '../../src/main/remote/launch'

describe('remote key', () => {
  it('U-KEY-1: splits and rejoins host and path byte for byte', () => {
    for (const key of [
      'ssh://devbox/home/koh/api',
      'ssh://koh@devbox.example.com/srv/app',
      'ssh://box-2/home/koh/my project/src'
    ]) {
      const parsed = parseRemoteKey(key)
      expect(parsed).not.toBeNull()
      expect(formatRemoteKey(parsed!.host, parsed!.path)).toBe(key)
    }
    expect(parseRemoteKey('ssh://devbox/home/koh/api')).toEqual({
      host: 'devbox',
      path: '/home/koh/api'
    })
    expect(parseRemoteKey('ssh://koh@devbox.example.com/srv/app')?.host).toBe(
      'koh@devbox.example.com'
    )
    expect(parseRemoteKey('ssh://box-2/home/koh/my project/src')?.path).toBe(
      '/home/koh/my project/src'
    )
    expect(remoteCopyText('devbox', '/home/koh/api')).toBe('devbox:/home/koh/api')
  })

  it('U-KEY-2: answers null for a local path or a malformed remote key', () => {
    expect(parseRemoteKey('/Users/koh/app')).toBeNull()
    expect(isRemoteKey('/Users/koh/app')).toBe(false)
    expect(parseRemoteKey('ssh:///home/koh')).toBeNull()
    expect(parseRemoteKey('ssh://devbox')).toBeNull()
  })
})

describe('derived paths', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-rkey-')))
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it("U-KEY-3: puts each machine mirror under its own folder, spelling a host's @ as -at-", () => {
    expect(mirrorProjectsRoot('/ud', 'devbox')).toBe(
      path.join('/ud', 'remote', 'devbox', 'projects')
    )
    expect(mirrorHookDir('/ud', 'devbox')).toBe(
      path.join('/ud', 'remote', 'devbox', 'hook-sessions')
    )
    expect(mirrorProjectsRoot('/ud', 'koh@box')).toContain('koh-at-box')
  })

  it('U-KEY-3: names the machine package by its contents, so the name alone says whether to push it again', () => {
    const files = { 'ensure.sh': 'a\n', 'statusline/run.sh': 'b\n' }
    const first = buildMachinePackage(tmp, files)
    const again = buildMachinePackage(tmp, files)
    expect(again.name).toBe(first.name)
    const changed = buildMachinePackage(tmp, { ...files, 'ensure.sh': 'A\n' })
    expect(changed.name).not.toBe(first.name)
    expect(fs.readFileSync(path.join(first.dir, 'statusline/run.sh'), 'utf8')).toBe('b\n')
  })
})
