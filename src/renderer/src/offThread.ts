import type { RenderedDoc } from './markdown/render'

type Job =
  | { job: 'markdown'; text: string; srcPath: string; token: string }
  | { job: 'lines'; codes: string[]; lang: string }
  | { job: 'code'; code: string; lang: string }

type Answer = RenderedDoc | string[][] | string

export type OffThreadAsk = Job & { id: number }

export type OffThreadReply =
  { id: number; ok: true; value: Answer } | { id: number; ok: false; message: string }

type Waiting = { resolve: (v: Answer) => void; reject: (e: Error) => void }

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

function ask(job: Job): Promise<Answer> {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject })
    theWorker().postMessage({ ...job, id })
  })
}

export function renderMarkdownOffThread(doc: {
  text: string
  srcPath: string
  token: string
}): Promise<RenderedDoc> {
  return ask({ job: 'markdown', ...doc }) as Promise<RenderedDoc>
}

export function highlightCodeOffThread(code: string, lang: string): Promise<string> {
  return ask({ job: 'code', code, lang }) as Promise<string>
}

interface LinesWanted {
  codes: string[]
  lang: string
  resolve: (v: string[][]) => void
  reject: (e: Error) => void
}

const colorQueues = new Map<object, { busy: boolean; next: LinesWanted | null }>()

function colorNext(owner: object): void {
  const q = colorQueues.get(owner)
  const want = q?.next
  if (!q || !want) {
    colorQueues.delete(owner)
    return
  }
  q.next = null
  q.busy = true
  ;(ask({ job: 'lines', codes: want.codes, lang: want.lang }) as Promise<string[][]>)
    .then(want.resolve, want.reject)
    .finally(() => {
      q.busy = false
      colorNext(owner)
    })
}

export function dropQueuedColoring(owner: object): void {
  const q = colorQueues.get(owner)
  q?.next?.reject(new Error('superseded'))
  if (q) q.next = null
}

export function highlightLinesOffThread(
  owner: object,
  codes: string[],
  lang: string
): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const q = colorQueues.get(owner) ?? { busy: false, next: null }
    colorQueues.set(owner, q)
    q.next?.reject(new Error('superseded'))
    q.next = { codes, lang, resolve, reject }
    if (!q.busy) colorNext(owner)
  })
}
