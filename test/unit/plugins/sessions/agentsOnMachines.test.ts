import { describe, expect, it } from 'vitest'
import {
  SessionBackends,
  type StoredRemoteWiredByHand
} from '../../../../src/core/agent/sessionBackends'
import type { BackendId } from '@shared/types'
import { lifecycle } from '../../helpers/sessionBackendStub'

const MACHINE = 'devbox'
const SESSIONS_THAT_LEFT = ['session-a', 'session-b']
const FIRST_OF_THE_LIST: BackendId = 'claude'

type Notice = 'sessions left' | 'mirror pulled'

interface AgentOnMachines {
  id: BackendId
  hears: Notice[]
  tmuxOfItsTabs: Record<string, string | undefined>
}

const agent = (
  id: BackendId,
  hears: Notice[] = [],
  tmuxOfItsTabs: Record<string, string | undefined> = {}
): AgentOnMachines => ({ id, hears, tmuxOfItsTabs })

function backendsOf(said: string[], agents: AgentOnMachines[]): SessionBackends {
  const backends = new SessionBackends(lifecycle())
  const heardLeft = (a: AgentOnMachines) => (host: string, ids: string[]) =>
    void said.push(`${a.id} hears that ${ids.join(', ')} left ${host}`)
  const first = agents.find((a) => a.id === FIRST_OF_THE_LIST)
  if (first)
    backends.remoteByHand = {
      noticeRemoteExits: first.hears.includes('sessions left') ? heardLeft(first) : () => {},
      tmuxOfTab: (tabId) => first.tmuxOfItsTabs[tabId]
    }
  const others = agents
    .filter((a) => a !== first)
    .map((a): StoredRemoteWiredByHand => ({
      hasTab: (tabId) => tabId in a.tmuxOfItsTabs,
      ...(a.hears.includes('sessions left') && { noticeRemoteExits: heardLeft(a) }),
      ...(a.hears.includes('mirror pulled') && {
        followMirrors: (host) => void said.push(`${a.id} hears that the mirror of ${host} came`)
      }),
      ...(Object.values(a.tmuxOfItsTabs).some(Boolean) && {
        tmuxOfTab: (tabId) => a.tmuxOfItsTabs[tabId]
      })
    }))
  backends.storedRemoteByHand = () => others
  return backends
}

describe('sessions that left a machine, as the agents are told of it', () => {
  it('the first agent of the list hears of them first, then the others in the order of the list of agents, each with the machine and the same sessions; one that does nothing with the news is no obstacle', () => {
    const said: string[] = []
    backendsOf(said, [
      agent('claude', ['sessions left']),
      agent('codex', ['sessions left']),
      agent('agy', ['sessions left'])
    ]).noticeRemoteExits(MACHINE, SESSIONS_THAT_LEFT)
    expect(said).toEqual([
      'claude hears that session-a, session-b left devbox',
      'codex hears that session-a, session-b left devbox',
      'agy hears that session-a, session-b left devbox'
    ])

    said.length = 0
    backendsOf(said, [
      agent('claude', ['sessions left']),
      agent('codex'),
      agent('agy', ['sessions left'])
    ]).noticeRemoteExits(MACHINE, SESSIONS_THAT_LEFT)
    expect(said).toEqual([
      'claude hears that session-a, session-b left devbox',
      'agy hears that session-a, session-b left devbox'
    ])
  })

  it('an agent that was not built is passed over: the others still hear', () => {
    const said: string[] = []
    backendsOf(said, [
      agent('claude', ['sessions left']),
      agent('agy', ['sessions left'])
    ]).noticeRemoteExits(MACHINE, SESSIONS_THAT_LEFT)
    expect(said).toEqual([
      'claude hears that session-a, session-b left devbox',
      'agy hears that session-a, session-b left devbox'
    ])
  })
})

describe('the mirror of a machine that was just pulled, as the agents are told of it', () => {
  it('every agent that is there hears which machine, in the order of the list of agents; one that was not built is passed over', () => {
    const said: string[] = []
    backendsOf(said, [
      agent('claude'),
      agent('codex', ['mirror pulled']),
      agent('agy', ['mirror pulled'])
    ]).mirrorPulled(MACHINE)
    expect(said).toEqual([
      'codex hears that the mirror of devbox came',
      'agy hears that the mirror of devbox came'
    ])

    said.length = 0
    backendsOf(said, [agent('claude'), agent('agy', ['mirror pulled'])]).mirrorPulled(MACHINE)
    expect(said).toEqual(['agy hears that the mirror of devbox came'])
  })
})

describe('the tmux session a tab runs in on a machine', () => {
  const everyAgent = (): AgentOnMachines[] => [
    agent('claude', [], { 't-claude': 'k-a-claude-session', 't-claude-here': undefined }),
    agent('codex', [], { 't-codex': undefined }),
    agent('agy', [], { 't-agy': 'k-an-agy-conversation' })
  ]

  it('is the one the tab’s own agent names, for the first agent of the list and for a later one; a tab on this Mac, a tab whose agent runs it in no tmux session there and a tab of nobody have none', () => {
    const backends = backendsOf([], everyAgent())
    expect(backends.tmuxOfTab('t-claude')).toBe('k-a-claude-session')
    expect(backends.tmuxOfTab('t-agy')).toBe('k-an-agy-conversation')
    expect(backends.tmuxOfTab('t-claude-here')).toBeUndefined()
    expect(backends.tmuxOfTab('t-codex')).toBeUndefined()
    expect(backends.tmuxOfTab('t-shell')).toBeUndefined()
  })

  it('a tab of an agent that was not built has none, and asking is no error', () => {
    const backends = backendsOf(
      [],
      everyAgent().filter((a) => a.id !== 'agy')
    )
    expect(backends.tmuxOfTab('t-agy')).toBeUndefined()
    expect(backends.tmuxOfTab('t-claude')).toBe('k-a-claude-session')
  })
})
