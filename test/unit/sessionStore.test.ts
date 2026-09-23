import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SessionStore,
  codexSessionKey,
  type CodexMember,
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
  fs.rmSync(directory, { recursive: true, force: true })
})

function member(): CodexMember {
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
    const reopened = new SessionStore(filename)
    expect(reopened.listMembers()).toEqual([])
    expect(reopened.getResource(worktree.id)).toEqual(worktree)
    reopened.upsertMember(session)
    expect(new SessionStore(filename).getMember(session.key)).toEqual(session)
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

  it('leaves disk and memory unchanged if the atomic replacement fails', () => {
    const store = new SessionStore(filename)
    const session = member()
    store.upsertMember(session)
    const original = fs.readFileSync(filename, 'utf8')
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('disk error')
    })
    expect(() => store.updateMember(session.key, { title: 'Lost write' })).toThrow('disk error')
    expect(store.getMember(session.key)).toEqual(session)
    expect(fs.readFileSync(filename, 'utf8')).toBe(original)
    expect(fs.readdirSync(directory).filter((file) => file.endsWith('.tmp'))).toEqual([])
  })

  it('keeps the first backup intact over later writes', () => {
    const store = new SessionStore(filename)
    const session = member()
    store.upsertMember(session)
    const original = fs.readFileSync(filename, 'utf8')
    store.updateMember(session.key, { title: 'Two' })
    store.updateMember(session.key, { title: 'Three' })
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
