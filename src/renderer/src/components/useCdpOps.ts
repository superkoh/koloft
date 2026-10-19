import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction
} from 'react'
import {
  CDP_GUEST_ID_RETRIES,
  CDP_GUEST_ID_RETRY_MS,
  CDP_MOUNT_ATTACH_MS,
  CDP_MOUNT_SETTLE_MS
} from '@shared/cdpBudget'
import type { BrowserCdpOp, BrowserCdpOpResult } from '@shared/types'
import { boundSessionId, useStore } from '../store'
import type { GuestElement } from './BrowserGuest'
import { cdpVisibleTabs, type WorkbenchTab, type WorkbenchTabSet } from './workbenchTabs'
import { guestId, guestLoading } from './WorkbenchWebGuests'

const CAPTURE_AFTER_PAINT_MS = 90

export function useStripReport(
  states: Record<string, WorkbenchTabSet>,
  live: string[],
  attached: number,
  guestIdOf: (tabId: string) => number
): void {
  const bindings = useStore((s) =>
    s.tabs.map((t) => `${t.id}=${boundSessionId(s, t.id) ?? ''}`).join(' ')
  )
  const lastReport = useRef(new Map<string, string>())
  useEffect(() => {
    const st = useStore.getState()
    for (const [owner, s] of Object.entries(states)) {
      const sid = boundSessionId(st, owner)
      if (!sid) continue
      const targets = cdpVisibleTabs(s).map((t) => ({
        targetId: t.id,
        url: t.url ?? '',
        title: t.title,
        guestId: guestIdOf(t.id) || null
      }))
      const json = JSON.stringify(targets)
      if (lastReport.current.get(sid) === json) continue
      lastReport.current.set(sid, json)
      window.api.browser.reportStrip(sid, targets)
    }
  }, [states, live, attached, guestIdOf, bindings])
}

export interface CdpMounts {
  waitGuestId: (tabId: string) => Promise<number>
  onAttached: (tabId: string) => void
  settled: (tabId: string) => void
  mounting: (tabId: string) => boolean
}

