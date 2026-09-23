import DOMPurify from 'dompurify'

// Type-only reference: nothing of mermaid reaches the bundle's entry graph, so a document
// with no diagram never pays for it (Edge Cases).
type MermaidApi = (typeof import('mermaid'))['default']

/** mermaid's own `maxTextSize` default. Sources longer than this are refused here rather
 *  than in mermaid, which silently swaps the diagram for a "Maximum text size exceeded"
 *  graph instead of throwing (mermaid.core.mjs render(): `text = MAX_TEXTLENGTH_EXCEEDED_MSG`). */
export const MERMAID_MAX_TEXT_SIZE = 50000

const CACHE_LIMIT = 50

/** Cache key for a diagram source. FNV-1a (32-bit); the length suffix keeps the cheap
 *  near-collisions apart, which matters because a hit here replaces a whole diagram. */
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

/** Bounded LRU of sanitized SVGs. FR-15: a save that touches one paragraph must not
 *  redraw (and flicker) every diagram in the document. */
export function makeCache(limit: number = CACHE_LIMIT): DiagramCache {
  // Map iterates in insertion order, so "delete + re-insert" is the whole LRU:
  // the first key is always the least recently used one.
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

/** Diagrams inherit the app's own font instead of mermaid's built-in "trebuchet ms"
 *  stack. Resolved to a literal stack rather than left as `var(--mono)`: the value also
 *  lands in SVG presentation attributes (`<text font-family="…">`) while mermaid measures
 *  label widths, and `var()` is not reliably honoured there. */
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
        // The md preview renders into the privileged renderer, so the diagram source is
        // treated as untrusted input. These four keys are in mermaid's `secure` list —
        // a `%%{init}%%` directive inside the document cannot raise them again.
        securityLevel: 'strict',
        suppressErrorRendering: true,
        maxTextSize: MERMAID_MAX_TEXT_SIZE,
        // mermaid's stock `secure` list covers securityLevel/startOnLoad/maxTextSize/
        // suppressErrorRendering/maxEdges — but NOT the two keys below, which a document's
        // own `%%{init}%%` could otherwise set: `htmlLabels: true` would move every label
        // into a <foreignObject> that the sanitize step deletes wholesale (the document
        // could blank out its own diagram), and `themeCSS` is document-authored CSS that
        // reaches a <style> inside the SVG with only bracket-balance checking.
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
        // Not a style choice: HTML labels live in <foreignObject>, which DOMPurify forbids
        // outright — every node's text would vanish in the sanitize step below. Off, the
        // output is pure SVG and carries no HTML at all. The root key wins over the
        // per-diagram ones in mermaid 11, but the flowchart renderer still reads
        // `flowchart.htmlLabels` directly in two places, so both are set.
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        class: { htmlLabels: false },
        fontFamily: appFontFamily()
      })
      return mermaid
    })
    .catch((err: unknown) => {
      // a chunk that failed to load once must not condemn every later diagram
      mermaidPromise = null
      throw err
    }))
}

// mermaid applies each document's `%%{init}%%` directive to its process-wide config at the
// start of render(), so two renders in flight at once can bleed one diagram's settings
// into the other. One at a time.
let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

/** stands in for the render id inside a cached svg, so each insertion can take its own */
const ID_SLOT = '__koloft_mmd_id__'

/** mermaid feeds the id straight into a `#id` selector, so keep it selector-safe and
 *  never leading with a digit. */
function domId(id: string): string {
  return `mmd-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`
}

function messageOf(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.trim() || 'The diagram could not be rendered.'
}

/** Render one mermaid source to a sanitized SVG string, or to a message the reader can
 *  act on. Never throws and never touches the document beyond an off-screen scratch node:
 *  a broken diagram must cost only its own block (NFR-05). */
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
  if (cached !== undefined) return { ok: true, svg: cached.split(ID_SLOT).join(domId(id)) }

  let mermaid: MermaidApi
  try {
    mermaid = await getMermaid()
  } catch {
    return { ok: false, message: 'The diagram renderer failed to load.' }
  }

  // mermaid measures label geometry with getBBox, which needs a laid-out node: an
  // off-screen host keeps that real while never painting a half-built diagram into the
  // pane. Without one, mermaid appends its scratch <div> to <body> for the duration.
  const host = document.createElement('div')
  host.setAttribute(
    'style',
    'position:fixed;left:-10000px;top:0;width:1200px;visibility:hidden;pointer-events:none'
  )
  document.body.appendChild(host)
  try {
    const { svg } = await serialized(() => mermaid.render(domId(id), src, host))
    // Defence in depth: the renderer's output is not trusted either (NFR-01). `<use>` and
    // <foreignObject> do not survive this.
    const clean = DOMPurify.sanitize(svg)
    // mermaid stamps the render id all through its output — the root element, a <style>
    // block of `#id …` rules, `url(#id_flowchart-pointEnd)` marker refs. Cached verbatim,
    // the same diagram twice in one document would put duplicate ids in the DOM and the
    // second copy would resolve its markers against the first. Stored with the id blanked
    // out, every insertion gets its own.
    cache.set(key, clean.split(domId(id)).join(ID_SLOT))
    return { ok: true, svg: clean }
  } catch (err) {
    return { ok: false, message: messageOf(err) }
  } finally {
    host.remove()
  }
}
