import type { JSX } from 'react'
import { SessionMethodsSection } from './SessionMethodsSection'

/** Which tool a new session runs. Its own pane because that is not an account
 *  question — Accounts is about the pool of Claude logins. */
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
