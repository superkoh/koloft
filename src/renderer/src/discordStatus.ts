import { useEffect, useState } from 'react'
import { SET_UP_WITH_ASSIST } from '@shared/conductors'
import type { DiscordStatus } from '@shared/types'

export function useDiscordStatus(): DiscordStatus | null {
  const [status, setStatus] = useState<DiscordStatus | null>(null)
  useEffect(() => {
    let alive = true
    void window.api.discord.status().then((s) => {
      if (alive) setStatus(s)
    })
    const off = window.api.discord.onStatus(setStatus)
    return () => {
      alive = false
      off()
    }
  }, [])
  return status
}

export function statusText(s: DiscordStatus): string {
  switch (s.phase) {
    case 'off':
      return 'Not connected'
    case 'connecting':
      return 'Connecting…'
    case 'connected':
      return `✓ Connected as ${s.botName}`
    case 'token':
      return 'Invalid token'
    case 'intents':
      return 'Message Content is off'
    case 'unreachable':
      return 'Cannot reach Discord — trying again'
    case 'elsewhere':
      return 'Another Koloft is connected'
  }
}

export function statusClass(s: DiscordStatus): string {
  if (s.phase === 'connected') return ' ok'
  return s.phase === 'token' || s.phase === 'intents' ? ' bad' : ''
}

export const MESSAGE_CONTENT_BY_HAND = `Koloft could not turn Message Content on. Click ${SET_UP_WITH_ASSIST} above: Assist does that with you. Koloft checks again every 30 seconds.`
