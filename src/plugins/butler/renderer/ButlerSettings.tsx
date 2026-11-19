import { useEffect, useState, type JSX } from 'react'
import { AssistRow, BUTLER_DOES } from '@renderer/components/settings/AssistSection'
import { useSettingsUpdate } from '@renderer/components/settings/useSettingsUpdate'
import { useStore } from '@renderer/store'
import { useAssistSetup } from '@renderer/useAssistSetup'
import { butlerName, butlerTitle, renamedButler } from '../shared/names'

export function ButlerSettings(): JSX.Element {
  const butler = useStore((s) => s.settings.butler)
  const name = butler.name
  const update = useSettingsUpdate()
  const setup = useAssistSetup()
  const [nameDraft, setNameDraft] = useState(name)
  useEffect(() => setNameDraft(name), [name])

  const commitName = (): void => {
    const next = butlerName(nameDraft)
    setNameDraft(next)
    if (next !== name) update({ butler: renamedButler(butler, next) })
  }

  return (
    <>
      <div className="set-grp">Butler</div>
      <AssistRow row="butler" title={name} does={BUTLER_DOES} setup={setup} />
      <div className="set-row stack">
        <div className="set-lab">
          <b>Name</b>
          <small>
            Your butler’s name, shown as “{butlerTitle(name)}” at the top of the sidebar. Other
            sessions reach it by this name.
          </small>
        </div>
        <input
          className="set-input"
          type="text"
          aria-label="Butler name"
          value={nameDraft}
          onChange={(e) => setNameDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitName()
          }}
          spellCheck={false}
        />
      </div>
    </>
  )
}
