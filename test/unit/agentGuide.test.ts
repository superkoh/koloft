import { describe, it, expect } from 'vitest'
import {
  AGENT_GUIDE,
  agentGuide,
  DISCORD_PREFIX,
  koloftPrompt,
  WAITING_QUESTION_TOOL
} from '../../src/shared/agentGuide'
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

describe("a project's own rules for picking a session's model and effort", () => {
  const RULES = 'Docs: sonnet, low.\nNever start a Codex session for work in src/renderer.'

  it.each(SESSION_BACKENDS)(
    'come first in what a %s session is told at start, with Koloft’s own way after them, and are not there for a project without rules',
    (backend) => {
      const told = koloftPrompt(backend, RULES)
      const rules = told.indexOf('    Docs: sonnet, low.\n    Never start a Codex session')
      expect(rules).toBeGreaterThan(-1)
      expect(rules).toBeLessThan(told.indexOf("Koloft's own way: Sort the task first."))
      expect(koloftPrompt(backend)).not.toContain("Koloft's own way")
    }
  )

  it('come first in koloft help under session new, indented with it, and are not in the help of a project without rules', () => {
    const help = agentGuide(RULES)
    const at = help.indexOf('koloft session new [')
    expect(help.slice(at)).toContain(
      "they leave out.\n        Docs: sonnet, low.\n        Never start a Codex session for work in src/renderer.\n    Koloft's own way: Sort the task first."
    )
    expect(AGENT_GUIDE).not.toContain("Koloft's own way")
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
