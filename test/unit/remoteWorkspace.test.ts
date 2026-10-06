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

  it('refuses a machine name ssh would not take verbatim, or would read as one of its options', () => {
    expect(remoteKeyFromForm('dev box', '/home/koh')).toEqual({ ok: false, message: MACHINE_BAD })
    expect(remoteKeyFromForm('dev/box', '/home/koh')).toEqual({ ok: false, message: MACHINE_BAD })
    expect(remoteKeyFromForm('-F', '/tmp/x')).toEqual({ ok: false, message: MACHINE_BAD })
  })

  it('refuses a path that is not an absolute directory over there', () => {
    expect(remoteKeyFromForm('devbox', 'home/koh')).toEqual({ ok: false, message: PATH_BAD })
    expect(remoteKeyFromForm('devbox', '')).toEqual({ ok: false, message: PATH_BAD })
    expect(remoteKeyFromForm('devbox', '/')).toEqual({ ok: false, message: PATH_BAD })
  })
})

describe('workspaceMenuCount', () => {
  it('adds only the worktree item for a checkout — fetching lives in the git panel', () => {
    expect(workspaceMenuCount({ missing: false, isGit: true, canBind: false })).toBe(6)
    expect(workspaceMenuCount({ missing: false, isGit: false, canBind: false })).toBe(5)
  })

  it('a workspace with no conductor yet also offers to bind a Discord channel', () => {
    expect(workspaceMenuCount({ missing: false, isGit: true, canBind: true })).toBe(7)
  })

  it('a deleted folder offers only Remove', () => {
    expect(workspaceMenuCount({ missing: true, isGit: false, canBind: true })).toBe(1)
  })
})
