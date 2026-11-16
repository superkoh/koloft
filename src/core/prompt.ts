// ADR-0051
import type { BackendId } from '@shared/types'
import type { TextBlock } from './plugin'
import { PLUGINS } from '@plugins/list'

export interface PromptContext {
  agent?: BackendId
  facts?: readonly string[]
  values?: Readonly<Record<string, string>>
}

const SLOT_OR_VALUE = /\{\{([a-z-]+)\}\}/g

const BLOCKS_IN_LIST_ORDER = PLUGINS.flatMap((p) => p.text ?? [])

const BLOCKS_BY_SLOT_IN_LIST_ORDER = new Map(
  BLOCKS_IN_LIST_ORDER.map((b) => [b.slot, BLOCKS_IN_LIST_ORDER.filter((o) => o.slot === b.slot)])
)

const textFor = (block: TextBlock, agent: BackendId | undefined): string =>
  (agent ? block.byAgent?.[agent] : undefined) ?? block.text

export function composePrompt(slot: string, context: PromptContext = {}): string {
  const { agent, facts = [], values = {} } = context
  return (BLOCKS_BY_SLOT_IN_LIST_ORDER.get(slot) ?? [])
    .filter((block) => !block.when || facts.includes(block.when))
    .map((block) => textFor(block, agent))
    .join('')
    .replace(SLOT_OR_VALUE, (_, name: string) => {
      if (Object.hasOwn(values, name)) return values[name]
      if (!BLOCKS_BY_SLOT_IN_LIST_ORDER.has(name))
        throw new Error(`No text block fills {{${name}}} and no value was given for it`)
      return composePrompt(name, context)
    })
}
