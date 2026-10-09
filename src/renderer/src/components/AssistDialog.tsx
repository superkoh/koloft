import type { JSX } from 'react'
import type { AssistSetupState } from '../useAssistSetup'
import { AssistSetup } from './AssistSetup'

// ADR-0030
export function AssistDialog({
  setup,
  onNotNow
}: {
  setup: AssistSetupState
  onNotNow(): void
}): JSX.Element {
  return (
    <div className="modal-backdrop">
      <div className="modal assist-modal" role="dialog" aria-label="Koloft Assist">
        <div className="modal-header">Koloft Assist</div>
        <div className="modal-body">
          <AssistSetup setup={setup} />
        </div>
        {setup.noTool && (
          <div className="modal-foot">
            <button className="mini" onClick={onNotNow}>
              Not now
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
