import { describe, it, expect } from 'vitest'
import { koloftPrompt, WAITING_QUESTION_TOOL } from '../../src/shared/agentGuide'

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
