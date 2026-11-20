// ADR-0051
import type { BackendId } from '@shared/types'
import type { TextBlock } from './plugin'
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

const holdsIn = (state: PromptState, { block, plugin }: ListedBlock): boolean =>
  isOnIn(state, plugin) &&
  (!block.when || state.facts.includes(block.when)) &&
  (!block.whenOff || !isOnIn(state, block.whenOff))

export function composePrompt(slot: string, context: PromptContext = {}): string {
  const now: PromptState = { on: {}, facts: context.facts ?? [] }
  const texts = BLOCKS_IN_LIST_ORDER.filter(
    (listed) => listed.block.slot === slot && holdsIn(now, listed)
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
    if (!DECLARED_SLOTS.has(name))
      throw new Error(`No text block fills {{${name}}} and no value was given for it`)
    return composePrompt(name, context)
  })
}
