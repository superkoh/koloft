import type { JSX } from 'react'
import { AssistSection } from './AssistSection'

export function AssistPane(): JSX.Element {
  return (
    <>
      <div className="set-ph">
        <h3>Assist</h3>
        <p>
          Koloft’s own AI. It does small jobs for you, and you can talk to it from the sidebar or
          from Discord.
        </p>
      </div>
      <AssistSection />
    </>
  )
}
