// ADR-0051
import type { BackendId } from '@shared/types'
import type { TextBlock } from './plugin'
import { AGENT_MANIFESTS, agentManifest } from './agent/registry'
import { pluginStateOf } from './switches'
import { PLUGINS } from '@plugins/list'

export interface PromptContext {
  agent?: BackendId
  facts?: readonly string[]
  values?: Readonly<Record<string, string>>
}

const SLOT_OR_VALUE = /\{\{([a-z-]+)\}\}/g

const BLOCKS_IN_LIST_ORDER = PLUGINS.flatMap((p) =>
  (p.text ?? []).map((block) => ({ block, plugin: p.id }))
)

const DECLARED_SLOTS = new Set(BLOCKS_IN_LIST_ORDER.map(({ block }) => block.slot))

const SLOTS_EACH_AGENT_FILLS = new Set(PLUGINS.flatMap((p) => p.slotsEachAgentFills ?? []))

const SLOTS_ANY_AGENT_ADDS_TO = new Set(PLUGINS.flatMap((p) => p.slotsAnyAgentAddsTo ?? []))

const whatAgentsAddTo = (slot: string): string =>
  AGENT_MANIFESTS.map((agent) => agent.slotAdditions[slot] ?? '').join('')

const textFor = (block: TextBlock, agent: BackendId | undefined): string =>
  (agent ? block.byAgent?.[agent] : undefined) ?? block.text

const OR_LIST = '-or-list'

const asTheEndOfAList = (items: readonly string[]): string =>
  items.map((item, i) => (i === items.length - 1 ? ', or ' : ', ') + item).join('')

export interface PromptState {
  on: Readonly<Record<string, boolean>>
  facts: readonly string[]
}

type ListedBlock = (typeof BLOCKS_IN_LIST_ORDER)[number]

const isOnIn = (state: PromptState, id: string): boolean => state.on[id] ?? pluginStateOf(id).on

function theAgentReading(agent: BackendId | undefined, what: string): BackendId {
  if (!agent) throw new Error(`${what} is about the agent reading it, and no agent was given`)
  return agent
}

const pickedFor = (block: TextBlock, agent: BackendId | undefined): boolean =>
  !block.whenAgentFlag ||
  agentManifest(theAgentReading(agent, `A block of slot ${block.slot}`)).flags[block.whenAgentFlag]

const holdsIn = (state: PromptState, { block, plugin }: ListedBlock, agent?: BackendId): boolean =>
  pickedFor(block, agent) &&
  isOnIn(state, plugin) &&
  (!block.when || state.facts.includes(block.when))

export function composePrompt(slot: string, context: PromptContext = {}): string {
  const now: PromptState = { on: {}, facts: context.facts ?? [] }
  const texts = BLOCKS_IN_LIST_ORDER.filter(
    (listed) => listed.block.slot === slot && holdsIn(now, listed, context.agent)
  ).map(({ block }) => textFor(block, context.agent))
  return fillSlots(slot.endsWith(OR_LIST) ? asTheEndOfAList(texts) : texts.join(''), context)
}

export const fillsGained = (
  slots: readonly string[],
  was: PromptState,
  now: PromptState
): string[] =>
  slots.flatMap((slot) =>
    BLOCKS_IN_LIST_ORDER.filter(
      (listed) => listed.block.slot === slot && holdsIn(now, listed) && !holdsIn(was, listed)
    ).map(({ block }) => fillSlots(block.text, { facts: now.facts }))
  )

export function fillSlots(text: string, context: PromptContext = {}): string {
  const { values = {} } = context
  return text.replace(SLOT_OR_VALUE, (_, name: string) => {
    if (Object.hasOwn(values, name)) return values[name]
    if (SLOTS_EACH_AGENT_FILLS.has(name)) {
      const agent = theAgentReading(context.agent, `{{${name}}}`)
      const words: string | undefined = agentManifest(agent).slotFills[name]
      if (words === undefined) throw new Error(`The agent ${agent} fills no {{${name}}}`)
      return fillSlots(words, context)
    }
    if (SLOTS_ANY_AGENT_ADDS_TO.has(name)) return whatAgentsAddTo(name)
    if (!DECLARED_SLOTS.has(name))
      throw new Error(`No text block fills {{${name}}} and no value was given for it`)
    return composePrompt(name, context)
  })
}
