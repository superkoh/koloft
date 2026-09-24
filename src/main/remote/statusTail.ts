import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { REMOTE_PATH_LINE } from './install'
import { REMOTE_HOOK_DIR } from './paths'

export interface TailProcess {
  onData(cb: (chunk: Buffer) => void): void
  onExit(cb: () => void): void
  kill(): void
}

export interface StatusTailDeps {
  spawn(host: string, remoteCmd: string): TailProcess
  mirrorDir(host: string): string
}

export const TAIL_RECONNECT_MS = 2000

// PLATFORM§37
export function statusTailCmd(tabId: string, fromByte: number): string {
  const body = `${REMOTE_PATH_LINE}; exec tail -c "+$2" -F "${REMOTE_HOOK_DIR}/$1.status.jsonl" 2>/dev/null`
  return [`sh -c ${shq(body)} sh`, shq(tabId), String(fromByte)].join(' ')
}

interface Tail {
  host: string
  proc?: TailProcess
  timer?: ReturnType<typeof setTimeout>
}

export class StatusTails {
  private tails = new Map<string, Tail>()

  constructor(private deps: StatusTailDeps) {}

  follow(live: { tabId: string; host: string }[]): void {
    const wanted = new Map(live.map((t) => [t.tabId, t.host]))
    for (const [tabId, tail] of this.tails) {
      if (wanted.get(tabId) !== tail.host) this.stop(tabId)
    }
    for (const [tabId, host] of wanted) {
      if (this.tails.has(tabId)) continue
      const tail: Tail = { host }
      this.tails.set(tabId, tail)
      this.start(tabId, tail)
    }
  }

  stopAll(): void {
    for (const tabId of [...this.tails.keys()]) this.stop(tabId)
  }

  private stop(tabId: string): void {
    const tail = this.tails.get(tabId)
    if (!tail) return
    this.tails.delete(tabId)
    if (tail.timer) clearTimeout(tail.timer)
    tail.proc?.kill()
  }

  private start(tabId: string, tail: Tail): void {
    const file = path.join(this.deps.mirrorDir(tail.host), `${tabId}.status.jsonl`)
    let have = 0
    try {
      have = fs.statSync(file).size
    } catch {}
    const proc = this.deps.spawn(tail.host, statusTailCmd(tabId, have + 1))
    tail.proc = proc
    proc.onData((chunk) => {
      if (this.tails.get(tabId) !== tail) return
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.appendFileSync(file, chunk)
      } catch {}
    })
    proc.onExit(() => {
      if (this.tails.get(tabId) !== tail || tail.proc !== proc) return
      tail.proc = undefined
      tail.timer = setTimeout(() => {
        tail.timer = undefined
        if (this.tails.get(tabId) === tail) this.start(tabId, tail)
      }, TAIL_RECONNECT_MS)
      tail.timer.unref?.()
    })
  }
}
