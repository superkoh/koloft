import { useMemo } from 'react'
import { fillsOf } from './pluginUi'
import { useStore } from './store'
import { OWNER_ASKS, type OverTerminal, type OwnerAsks, type PageAsk } from './slots'

const askers = (): readonly OwnerAsks[] => fillsOf(OWNER_ASKS)

export function useWatchOwnerAsks(): void {
  for (const asker of askers()) asker.useWatch()
}

export function useAskedTabs(): readonly { tabId: string }[] {
  const asked = askers().flatMap((asker) => asker.useAsked())
  const instructionAsks = useStore((s) => s.instructionAsks)
  return [...asked, ...instructionAsks]
}

export function useOverTerminal(): (tabId: string) => OverTerminal | undefined {
  const lookups = askers().map((asker) => asker.useOverTerminal())
  return (tabId) => lookups.map((overOf) => overOf(tabId)).find(Boolean)
}

export function usePageAsk(ownerTab: string | null): PageAsk | undefined {
  return askers()
    .map((asker) => asker.usePageAsk(ownerTab))
    .find(Boolean)
}

export function useHeldGuests(): readonly number[] {
  const lists = askers().map((asker) => asker.useHeldGuests())
  return useMemo(() => lists.flat(), lists)
}
