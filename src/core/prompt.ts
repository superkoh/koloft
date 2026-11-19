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

export function composePrompt(slot: string, context: PromptContext = {}): string {
  const { agent, facts = [], values = {} } = context
  return BLOCKS_IN_LIST_ORDER.filter(
    ({ block, plugin }) =>
      block.slot === slot && pluginStateOf(plugin).on && (!block.when || facts.includes(block.when))
  )
    .map(({ block }) => textFor(block, agent))
    .join('')
    .replace(SLOT_OR_VALUE, (_, name: string) => {
      if (Object.hasOwn(values, name)) return values[name]
      if (!DECLARED_SLOTS.has(name))
        throw new Error(`No text block fills {{${name}}} and no value was given for it`)
      return composePrompt(name, context)
    })
}
