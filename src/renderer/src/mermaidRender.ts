import DOMPurify from 'dompurify'

type MermaidApi = (typeof import('mermaid'))['default']

// PLATFORM§26
export const MERMAID_MAX_TEXT_SIZE = 50000

const CACHE_LIMIT = 50

export function hashCode(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return `${(h >>> 0).toString(36)}-${s.length.toString(36)}`
}

export interface DiagramCache {
  get(key: string): string | undefined
  set(key: string, value: string): void
  readonly size: number
}

export function makeCache(limit: number = CACHE_LIMIT): DiagramCache {
  const entries = new Map<string, string>()
  return {
    get(key) {
      const svg = entries.get(key)
      if (svg === undefined) return undefined
      entries.delete(key)
      entries.set(key, svg)
      return svg
    },
    set(key, value) {
      entries.delete(key)
      entries.set(key, value)
      if (entries.size > limit) {
        const oldest = entries.keys().next().value
        if (oldest !== undefined) entries.delete(oldest)
      }
    },
    get size() {
      return entries.size
    }
  }
}

const cache = makeCache()

// PLATFORM§26
function appFontFamily(): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--mono').trim()
  return v || 'ui-monospace, monospace'
}

let mermaidPromise: Promise<MermaidApi> | null = null
function getMermaid(): Promise<MermaidApi> {
  return (mermaidPromise ??= import('mermaid')
    .then(({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        maxTextSize: MERMAID_MAX_TEXT_SIZE,
        // PLATFORM§26
        secure: [
          'secure',
          'securityLevel',
          'startOnLoad',
          'maxTextSize',
          'suppressErrorRendering',
          'maxEdges',
          'htmlLabels',
          'themeCSS',
          'fontFamily',
          'altFontFamily'
        ],
        // PLATFORM§26
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        class: { htmlLabels: false },
        fontFamily: appFontFamily()
      })
      return mermaid
    })
    .catch((err: unknown) => {
      mermaidPromise = null
      throw err
    }))
}

// PLATFORM§26
let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

const ID_SLOT = '__koloft_mmd_id__'

function selectorSafeId(id: string): string {
  return `mmd-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`
}

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.trim() || 'The diagram could not be rendered.'
}

export async function renderDiagram(
  code: string,
  id: string
): Promise<{ ok: true; svg: string } | { ok: false; message: string }> {
  const src = code.trim()
  if (!src) return { ok: false, message: 'This mermaid block is empty.' }
  if (src.length > MERMAID_MAX_TEXT_SIZE) {
    return {
      ok: false,
      message: `Diagram source is ${src.length} characters, over the ${MERMAID_MAX_TEXT_SIZE} limit.`
    }
  }

  const key = hashCode(src)
  const cached = cache.get(key)
  if (cached !== undefined) return { ok: true, svg: cached.split(ID_SLOT).join(selectorSafeId(id)) }

  let mermaid: MermaidApi
  try {
    mermaid = await getMermaid()
  } catch {
    return { ok: false, message: 'The diagram renderer failed to load.' }
  }

  // PLATFORM§26
  const host = document.createElement('div')
  host.setAttribute(
    'style',
    'position:fixed;left:-10000px;top:0;width:1200px;visibility:hidden;pointer-events:none'
  )
  document.body.appendChild(host)
  try {
    const { svg } = await serialized(() => mermaid.render(selectorSafeId(id), src, host))
    const clean = DOMPurify.sanitize(svg)
    cache.set(key, clean.split(selectorSafeId(id)).join(ID_SLOT))
    return { ok: true, svg: clean }
  } catch (err) {
    return { ok: false, message: messageOf(err) }
  } finally {
    host.remove()
  }
}
