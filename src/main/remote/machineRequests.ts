import type fs from 'fs'
import { refused, type AgentReply } from '@core/command'
import type { PtyManager } from '../ptyManager'
import type { Machine } from '../host/machine'
import { NOT_ITS_PASS, REQUEST_NAME, replyJson, tabSpokenFor } from '../agentRequests'
import { holdsPass, isStartedBeforeTabPasses } from '../tabPass'
import { oncePerName, watchAndSweepJsonDrops } from '../jsonDrops'
import { hookMirrorWatches } from './hookMirrorWatches'

export interface MachineRequestDeps {
  pty: Pick<PtyManager, 'get'>
  hosts: { machine(name: string): Machine }
  remoteTargets(): { host: string; paths: string[] }[]
  userData(): string
  machineOfTab(tabId: string): string | undefined
  tabOfTmuxSession(host: string, name: string): string | undefined
  agentReply(
    tabId: string | undefined,
    raw: unknown,
    stillWaiting?: () => boolean
  ): Promise<AgentReply>
}

class CallerOnTheMachine {
  private state: 'unseen' | 'runs' | 'stopped' = 'unseen'
  private asked = false
  private checking?: Promise<void>

  constructor(
    private host: Machine,
    private requestId: string,
    private pid: number
  ) {}

  stillWaiting = (): boolean => {
    this.asked = true
    void this.check()
    return this.state !== 'stopped'
  }

  async stoppedWaiting(): Promise<boolean> {
    if (this.asked && this.state !== 'stopped') {
      await this.checking
      await this.check()
    }
    return this.state === 'stopped'
  }

  private check(): Promise<void> {
    this.checking ??= this.host
      .requestCallerWaits(this.requestId, this.pid)
      .catch(() => undefined)
      .then((seen) => {
        this.checking = undefined
        if (seen === 'request-gone' || (seen === 'gone' && this.state === 'runs'))
          this.state = 'stopped'
        else if (seen === 'runs' && this.state === 'unseen') this.state = 'runs'
      })
    return this.checking
  }
}

export class MachineRequests {
  private watchedHookMirrors = hookMirrorWatches(
    () => this.d.userData(),
    () => this.d.remoteTargets(),
    (dir, host) => {
      const drops = this.watchMachineDrops(dir, host)
      return () => drops?.close()
    }
  )

  constructor(private d: MachineRequestDeps) {}

  watchRemoteHookMirrors(): void {
    this.watchedHookMirrors()
  }

  private watchMachineDrops(dir: string, machine: string): fs.FSWatcher | null {
    const agentRequest = oncePerName((name) => {
      const id = REQUEST_NAME.exec(name)?.[1]
      return id ? (raw): void => this.answerMachineRequest(machine, id, raw) : null
    })
    return watchAndSweepJsonDrops(dir, agentRequest, agentRequest)
  }

  // ADR-0052
  private callerOnMachine(machine: string, raw: unknown): { tabId?: string; refusal?: string } {
    const r = (raw ?? {}) as { tabId?: unknown; tmux?: unknown; pass?: unknown }
    if (typeof r.pass === 'string' && r.pass) {
      const asked = typeof r.tabId === 'string' ? r.tabId : ''
      const facts = this.d.pty.get(asked)
      if (!facts) return {}
      if (!holdsPass(asked, r.pass)) return { refusal: NOT_ITS_PASS }
      const tabId = tabSpokenFor(asked, facts)
      return this.liveTabOnMachine(machine, tabId) === tabId ? { tabId } : {}
    }
    const named = this.namedOnMachine(machine, r)
    if (!named) return {}
    return isStartedBeforeTabPasses(named) ? { tabId: named } : { refusal: NOT_ITS_PASS }
  }

  private liveTabOnMachine(machine: string, tabId: string): string | undefined {
    return this.d.machineOfTab(tabId) === machine && this.d.pty.get(tabId) ? tabId : undefined
  }

  private namedOnMachine(
    machine: string,
    r: { tabId?: unknown; tmux?: unknown }
  ): string | undefined {
    const tmux = typeof r.tmux === 'string' ? r.tmux : ''
    const byTmux = tmux && this.d.tabOfTmuxSession(machine, tmux)
    if (byTmux) return byTmux
    const asked = typeof r.tabId === 'string' ? r.tabId : ''
    const facts = this.d.pty.get(asked)
    return this.liveTabOnMachine(machine, facts ? tabSpokenFor(asked, facts) : asked)
  }

  private fromOwnWorkbenchShell(raw: unknown): boolean {
    const { tabId } = (raw ?? {}) as { tabId?: unknown }
    return typeof tabId === 'string' && !!this.d.pty.get(tabId)?.util
  }

  private answerMachineRequest(machine: string, requestId: string, raw: unknown): void {
    const { tabId, refusal } = this.callerOnMachine(machine, raw)
    const host = this.d.hosts.machine(machine)
    const noOneWaits = (raw as { reply?: unknown } | null)?.reply === false
    if (!tabId && !refusal && !this.fromOwnWorkbenchShell(raw)) {
      if (noOneWaits) void host.answerRequest(requestId, null)
      return
    }
    const pid = (raw as { pid?: unknown } | null)?.pid
    const caller =
      noOneWaits || typeof pid !== 'number'
        ? undefined
        : new CallerOnTheMachine(host, requestId, pid)
    const replied = refusal
      ? Promise.resolve(refused(refusal))
      : this.d.agentReply(tabId, raw, caller?.stillWaiting)
    void replied.then(async (reply) => {
      const nobodyReads = noOneWaits || !!(await caller?.stoppedWaiting())
      await host.answerRequest(requestId, nobodyReads ? null : replyJson(reply))
    })
  }
}
