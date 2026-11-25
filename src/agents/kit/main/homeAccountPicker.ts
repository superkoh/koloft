import { homeRoom, usableAccounts, type HomeRoom } from '@shared/accountUsage'
import type { AccountView, SignInFolderKind } from '@shared/types'
import {
  SCORE_PER_LIVE_SESSION,
  liveSessionsPerAccount,
  soonest,
  type LaunchedSession
} from '../../../main/accountPicker'
import { leximaxFinalists, weekUse } from '../../../main/usageProbe'
import { withSavedHomeUsage, type SavedHomeUsageOf } from '../../../main/savedHomeUsage'

function bindingWeek(room: HomeRoom, nowSec: number): { use: number; resetsAt: number } {
  return room.longWindows.reduce(
    (heaviest, w) => {
      const use = weekUse(w.used, w.resetsAt ?? 0, nowSec)
      return use > heaviest.use ? { use, resetsAt: w.resetsAt ?? 0 } : heaviest
    },
    { use: -1, resetsAt: 0 }
  )
}

export class HomeAccountPicker {
  private turn = 0

  constructor(
    private kind: SignInFolderKind,
    private savedUsageOf: SavedHomeUsageOf = () => undefined
  ) {}

  pick(
    accounts: AccountView[],
    resumedOn?: string,
    launched: LaunchedSession[] = []
  ): AccountView | undefined {
    const usable = withSavedHomeUsage(usableAccounts(accounts, [this.kind]), this.savedUsageOf)
    if (usable.length === 0) return undefined
    const nowSec = Math.floor(Date.now() / 1000)
    const all = usable.map((a) => ({ a, room: homeRoom(a, nowSec) }))
    const subscriptions = all.filter(({ a }) => !a.apiKey)
    const keys = all.filter(({ a }) => a.apiKey)
    const everySubscriptionFull = subscriptions.every(({ room }) => room?.walled)
    const rooms = keys.length > 0 && everySubscriptionFull ? keys : subscriptions
    const same = rooms.find(({ a }) => a.name === resumedOn)
    if (same && (!same.room || same.room.keepsResumedSession)) return same.a
    const live = liveSessionsPerAccount(launched, undefined)
    const open = rooms.flatMap(({ a, room }) => (room && !room.walled ? [{ a, room }] : []))
    const fresh = open.filter(({ room }) => room.fiveHourStoppedUntil === undefined)
    const ranked = (fresh.length > 0 ? fresh : rooms.filter(({ room }) => !room)).map(
      ({ a, room }) => {
        const week = room ? bindingWeek(room, nowSec) : { use: 0, resetsAt: 0 }
        return {
          a,
          score: {
            s1:
              Math.max(0, week.use) +
              (live.get(a.name.toLowerCase()) ?? 0) * SCORE_PER_LIVE_SESSION,
            s2: 0,
            tiebreak: week.resetsAt > nowSec ? week.resetsAt : 0
          }
        }
      }
    )
    if (ranked.length > 0) {
      const finalists = leximaxFinalists(ranked)
      return finalists[finalists.length > 1 ? this.turn++ % finalists.length : 0].a
    }
    if (open.length > 0) return soonest(open, ({ room }) => room.fiveHourStoppedUntil ?? Infinity).a
    return soonest(rooms, ({ room }) => room?.backAt || Infinity).a
  }

  peek(accounts: AccountView[]): AccountView | undefined {
    const turn = this.turn
    const picked = this.pick(accounts)
    this.turn = turn
    return picked
  }
}