export function useCdpOps({
  els,
  webIndexRef,
  pinnedRef,
  stage,
  unstage,
  applyLiveIn,
  makeLive,
  setLive,
  cdpOps,
  tabForSession,
  onCdpCreate,
  onCdpDone,
  closeIn
}: {
  els: RefObject<Map<string, GuestElement>>
  webIndexRef: RefObject<Map<string, { owner: string; tab: WorkbenchTab }>>
  pinnedRef: RefObject<Set<string>>
  stage: (tabId: string) => void
  unstage: (tabId: string) => void
  applyLiveIn: (owner: string | null, id: string, url: string) => void
  makeLive: (id: string) => void
  setLive: Dispatch<SetStateAction<string[]>>
  cdpOps: BrowserCdpOp[]
  tabForSession: (sessionId: string) => string | undefined
  onCdpCreate: (sessionId: string, url: string) => Promise<string | null>
  onCdpDone: (opId: string) => void
  closeIn: (owner: string, id: string) => void
}): CdpMounts {
  const pendingMounts = useRef(new Map<string, () => void>())
  const pendingSettles = useRef(new Map<string, () => void>())
  const doneOps = useRef(new Set<string>())

  // PLATFORM§8
  const waitGuestId = useCallback(
    async (tabId: string): Promise<number> => {
      for (let i = 0; i < CDP_GUEST_ID_RETRIES; i++) {
        const id = guestId(els.current.get(tabId))
        if (id) return id
        await new Promise((r) => setTimeout(r, CDP_GUEST_ID_RETRY_MS))
      }
      throw new Error('the page never reported its id')
    },
    [els]
  )

  const inFlightMounts = useRef(new Map<string, Promise<number>>())

  const settledPromise = useCallback((tabId: string): Promise<void> => {
    return new Promise<void>((resolve) => {
      const done = (): void => {
        pendingSettles.current.delete(tabId)
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(done, CDP_MOUNT_SETTLE_MS)
      pendingSettles.current.set(tabId, done)
    })
  }, [])

  const doMount = useCallback(
    async (opOwner: string, tabId: string, urlHint?: string): Promise<number> => {
      const url = urlHint ?? webIndexRef.current.get(tabId)?.tab.url
      if (url === undefined) throw new Error(`no tab ${tabId}`)
      // PLATFORM§9
      stage(tabId)
      const fresh = !els.current.has(tabId)
      if (fresh) {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingMounts.current.delete(tabId)
            reject(new Error('the page did not open'))
          }, CDP_MOUNT_ATTACH_MS)
          pendingMounts.current.set(tabId, () => {
            clearTimeout(timer)
            resolve()
          })
          applyLiveIn(opOwner, tabId, url || 'about:blank')
        })
      } else {
        makeLive(tabId)
      }
      // PLATFORM§8
      if (fresh || guestLoading(els.current.get(tabId))) await settledPromise(tabId)
      return await waitGuestId(tabId)
    },
    [els, webIndexRef, applyLiveIn, makeLive, settledPromise, waitGuestId, stage]
  )

  const mountTab = useCallback(
    (opOwner: string, tabId: string, urlHint?: string): Promise<number> => {
      const already = inFlightMounts.current.get(tabId)
      if (already) return already
      const p = doMount(opOwner, tabId, urlHint)
        .catch((e: unknown) => {
          if (!pinnedRef.current.has(tabId)) unstage(tabId)
          throw e
        })
        .finally(() => inFlightMounts.current.delete(tabId))
      inFlightMounts.current.set(tabId, p)
      return p
    },
    [doMount, unstage, pinnedRef]
  )

  useEffect(() => {
    if (!cdpOps.length) return
    for (const id of [...doneOps.current]) {
      if (!cdpOps.some((o) => o.opId === id)) doneOps.current.delete(id)
    }
    for (const op of cdpOps) {
      if (doneOps.current.has(op.opId)) continue
      doneOps.current.add(op.opId)
      const finish = (res: Omit<BrowserCdpOpResult, 'opId'>): void => {
        window.api.browser.answerCdpOp({ opId: op.opId, ...res })
        onCdpDone(op.opId)
      }
      const fail = (e: unknown): void =>
        finish({ ok: false, error: e instanceof Error ? e.message : String(e) })

      const opOwner = tabForSession(op.sessionId)
      if (!opOwner) {
        fail(new Error(`no session ${op.sessionId}`))
        continue
      }

      if (op.kind === 'mount' && op.targetId) {
        mountTab(opOwner, op.targetId).then(
          (gid) => finish({ ok: true, targetId: op.targetId, guestId: gid }),
          fail
        )
      } else if (op.kind === 'create') {
        const url = op.url || 'about:blank'
        void onCdpCreate(op.sessionId, url).then((tabId) => {
          if (!tabId) {
            finish({ ok: false, error: 'the tab limit is full of pages an agent is driving' })
            return
          }
          mountTab(opOwner, tabId, url).then(
            (gid) => finish({ ok: true, targetId: tabId, guestId: gid }),
            fail
          )
        }, fail)
      } else if (op.kind === 'close' && op.targetId) {
        const id = op.targetId
        closeIn(opOwner, id)
        setLive((prev) => prev.filter((x) => x !== id))
        finish({ ok: true })
      } else if (op.kind === 'stage' && op.targetId) {
        stage(op.targetId)
        requestAnimationFrame(() => setTimeout(() => finish({ ok: true }), CAPTURE_AFTER_PAINT_MS))
      } else {
        finish({ ok: false, error: `unknown op ${op.kind}` })
      }
    }
  }, [cdpOps, mountTab, onCdpCreate, onCdpDone, closeIn, tabForSession, stage, setLive])

  const onAttached = useCallback((tabId: string): void => {
    const waiting = pendingMounts.current.get(tabId)
    if (waiting) {
      pendingMounts.current.delete(tabId)
      waiting()
    }
  }, [])
  const settled = useCallback((tabId: string): void => pendingSettles.current.get(tabId)?.(), [])
  const mounting = useCallback((tabId: string): boolean => inFlightMounts.current.has(tabId), [])

  return { waitGuestId, onAttached, settled, mounting }
}
