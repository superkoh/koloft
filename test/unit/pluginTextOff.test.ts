import { afterEach, describe, expect, it } from 'vitest'
import { knowPluginStates, pluginStates } from '../../src/core/switches'
import type { SavedSettings } from '../../src/core/settings'
import { PLUGINS } from '../../src/plugins/list'
import { DEFAULT_SETTINGS } from '../../src/shared/settingsOps'
import { agentGuide, agentSkillDescription } from '../../src/shared/agentGuide'
import { todoMethod } from '../../src/plugins/todo/api'
import { koloftPrompt } from '../../src/plugins/sessions/api'
import { butlerHelperRole, butlerRole } from '../../src/plugins/butler/api'
import { DISCORD_BOUND } from '../../src/plugins/discord/api'
import { agentPluginFiles } from '../../src/main/agentPlugin'
import { SESSION_BACKENDS } from '../../src/shared/sessionBackend'

const BUTLER = 'Alfred'
const OPTIONAL = PLUGINS.filter((p) => !p.mandatory)
const saved = (s: unknown): SavedSettings => s as SavedSettings

function statesWithOff(ids: readonly string[]) {
  const pluginsOn = Object.fromEntries(OPTIONAL.map((p) => [p.id, !ids.includes(p.id)]))
  return pluginStates(PLUGINS, saved({ ...DEFAULT_SETTINGS, pluginsOn }), saved(DEFAULT_SETTINGS))
}

function turnOff(ids: readonly string[]) {
  const states = statesWithOff(ids)
  knowPluginStates(states)
  return PLUGINS.filter((p) => !states[p.id].on)
}

const everyText = (): Record<string, string> => ({
  help: agentGuide(),
  'skill description': agentSkillDescription(),
  butler: butlerRole(BUTLER, [DISCORD_BOUND]),
  helper: butlerHelperRole(BUTLER),
  'todo method': todoMethod(),
  ...Object.fromEntries(SESSION_BACKENDS.map((b) => [`${b} session`, koloftPrompt(b)]))
})

const ownWords = (id: string): string[] =>
  (PLUGINS.find((p) => p.id === id)!.text ?? [])
    .flatMap((block) => [block.text, ...Object.values(block.byAgent ?? {})])
    .flatMap((text) => text.split(/\{\{[a-z-]+\}\}/))
    .map((part) => part.trim())
    .filter((part) => part.length > 12)

