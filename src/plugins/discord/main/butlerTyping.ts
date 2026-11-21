import type { SessionStatus } from '@shared/types'
import type { DiscordLink } from './link'

export interface ButlerTypingDeps {
  link: Pick<DiscordLink, 'typing'>
  channelOf(tabId: string): string | undefined
  status(tabId: string): SessionStatus | undefined
  alive(tabId: string): boolean
}

// PLATFORM§39
export const TYPING_RENEWED_EVERY_MS = 8000

export class ButlerTyping {
  private typers = new Map<string, { channelId: string; timer: ReturnType<typeof setInterval> }>()

  constructor(private d: ButlerTypingDeps) {}

  refresh(tabId: string): void {
    const working = this.d.alive(tabId) && this.d.status(tabId) === 'working'
    const channelId = working ? this.d.channelOf(tabId) : undefined
    const was = this.typers.get(tabId)
    if (was?.channelId === channelId) return
    if (was) clearInterval(was.timer)
    this.typers.delete(tabId)
    if (!channelId) return
    const type = (): void => void this.d.link.typing(channelId).catch(() => undefined)
    type()
    const renew = (): void => (this.d.channelOf(tabId) === channelId ? type() : this.refresh(tabId))
    this.typers.set(tabId, { channelId, timer: setInterval(renew, TYPING_RENEWED_EVERY_MS) })
  }

  forget(tabId: string): void {
    clearInterval(this.typers.get(tabId)?.timer)
    this.typers.delete(tabId)
  }
}
