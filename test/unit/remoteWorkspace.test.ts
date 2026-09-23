import { describe, expect, it } from 'vitest'
import {
  MACHINE_BAD,
  MACHINE_EMPTY,
  PATH_BAD,
  remoteKeyFromForm,
  workspaceMenuCount
} from '../../src/renderer/src/remoteWorkspace'

describe('remoteKeyFromForm', () => {
  it('builds the workspace key from the two fields', () => {
    expect(remoteKeyFromForm('devbox', '/home/koh/api')).toEqual({
      ok: true,
      key: 'ssh://devbox/home/koh/api'
    })
  })

  it('keeps a user@host machine name whole and trims stray spaces', () => {
    expect(remoteKeyFromForm('  koh@10.0.0.5 ', ' /srv/app ')).toEqual({
      ok: true,
      key: 'ssh://koh@10.0.0.5/srv/app'
    })
  })

  it('refuses an empty machine name', () => {
    expect(remoteKeyFromForm('   ', '/home/koh')).toEqual({ ok: false, message: MACHINE_EMPTY })
  })

  it('refuses a machine name ssh would not take verbatim', () => {
    expect(remoteKeyFromForm('dev box', '/home/koh')).toEqual({ ok: false, message: MACHINE_BAD })
    expect(remoteKeyFromForm('dev/box', '/home/koh')).toEqual({ ok: false, message: MACHINE_BAD })
  })

  it('refuses a path that is not an absolute directory over there', () => {
    expect(remoteKeyFromForm('devbox', 'home/koh')).toEqual({ ok: false, message: PATH_BAD })
    expect(remoteKeyFromForm('devbox', '')).toEqual({ ok: false, message: PATH_BAD })
    expect(remoteKeyFromForm('devbox', '/')).toEqual({ ok: false, message: PATH_BAD })
  })
})

describe('workspaceMenuCount', () => {
  it('drops Scheduled jobs and Fetch origin for a remote workspace', () => {
    expect(workspaceMenuCount({ missing: false, isGit: false, remote: true })).toBe(4)
  })

  it('keeps the worktree item when the remote folder is a checkout', () => {
    expect(workspaceMenuCount({ missing: false, isGit: true, remote: true })).toBe(5)
  })

  it('is unchanged for local workspaces', () => {
    expect(workspaceMenuCount({ missing: false, isGit: true, remote: false })).toBe(7)
    expect(workspaceMenuCount({ missing: false, isGit: false, remote: false })).toBe(5)
    expect(workspaceMenuCount({ missing: true, isGit: false, remote: false })).toBe(1)
  })
})
