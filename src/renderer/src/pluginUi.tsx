// ADR-0051
import type { JSX } from 'react'
import { PLUGINS } from '@plugins/list'
import { PLUGIN_UIS } from '@plugins/uis'
import type { UiPlace } from '@core/plugin'
import { placeUi, type PlacedPart, type PlacedUi, type Slot } from '@core/ui'
import { keepWorkspacesOutOfTheList, landAfterClosingAWatchedSession, useStore } from './store'
import {
  GLOBAL_NOTE,
  LANDING_AFTER_CLOSE,
  WORKSPACE_CLAIM,
  WORKSPACE_GIT_PART,
  type WorkspaceGitPart
} from './slots'
import type { WorkspaceRows } from '@shared/types'

let placedOnce: PlacedUi | undefined

function placed(): PlacedUi {
  if (placedOnce) return placedOnce
  placedOnce = placeUi(PLUGINS, PLUGIN_UIS)
  const [landing] = placedOnce.fillsOf(LANDING_AFTER_CLOSE)
  if (landing) landAfterClosingAWatchedSession(landing)
  const claims = placedOnce.fillsOf(WORKSPACE_CLAIM)
  keepWorkspacesOutOfTheList((w) => claims.some((claim) => claim(w)))
  return placedOnce
}

export function placePluginUi(): void {
  placed()
}

export const fillsOf = <T,>(into: Slot<T>): readonly T[] => placed().fillsOf(into)

export const partsAt = (place: UiPlace): readonly PlacedPart[] => placed().parts[place] ?? []

export const gitPartsOf = (ws: WorkspaceRows['workspace']): readonly WorkspaceGitPart[] =>
  fillsOf(WORKSPACE_GIT_PART).filter((part) => part.shows(ws))

export function useShowsGlobalNote(tabId: string | null, rowId: string | null): boolean {
  return fillsOf(GLOBAL_NOTE)
    .map((shows) => shows(tabId, rowId))
    .some(Boolean)
}

export function PartsAt({ place }: { place: UiPlace }): JSX.Element {
  return (
    <>
      {partsAt(place).map(({ id, Part }) => (
        <Part key={id} />
      ))}
    </>
  )
}

export function OpenCentrePage(): JSX.Element | null {
  const open = useStore((s) => s.centrePage)
  const page = partsAt('centre-page').find((p) => p.id === open)
  return page ? <page.Part /> : null
}
