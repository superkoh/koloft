import type { JSX } from 'react'
import { useStore } from '@renderer/store'
import { AssistDialog } from '@renderer/components/AssistDialog'
import { butlerSetUp } from './butlerTabs'
import { useButler } from './state'

export function ButlerSetUpDialog(): JSX.Element | null {
  const asked = useButler((s) => s.setUpAsked)
  const setUp = useStore(butlerSetUp)
  if (!asked || setUp) return null
  return <AssistDialog onNotNow={() => useButler.setState({ setUpAsked: false })} />
}
