import { createContext, useContext, useEffect } from 'react'

type EscConsumer = () => boolean
type Register = (fn: EscConsumer) => () => void

export const EscScope = createContext<Register>(() => () => {})

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
