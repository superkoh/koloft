import { describe, it, expect } from 'vitest'
import type { ConductorBinding, SessionThread } from '../../src/shared/types'
import { SessionThreads, type ThreadDeps } from '../../src/main/discord/threads'

const WS = '/Users/me/koloft'

function setup(scope = WS, fail = false) {
  const b: ConductorBinding = {
    id: 'b1',
    scope,
    backend: 'claude',
    channel: { guildId: '1', channelId: '10', name: 'koloft' },
    sessionIds: [],
    touched: []
  }
  const threads: SessionThread[] = []
  const openers: string[] = []
  const names: string[] = []
  const members: string[] = []
  const renames: string[] = []
  const renamed: { resolve: () => void; reject: (e: Error) => void }[] = []
  let next = 100
  const deps: ThreadDeps = {
    link: {
      card: async (_c, card) => {
        openers.push(card.header)
        return [String(++next)]
      },
      startThread: async (_c, messageId, name) => {
        if (fail) throw new Error('Discord answered 403')
        names.push(name)
        return messageId
      },
      addToThread: async (threadId, userId) => void members.push(`${threadId}:${userId}`),
      archiveThread: async () => undefined,
      renameThread: (threadId, name) => {
        renames.push(`${threadId}:${name}`)
        return new Promise<void>((resolve, reject) => renamed.push({ resolve, reject }))
      }
    },
    conductors: {
      owner: () => '555',
      threadOfKey: (key) => {
        const thread = threads.find((t) => t.keys.includes(key))
        return thread && { binding: b, thread }
      },
      keepThread: (_b, threadId, key) => {
        const t = threads.find((x) => x.threadId === threadId)
        if (t) t.keys.push(key)
        else threads.push({ threadId, keys: [key] })
      },
      nameThread: (threadId, name) => {
        const t = threads.find((x) => x.threadId === threadId)
        if (t) t.name = name
      }
    }
  }
  const finishRename = async (): Promise<void> => {
    renamed.shift()?.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }
  const failRename = async (): Promise<void> => {
    renamed.shift()?.reject(new Error('Discord answered 403'))
    await new Promise((r) => setTimeout(r, 0))
  }
  return {
    b,
    threads: new SessionThreads(deps),
    kept: threads,
    openers,
    names,
    members,
    renames,
    finishRename,
    failRename
  }
}

