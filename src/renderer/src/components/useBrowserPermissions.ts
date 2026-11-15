import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserPermissionAsk, BrowserPermissionRefusal } from '@shared/types'

const PERMISSION_REFUSAL_NOTICE_MS = 4000

export function useBrowserPermissions(): {
  ask: BrowserPermissionAsk | null
  refusal: BrowserPermissionRefusal | null
  answer: (id: string, granted: boolean) => void
  dismissRefusal: () => void
  cancelAll: () => void
} {
  const [ask, setAsk] = useState<BrowserPermissionAsk | null>(null)
  const [refusal, setRefusal] = useState<BrowserPermissionRefusal | null>(null)
  const queue = useRef<BrowserPermissionAsk[]>([])

  useEffect(() => {
    const offAsk = window.api.browser.onPermissionAsk((next) => {
      setAsk((current) => {
        if (current) {
          queue.current.push(next)
          return current
        }
        return next
      })
    })
    const offRefused = window.api.browser.onPermissionRefused((r) => setRefusal(r))
    const offDrop = window.api.browser.onPermissionDrop((id) => {
      queue.current = queue.current.filter((a) => a.id !== id)
      setAsk((current) => (current?.id === id ? (queue.current.shift() ?? null) : current))
    })
    return () => {
      offAsk()
      offRefused()
      offDrop()
    }
  }, [])

  useEffect(() => {
    if (!refusal) return
    const timer = setTimeout(() => setRefusal(null), PERMISSION_REFUSAL_NOTICE_MS)
    return () => clearTimeout(timer)
  }, [refusal])

  const answer = useCallback((id: string, granted: boolean) => {
    window.api.browser.answerPermission(id, granted)
    setAsk(queue.current.shift() ?? null)
  }, [])

  const dismissRefusal = useCallback(() => setRefusal(null), [])

  const cancelAll = useCallback((): void => {
    const releaseWaitingPage = (askId: string): void => window.api.browser.cancelPermission(askId)
    setAsk((current) => {
      if (current) releaseWaitingPage(current.id)
      for (const queued of queue.current) releaseWaitingPage(queued.id)
      queue.current = []
      return null
    })
    setRefusal(null)
  }, [])

  return { ask, refusal, answer, dismissRefusal, cancelAll }
}
