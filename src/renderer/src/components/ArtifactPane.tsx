import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { LuX } from 'react-icons/lu'
import type { ArtifactView } from '@shared/types'
import { basename, isWebPagePath, previewKindForPath } from '@shared/preview'
import { openWebPage, previewLinkTarget } from '../store'
import { PreviewViewer, type MdHeading } from './PreviewViewer'
import { InlineDiff } from './InlineDiff'
import { baseUnresolved } from './changesModel'
import { parseUnifiedDiff } from '../inlineDiff'
import { highlightCode, langForPath } from '../highlight'

interface Sym {
  name: string
  line: number
  kind: 'class' | 'fn' | 'type' | 'method'
}

const OUTLINE_RULES: { re: RegExp; kind: Sym['kind'] }[] = [
  { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_]+)/, kind: 'class' },
  {
    re: /^\s*(?:export\s+)?(?:pub\s+)?(?:struct|enum|trait|interface|type)\s+([A-Za-z0-9_]+)/,
    kind: 'type'
  },
  { re: /^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z0-9_]+)/, kind: 'fn' },
  {
    re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_]+)\s*=>/,
    kind: 'fn'
  },
  { re: /^\s*def\s+([A-Za-z0-9_]+)/, kind: 'fn' },
  { re: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_]+)/, kind: 'fn' },
  { re: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_]+)/, kind: 'fn' },
  {
    re: /^\s*(?:public|private|protected|static|readonly|async|get|set|\s)*\b([A-Za-z0-9_]+)\s*\([^)]*\)\s*(?::[^={]+)?\{/,
    kind: 'method'
  }
]
const OUTLINE_SKIP = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'function',
  'return',
  'else',
  'do',
  'await',
  'typeof',
  'new',
  'constructor'
])

function extractOutline(text: string): Sym[] {
  const out: Sym[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length && out.length < 400; i++) {
    const line = lines[i]
    if (line.length > 400) continue
    for (const rule of OUTLINE_RULES) {
      const m = rule.re.exec(line)
      if (m && m[1] && !OUTLINE_SKIP.has(m[1])) {
        out.push({ name: m[1], line: i + 1, kind: rule.kind })
        break
      }
    }
  }
  return out
}

const MD_HEADING_SEL = 'h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'
const VIEW_SCROLLER = '.code-body, .md-body, .idiff'
const GIVE_UP_RESTORE_MS = 4000
const HEADING_AT_TOP_SLACK_PX = 8

async function fileExists(p: string): Promise<boolean> {
  try {
    await window.api.preview.readText(p)
    return true
  } catch (err) {
    const msg = String((err as Error)?.message ?? '')
    return msg.includes('KOLOFT_TOO_LARGE') || msg.includes('KOLOFT_BINARY')
  }
}

type TextState = 'loading' | 'ok' | 'binary' | 'tooLarge' | 'missing' | 'error'

export interface ArtifactCaps {
  views: ArtifactView[]
  current: ArtifactView | null
  hasDiff: boolean
  hasOutline: boolean
  canFind: boolean
}

export const NO_CAPS: ArtifactCaps = {
  views: [],
  current: null,
  hasDiff: false,
  hasOutline: false,
  canFind: false
}

export function sameCaps(a: ArtifactCaps, b: ArtifactCaps): boolean {
  return (
    a.current === b.current &&
    a.hasDiff === b.hasDiff &&
    a.hasOutline === b.hasOutline &&
    a.canFind === b.canFind &&
    a.views.length === b.views.length &&
    a.views.every((v, i) => v === b.views[i])
  )
}

