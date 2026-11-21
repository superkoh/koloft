import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BackendId, CreateTabOptions, SessionInfo } from '../../../../src/shared/types'
import { formatRemoteKey } from '../../../../src/shared/remoteKey'
import { StartedSessions } from '../../../../src/plugins/sessions/main/startedSessions'
import {
  startBeside,
  type BesideDeps,
  type BesideSpec
} from '../../../../src/plugins/sessions/main/sessionTabs'

type Launched = CreateTabOptions & { kind: BackendId }

let directory: string
let shownUnder: StartedSessions
let launched: Launched[]

const session = (over: Partial<SessionInfo> = {}): SessionInfo =>
  ({
    tabId: 'tab-watched',
    sessionId: 'watched',
    backendId: 'claude',
    title: 'Fix the login',
    cwd: '/work/app/.claude/worktrees/fix-login',
    treeRoot: '/work/app/.claude/worktrees/fix-login',
    alive: true,
    updatedAt: 0,
    ...over
  }) as SessionInfo

const spec: BesideSpec = {
  role: 'You check this session for the owner.',
  task: 'Read its last turn.',
  permission: 'bypass',
  model: 'opus',
  name: 'Check it'
}

function deps(s: SessionInfo | undefined, pinned: string[] = []): BesideDeps {
  return {
    sessionOfTab: (tabId) => (s?.tabId === tabId ? s : undefined),
    launch: async (options) => {
      launched.push(options)
      return 'tab-helper'
    },
    pinnedWorkspaces: () => pinned.map((p) => ({ path: p })),
    turnedOff: (backend) => (backend === 'muse' ? 'Muse is turned off in Settings' : null),
    shownUnder
  }
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-beside-'))
  shownUnder = new StartedSessions(() => path.join(directory, 'shown-under.json'))
  launched = []
})

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('startBeside', () => {
  it("starts in the session's own folder, with its agent, and the role before the task", async () => {
    const started = await startBeside(deps(session()), 'tab-watched', spec)
    expect(started).toEqual({ ok: true, tabId: 'tab-helper' })
    expect(launched).toEqual([
      expect.objectContaining({
        kind: 'claude',
        cwd: '/work/app/.claude/worktrees/fix-login',
        permission: 'bypass',
        model: 'opus',
        name: 'Check it',
        trustFolder: false,
        firstPrompt: `${spec.role}\n\n${spec.task}`
      })
    ])
  })

  it('on another machine, starts on that machine in the same folder', async () => {
    const remote = session({ remote: { host: 'lab' }, backendId: 'agy' })
    await startBeside(deps(remote), 'tab-watched', spec)
    expect(launched[0]).toMatchObject({
      kind: 'agy',
      cwd: formatRemoteKey('lab', '/work/app/.claude/worktrees/fix-login'),
      name: undefined
    })
  })

  it('hands a Codex session its role as a role, and the task as its first prompt', async () => {
    await startBeside(deps(session()), 'tab-watched', { ...spec, backend: 'codex' })
    expect(launched[0]).toMatchObject({ kind: 'codex', role: spec.role, firstPrompt: spec.task })
  })

  it('trusts the folder for the agent only when it is a sidebar workspace or inside one', async () => {
    const atTheRoot = session({ cwd: '/work/app', treeRoot: '/work/app' })
    await startBeside(deps(atTheRoot, ['/work/app']), 'tab-watched', spec)
    await startBeside(deps(session(), ['/work/app']), 'tab-watched', spec)
    await startBeside(deps(session(), ['/work/ap']), 'tab-watched', spec)
    expect(launched.map((l) => l.trustFolder)).toEqual([true, true, false])
  })

  it('is shown under the session in the sidebar, once it binds too', async () => {
    await startBeside(deps(session()), 'tab-watched', spec)
    expect(shownUnder.parentOfRow('tab-helper')).toBe('watched')
    shownUnder.bound('tab-helper', 'helper-session')
    expect(shownUnder.parentOfRow('helper-session')).toBe('watched')
  })

  it('starts nothing beside a tab with no open session', async () => {
    const closed = session({ alive: false })
    expect(await startBeside(deps(closed), 'tab-watched', spec)).toMatchObject({ ok: false })
    expect(await startBeside(deps(undefined), 'tab-watched', spec)).toMatchObject({ ok: false })
    expect(launched).toEqual([])
  })

  it('starts no agent the owner turned off, and says why', async () => {
    expect(await startBeside(deps(session()), 'tab-watched', { ...spec, backend: 'muse' })).toEqual(
      { ok: false, why: 'Muse is turned off in Settings' }
    )
    expect(launched).toEqual([])
  })

  it('says why when the session could not start, and shows nothing under the session', async () => {
    const failing = {
      ...deps(session()),
      launch: async () => {
        throw new Error('ssh: lab is not reachable')
      }
    }
    expect(await startBeside(failing, 'tab-watched', spec)).toEqual({
      ok: false,
      why: 'ssh: lab is not reachable'
    })
    expect(shownUnder.parentOfRow('tab-helper')).toBeUndefined()
  })
})
