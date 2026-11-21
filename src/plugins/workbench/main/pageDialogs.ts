import crypto from 'crypto'
import { app, session, type IpcMainEvent, type WebContents } from 'electron'
import {
  BROWSER_PARTITION,
  type BrowserAuthChallenge,
  type BrowserDialogAnswer,
  type BrowserJsDialog
} from '@shared/types'
import { authPromptFor, certHostOf, certTrusted, jsDialogFor } from './pageRules'
import { CHANNELS } from '../shared/ipc'

export interface PageDialogsDeps {
  push(channel: string, ...args: unknown[]): boolean
  isOverlay(page: WebContents): boolean
}

export class PageDialogs {
  // ADR-0009
  private trustedCertHosts = new Set<string>()
  private pendingAuth = new Map<string, (username?: string, password?: string) => void>()
  private pendingJsDialogs = new Map<string, (answer: BrowserDialogAnswer) => void>()
  private pageOfTheModalUp = 0

  constructor(private d: PageDialogsDeps) {}

  private modalSlotTaken(): boolean {
    return this.pendingAuth.size > 0 || this.pendingJsDialogs.size > 0
  }

  modalPage(): number | null {
    return this.modalSlotTaken() ? this.pageOfTheModalUp : null
  }

  // PLATFORM§12
  watchSignIns(): void {
    app.on('login', (event, contents, details, authInfo, callback) => {
      if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
      const prompt = authPromptFor(details, authInfo, this.modalSlotTaken())
      if (!prompt) return
      event.preventDefault()
      const id = crypto.randomUUID()
      this.pageOfTheModalUp = contents.id
      this.pendingAuth.set(id, callback)
      const payload: BrowserAuthChallenge = { id, kind: 'auth', ...prompt }
      this.d.push(CHANNELS.authChallenge, payload)
    })
  }

  // PLATFORM§12
  watchCertificates(): void {
    app.on('certificate-error', (event, contents, url, _error, _cert, callback) => {
      if (contents.session !== session.fromPartition(BROWSER_PARTITION)) return
      event.preventDefault()
      callback(certTrusted(this.trustedCertHosts, certHostOf(url)))
    })
  }

  certProceed(url: unknown): void {
    const host = certHostOf(typeof url === 'string' ? url : '')
    if (!host) return
    this.trustedCertHosts.add(host)
  }

  // PLATFORM§12
  async clearSiteData(): Promise<void> {
    const ses = session.fromPartition(BROWSER_PARTITION)
    this.trustedCertHosts.clear()
    await ses.clearData()
    await ses.clearAuthCache()
    await ses.closeAllConnections()
  }

  authAnswer(id: string, answer: BrowserDialogAnswer): void {
    const respond = this.pendingAuth.get(id)
    if (!respond) return
    this.pendingAuth.delete(id)
    if (answer?.ok && typeof answer.username === 'string') {
      respond(answer.username, answer.password ?? '')
    } else respond()
  }

  jsDialog(
    e: IpcMainEvent,
    request: { kind?: unknown; message?: unknown; defaultValue?: unknown }
  ): void {
    const cancel = { ok: false } satisfies BrowserDialogAnswer
    if (e.sender.session !== session.fromPartition(BROWSER_PARTITION)) {
      e.returnValue = cancel
      return
    }
    const dialog = jsDialogFor(request ?? {}, e.senderFrame?.url ?? '', this.modalSlotTaken())
    if (!dialog) {
      e.returnValue = cancel
      return
    }
    const id = crypto.randomUUID()
    const gone = (): void => {
      this.pendingJsDialogs.delete(id)
    }
    this.pageOfTheModalUp = e.sender.id
    this.pendingJsDialogs.set(id, (answer) => {
      e.sender.removeListener('destroyed', gone)
      e.returnValue = answer
    })
    e.sender.once('destroyed', gone)
    const payload: BrowserJsDialog = {
      id,
      ...dialog,
      guestId: e.sender.id,
      overlay: this.d.isOverlay(e.sender)
    }
    this.d.push(CHANNELS.jsDialog, payload)
  }

  jsDialogAnswer(id: string, answer: BrowserDialogAnswer): void {
    const respond = this.pendingJsDialogs.get(id)
    if (!respond) return
    this.pendingJsDialogs.delete(id)
    respond(
      answer?.ok
        ? { ok: true, value: typeof answer.value === 'string' ? answer.value : '' }
        : { ok: false }
    )
  }
}
