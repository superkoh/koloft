import type { JSX } from 'react'
import { useAssistSetup } from '../useAssistSetup'
import { AssistSetup } from './AssistSetup'

// ADR-0030
export function AssistDialog({ onNotNow }: { onNotNow(): void }): JSX.Element {
  const setup = useAssistSetup()
  return (
    <div className="modal-backdrop">
      <div className="modal assist-modal" role="dialog" aria-label="Koloft Assist">
        <div className="modal-header">Koloft Assist</div>
        <div className="modal-body">
          <AssistSetup setup={setup} />
        </div>
        <div className="modal-foot">
          <button className="mini" onClick={onNotNow}>
            Not now
          </button>
        </div>
      </div>
    </div>
  )
}
