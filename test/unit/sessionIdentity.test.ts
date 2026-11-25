import { describe, expect, it } from 'vitest'
import { formatRemoteKey } from '@shared/remoteKey'
import { agentSessionId, identityOf, sessionKey } from '@shared/sessionBackend'
import { workspaceWorkbenchKey } from '@shared/workbenchState'

const SESSION = '00000000-0000-4000-8000-000000000001'
const WORKSPACE_PANEL_ON_THIS_MAC = workspaceWorkbenchKey('/Users/me/proj')
const WORKSPACE_PANEL_ON_A_MACHINE = workspaceWorkbenchKey(
  formatRemoteKey('devbox', '/home/me/proj')
)

describe('identityOf (whose session a saved key is)', () => {
  it.each([
    ['claude', 'local'],
    ['codex', 'local'],
    ['agy', 'local'],
    ['claude', 'devbox'],
    ['codex', 'devbox'],
    ['agy', 'devbox']
  ] as const)(
    'a key of three parts whose first part is %s is that agent’s session, on the place its second part names (%s)',
    (backendId, sourceId) => {
      expect(identityOf(`${backendId}:${sourceId}:${SESSION}`)).toEqual({
        backendId,
        sourceId,
        nativeSessionId: SESSION
      })
    }
  )

  it('reads back, part for part, a key Koloft built from a place and an id that hold a colon, a slash or a percent sign', () => {
    const built = {
      backendId: 'codex',
      sourceId: 'me@dev:2222',
      nativeSessionId: 'a/b:c%d'
    } as const
    expect(sessionKey(built).split(':')).toHaveLength(3)
    expect(identityOf(sessionKey(built))).toEqual(built)
  })

  it.each([
    ['an id with no prefix, as saved when Claude Code was the only agent', SESSION],
    ['an empty key', ''],
    ['a key of two parts', 'codex:local'],
    ['a key of four parts', `codex:local:${SESSION}:more`],
    ['a workspace panel’s key on this Mac, which has two parts', WORKSPACE_PANEL_ON_THIS_MAC]
  ])('%s is read as a Claude Code session on this Mac whose id is the whole key', (_what, key) => {
    expect(identityOf(key)).toEqual({
      backendId: 'claude',
      sourceId: 'local',
      nativeSessionId: key
    })
  })

  it.each([
    ['names an agent this Koloft no longer has', `muse:local:${SESSION}`],
    ['is a workspace panel’s key on another machine', WORKSPACE_PANEL_ON_A_MACHINE]
  ])(
    'a key of three parts that %s is nobody’s session: it is unavailable, and the text shown for it is the key as it is',
    (_what, key) => {
      expect(key.split(':')).toHaveLength(3)
      expect(identityOf(key)).toBeUndefined()
      expect(agentSessionId(key)).toBe(key)
    }
  )
})
