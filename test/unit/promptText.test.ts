import { describe, expect, it } from 'vitest'
import {
  agentGuide,
  butlerHelperRole,
  butlerRole,
  koloftPrompt,
  ownerSays,
  projectRulesForTheButler,
  TODO_METHOD,
  TODO_NOTICE
} from '../../src/shared/agentGuide'
import { SESSION_BACKENDS } from '../../src/shared/sessionBackend'
import { agentPluginFiles, claudeProjectPrompt, docsPluginFiles } from '../../src/main/agentPlugin'
import { DISCORD_SETUP_STEPS } from '../../src/main/discord/setupSteps'

const PINNED = './prompt-text'
const RULES = 'Docs: sonnet, low.\nNever start a Codex session for work in src/renderer.'
const BUTLER = 'Alfred'

const pin = (text: string, name: string): Promise<void> =>
  expect(text).toMatchFileSnapshot(`${PINNED}/${name}.txt`)

describe('the full text of what Koloft tells an agent, pinned so that moving it around changes no character', () => {
  it.each(SESSION_BACKENDS.filter((backend) => backend !== 'claude'))(
    "a %s session's prompt",
    (backend) => pin(koloftPrompt(backend), `session/${backend}`)
  )

  it.each(SESSION_BACKENDS.filter((backend) => backend !== 'claude'))(
    "a %s session's prompt in a project with its own rules for picking a model",
    (backend) => pin(koloftPrompt(backend, RULES), `session/${backend}-project-rules`)
  )

  it('the prompt file a Claude session reads in a project with its own rules for picking a model', () =>
    pin(claudeProjectPrompt(RULES), 'session/claude-project-prompt-file'))

  it('the butler, with Discord bound and without, and the helper it starts in its own folder', async () => {
    await pin(butlerRole(BUTLER, true), 'butler/butler-discord-bound')
    await pin(butlerRole(BUTLER, false), 'butler/butler-discord-not-bound')
    await pin(butlerHelperRole(BUTLER), 'butler/helper')
    await pin(projectRulesForTheButler('koloft', RULES), 'butler/project-rules')
    await pin(ownerSays('«Merge it.»'), 'butler/message-for-the-owner')
    await pin(TODO_NOTICE, 'butler/todo-notice')
  })

  it("what koloft help prints, with and without a project's own rules for picking a model", async () => {
    await pin(agentGuide(), 'help/koloft-help')
    await pin(agentGuide(RULES), 'help/koloft-help-with-project-rules')
  })

  it('the method koloft todo prints first, and the steps koloft discord setup prints', async () => {
    await pin(TODO_METHOD, 'help/todo-method')
    await pin(DISCORD_SETUP_STEPS, 'help/discord-setup-steps')
  })

  it.each([
    ['koloft-plugin', agentPluginFiles],
    ['koloft-docs-plugin', docsPluginFiles]
  ] as const)(
    'every file of the %s, which holds its skill (and, for koloft, the prompt file every Claude session reads)',
    async (plugin, files) => {
      const written = files()
      await pin(Object.keys(written).sort().join('\n'), `${plugin}/_files`)
      for (const [rel, text] of Object.entries(written)) await pin(text, `${plugin}/${rel}`)
    }
  )
})
