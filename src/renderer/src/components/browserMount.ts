const BLANK = 'about:blank'

export interface StopEvidence {
  guestUrl: string
  targetUrl: string
  isLoading: boolean
}

// PLATFORM§8
export function stopEndsMount({ guestUrl, targetUrl, isLoading }: StopEvidence): boolean {
  if (isLoading) return false
  const target = targetUrl || BLANK
  if (target === BLANK) return true
  return guestUrl !== BLANK && guestUrl !== ''
}
