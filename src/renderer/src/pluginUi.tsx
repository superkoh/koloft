// ADR-0051
import type { JSX } from 'react'
import { PLUGINS } from '@plugins/list'
import { PLUGIN_UIS } from '@plugins/uis'
import type { UiPlace } from '@core/plugin'
import { placeUi } from '@core/ui'
import { useStore } from './store'

const PLACED = placeUi(PLUGINS, PLUGIN_UIS)

export function PartsAt({ place }: { place: UiPlace }): JSX.Element {
  return (
    <>
      {(PLACED[place] ?? []).map(({ id, Part }) => (
        <Part key={id} />
      ))}
    </>
  )
}

export function OpenCentrePage(): JSX.Element | null {
  const open = useStore((s) => s.centrePage)
  const page = PLACED['centre-page']?.find((p) => p.id === open)
  return page ? <page.Part /> : null
}
