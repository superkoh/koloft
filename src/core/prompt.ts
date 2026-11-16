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

const BLOCKS_IN_LIST_ORDER: readonly TextBlock[] = PLUGINS.flatMap((p) => p.text ?? [])

const textFor = (block: TextBlock, agent: BackendId | undefined): string =>
  (agent ? block.byAgent?.[agent] : undefined) ?? block.text

export function composePrompt(slot: string, context: PromptContext = {}): string {
  const { agent, facts = [], values = {} } = context
  return BLOCKS_IN_LIST_ORDER.filter(
    (block) => block.slot === slot && (!block.when || facts.includes(block.when))
  )
    .map((block) => textFor(block, agent))
    .join('')
    .replace(SLOT_OR_VALUE, (_, name: string) => {
      if (Object.hasOwn(values, name)) return values[name]
      if (!BLOCKS_IN_LIST_ORDER.some((block) => block.slot === name))
        throw new Error(`No text block fills {{${name}}} and no value was given for it`)
      return composePrompt(name, context)
    })
}
