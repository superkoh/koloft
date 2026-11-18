// ADR-0051
import type { JSX } from 'react'
import { PLUGINS } from '@plugins/list'
import { PLUGIN_UIS } from '@plugins/uis'
import type { UiPlace } from '@core/plugin'
import { placeUi, type PlacedUi, type Slot } from '@core/ui'
import { landAfterClosingAWatchedSession, useStore } from './store'
import { GLOBAL_NOTE, LANDING_AFTER_CLOSE } from './slots'

let placedOnce: PlacedUi | undefined

function placed(): PlacedUi {
  if (placedOnce) return placedOnce
  placedOnce = placeUi(PLUGINS, PLUGIN_UIS)
  for (const landing of placedOnce.fillsOf(LANDING_AFTER_CLOSE))
    landAfterClosingAWatchedSession(landing)
  return placedOnce
}

export const fillsOf = <T,>(into: Slot<T>): readonly T[] => placed().fillsOf(into)

export function useShowsGlobalNote(tabId: string | null, rowId: string | null): boolean {
  return fillsOf(GLOBAL_NOTE)
    .map((shows) => shows(tabId, rowId))
    .some(Boolean)
}

export function PartsAt({ place }: { place: UiPlace }): JSX.Element {
  return (
    <>
      {(placed().parts[place] ?? []).map(({ id, Part }) => (
        <Part key={id} />
      ))}
    </>
  )
}

export function OpenCentrePage(): JSX.Element | null {
  const open = useStore((s) => s.centrePage)
  const page = placed().parts['centre-page']?.find((p) => p.id === open)
  return page ? <page.Part /> : null
}
