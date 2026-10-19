import type { ConductorBinding } from '@shared/types'
import type { SessionEvents, SyncEvent } from '../sessionEvents'
import type { LiveStatus } from './liveStatus'
import type { Notices } from './notices'
import type { SessionThreads } from './threads'

export interface FollowingParts {
  notices: Pick<Notices, 'working' | 'settled' | 'waiting' | 'turnEnded' | 'closed' | 'forget'>
  live: Pick<LiveStatus, 'refresh' | 'sessionChanged' | 'closed' | 'forget'>
  threads: Pick<SessionThreads, 'place' | 'bound' | 'retitle' | 'left' | 'forget'>
  bindingOfTab(tabId: string): ConductorBinding | undefined
}

export function follow(p: FollowingParts, e: SyncEvent): void {
  switch (e.kind) {
    case 'session-listed':
      if (e.startedBy && e.title && e.backend) {
        const b = p.bindingOfTab(e.startedBy)
        if (b) {
          const subject = {
            tabId: e.tabId,
            name: e.title,
            workspace: e.workspace,
            backend: e.backend
          }
          void p.threads.place(b, subject, true)
        }
      }
      if (e.key) p.threads.bound(e.tabId, e.key)
      return
    case 'session-reopened':
      return p.threads.bound(e.tabId, e.key)
    case 'session-renamed':
      if (e.title) p.threads.retitle(e.tabId, e.title, e.workspace)
      return p.live.sessionChanged(e.tabId, e.title, e.statusUnknown)
    case 'working':
      p.notices.working(e.tabId)
      return void p.live.refresh(e.tabId)
    case 'idle':
      p.notices.settled(e.tabId, e.turnDone)
      return void p.live.refresh(e.tabId)
    case 'asked':
      p.notices.waiting(e.tabId)
      return void p.live.refresh(e.tabId)
    case 'turn-replied':
      return p.notices.turnEnded(e.tabId, e.reply)
    case 'session-closed':
      if (e.why !== 'asleep') {
        p.notices.closed(e.tabId)
        p.live.closed(e.tabId)
      }
      if (!e.gone) return
      p.notices.forget(e.tabId)
      p.live.forget(e.tabId)
      return p.threads.forget(e.tabId)
    case 'session-removed':
      return p.threads.left(e.key)
  }
}

export function followSessions(events: SessionEvents, parts: () => FollowingParts | null): void {
  events.on('event', (e) => {
    const p = parts()
    if (p) follow(p, e)
  })
}