const JOINT_DEBRIS = [/\{\{/, /\S {2,}\S/, / ,/, /, ,/, /,\./, /\n\n\n/, /\( /, / \)/]

afterEach(() => knowPluginStates({}))

describe('the text an agent gets when optional plugins are turned off', () => {
  const combinations = OPTIONAL.reduce<string[][]>(
    (all, p) => [...all, ...all.map((c) => [...c, p.id])],
    [[]]
  )

  it.each(combinations.map((ids) => [ids.join(', ') || 'none', ids]))(
    'with %s off, no sentence of an off plugin is left and no joint is left broken',
    (_, ids) => {
      const off = turnOff(ids as string[])
      for (const [name, text] of Object.entries(everyText())) {
        for (const debris of JOINT_DEBRIS) expect(text, `${name}: ${debris}`).not.toMatch(debris)
        for (const p of off)
          for (const words of ownWords(p.id))
            expect(text.includes(words), `${name} still holds ${p.id}: ${words}`).toBe(false)
      }
    }
  )

  it('with Todo off, koloft help, the koloft skill and the butler lose the to-dos, pinned, and every session prompt stays as it was', async () => {
    const sessions = SESSION_BACKENDS.map((b) => koloftPrompt(b))
    turnOff(['todo'])
    expect(SESSION_BACKENDS.map((b) => koloftPrompt(b))).toEqual(sessions)
    await expect(agentGuide()).toMatchFileSnapshot('./prompt-text/todo-off/koloft-help.txt')
    await expect(agentPluginFiles()['skills/koloft/SKILL.md']).toMatchFileSnapshot(
      './prompt-text/todo-off/koloft-skill.md'
    )
    await expect(butlerRole(BUTLER, [DISCORD_BOUND])).toMatchFileSnapshot(
      './prompt-text/todo-off/butler-discord-bound.txt'
    )
    await expect(butlerHelperRole(BUTLER)).toMatchFileSnapshot('./prompt-text/todo-off/helper.txt')
  })

  it('with Passwords and sign-in off, koloft help and the koloft skill lose passwords, codes, sign-ins and robot checks, pinned, and the rest stays as it was', async () => {
    const before = {
      sessions: SESSION_BACKENDS.map((b) => koloftPrompt(b)),
      butler: butlerRole(BUTLER, [DISCORD_BOUND]),
      helper: butlerHelperRole(BUTLER)
    }
    turnOff(['passwords'])
    expect({
      sessions: SESSION_BACKENDS.map((b) => koloftPrompt(b)),
      butler: butlerRole(BUTLER, [DISCORD_BOUND]),
      helper: butlerHelperRole(BUTLER)
    }).toEqual(before)
    await expect(agentGuide()).toMatchFileSnapshot('./prompt-text/passwords-off/koloft-help.txt')
    await expect(agentPluginFiles()['skills/koloft/SKILL.md']).toMatchFileSnapshot(
      './prompt-text/passwords-off/koloft-skill.md'
    )
  })

  it('with GitHub off, koloft help and the koloft skill lose koloft gh and the to-dos, the butler stops being told how to open an issue, pinned, and every session prompt stays as it was', async () => {
    const before = { sessions: SESSION_BACKENDS.map((b) => koloftPrompt(b)), todo: todoMethod() }
    turnOff(['github'])
    expect({ sessions: SESSION_BACKENDS.map((b) => koloftPrompt(b)), todo: todoMethod() }).toEqual(
      before
    )
    await expect(agentGuide()).toMatchFileSnapshot('./prompt-text/github-off/koloft-help.txt')
    const files = agentPluginFiles()
    await expect(files['skills/koloft/SKILL.md']).toMatchFileSnapshot(
      './prompt-text/github-off/koloft-skill.md'
    )
    await expect(files['koloft-prompt.md']).toMatchFileSnapshot(
      './prompt-text/github-off/claude-prompt-file.md'
    )
    await expect(butlerRole(BUTLER, [DISCORD_BOUND])).toMatchFileSnapshot(
      './prompt-text/github-off/butler-discord-bound.txt'
    )
    await expect(butlerHelperRole(BUTLER)).toMatchFileSnapshot(
      './prompt-text/github-off/helper.txt'
    )
  })

  it('with Discord off, koloft help, the koloft skill, every session prompt, the butler and its helper lose Discord, pinned, and the butler bound to a channel reads as one with none', async () => {
    turnOff(['discord'])
    expect(butlerRole(BUTLER, [DISCORD_BOUND])).toBe(butlerRole(BUTLER))
    await expect(butlerRole(BUTLER)).toMatchFileSnapshot('./prompt-text/discord-off/butler.txt')
    await expect(butlerHelperRole(BUTLER)).toMatchFileSnapshot(
      './prompt-text/discord-off/helper.txt'
    )
    await expect(agentGuide()).toMatchFileSnapshot('./prompt-text/discord-off/koloft-help.txt')
    const files = agentPluginFiles()
    await expect(files['skills/koloft/SKILL.md']).toMatchFileSnapshot(
      './prompt-text/discord-off/koloft-skill.md'
    )
    await expect(files['koloft-prompt.md']).toMatchFileSnapshot(
      './prompt-text/discord-off/claude-prompt-file.md'
    )
    for (const b of SESSION_BACKENDS)
      await expect(koloftPrompt(b)).toMatchFileSnapshot(`./prompt-text/discord-off/${b}.txt`)
    await expect(todoMethod()).toMatchFileSnapshot('./prompt-text/discord-off/todo-method.txt')
  })
})
