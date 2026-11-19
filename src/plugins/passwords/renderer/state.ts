import { useEffect } from 'react'
import { create } from 'zustand'
import type { SecretAskView } from '@shared/types'

export const useSecretAsks = create<{ asks: SecretAskView[] }>(() => ({ asks: [] }))

export function useWatchSecretAsks(): void {
  useEffect(() => {
    const set = (asks: SecretAskView[]): void => useSecretAsks.setState({ asks })
    const off = window.api.secret.onAsks(set)
    void window.api.secret.list().then(set)
    return off
  }, [])
}