function CodeSource({
  path,
  text,
  line
}: {
  path: string
  text: string
  line?: number
}): JSX.Element {
  const [html, setHtml] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    highlightCode(text, langForPath(path))
      .then((h) => {
        if (!cancelled) setHtml(h)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [text, path])

  // PLATFORM§25
  const codeHtml = useMemo(() => ({ __html: html }), [html])

  const jumpedLine = useRef<number | null>(null)
  useEffect(() => {
    if (!line || jumpedLine.current === line || !html) return
    jumpedLine.current = line
    bodyRef.current?.querySelectorAll<HTMLElement>('.line')[line - 1]?.scrollIntoView({
      block: 'center'
    })
  }, [line, html])

  return (
    <div className="code-wrap">
      <div className="code-body" ref={bodyRef} dangerouslySetInnerHTML={codeHtml} />
    </div>
  )
}

export interface ArtifactPaneProps {
  tabId: string
  path: string
  view?: ArtifactView
  wsRoot: string | null
  line?: number
  changed?: boolean
  base?: string | null
  initialScrollTop?: number
  reloadNonce: number
  outlineOpen: boolean
  onCaps: (tabId: string, caps: ArtifactCaps) => void
  onNavigate: (tabId: string, path: string, line?: number) => void
  onBody: (tabId: string, el: HTMLElement | null) => void
  onZoomImage: (src: string) => void
  zoom: string | null
  onCloseZoom: () => void
  onOutlineClose: (tabId: string) => void
  onClose: (tabId: string) => void
  onUnmount?: (tabId: string, scrollTop: number) => void
  editText?: string
  editUnsaved?: boolean
}

export function ArtifactPane({
  tabId,
  path,
  view,
  wsRoot,
  line,
  base,
  changed,
  initialScrollTop,
  reloadNonce,
  outlineOpen,
  onCaps,
  onNavigate,
  onBody,
  onZoomImage,
  zoom,
  onCloseZoom,
  onOutlineClose,
  onClose,
  onUnmount,
  editText,
  editUnsaved
}: ArtifactPaneProps): JSX.Element {
  const kind = previewKindForPath(path)
  const isBinaryKind = kind === 'image' || kind === 'pdf'

  const bodyRef = useRef<HTMLDivElement>(null)
  const [text, setText] = useState('')
  const [state, setState] = useState<TextState>(isBinaryKind ? 'ok' : 'loading')
  const [diff, setDiff] = useState<{ src: string; text: string } | null>(null)
  const changedRef = useRef(changed)
  changedRef.current = changed
  const [reloadTick, setReloadTick] = useState(0)
  const [pdfReloadToken, setPdfReloadToken] = useState(0)
  const [diffTick, setDiffTick] = useState(0)
  const [stale, setStale] = useState(false)
  const [mdHeadings, setMdHeadings] = useState<MdHeading[]>([])
  const [curHeading, setCurHeading] = useState(0)

  const diffText = diff && diff.src === path ? diff.text : null
  const parsed = useMemo(() => (diffText ? parseUnifiedDiff(diffText) : null), [diffText])
  const hasChange = !!parsed?.hasChange

  const views = useMemo<ArtifactView[]>(() => {
    if (isBinaryKind) return []
    return kind === 'markdown' ? ['render', 'diff', 'source'] : ['diff', 'source']
  }, [isBinaryKind, kind])

  const live: ArtifactView | null = isBinaryKind
    ? null
    : kind === 'markdown'
      ? 'render'
      : hasChange
        ? 'diff'
        : 'source'
  const diffResolved = diff !== null && diff.src === path
  const defaultLatchedForPath = useRef<{ path: string; view: ArtifactView | null } | null>(null)
  if (defaultLatchedForPath.current?.path !== path) defaultLatchedForPath.current = null
  if (defaultLatchedForPath.current === null && diffResolved)
    defaultLatchedForPath.current = { path, view: live }
  const defaultView = defaultLatchedForPath.current?.view ?? live
  const wanted = view && views.includes(view) ? view : defaultView
  const current =
    wanted === 'diff' && !hasChange ? (kind === 'markdown' ? 'render' : 'source') : wanted

  const shownText = editText ?? text
  const symbols = useMemo(
    () => (current === 'source' && state === 'ok' ? extractOutline(shownText) : []),
    [current, state, shownText]
  )
  const hasOutline =
    current === 'source' ? symbols.length > 0 : current === 'render' && mdHeadings.length > 0

  const viewKey = views.join(',')
  useEffect(() => {
    onCaps(tabId, {
      views: viewKey ? (viewKey.split(',') as ArtifactView[]) : [],
      current,
      hasDiff: hasChange,
      hasOutline,
      canFind: !isBinaryKind
    })
  }, [tabId, viewKey, current, hasChange, hasOutline, isBinaryKind, onCaps])

  useEffect(() => {
    const el = bodyRef.current
    onBody(tabId, el)
    return () => onBody(tabId, null)
  }, [tabId, onBody])

  useEffect(() => {
    setStale(false)
    setMdHeadings([])
    setCurHeading(0)
  }, [path])

  const readPath = useRef<string | null>(null)
  useEffect(() => {
    const firstReadOfPath = readPath.current !== path
    readPath.current = path
    if (editText !== undefined) {
      setState('ok')
      return
    }
    if (isBinaryKind) {
      setState('ok')
      return
    }
    let cancelled = false
    if (firstReadOfPath) setState('loading')
    window.api.preview
      .readText(path)
      .then((t) => {
        if (cancelled) return
        setText(t)
        setState('ok')
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = String((err as Error)?.message ?? '')
        if (msg.includes('KOLOFT_READ_FAILED') || msg.includes('KOLOFT_NOT_FILE'))
          setState('missing')
        else if (msg.includes('KOLOFT_TOO_LARGE')) setState('tooLarge')
        else if (msg.includes('KOLOFT_BINARY')) setState('binary')
        else if (firstReadOfPath) setState('error')
      })
    return () => {
      cancelled = true
    }
  }, [path, isBinaryKind, reloadTick, editText])

  useEffect(() => {
    if (isBinaryKind || baseUnresolved(base)) return
    let cancelled = false
    // PLATFORM§30
    const keepLastDiffThroughMidRewrite = (prev: { src: string; text: string } | null): boolean =>
      !!changedRef.current && prev?.src === path && parseUnifiedDiff(prev.text).hasChange
    window.api.fs
      .gitFileDiffFull(path, base ?? undefined)
      .then((d) => {
        if (cancelled) return
        const parsesToNoChange = !parseUnifiedDiff(d.text).hasChange
        setDiff((prev) =>
          parsesToNoChange && keepLastDiffThroughMidRewrite(prev)
            ? prev
            : { src: path, text: d.text }
        )
      })
      .catch(() => {
        if (cancelled) return
        setDiff((prev) => (keepLastDiffThroughMidRewrite(prev) ? prev : { src: path, text: '' }))
      })
    return () => {
      cancelled = true
    }
  }, [path, isBinaryKind, diffTick, base])

  useEffect(() => {
    window.api.fs.watchFile(path)
    const off = window.api.fs.onFileChange((p) => {
      if (p !== path) return
      if (kind === 'pdf') {
        setStale(true)
        return
      }
      setReloadTick((t) => t + 1)
      if (kind !== 'image') setDiffTick((t) => t + 1)
    })
    return () => {
      off()
      window.api.fs.unwatchFile(path)
    }
  }, [path, kind])

  const nonceRef = useRef(reloadNonce)
  const refresh = useCallback(() => {
    setStale(false)
    if (kind === 'pdf') setPdfReloadToken((t) => t + 1)
    else setReloadTick((t) => t + 1)
    if (!isBinaryKind) setDiffTick((t) => t + 1)
  }, [kind, isBinaryKind])
  useEffect(() => {
    if (reloadNonce === nonceRef.current) return
    nonceRef.current = reloadNonce
    refresh()
  }, [reloadNonce, refresh])

  const lastScroll = useRef(initialScrollTop ?? 0)
  // PLATFORM§24
  const pendingRestoreOffset = useRef<number | null>(null)
  useEffect(() => {
    const host = bodyRef.current
    if (!host) return
    const onScroll = (e: Event): void => {
      if (pendingRestoreOffset.current !== null) return
      const el = e.target as HTMLElement | null
      if (el && el !== host && host.contains(el)) lastScroll.current = el.scrollTop
    }
    host.addEventListener('scroll', onScroll, true)
    return () => host.removeEventListener('scroll', onScroll, true)
  }, [])
  // ADR-0016
  useEffect(() => () => onUnmount?.(tabId, lastScroll.current), [tabId, onUnmount])

  const swapRef = useRef<{ path: string; view: ArtifactView | null } | null>(null)
  useLayoutEffect(() => {
    const prev = swapRef.current
    swapRef.current = { path, view: current }
    if (prev && prev.path !== path) {
      lastScroll.current = 0
      return
    }
    if (prev && prev.view === current) return
    const host = bodyRef.current
    const want = lastScroll.current
    if (!host || !want) return
    pendingRestoreOffset.current = want
    const finish = (): void => {
      pendingRestoreOffset.current = null
      mo.disconnect()
    }
    const apply = (): void => {
      const child = host.querySelector<HTMLElement>(VIEW_SCROLLER)
      if (!child) return
      child.scrollTop = want
      if (child.scrollTop === want) finish()
    }
    const mo = new MutationObserver(apply)
    mo.observe(host, { childList: true, subtree: true })
    apply()
    const stop = setTimeout(finish, GIVE_UP_RESTORE_MS)
    return () => {
      clearTimeout(stop)
      finish()
    }
  }, [path, current])

  useEffect(() => {
    if (!outlineOpen || current !== 'render' || !mdHeadings.length) return
    const host = bodyRef.current
    if (!host) return
    let raf = 0
    const recompute = (): void => {
      raf = 0
      const scroller = host.querySelector<HTMLElement>('.md-body')
      if (!scroller) return
      const top = scroller.getBoundingClientRect().top
      const els = scroller.querySelectorAll<HTMLElement>(MD_HEADING_SEL)
      let cur = 0
      for (let i = 0; i < els.length; i++) {
        if (els[i].getBoundingClientRect().top - top <= HEADING_AT_TOP_SLACK_PX) cur = i
      }
      setCurHeading(cur)
    }
    const onScroll = (): void => {
      if (!raf) raf = requestAnimationFrame(recompute)
    }
    recompute()
    host.addEventListener('scroll', onScroll, true)
    return () => {
      host.removeEventListener('scroll', onScroll, true)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [outlineOpen, current, mdHeadings])

  const jumpToHeading = (h: MdHeading, i: number): void => {
    const scroller = bodyRef.current?.querySelector<HTMLElement>('.md-body')
    if (!scroller) return
    const byId = h.id ? scroller.querySelector<HTMLElement>(`#${CSS.escape(h.id)}`) : null
    ;(byId ?? scroller.querySelectorAll<HTMLElement>(MD_HEADING_SEL)[i])?.scrollIntoView()
    onOutlineClose(tabId)
  }

  const jumpToLine = (n: number): void => {
    bodyRef.current?.querySelectorAll<HTMLElement>('.code-body .line')[n - 1]?.scrollIntoView({
      block: 'center'
    })
    onOutlineClose(tabId)
  }

  const insideWorkspaceFence = useCallback(
    (candidate: string): string | null => {
      const fence = wsRoot ?? path.slice(0, path.lastIndexOf('/'))
      return candidate === fence || candidate.startsWith(`${fence}/`) ? candidate : null
    },
    [wsRoot, path]
  )

  const openFileRef = (a: HTMLElement): void => {
    const rel = a.getAttribute('data-path')
    if (!rel) return
    const n = Number(a.getAttribute('data-line'))
    const at = Number.isInteger(n) && n > 0 ? n : undefined
    const raw = rel.startsWith('/')
      ? [previewLinkTarget(rel, '/.')]
      : [previewLinkTarget(rel, path), ...(wsRoot ? [previewLinkTarget(rel, `${wsRoot}/.`)] : [])]
    const candidates = raw.map(insideWorkspaceFence).filter((c): c is string => !!c)
    void (async () => {
      for (const c of candidates) {
        if (await fileExists(c)) {
          onNavigate(tabId, c, at)
          return
        }
      }
    })()
  }

  const onBodyClick = (e: ReactMouseEvent): void => {
    const target = e.target as HTMLElement
    const img = target.closest<HTMLImageElement>('.img-wrap img')
    if (img) {
      onZoomImage(img.src)
      return
    }
    const ref = target.closest<HTMLElement>('a.md-fileref')
    if (ref) {
      e.preventDefault()
      openFileRef(ref)
      return
    }
    const a = target.closest('a')
    const href = a?.getAttribute('href')
    if (!a || !href) return
    e.preventDefault()
    if (href.startsWith('#')) {
      const id = decodeURIComponent(href.slice(1))
      bodyRef.current?.querySelector(`#${CSS.escape(id)}`)?.scrollIntoView()
      return
    }
    const resolved = previewLinkTarget(href, path)
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(resolved)) {
      openWebPage(resolved, tabId)
      return
    }
    const inside = insideWorkspaceFence(resolved)
    if (!inside) return
    if (isWebPagePath(inside)) openWebPage(inside, tabId)
    else onNavigate(tabId, inside)
  }

  const body = ((): JSX.Element => {
    if (state === 'missing') {
      return (
        <div className="code-state">
          <div>This file no longer exists.</div>
          <button className="wb-state-btn" onClick={() => onClose(tabId)}>
            Close tab
          </button>
        </div>
      )
    }
    if (state === 'binary') return <div className="code-state">Binary file — not previewable.</div>
    if (state === 'tooLarge') return <div className="code-state">File too large to preview.</div>
    if (state === 'error') return <div className="code-state">Failed to read file.</div>
    if (isBinaryKind) {
      return (
        <PreviewViewer
          key={path}
          item={{ kind: kind!, src: path, label: basename(path) }}
          tick={kind === 'pdf' ? pdfReloadToken : reloadTick}
        />
      )
    }
    if (state === 'loading') return <div className="code-state">Loading…</div>
    if (current === 'diff' && parsed) {
      return <InlineDiff key={path} src={path} parsed={parsed} line={line} />
    }
    if (current === 'render') {
      return (
        <PreviewViewer
          key={path}
          item={{ kind: 'markdown', src: path, label: basename(path) }}
          tick={reloadTick}
          onHeadings={setMdHeadings}
        />
      )
    }
    return (
      <>
        {editUnsaved && (
          <div className="ed-unsaved-note">Unsaved — this is what the editor is holding</div>
        )}
        <CodeSource key={path} path={path} text={shownText} line={line} />
      </>
    )
  })()

  return (
    <div className="wb-artifact">
      {outlineOpen && hasOutline && (
        <div className="outline wb-outline">
          <div className="outline-list">
            {current === 'source'
              ? symbols.map((s, i) => (
                  <div
                    key={i}
                    className="outline-it"
                    onClick={() => jumpToLine(s.line)}
                    title={`Line ${s.line}`}
                  >
                    <span className={'outline-kind k-' + s.kind}>{s.kind[0].toUpperCase()}</span>
                    <span className="outline-name">{s.name}</span>
                    <span className="outline-line">{s.line}</span>
                  </div>
                ))
              : mdHeadings.map((h, i) => (
                  <div
                    key={i}
                    className={'outline-it' + (i === curHeading ? ' cur' : '')}
                    style={{ paddingLeft: 8 + (h.level - 1) * 12 }}
                    onClick={() => jumpToHeading(h, i)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') jumpToHeading(h, i)
                    }}
                    role="button"
                    tabIndex={0}
                    title={h.text}
                  >
                    <span className="outline-name">{h.text}</span>
                  </div>
                ))}
          </div>
        </div>
      )}
      <div className="file-pane-body" ref={bodyRef} onClick={onBodyClick}>
        {body}
      </div>
      {zoom && (
        <div className="wb-zoom" role="dialog" aria-label="Image" onClick={onCloseZoom}>
          <img src={zoom} alt="" />
        </div>
      )}
      {stale && (
        <div className="fp-stale" role="status">
          <span className="fp-stale-msg">
            File changed on disk — reloading resets the page position.
          </span>
          <button className="fp-stale-btn" onClick={refresh}>
            Reload
          </button>
          <button
            className="fp-stale-x"
            onClick={() => setStale(false)}
            title="Dismiss"
            aria-label="Dismiss"
          >
            <LuX size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
