import type { JSX } from 'react'
import { SessionMethodsSection } from './SessionMethodsSection'

export function SessionsPane(): JSX.Element {
  return (
    <>
      <div className="set-ph">
        <h3>Sessions</h3>
        <p>Pick the tool a new session runs, and see what Koloft found on this Mac.</p>
      </div>

      <SessionMethodsSection />
    </>
  )
}
