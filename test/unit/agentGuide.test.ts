import { describe, it, expect } from 'vitest'
import { DISCORD_PREFIX, koloftPrompt, WAITING_QUESTION_TOOL } from '../../src/shared/agentGuide'
import { SESSION_BACKENDS } from '../../src/shared/sessionBackend'

describe('koloftPrompt on Discord', () => {
  it.each(SESSION_BACKENDS)(
    'tells a %s session that a message starting with [Discord] is the owner on the phone, to answer short and ask with its question tool',
    (backend) => {
      const discord = koloftPrompt(backend).slice(koloftPrompt(backend).indexOf('DISCORD'))
      expect(discord).toContain(`starts with ${DISCORD_PREFIX} is the owner`)
      expect(discord).toContain(WAITING_QUESTION_TOOL[backend])
    }
  )

  it('tells a Claude session such a message arrives as one from another session, which it is not', () => {
    expect(koloftPrompt('claude')).toContain('reaches you as a message from another session')
    expect(koloftPrompt('codex')).not.toContain('reaches you as a message from another session')
  })
})

describe('koloftPrompt questions', () => {
  it.each(['codex', 'muse', 'agy'] as const)(
    'names the question tool of a %s session under QUESTIONS',
    (backend) => {
      const prompt = koloftPrompt(backend)
      const questions = prompt.indexOf('QUESTIONS')
      expect(questions).toBeGreaterThan(-1)
      expect(prompt.slice(questions)).toContain(WAITING_QUESTION_TOOL[backend])
    }
  )
})
