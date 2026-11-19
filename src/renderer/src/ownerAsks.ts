import { useMemo } from 'react'
import { useFillsOf } from './pluginUi'
import { useStore } from './store'
import { OWNER_ASKS, type OverTerminal, type OwnerAsks, type PageAsk } from './slots'

const useEachAsker = <R>(use: (asker: OwnerAsks) => R): (R | undefined)[] =>
  useFillsOf(OWNER_ASKS, use)

const NOTHING: readonly never[] = []

export function useWatchOwnerAsks(): void {
  useEachAsker((asker) => asker.useWatch())
}

export function useAskedTabs(): readonly { tabId: string }[] {
  const lists = useEachAsker((asker) => asker.useAsked())
  const instructionAsks = useStore((s) => s.instructionAsks)
  return useMemo(
    () => [...lists.flatMap((list) => list ?? NOTHING), ...instructionAsks],
    [...lists, instructionAsks]
  )
}

export function useOverTerminal(): (tabId: string) => OverTerminal | undefined {
  const lookups = useEachAsker((asker) => asker.useOverTerminal())
  return (tabId) => lookups.map((overOf) => overOf?.(tabId)).find(Boolean)
}

export function usePageAsk(ownerTab: string | null): PageAsk | undefined {
  return useEachAsker((asker) => asker.usePageAsk(ownerTab)).find(Boolean)
}

export function useHeldGuests(): readonly number[] {
  const lists = useEachAsker((asker) => asker.useHeldGuests())
  return useMemo(() => lists.flatMap((list) => list ?? NOTHING), lists)
}
