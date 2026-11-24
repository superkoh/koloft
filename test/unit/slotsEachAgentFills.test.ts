import { describe, expect, it } from 'vitest'
import { AGENT_MANIFESTS } from '@core/agent/registry'
import { composePrompt, fillSlots } from '@core/prompt'
import { PLUGINS } from '@plugins/list'

const SLOTS_EACH_AGENT_FILLS = PLUGINS.flatMap((p) => p.slotsEachAgentFills ?? [])
const BLOCKS_PICKED_BY_A_FLAG = PLUGINS.flatMap((p) =>
  (p.text ?? []).filter((block) => block.whenAgentFlag)
)

describe('the slots a plugin leaves for each agent to fill', () => {
  it('every agent fills each of them, an empty text counting as filled, and fills no slot that no plugin leaves', () => {
    expect(SLOTS_EACH_AGENT_FILLS).not.toEqual([])
    for (const agent of AGENT_MANIFESTS)
      expect(Object.keys(agent.slotFills).sort(), agent.id).toEqual(
        [...SLOTS_EACH_AGENT_FILLS].sort()
      )
  })

  it('a text put together for no agent cannot take what belongs to the agent reading it: a slot each agent fills, or a block picked by an agent’s flag', () => {
    for (const slot of SLOTS_EACH_AGENT_FILLS)
      expect(() => fillSlots(`{{${slot}}}`), slot).toThrow('no agent was given')
    expect(BLOCKS_PICKED_BY_A_FLAG).not.toEqual([])
    for (const { slot } of BLOCKS_PICKED_BY_A_FLAG)
      expect(() => composePrompt(slot), slot).toThrow('no agent was given')
  })
})
