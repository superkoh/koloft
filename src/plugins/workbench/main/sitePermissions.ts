import crypto from 'crypto'
import { session, type IpcMainEvent, type WebContents } from 'electron'
import { BROWSER_PARTITION } from '@shared/types'
import { canOpenExternally } from '@shared/browserRoute'
import {
  permissionAsk,
  permissionKeysFor,
  permissionQueryAsk,
  type PermissionDetails,
  type PermissionName
} from './browserPermission'
import { CHANNELS } from '../shared/ipc'

export interface SitePermissionsDeps {
  push(channel: string, ...args: unknown[]): boolean
  isOverlay(page: WebContents): boolean
  takeGesture(page: WebContents): boolean
  openExternally(url: string): void
  allowFullscreen(callback: (granted: boolean) => void): void
}

// PLATFORM§5
interface PendingPermission {
  guestId: number
  origin: string
  permission: PermissionName
  answer: (granted: boolean) => void
}

export class SitePermissions {
  // ADR-0009
  private answers = new Map<string, boolean>()
  private pending = new Map<string, PendingPermission>()
  private givenMicOrCamera = new Set<number>()

  constructor(private d: SitePermissionsDeps) {}

  private remembered(origin: string, permission: PermissionName): boolean | undefined {
    return this.answers.get(permissionKeysFor(origin, permission)[0])
  }

  private askUser(
    guestId: number,
    origin: string,
    permission: PermissionName,
    callback: (granted: boolean) => void
  ): void {
    for (const pending of this.pending.values()) {
      if (pending.guestId !== guestId || pending.permission !== permission) continue
      const first = pending.answer
      pending.answer = (granted) => {
        first(granted)
        callback(granted)
      }
      return
    }
    const id = crypto.randomUUID()
    this.pending.set(id, { guestId, origin, permission, answer: callback })
    this.d.push(CHANNELS.permissionAsk, { id, origin, permission })
  }

  answer(id: unknown, granted: unknown): void {
    if (typeof id !== 'string') return
    const pending = this.pending.get(id)
    if (!pending) return
    this.pending.delete(id)
    for (const key of permissionKeysFor(pending.origin, pending.permission)) {
      this.answers.set(key, granted === true)
    }
    pending.answer(granted === true)
  }

  cancel(id: unknown): void {
    if (typeof id !== 'string') return
    const pending = this.pending.get(id)
    if (pending) this.drop((p) => p === pending)
  }

  private drop(match: (p: PendingPermission) => boolean): void {
    for (const [id, pending] of [...this.pending]) {
      if (!match(pending)) continue
      this.pending.delete(id)
      pending.answer(false)
      this.d.push(CHANNELS.permissionDrop, id)
    }
  }

  pageOpened(contents: WebContents): void {
    // PLATFORM§5
    const guestId = contents.id
    contents.once('destroyed', () => {
      this.drop((pending) => pending.guestId === guestId)
    })
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return
      this.drop((pending) => pending.guestId === guestId)
    })
  }

  // PLATFORM§11
  undecided(e: IpcMainEvent, name: unknown): void {
    const decision = permissionQueryAsk(name, {
      requestingUrl: e.senderFrame?.url,
      isMainFrame: e.senderFrame?.parent === null
    })
    e.returnValue =
      e.sender.session === session.fromPartition(BROWSER_PARTITION) &&
      !this.d.isOverlay(e.sender) &&
      decision.kind === 'ask' &&
      this.remembered(decision.origin, decision.permission) === undefined
  }

  // PLATFORM§11
  request(
    page: WebContents,
    permission: string,
    callback: (granted: boolean) => void,
    details: unknown
  ): void {
    const decision = permissionAsk(permission, (details ?? {}) as PermissionDetails)
    if (this.d.isOverlay(page) && decision.kind === 'ask') {
      callback(false)
      return
    }
    if (decision.kind === 'allow') {
      if (permission === 'fullscreen') this.d.allowFullscreen(callback)
      else callback(true)
      return
    }
    if (decision.kind === 'refuse') {
      callback(false)
      if (decision.tell) {
        this.d.push(CHANNELS.permissionRefused, {
          origin: decision.origin,
          permission: decision.permission
        })
      }
      return
    }
    if (decision.kind === 'ask') {
      const answer = (granted: boolean): void => {
        if (granted && permission === 'media' && !this.givenMicOrCamera.has(page.id)) {
          const id = page.id
          const forget = (): void => void this.givenMicOrCamera.delete(id)
          this.givenMicOrCamera.add(id)
          page.once('destroyed', forget)
          page.once('did-navigate', forget)
        }
        callback(granted)
      }
      const remembered = this.remembered(decision.origin, decision.permission)
      if (remembered !== undefined) {
        answer(remembered)
        return
      }
      this.askUser(page.id, decision.origin, decision.permission, answer)
      return
    }
    // PLATFORM§11
    callback(false)
    // PLATFORM§11
    if (permission !== 'openExternal') return
    const target = (details as { externalURL?: string }).externalURL ?? ''
    if (canOpenExternally(target) && this.d.takeGesture(page)) this.d.openExternally(target)
    else if (target) this.d.push(CHANNELS.blockedScheme, target)
  }

  // PLATFORM§11
  check(permission: string, details: unknown): boolean {
    const decision = permissionAsk(permission, (details ?? {}) as PermissionDetails)
    if (decision.kind === 'allow') return true
    if (decision.kind !== 'ask') return false
    return this.remembered(decision.origin, decision.permission) ?? false
  }

  pagesHeld(): number[] {
    return [...this.givenMicOrCamera, ...[...this.pending.values()].map((p) => p.guestId)]
  }
}
