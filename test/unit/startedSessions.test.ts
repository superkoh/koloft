import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StartedSessions } from '../../src/main/startedSessions'

let file: string

beforeEach(() => {
  file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-started-')), 'started.json')
})

afterEach(() => {
  fs.rmSync(path.dirname(file), { recursive: true, force: true })
})

const record = (): StartedSessions => new StartedSessions(() => file)

describe('which session started which, kept across a Koloft restart', () => {
  it('a child started before a restart still belongs to its parent session after one', () => {
    const before = record()
    before.started('kid-tab', 'parent')
    before.bound('kid-tab', 'kid')
    const after = record()
    expect(after.startedBy({ sessionId: 'kid' }, { sessionId: 'parent' })).toBe(true)
    expect(after.startedBy({ sessionId: 'kid' }, { sessionId: 'someone-else' })).toBe(false)
  })

  it('a child that has not bound yet is reached by its tab', () => {
    const started = record()
    started.started('kid-tab', 'parent')
    expect(started.startedBy({ sessionId: '', tabId: 'kid-tab' }, { sessionId: 'parent' })).toBe(
      true
    )
  })

  it('follows the parent and the child when /clear gives their tab a new session id', () => {
    const started = record()
    started.bound('parent-tab', 'parent-1')
    started.started('kid-tab', 'parent-1')
    started.bound('kid-tab', 'kid-1')
    started.bound('parent-tab', 'parent-2')
    started.bound('kid-tab', 'kid-2')
    const after = record()
    expect(after.startedBy({ sessionId: 'kid-2' }, { sessionId: 'parent-2' })).toBe(true)
    expect(after.startedBy({ sessionId: 'kid-1' }, { sessionId: 'parent-1' })).toBe(false)
  })

  it('names the parent of a sidebar row while the child is starting, once bound, and after a restart', () => {
    const started = record()
    started.started('kid-tab', 'parent')
    expect(started.parentOfRow('kid-tab')).toBe('parent')
    started.bound('kid-tab', 'kid')
    expect(started.parentOfRow('kid')).toBe('parent')
    expect(started.parentOfRow('kid-tab')).toBe('parent')
    expect(record().parentOfRow('kid')).toBe('parent')
    expect(record().parentOfRow('parent')).toBeUndefined()
  })

  it('forgets a child once it is closed', () => {
    const started = record()
    started.started('kid-tab', 'parent')
    started.bound('kid-tab', 'kid')
    started.forget('kid')
    expect(record().startedBy({ sessionId: 'kid' }, { sessionId: 'parent' })).toBe(false)
  })
})
