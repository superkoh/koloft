import type { JSX } from 'react'
import { AssistSection } from './AssistSection'

export function AssistPane(): JSX.Element {
  return (
    <>
      <div className="set-ph">
        <h3>Assist</h3>
        <p>
          Koloft’s own AI. It does small jobs for you, and it runs your butler, whom you talk to
          from the top of the sidebar or from Discord.
        </p>
      </div>
      <AssistSection />
    </>
  )
}
