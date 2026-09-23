import { createContext, useContext, useEffect } from 'react'

/** FR-15: Esc collapses an open inline confirm before it closes the dialog. Panes
 *  register a consumer while their confirm strip is open; the shell asks consumers
 *  first and only closes the modal when none of them ate the press. */
type EscConsumer = () => boolean
type Register = (fn: EscConsumer) => () => void

export const EscScope = createContext<Register>(() => () => {})

/** register `collapse` as an Esc consumer while `active` is true */
export function useEscConsumer(active: boolean, collapse: () => void): void {
  const register = useContext(EscScope)
  useEffect(() => {
    if (!active) return
    return register(() => {
      collapse()
      return true
    })
  }, [active, collapse, register])
}
