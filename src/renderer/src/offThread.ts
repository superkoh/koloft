import type { RenderedDoc } from './markdown/render'

type Job =
  | { job: 'markdown'; text: string; srcPath: string; token: string }
  | { job: 'lines'; code: string; lang: string }

export type OffThreadAsk = Job & { id: number }

export type OffThreadReply =
  | { id: number; ok: true; value: RenderedDoc | string[] }
  | { id: number; ok: false; message: string }

type Waiting = { resolve: (v: RenderedDoc | string[]) => void; reject: (e: Error) => void }

let worker: Worker | null = null
let nextId = 0
const waiting = new Map<number, Waiting>()

function failAll(message: string): void {
  for (const w of waiting.values()) w.reject(new Error(message))
  waiting.clear()
  worker = null
}

function theWorker(): Worker {
  if (worker) return worker
  const w = new Worker(new URL('./offThread.worker.ts', import.meta.url), { type: 'module' })
  w.onmessage = (e: MessageEvent<OffThreadReply>): void => {
    const r = e.data
    const at = waiting.get(r.id)
    if (!at) return
    waiting.delete(r.id)
    if (r.ok) at.resolve(r.value)
    else at.reject(new Error(r.message))
  }
  w.onerror = (e): void => {
    w.terminate()
    failAll(e.message || 'render worker failed')
  }
  return (worker = w)
}

function ask(job: Job): Promise<RenderedDoc | string[]> {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    theWorker().postMessage({ ...job, id })
  })
}

export function renderMarkdownOffThread(
  text: string,
  srcPath: string,
  token: string
): Promise<RenderedDoc> {
  return ask({ job: 'markdown', text, srcPath, token }) as Promise<RenderedDoc>
}

export function highlightLinesOffThread(code: string, lang: string): Promise<string[]> {
  return ask({ job: 'lines', code, lang }) as Promise<string[]>
}
