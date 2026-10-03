import { useEffect, useState } from 'react'
import type { DiscordSettings, DiscordStatus } from '@shared/types'

export const SETUP_STEPS = 7

const NEXT_STEP_LABEL = [
  'create the app',
  'let the bot read messages',
  'copy the bot token',
  'make a private server',
  'add the bot to your server',
  'tell Koloft who you are',
  'bind a channel'
]

export function useDiscordStatus(): DiscordStatus {
  const [status, setStatus] = useState<DiscordStatus>({ phase: 'off', guildNames: [] })
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
      return 'Message Content is off — see step 2 of the setup guide'
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

export function nextSetupStep(s: DiscordStatus, discord: DiscordSettings): number | null {
  if (s.phase === 'off') return 1
  if (s.phase === 'intents') return 2
  if (s.phase === 'token') return 3
  if (s.phase === 'connected' && s.guildNames.length === 0) return 4
  if (!discord.userId) return 6
  if (discord.bindings.length === 0) return 7
  return null
}

export function nextStepLine(step: number): string {
  return `Step ${step} of ${SETUP_STEPS} next: ${NEXT_STEP_LABEL[step - 1]}`
}
