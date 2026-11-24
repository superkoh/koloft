import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_MANIFESTS } from '@core/agent/registry'
import { composePrompt, fillSlots } from '@core/prompt'
import type { SavedSettings } from '@core/settings'
import { knowPluginStates, pluginStates } from '@core/switches'
import { PLUGINS } from '@plugins/list'
import { DEFAULT_SETTINGS } from '@shared/settingsOps'

const SLOTS_EACH_AGENT_FILLS = PLUGINS.flatMap((p) => p.slotsEachAgentFills ?? [])
const BLOCKS = PLUGINS.flatMap((p) => p.text ?? [])
const BLOCKS_PICKED_BY_A_FLAG = BLOCKS.filter((block) => block.whenAgentFlag)

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
        (slot) =>
          !plugin.slotsEachAgentFills?.includes(slot) &&
          (plugin.text ?? []).some((block) => block.text.includes(`{{${slot}}}`))
      ).map((slot) => `${plugin.id} writes {{${slot}}}`)
    )
    expect(writtenElsewhere).toEqual([])
  })

  it.each([
    ['on', () => {}],
    ['off', turnEveryOptionalPluginOff]
  ])(
    'a text put together for no agent cannot take what belongs to the agent reading it, a slot each agent fills or a block picked by an agent’s flag, with every optional plugin %s',
    (_, setPlugins) => {
      setPlugins()
      for (const slot of SLOTS_EACH_AGENT_FILLS)
        expect(() => fillSlots(`{{${slot}}}`), slot).toThrow('no agent was given')
      expect(BLOCKS_PICKED_BY_A_FLAG).not.toEqual([])
      for (const { slot } of BLOCKS_PICKED_BY_A_FLAG)
        expect(() => composePrompt(slot), slot).toThrow('no agent was given')
    }
  )
})
