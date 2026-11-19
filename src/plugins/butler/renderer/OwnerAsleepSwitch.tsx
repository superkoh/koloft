import type { JSX } from 'react'
import { IconOwnerAsleep } from '@renderer/icons'
import { useStore } from '@renderer/store'
import { updateSettings } from '@renderer/components/settings/useSettingsUpdate'

export function OwnerAsleepSwitch(): JSX.Element {
  const asleep = useStore((s) => s.settings.ownerAsleepSince !== null)
  return (
    <button
      className={'tb-ico' + (asleep ? ' on' : '')}
      onClick={() => updateSettings({ ownerAsleepSince: asleep ? null : Date.now() })}
      title={
        asleep
          ? "Asleep — sessions keep going on their own. Click when you're back"
          : 'Going to sleep — sessions keep going without you'
      }
      aria-label="Owner asleep"
      aria-pressed={asleep}
    >
      <IconOwnerAsleep size={20} />
    </button>
  )
}