describe('one Discord thread per session', () => {
  it('a session first heard from gets an opener card in the channel and a thread on it, with the owner added; later notices reuse it', async () => {
    const { b, threads, kept, openers, names, members } = setup()
    const s = {
      tabId: 't1',
      key: 'k1',
      name: 'fix-login',
      backend: 'claude' as const,
      workspace: WS
    }
    const [first, again] = await Promise.all([threads.place(b, s), threads.place(b, s)])
    expect(first).toBe('101')
    expect(again).toBe('101')
    expect(await threads.place(b, { ...s, tabId: 't9' })).toBe('101')
    expect(openers).toEqual(['🧵 **fix-login**'])
    expect(names).toEqual(['fix-login'])
    expect(members).toEqual(['101:555'])
    expect(kept).toEqual([{ threadId: '101', keys: ['k1'], name: 'fix-login' }])
  })

  it('a session the conductor starts gets its thread before it has an id, and keeps it once the id and, after /clear, a new id arrive', async () => {
    const { b, threads, kept, openers } = setup()
    await threads.place(b, { tabId: 't1', name: 'docs', backend: 'codex', workspace: WS }, true)
    expect(openers).toEqual(['▶ Started **docs**'])
    expect(kept).toEqual([])
    threads.bound('t1', 'k1')
    threads.bound('t1', 'k2')
    expect(kept).toEqual([{ threadId: '101', keys: ['k1', 'k2'], name: 'docs' }])
  })

  it('after a restart, a resumed session cleared with /clear carries its thread over to the new id', async () => {
    const { threads, kept } = setup()
    kept.push({ threadId: '50', keys: ['k1'] })
    threads.bound('t2', 'k1')
    threads.bound('t2', 'k2')
    expect(kept).toEqual([{ threadId: '50', keys: ['k1', 'k2'] }])
  })

  it('a tab that resumes another session with a thread of its own moves to that thread, and adds nothing to its old one', async () => {
    const { b, threads, kept } = setup()
    await threads.place(b, { tabId: 't1', key: 'k1', name: 'a', backend: 'claude', workspace: WS })
    kept.push({ threadId: '50', keys: ['k9'] })
    threads.bound('t1', 'k9')
    expect(kept).toEqual([
      { threadId: '101', keys: ['k1'], name: 'a' },
      { threadId: '50', keys: ['k9'] }
    ])
    expect(await threads.place(b, { tabId: 't1', name: 'a', backend: 'claude' })).toBe('50')
  })

  it('a closed session’s thread is kept by its id alone, so once that id is forgotten it no longer leads to the old thread', async () => {
    const { b, threads, kept } = setup()
    const closed = { key: 'k1', name: 'a', backend: 'claude' as const, workspace: WS }
    expect(await threads.place(b, closed)).toBe('101')
    expect(kept).toEqual([{ threadId: '101', keys: ['k1'], name: 'a' }])
    kept.length = 0
    expect(await threads.place(b, closed)).toBe('102')
  })

  it('a thread follows the session’s title: renamed once per new title, the latest title wins while a rename waits, and nothing is sent when the name already matches', async () => {
    const { b, threads, kept, renames, finishRename } = setup()
    await threads.place(b, { tabId: 't1', key: 'k1', name: 'helper-1', backend: 'claude' }, true)
    threads.retitle('t1', 'helper-1')
    expect(renames).toEqual([])
    threads.retitle('t1', 'Fix the login page')
    threads.retitle('t1', 'Fix the login page')
    threads.retitle('t1', 'Fix login on phones')
    threads.retitle('t1', 'Fix login, phones')
    expect(renames).toEqual(['101:Fix the login page'])
    await finishRename()
    expect(renames).toEqual(['101:Fix the login page', '101:Fix login, phones'])
    await finishRename()
    expect(kept[0].name).toBe('Fix login, phones')
  })

  it('a rename Discord refuses is not saved as done, and is not tried again for the same title while the tab lives', async () => {
    const { b, threads, kept, renames, failRename } = setup()
    await threads.place(b, { tabId: 't1', key: 'k1', name: 'helper-1', backend: 'claude' })
    threads.retitle('t1', 'Fix login')
    await failRename()
    threads.retitle('t1', 'Fix login')
    expect(renames).toEqual(['101:Fix login'])
    expect(kept[0].name).toBe('helper-1')
  })

  it('after a restart, a thread already named after the title is not renamed again', async () => {
    const { threads, kept, renames } = setup()
    kept.push({ threadId: '50', keys: ['k1'], name: 'Fix login' })
    threads.bound('t2', 'k1')
    threads.retitle('t2', 'Fix login')
    expect(renames).toEqual([])
  })

  it('the global conductor’s thread keeps the workspace in its name when it follows the title', async () => {
    const { b, threads, renames } = setup('global')
    await threads.place(b, {
      tabId: 't1',
      key: 'k1',
      name: 'helper-1',
      backend: 'claude',
      workspace: WS
    })
    threads.retitle('t1', 'Fix login', WS)
    expect(renames).toEqual(['101:Fix login · koloft'])
  })

  it('the global conductor’s threads say which workspace the session is in', async () => {
    const { b, threads, names } = setup('global')
    await threads.place(b, {
      tabId: 't1',
      key: 'k1',
      name: 'fix-login',
      backend: 'claude',
      workspace: WS
    })
    expect(names).toEqual(['fix-login · koloft'])
  })

  it('where Discord refuses a thread, the session’s notices go in the channel, and no new opener is tried for it', async () => {
    const { b, threads, openers } = setup(WS, true)
    const s = {
      tabId: 't1',
      key: 'k1',
      name: 'fix-login',
      backend: 'claude' as const,
      workspace: WS
    }
    expect(await threads.place(b, s)).toBe('10')
    expect(await threads.place(b, s)).toBe('10')
    expect(openers).toHaveLength(1)
  })
})
