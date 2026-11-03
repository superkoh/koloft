import { describe, it, expect } from 'vitest'
import { koloftPrompt, WAITING_QUESTION_TOOL } from '../../src/shared/agentGuide'

describe('koloftPrompt questions', () => {
  it.each(['codex', 'muse', 'agy'] as const)(
    'tells a %s session to ask the owner with its own question tool, the one Koloft watches',
    (backend) => {
      const prompt = koloftPrompt(backend)
      expect(prompt).toContain('QUESTIONS')
      expect(prompt).toContain(`ask with ${WAITING_QUESTION_TOOL[backend]}`)
    }
  )
})
