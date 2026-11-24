import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_MANIFESTS } from '@core/agent/registry'
import { composePrompt, fillSlots, type PromptContext } from '@core/prompt'
import { DISCORD_BOUND } from '@plugins/discord/api'
import type { SavedSettings } from '@core/settings'
import { knowPluginStates, pluginStates } from '@core/switches'
import { PLUGINS } from '@plugins/list'
import { DEFAULT_SETTINGS } from '@shared/settingsOps'

const SLOTS_EACH_AGENT_FILLS = PLUGINS.flatMap((p) => p.slotsEachAgentFills ?? [])
const SLOTS_ANY_AGENT_ADDS_TO = PLUGINS.flatMap((p) => p.slotsAnyAgentAddsTo ?? [])
const BLOCKS = PLUGINS.flatMap((p) => p.text ?? [])
const BLOCKS_PICKED_BY_A_FLAG = BLOCKS.filter((block) => block.whenAgentFlag)
const VALUES_ONLY_A_SESSIONS_PROMPT_IS_GIVEN = ['question-tool', 'session-model-tiers']
const NO_AGENT: PromptContext = {}
const THE_BUTLERS_ROLE: PromptContext = {
  values: { 'butler-name': 'Alfred' },
  facts: [DISCORD_BOUND]
}

const writes = (plugin: (typeof PLUGINS)[number], slot: string): boolean =>
  (plugin.text ?? []).some((block) => block.text.includes(`{{${slot}}}`))

function turnEveryOptionalPluginOff(): void {
  const pluginsOn = Object.fromEntries(
    PLUGINS.filter((p) => !p.mandatory).map((p) => [p.id, false])
  )
  const saved = (s: unknown): SavedSettings => s as SavedSettings
  knowPluginStates(
    pluginStates(PLUGINS, saved({ ...DEFAULT_SETTINGS, pluginsOn }), saved(DEFAULT_SETTINGS))
  )
}

afterEach(() => knowPluginStates({}))

describe('the slots a plugin leaves for each agent to fill', () => {
  it('every agent fills each of them, an empty text counting as filled, and fills no slot that no plugin leaves', () => {
    expect(SLOTS_EACH_AGENT_FILLS).not.toEqual([])
    for (const agent of AGENT_MANIFESTS)
      expect(Object.keys(agent.slotFills).sort(), agent.id).toEqual(
        [...SLOTS_EACH_AGENT_FILLS].sort()
      )
  })

  it('one plugin leaves each of them, and no text block fills the same name, since the block would never be read', () => {
    expect(SLOTS_EACH_AGENT_FILLS).toEqual([...new Set(SLOTS_EACH_AGENT_FILLS)])
    expect(
      BLOCKS.map((block) => block.slot).filter((s) => SLOTS_EACH_AGENT_FILLS.includes(s))
    ).toEqual([])
  })

  it('only the plugin that leaves a slot writes it in its text, so an agent’s words for it go when that plugin is off', () => {
    const writtenElsewhere = PLUGINS.flatMap((plugin) =>
      SLOTS_EACH_AGENT_FILLS.filter(
        (slot) => !plugin.slotsEachAgentFills?.includes(slot) && writes(plugin, slot)
      ).map((slot) => `${plugin.id} writes {{${slot}}}`)
    )
    expect(writtenElsewhere).toEqual([])
  })

  it.each([
    ['on', () => {}],
    ['off', turnEveryOptionalPluginOff]
  ])(
    'a text put together for no agent, the butler’s role with its name and facts included, cannot take what belongs to the agent reading it: a slot each agent fills, a block picked by an agent’s flag, or a value only a session’s prompt is given, with every optional plugin %s',
    (_, setPlugins) => {
      setPlugins()
      for (const reader of [NO_AGENT, THE_BUTLERS_ROLE]) {
        for (const slot of SLOTS_EACH_AGENT_FILLS)
          expect(() => fillSlots(`{{${slot}}}`, reader), slot).toThrow('no agent was given')
        expect(BLOCKS_PICKED_BY_A_FLAG).not.toEqual([])
        for (const { slot } of BLOCKS_PICKED_BY_A_FLAG)
          expect(() => composePrompt(slot, reader), slot).toThrow('no agent was given')
        for (const value of VALUES_ONLY_A_SESSIONS_PROMPT_IS_GIVEN)
          expect(() => fillSlots(`{{${value}}}`, reader), value).toThrow('no value was given')
      }
    }
  )

  it('the values only a session’s prompt is given are written in the text some agent reads, so the case above is about real names', () => {
    const written = [
      ...BLOCKS.map((block) => block.text),
      ...AGENT_MANIFESTS.flatMap((agent) => Object.values(agent.slotFills))
    ].join('')
    for (const value of VALUES_ONLY_A_SESSIONS_PROMPT_IS_GIVEN)
      expect(written, value).toContain(`{{${value}}}`)
  })
})

describe('the slots a plugin leaves, in text every agent reads, for any agent to add words about itself to', () => {
  it('an agent adds only to a slot some plugin leaves, so a misspelt name is not dropped unseen, and every such slot has words from at least one agent', () => {
    expect(SLOTS_ANY_AGENT_ADDS_TO).not.toEqual([])
    for (const agent of AGENT_MANIFESTS)
      expect(
        Object.keys(agent.slotAdditions).filter((slot) => !SLOTS_ANY_AGENT_ADDS_TO.includes(slot)),
        agent.id
      ).toEqual([])
    expect(
      SLOTS_ANY_AGENT_ADDS_TO.filter(
        (slot) => !AGENT_MANIFESTS.some((agent) => Object.hasOwn(agent.slotAdditions, slot))
      )
    ).toEqual([])
  })

  it('one plugin leaves each of them, none is also a slot each agent fills, and no text block fills the same name', () => {
    expect(SLOTS_ANY_AGENT_ADDS_TO).toEqual([...new Set(SLOTS_ANY_AGENT_ADDS_TO)])
    expect(SLOTS_ANY_AGENT_ADDS_TO.filter((s) => SLOTS_EACH_AGENT_FILLS.includes(s))).toEqual([])
    expect(
      BLOCKS.map((block) => block.slot).filter((s) => SLOTS_ANY_AGENT_ADDS_TO.includes(s))
    ).toEqual([])
  })

  it('only the plugin that leaves a slot writes it in its text, so what the agents added goes when that plugin is off', () => {
    const writtenElsewhere = PLUGINS.flatMap((plugin) =>
      SLOTS_ANY_AGENT_ADDS_TO.filter(
        (slot) => !plugin.slotsAnyAgentAddsTo?.includes(slot) && writes(plugin, slot)
      ).map((slot) => `${plugin.id} writes {{${slot}}}`)
    )
    expect(writtenElsewhere).toEqual([])
  })
})
