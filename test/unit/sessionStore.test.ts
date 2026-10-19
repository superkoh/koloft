import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SessionStore,
  codexSessionKey,
  type StoredMember,
  type WorktreeResource
} from '../../src/main/sessionStore'

let directory: string
let filename: string

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-session-store-'))
  filename = path.join(directory, 'sessions.json')
})

afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 })
})

function member(): StoredMember {
  const id = randomUUID()
  return {
    id,
    key: codexSessionKey(id),
    workspacePath: '/repo',
    cwd: '/repo',
    title: 'One',
    createdAt: 1,
    updatedAt: 1
  }
}

function resource(): WorktreeResource {
  return {
    id: randomUUID(),
    originalCwd: '/repo',
    worktreePath: '/repo/.claude/worktrees/one',
    worktreeName: 'one',
    worktreeBranch: 'worktree-one',
    originalHeadCommit: 'a'.repeat(40),
    state: 'ready',
    managed: true
  }
}

describe('SessionStore', () => {
  it('retains recovery evidence when a member is removed and restored after reopening', () => {
    const store = new SessionStore(filename)
    const worktree = resource()
    const session = { ...member(), worktreeResourceId: worktree.id }
    store.putResource(worktree)
    store.upsertMember(session)
    store.removeMember(session.key)
    store.flushSync()
    const reopened = new SessionStore(filename)
    expect(reopened.listMembers()).toEqual([])
    expect(reopened.getResource(worktree.id)).toEqual(worktree)
    reopened.upsertMember(session)
    reopened.flushSync()
    expect(new SessionStore(filename).getMember(session.key)).toEqual(session)
  })

  it('writes off the main thread: a change is in memory at once and lands on disk, owner-only, a moment later', async () => {
    const writes = vi.spyOn(fs, 'writeFileSync')
    const store = new SessionStore(filename)
    const session = member()
    store.upsertMember(session)
    expect(store.getMember(session.key)).toEqual(session)
    expect(writes).not.toHaveBeenCalled()
    await vi.waitFor(() =>
      expect(new SessionStore(filename).getMember(session.key)).toEqual(session)
    )
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600)
  })

  it('drops a worktree’s recovery record once no member uses it, and keeps it while one still does', () => {
    const store = new SessionStore(filename)
    const worktree = resource()
    const first = { ...member(), worktreeResourceId: worktree.id }
    const second = { ...member(), worktreeResourceId: worktree.id }
    store.putResource(worktree)
    store.upsertMember(first)
    store.upsertMember(second)
    store.removeMember(first.key)
    store.removeUnusedResourcesAt(worktree.worktreePath)
    expect(store.getResource(worktree.id)).toEqual(worktree)
    store.removeMember(second.key)
    store.removeUnusedResourcesAt(worktree.worktreePath)
    store.flushSync()
    expect(new SessionStore(filename).getResource(worktree.id)).toBeUndefined()
  })

  it('updates members separately without exposing mutable store objects', () => {
    const store = new SessionStore(filename)
    const first = member()
    const second = { ...member(), workspacePath: '/other' }
    store.upsertMember(first)
    store.upsertMember(second)
    store.updateMember(first.key, { title: 'Changed', updatedAt: 2 })
    const copy = store.getMember(first.key)!
    copy.title = 'Mutation outside the store'
    expect(store.listMembers('/repo').map((m) => m.title)).toEqual(['Changed'])
    expect(store.getMember(second.key)).toEqual(second)
  })

  it('rejects unsupported and malformed files without replacing them', () => {
    for (const raw of [
      '{"version":2,"members":{},"resources":{}}',
      '{broken json',
      '{"version":1,"members":null,"resources":{}}'
    ]) {
      fs.writeFileSync(filename, raw)
      expect(() => new SessionStore(filename)).toThrow()
      expect(fs.readFileSync(filename, 'utf8')).toBe(raw)
    }
  })

  it('keeps the first backup intact over later writes and later opens', () => {
    const session = member()
    const first = new SessionStore(filename)
    first.upsertMember(session)
    first.flushSync()
    const original = fs.readFileSync(filename, 'utf8')
    const store = new SessionStore(filename)
    store.updateMember(session.key, { title: 'Two' })
    store.flushSync()
    const later = new SessionStore(filename)
    later.updateMember(session.key, { title: 'Three' })
    later.flushSync()
    expect(fs.readFileSync(filename + '.bak', 'utf8')).toBe(original)
    expect(new SessionStore(filename).getMember(session.key)?.title).toBe('Three')
  })

  it('rejects identity mismatches and missing resources before writing', () => {
    const store = new SessionStore(filename)
    const session = member()
    expect(() => store.upsertMember({ ...session, key: 'claude:local:' + session.id })).toThrow()
    expect(() => store.upsertMember({ ...session, worktreeResourceId: randomUUID() })).toThrow(
      'Missing worktree resource'
    )
    expect(fs.existsSync(filename)).toBe(false)
  })
})
