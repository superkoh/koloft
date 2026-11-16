import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
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
import {
  agentPluginFiles,
  claudeProjectPrompt,
  docsPluginFiles,
  keepSkillsIn,
  KOLOFT_SKILLS,
  pluginSkillDir
} from '../../src/main/agentPlugin'
import { DISCORD_SETUP_STEPS } from '../../src/main/discord/setupSteps'

const PINNED = './prompt-text'
const RULES = 'Docs: sonnet, low.\nNever start a Codex session for work in src/renderer.'
const BUTLER = 'Alfred'

const pin = (text: string, name: string): Promise<void> =>
  expect(text).toMatchFileSnapshot(`${PINNED}/${name}.txt`)

describe('the full text of what Koloft tells an agent, pinned so that moving it around changes no character', () => {
  it.each(SESSION_BACKENDS)(
    "a %s session's prompt: one text for a local and a remote tab, whether Discord is bound or not",
    async (backend) => {
      await pin(koloftPrompt(backend), `session/${backend}`)
      await pin(koloftPrompt(backend, RULES), `session/${backend}-with-project-rules`)
    }
  )

  it('the prompt file a Claude session in a project with its own rules reads, locally and on another machine', async () => {
    await pin(claudeProjectPrompt(RULES), 'session/claude-project-prompt-file')
  })

  it('the butler, with Discord bound and without; the helper it starts in its own folder gets one text either way', async () => {
    await pin(butlerRole(BUTLER, true), 'butler/butler-discord-bound')
    await pin(butlerRole(BUTLER, false), 'butler/butler-discord-not-bound')
    await pin(butlerHelperRole(BUTLER), 'butler/helper')
    await pin(projectRulesForTheButler('koloft', RULES), 'butler/project-rules')
    await pin(ownerSays('«Merge it.»'), 'butler/message-for-the-owner')
    await pin(TODO_NOTICE, 'butler/todo-notice')
  })

  it("what koloft help prints, in every kind of tab, with and without a project's own rules", async () => {
    await pin(agentGuide(), 'help/koloft-help')
    await pin(agentGuide(RULES), 'help/koloft-help-with-project-rules')
  })

  it('the method koloft todo prints first, and the steps koloft discord setup prints', async () => {
    await pin(TODO_METHOD, 'help/todo-method')
    await pin(DISCORD_SETUP_STEPS, 'help/discord-setup-steps')
  })

  it('every file of the koloft plugin, which holds the koloft skill and the Claude prompt file', async () => {
    const files = agentPluginFiles()
    await pin(Object.keys(files).sort().join('\n'), 'koloft-plugin/_files')
    for (const [rel, text] of Object.entries(files)) await pin(text, `koloft-plugin/${rel}`)
  })

  it('every file of the koloft-docs plugin, which holds the koloft-docs skill', async () => {
    const files = docsPluginFiles()
    await pin(Object.keys(files).sort().join('\n'), 'koloft-docs-plugin/_files')
    for (const [rel, text] of Object.entries(files)) await pin(text, `koloft-docs-plugin/${rel}`)
  })
})

describe('the skills a Muse or Antigravity session reads', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
  })

  const filesUnder = (dir: string): Record<string, string> =>
    Object.fromEntries(
      fs
        .readdirSync(dir, { recursive: true, encoding: 'utf8' })
        .filter((rel) => fs.statSync(path.join(dir, rel)).isFile())
        .map((rel) => [rel.split(path.sep).join('/'), fs.readFileSync(path.join(dir, rel), 'utf8')])
    )

  it('are the same files, byte for byte, as the skills in the two Claude plugins', () => {
    const skills = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-prompt-text-'))
    roots.push(skills)
    keepSkillsIn(skills, true)
    const inPlugins = { ...agentPluginFiles(), ...docsPluginFiles() }
    for (const skill of KOLOFT_SKILLS) {
      const prefix = `${pluginSkillDir(skill)}/`
      const expected = Object.fromEntries(
        Object.entries(inPlugins)
          .filter(([rel]) => rel.startsWith(prefix))
          .map(([rel, text]) => [rel.slice(prefix.length), text])
      )
      expect(filesUnder(path.join(skills, skill))).toEqual(expected)
    }
  })
})
