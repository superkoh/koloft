import { useCallback, useState, type JSX } from 'react'
import { bytesLeft, instructionsBytes, textInUse } from '@core/ownerInstructions'
import { EVERY_WORKSPACE_TEXT_MAX_BYTES } from '@plugins/sessions/shared/workspaceInstructions'
import { useStore } from '../../store'
import { plural } from '../../sessionRows'
import { OwnerInstructionsEditor } from '../OwnerInstructionsEditor'
import { SessionMethodsSection } from './SessionMethodsSection'
import { useEscConsumer } from './escScope'

const EVERY_WORKSPACE = 'Instructions for every workspace'

const linesAndLeft = (text: string): string =>
  `${plural(text.split('\n').length, 'line')} · ${bytesLeft(EVERY_WORKSPACE_TEXT_MAX_BYTES - instructionsBytes(text))}`

function EveryWorkspaceInstructions(): JSX.Element {
  const text = useStore((s) => textInUse(s.settings.everyWorkspaceInstructions))
  const butler = useStore((s) => s.settings.butler.name)
  const [editing, setEditing] = useState(false)
  const close = useCallback(() => setEditing(false), [])
  useEscConsumer(editing, close)
  return (
    <>
      <div className="set-grp">Instructions</div>
      <div className="set-row">
        <div className="set-lab">
          <b>{EVERY_WORKSPACE}</b>
          <small>
            {`Written by you. Every session in every workspace follows them, before that workspace's own instructions. A workspace can leave them out in its Session defaults. ${butler} does not get them.`}
          </small>
          <small>{text ? linesAndLeft(text) : 'Empty'}</small>
        </div>
        <button className="mini" onClick={() => setEditing(true)}>
          Edit
        </button>
      </div>
      {editing && (
        <OwnerInstructionsEditor
          title={`${EVERY_WORKSPACE} · written by you`}
          placeholder="What should every session always know or do? One rule a line."
          status={`Every session started from now on follows this, in every workspace that does not leave it out. A resumed conversation keeps the text it started with. ${butler} does not get it.`}
          inUse={text}
          maxBytes={EVERY_WORKSPACE_TEXT_MAX_BYTES}
          save={(typed, opened) => window.api.sessionDefaults.saveEveryWorkspace(typed, opened)}
          savedToast="Instructions saved. Sessions started from now on follow them."
          onClose={close}
        />
      )}
    </>
  )
}

export function SessionsPane(): JSX.Element {
  return (
    <>
      <div className="set-ph">
        <h3>Sessions</h3>
        <p>
          Pick the tool a new session runs, see what Koloft found on this Mac, and write what every
          session should follow.
        </p>
      </div>

      <SessionMethodsSection />
      <EveryWorkspaceInstructions />
    </>
  )
}
