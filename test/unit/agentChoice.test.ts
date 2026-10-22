import { describe, expect, it } from 'vitest'
import {
  enterHint,
  enterMethod,
  firstHot,
  type AgentChoice
} from '../../src/renderer/src/agentChoice'
import type { BackendId } from '../../src/shared/types'

function choice(
  listed: BackendId[],
  lead: BackendId,
  blocked: Partial<Record<BackendId, string>> = {}
): AgentChoice {
  return {
    listed,
    lead,
    defaultBackend: lead,
    issue: (b) => blocked[b] ?? '',
    note: () => ''
  }
}

const plain = false
const shift = true

describe('which agent ⏎ and ⇧⏎ start in a new-session dialog', () => {
  it('⏎ always starts the agent the button names', () => {
    expect(enterMethod(plain, choice(['claude', 'codex', 'muse'], 'codex'))).toBe('codex')
  })

  it('with two agents listed, ⇧⏎ starts the other one straight away', () => {
    expect(enterMethod(shift, choice(['claude', 'codex'], 'claude'))).toBe('codex')
    expect(enterMethod(shift, choice(['claude', 'codex'], 'codex'))).toBe('claude')
  })

  it('with two agents listed and the other one unusable, ⇧⏎ opens the list so its reason shows', () => {
    expect(enterMethod(shift, choice(['claude', 'codex'], 'claude', { codex: 'Local only' }))).toBe(
      'list'
    )
  })

  it('with three or more agents listed, ⇧⏎ opens the list', () => {
    expect(enterMethod(shift, choice(['claude', 'codex', 'muse'], 'claude'))).toBe('list')
  })

  it('with one agent listed, ⇧⏎ starts it like ⏎', () => {
    expect(enterMethod(shift, choice(['claude'], 'claude'))).toBe('claude')
  })

  it('the hint names what ⇧⏎ does, and says nothing with one agent', () => {
    expect(enterHint(choice(['claude', 'codex'], 'claude'))).toBe('⏎ Claude · ⇧⏎ Codex')
    expect(enterHint(choice(['claude', 'codex', 'muse'], 'claude'))).toBe(
      '⏎ Claude · ⇧⏎ other agent'
    )
    expect(enterHint(choice(['claude'], 'claude'))).toBe('')
  })
})

describe('the row the agent list opens on', () => {
  it('is the first usable agent the button does not already name', () => {
    expect(firstHot(choice(['claude', 'codex', 'muse'], 'claude'))).toBe(1)
    expect(firstHot(choice(['claude', 'codex', 'muse'], 'claude', { codex: 'No account' }))).toBe(2)
  })

  it('is the first usable agent when the named one cannot start', () => {
    expect(firstHot(choice(['claude', 'codex'], 'codex', { codex: 'No account' }))).toBe(0)
  })
})
