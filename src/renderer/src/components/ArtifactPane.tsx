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
import { parseUnifiedDiff } from '../inlineDiff'
import { highlightCode, langForPath } from '../highlight'

/**
 * FR-30…FR-35 — ONE artifact, rendered. Extracted from the former `FilePane` so the
 * Workbench can mount one per `file` tab (and, once FilesView lands, one more for Browse's
 * reading area) instead of one per terminal tab.
 *
 * What changed in the extraction, and why it is not a logic-preserving move: `view` goes
 * from FilePane's two states (content / diff) to FR-30's three (Rendered / Diff / Source),
 * and the CHROME left the component. The path, the git letter, the ±counts, the
 * `[ Rendered | Diff | Source ]` segment, ↻ and the ≡ toggle all live in the panel's kind
 * bar now (FR-31), so this component reports what it can offer (`ArtifactCaps`) and takes
 * the answers back as props. The outline LIST still renders here — it hangs over the
 * content it scrolls, not over the bar.
 *
 * Everything else carries over in substance: the full-context diff fetch, the watchFile
 * reload-in-place that preserves scroll, the pdf staleness notice, the markdown outline's
 * current-section tracking, and FR-34's `path:line` resolution with its workspace fence.
 *
 * Every callback takes the tab id back: the panel hands ONE stable function per concern to
 * every mounted pane, because a per-tab closure would be a fresh identity each render and
 * the `onCaps` report would then re-fire on every parent render.
 */

interface Sym {
  name: string
  line: number
  kind: 'class' | 'fn' | 'type' | 'method'
}

// Line-based, multi-language symbol patterns for the outline. Best-effort (no parser):
// covers TS/JS, Python, Rust, Go, and C-like method signatures. The method rule is last
// and keyword-guarded so control-flow lines (`if (...) {`) don't masquerade as symbols.
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

/** The heading tags of a rendered markdown body, in document order — the outline's rows
 *  map onto these one for one (FR-32). Only headings that carry an anchor id: those are
 *  exactly the ones the pipeline put in the outline, while a heading hand-written as raw
 *  `<h2>` in the document is an html_block with no id and no outline row, and counting it
 *  here would slide every later row onto the wrong section. */
const MD_HEADING_SEL = 'h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]'

/** Is there a file at this path? There is no stat across the bridge, so the read is the
 *  probe: "too large" / "binary" are failures OF A FILE THAT EXISTS, which is all a
 *  `path:line` reference needs to know (FR-34). */
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

/** What this artifact can offer, reported up so the kind bar renders only real controls
 *  (FR-31) and the Esc / ⌘F ladders know whether there is anything to act on. */
export interface ArtifactCaps {
  /** the views the segment offers, in kind-bar order. Code has no Rendered form at all
   *  (FR-30), so the segment for it really is two-wide; an image/pdf has none. */
  views: ArtifactView[]
  /** which one is on screen: the tab's stored choice, or FR-30's default for the kind */
  current: ArtifactView | null
  /** there is a diff to show. Diff stays IN the segment for an unchanged file and goes
   *  disabled instead of vanishing — a control that appears and disappears as the agent
   *  edits the file underneath is a moving target for the pointer. */
  hasDiff: boolean
  /** the ≡ has something to open in the CURRENT view (symbols / headings, FR-32) */
  hasOutline: boolean
  /** ⌘F can search it — an image has no text and a pdf keeps PDFium's own find (FR-35) */
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

/** Shiki-highlighted source. No read of its own any more: the parent holds the text so ONE
 *  read serves the Source view, the symbol outline and the missing/binary/too-large
 *  placeholder alike — and so the placeholder reads the same in all three views. The
 *  `.code-body` node survives a text change, which is what keeps FR-33's reload in place (a
 *  remount would lose the scroll). */
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
      .catch(() => {
        /* transient highlight failure mid-write — keep the last good render */
      })
    return () => {
      cancelled = true
    }
  }, [text, path])

  // stable {__html} identity — React 19 re-sets innerHTML (rebuilding the DOM, losing
  // scroll, waking the find observer) whenever the wrapper object is fresh; see the
  // matching note in PreviewViewer.
  const codeHtml = useMemo(() => ({ __html: html }), [html])

  // jump to the requested line once the highlighted HTML is in the DOM (a `path:line`
  // click, FR-34, or a content-search hit, FR-45). Guarded per line value: a reload
  // re-renders `html` with the same `line`, and re-jumping then would yank away the scroll
  // position the user moved to.
  const jumpedLine = useRef<number | null>(null)
  useEffect(() => {
    if (!line || jumpedLine.current === line || !html) return
    jumpedLine.current = line
    bodyRef.current?.querySelectorAll<HTMLElement>('.line')[line - 1]?.scrollIntoView({
      block: 'center'
    })
  }, [line, html])

  // Safe by construction: `html` is Shiki's codeToHtml output, which HTML-escapes the
  // source tokens — file content is rendered as escaped text, never raw HTML (a <script>
  // in the file becomes &lt;script&gt). No sanitizer needed, unlike the markdown path
  // which renders raw HTML and uses DOMPurify.
  return (
    <div className="code-wrap">
      <div className="code-body" ref={bodyRef} dangerouslySetInnerHTML={codeHtml} />
    </div>
  )
}

export interface ArtifactPaneProps {
  /** the tab this artifact belongs to — every callback hands it back, and FR-56's backlink
   *  is minted from it when a link in here opens an html page */
  tabId: string
  path: string
  /** the tab's stored view, or undefined for FR-30's default */
  view?: ArtifactView
  /** the session's own workspace: FR-34's fence, and the only root a reference may resolve
   *  against besides the document's own directory */
  wsRoot: string | null
  /** the line to scroll to on open (FR-34 / FR-45) */
  line?: number
  /** Does the workspace's status map list this file as changed? §6's "keep the last good
   *  content through a transient read failure" needs it: an EMPTY diff is ambiguous on its
   *  own — the file may genuinely be unchanged, or it may have been caught mid-write — and
   *  this is the evidence that separates the two. */
  changed?: boolean
  /** NFR-02 — the baseline the panel already resolved. Three states, and the third is the
   *  point: a sha or `'HEAD'`, `null` for "this directory has no baseline" (a repo with no
   *  commits), and `undefined` for "not resolved yet".
   *
   *  Passing it is not an optimisation — without it `gitFileDiffFull` re-derives the base
   *  in main, so every artifact spawns its own `symbolic-ref` + `merge-base` on every
   *  reload and WB-C17's "resolved once per refresh" stops being about the Changes refresh
   *  at all. But waiting for it must not become REFUSING it: an earlier spelling skipped
   *  the fetch whenever `base` was falsy, which left the Diff view permanently disabled in
   *  a repo with no commits. */
  base?: string | null
  /** FR-12 — a tab split off an existing artifact inherits its scroll offset. Applied
   *  exactly once, on the first render that has something to scroll; a later reload must
   *  not yank the reader back to where the split happened. */
  initialScrollTop?: number
  /** the kind bar's ↻ (FR-33) — a bump reloads every kind immediately, pdf included */
  reloadNonce: number
  /** the kind bar's ≡ (FR-32); the list renders here, the button up there */
  outlineOpen: boolean
  onCaps: (tabId: string, caps: ArtifactCaps) => void
  /** FR-34 — a reference opens IN THIS TAB, so retargeting is the panel's business */
  onNavigate: (tabId: string, path: string, line?: number) => void
  /** the panel owns the single find bar (FR-35); this is its search root */
  onBody: (tabId: string, el: HTMLElement | null) => void
  /** FR-54's first rung: the blow-up's STATE is the panel's, so Esc can consume it from
   *  anywhere in the panel — but the markup is here, because SEC-6 forbids an `<img>` in
   *  the chrome around a guest (that renderer is privileged, and a source guard, not a
   *  trace of where the src came from, is what keeps it that way). Artifact images
   *  legitimately paint in this layer; the overlay shows the one already on screen. */
  onZoomImage: (src: string) => void
  /** the blown-up image's src, or null. Only the ACTIVE pane is ever handed one. */
  zoom: string | null
  onCloseZoom: () => void
  /** the ≡ list closes itself after a jump; the panel holds the open flag */
  onOutlineClose: (tabId: string) => void
  /** §6 — the file is gone: the placeholder's close affordance closes the tab */
  onClose: (tabId: string) => void
  /**
   * B-14/B-14b — the text the editor is holding for THIS tab, when there is one.
   *
   * Two rules in one prop. The Source view shows the buffer rather than the bytes on disk,
   * because showing the older file next to an editor full of changes reads as "my edit did
   * nothing". And the read below is skipped entirely while it is set: the editor already
   * read the file through its own channel, and a second read on the way past could easily
   * land on a different version — one file, two views, two contents.
   */
  editText?: string
  /** …and that buffer has changes that are not on disk yet, so the view says so */
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
  editText,
  editUnsaved
}: ArtifactPaneProps): JSX.Element {
  const kind = previewKindForPath(path)
  const isBinaryKind = kind === 'image' || kind === 'pdf'

  const bodyRef = useRef<HTMLDivElement>(null)
  const [text, setText] = useState('')
  const [state, setState] = useState<TextState>(isBinaryKind ? 'ok' : 'loading')
  // the fetched full-context diff, tagged with the file it is for so a diff fetched for a
  // previous path never renders under the next one
  const [diff, setDiff] = useState<{ src: string; text: string } | null>(null)
  /** read inside the fetch's `.then`, so a status that moved while the request was out is
   *  the one consulted — a dep would restart the fetch instead */
  const changedRef = useRef(changed)
  changedRef.current = changed
  // Auto-refresh counters (monotonic, never reset): reloadTick re-reads text/markdown in
  // place and cache-busts images; wvToken reloads the pdf webview; diffTick refetches the
  // full-context diff. pdf never bumps wvToken on its own — a reload loses the PDFium page
  // position irrecoverably, so a disk change only sets `stale` and asks the user first.
  const [reloadTick, setReloadTick] = useState(0)
  const [wvToken, setWvToken] = useState(0)
  const [diffTick, setDiffTick] = useState(0)
  const [stale, setStale] = useState(false)
  const [mdHeadings, setMdHeadings] = useState<MdHeading[]>([])
  const [curHeading, setCurHeading] = useState(0)

  const diffText = diff && diff.src === path ? diff.text : null
  const parsed = useMemo(() => (diffText ? parseUnifiedDiff(diffText) : null), [diffText])
  const hasChange = !!parsed?.hasChange

  // FR-30's routing table, as the set of views the segment offers. Rendered exists only for
  // markdown — code has no typeset form, and html never reaches here at all (FR-11 sends it
  // to a `web` tab). Diff is always offered for a text kind and goes disabled when there is
  // nothing to diff (see `hasDiff`).
  const views = useMemo<ArtifactView[]>(() => {
    if (isBinaryKind) return []
    return kind === 'markdown' ? ['render', 'diff', 'source'] : ['diff', 'source']
  }, [isBinaryKind, kind])

  /**
   * The tab stores only what the user CHOSE; the default is derived here.
   *
   * It is derived ONCE PER SUBJECT and then only ever falls BACK, and the asymmetry is the
   * point. The justification for following `hasChange` at all is "rather than being pinned
   * to a view the artifact cannot render" — and that only argues one direction: Diff with
   * no diff renders nothing, so losing a diff must fall back to Source. Gaining one argues
   * nothing, because Source is always renderable, and promoting on it yanks the reader out
   * of the text they are reading the instant an agent touches the file.
   *
   * Found in's manual round, in its loudest form: a file rewritten underneath the
   * reader (`cat >` truncates, so the diff is briefly empty) made the view oscillate
   * between Diff and Source several times a second. The oscillation was the symptom; the
   * promote-on-gain rule was the defect, and it bites a single agent edit just as surely,
   * only once instead of repeatedly.
   */
  const live: ArtifactView | null = isBinaryKind
    ? null
    : kind === 'markdown'
      ? 'render'
      : hasChange
        ? 'diff'
        : 'source'
  // The diff arrives asynchronously, so the latch may only close once there is an ANSWER
  // for this path. Closing it on the first render instead pins every file to Source —
  // `hasChange` is false while the fetch is still out — and FR-30's "changed → Diff"
  // default stops existing (caught by preview.spec's R3).
  const diffResolved = diff !== null && diff.src === path
  const latched = useRef<{ path: string; view: ArtifactView | null } | null>(null)
  if (latched.current?.path !== path) latched.current = null // a new subject re-opens it
  // Latch ON the render that first has the answer, not after it: keying the update on
  // "not resolved yet" stops one frame early and freezes the pre-answer value, which is
  // always `source` — FR-30's "changed → Diff" then never fires (preview.spec R3, and
  // measured: `live=diff` while `fb=source` on the very frame the diff arrived).
  if (latched.current === null && diffResolved) latched.current = { path, view: live }
  const fallback = latched.current?.view ?? live
  const wanted = view && views.includes(view) ? view : fallback
  // the ONE direction that still tracks the file: a Diff view with nothing to diff cannot
  // render, so it steps aside for Source
  const current =
    wanted === 'diff' && !hasChange ? (kind === 'markdown' ? 'render' : 'source') : wanted

  /** the buffer wins over the disk read for as long as there is one (B-14) */
  const shownText = editText ?? text
  const symbols = useMemo(
    () => (current === 'source' && state === 'ok' ? extractOutline(shownText) : []),
    [current, state, shownText]
  )
  const hasOutline =
    current === 'source' ? symbols.length > 0 : current === 'render' && mdHeadings.length > 0

  // report upward for the kind bar. `views` is rebuilt every render, so the dep is its
  // value rather than its identity — the parent drops an unchanged report, and an identity
  // dep would still re-run this on every parent render for nothing.
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

  // hand the panel this pane's search root (FR-35's DOM find) for as long as it is mounted
  useEffect(() => {
    const el = bodyRef.current
    onBody(tabId, el)
    return () => onBody(tabId, null)
  }, [tabId, onBody])

  // FR-34's retarget keeps this pane MOUNTED under a new path, so the previous file's
  // per-file state has to be dropped by hand — the `key` that used to do it belongs to the
  // tab now, not to the file. (`diff` carries its own src tag and self-invalidates.)
  useEffect(() => {
    setStale(false)
    setMdHeadings([])
    setCurHeading(0)
  }, [path])

  // ONE read serves the Source view, the symbol outline and every failure placeholder —
  // which is why it runs for markdown too, whose Rendered view reads again through its own
  // pipeline. The alternative (reading only while Source is showing) would leave the
  // missing / binary / too-large states unknown in the other two views, and §6 asks for the
  // same message in all of them.
  //
  // "First read" is per PATH, not per mount: the reload counter survives a retarget, so a
  // tick-based baseline would treat the new file's very first read as a reload and swallow
  // its failure into "keep the last good content".
  const readPath = useRef<string | null>(null)
  useEffect(() => {
    const first = readPath.current !== path
    readPath.current = path
    // B-14b — an editor is holding this file; its text is the one both of us show
    if (editText !== undefined) {
      setState('ok')
      return
    }
    if (isBinaryKind) {
      // an image/pdf is read by its own viewer; nothing here can fail, so nothing here
      // may leave a stale failure placeholder over it after a retarget
      setState('ok')
      return
    }
    let cancelled = false
    if (first) setState('loading')
    window.api.preview
      .readText(path)
      .then((t) => {
        if (cancelled) return
        setText(t)
        setState('ok') // also recovers a pane stuck on a failure once the file is back
      })
      .catch((err: unknown) => {
        if (cancelled) return
        const msg = String((err as Error)?.message ?? '')
        // §6 — a file deleted under an open tab keeps the tab and says so. A rename mid-
        // write can flash through the same error; the watch fires again when the new file
        // lands and the read above clears the state, so the flash is self-healing.
        if (msg.includes('KOLOFT_READ_FAILED') || msg.includes('KOLOFT_NOT_FILE'))
          setState('missing')
        else if (msg.includes('KOLOFT_TOO_LARGE')) setState('tooLarge')
        else if (msg.includes('KOLOFT_BINARY')) setState('binary')
        else if (first) setState('error')
        // a transient failure on a RELOAD keeps the last good content
      })
    return () => {
      cancelled = true
    }
  }, [path, isBinaryKind, reloadTick, editText])

  // the full-context diff behind the Diff view and behind FR-30's "changed → Diff" default.
  // Refetched on every diffTick bump (disk change / ↻), so the diff tracks the file instead
  // of staying a snapshot. Never spawned for image/pdf.
  //
  // It waits for the panel's baseline instead of running once without it and again with it,
  // and that is not an optimisation — the two answers can DISAGREE, and a disagreement here
  // is visible: `hasChange` flips, FR-30's default view flips Source → Diff → Source with
  // it, and the swap unmounts the scroller mid-read. Measured as a ~200ms round trip that
  // silently discarded the reader's scroll position (BB-M12, which asserts it across a tab
  // swap and so looked like a panel bug rather than a double fetch). `base` is null both
  // before the first poll answers and in a directory that is not a repo; neither has a diff
  // to show, so waiting is right in both.
  useEffect(() => {
    // wait only for "not resolved yet" — a resolved `null` means there is no baseline, and
    // the honest fetch is the un-based one, which is what main's staged+unstaged fallback
    // is for. Waiting for it at all is what keeps the answer from changing under the
    // reader: two fetches with different bases flip `hasChange`, which flips FR-30's
    // default view, which unmounts the scroller mid-read (BB-M12).
    if (isBinaryKind || base === undefined) return
    let cancelled = false
    window.api.fs
      .gitFileDiffFull(path, base ?? undefined)
      .then((d) => {
        if (cancelled) return
        // §6 — an empty answer for a file the status map still calls CHANGED is a
        // transient read, not news: `cat >`-style writes truncate before they fill, and a
        // refetch landing in that window would otherwise drop the diff, flip FR-30's view
        // out from under the reader and drop them back again a tick later. Measured in
        // 's manual round as the view oscillating several times a second. When the file
        // really does stop being changed the status map says so, and the empty is taken.
        // The test is "does this PARSE to no change", not "is the text empty" — and the
        // difference is the whole bug. Measured: a file caught at zero bytes yields an
        // 85-character diff (a `--no-index` header with no hunks), so an empty-string test
        // waves it straight through and `hasChange` drops anyway. Parsed with the same
        // function the view uses, so the two cannot disagree about what "no change" means.
        const empty = !parseUnifiedDiff(d.text).hasChange
        setDiff((prev) =>
          empty && changedRef.current && prev?.src === path && parseUnifiedDiff(prev.text).hasChange
            ? prev
            : { src: path, text: d.text }
        )
      })
      .catch(() => {
        if (cancelled) return
        // The SAME guard as the success path, and it needs it more: git reading a file
        // that is being rewritten can fail outright, and a wide write window (a `cat >`
        // forks a process before it writes, where a single writeFileSync does not) makes
        // that the common outcome rather than the rare one. An unguarded catch here undid
        // the whole of §6 — it dropped the diff on exactly the transient the guard exists
        // for, which is why the automated repro stayed green while the manual round kept
        // seeing the flip.
        setDiff((prev) =>
          changedRef.current && prev?.src === path && parseUnifiedDiff(prev.text).hasChange
            ? prev
            : { src: path, text: '' }
        )
      })
    return () => {
      cancelled = true
    }
  }, [path, isBinaryKind, diffTick, base])

  // live watch of this artifact: main stat-polls the path (fs:watchFile, ref-counted) and
  // pushes fs:file-changed. Consumption is per kind — text/markdown/image reload in place
  // immediately; pdf only raises the stale notice (see the counters' comment above).
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

  // FR-33's manual ↻ (and the pdf notice's Reload): the same reload paths, immediately.
  // Baselined at mount — the panel's counter is per tab and monotonic, so a nonzero value
  // on a freshly mounted pane is history, not a pending reload.
  const nonceRef = useRef(reloadNonce)
  const refresh = useCallback(() => {
    setStale(false)
    if (kind === 'pdf') setWvToken((t) => t + 1)
    else setReloadTick((t) => t + 1)
    if (!isBinaryKind) setDiffTick((t) => t + 1)
  }, [kind, isBinaryKind])
  useEffect(() => {
    if (reloadNonce === nonceRef.current) return
    nonceRef.current = reloadNonce
    refresh()
  }, [reloadNonce, refresh])

  /**
   * Best-effort scroll carry-over across a view swap the READER did not ask for: an
   * unchanged file gaining its first change (the agent just edited the file being read)
   * flips FR-30's default from Source to Diff underneath them, and the old view's scroller
   * unmounts with its offset. Each view renders exactly one scrollable child of the body,
   * so remember that child's last scrollTop — scroll does not bubble, but a capture-phase
   * listener on the body still sees it — and re-apply it right after a same-file swap.
   *
   * The retired FilePane needed this for a second case too: the aux column hid it with
   * `display`, and a subtree with no layout box has nowhere to keep a scroll offset. The
   * panel hides an inactive tab with `visibility` instead (NFR-03), which keeps the box —
   * so that half is gone, not dropped.
   */
  const lastScroll = useRef(0)
  /**
   * The offset a restore is currently trying to reach, or null.
   *
   * It is a VALUE with a lifetime, not a flag around the assignment, and that distinction
   * is the correctness: a scroll event raised by a programmatic `scrollTop` write is
   * delivered asynchronously, so a boolean cleared on the next line is always already false
   * by the time the listener runs. The listener would then record the CLAMPED offset — a
   * restore into a not-yet-tall view lands at 0 — and every later restore would faithfully
   * re-apply 0. That is how BB-M12's reader lost their place, and the first fix for it did
   * not actually close the window.
   *
   * While this is non-null the authoritative offset is known, so the listener stands down
   * entirely until the restore succeeds or gives up.
   */
  const restoreTo = useRef<number | null>(null)
  useEffect(() => {
    const host = bodyRef.current
    if (!host) return
    const onScroll = (e: Event): void => {
      if (restoreTo.current !== null) return
      const el = e.target as HTMLElement | null
      // the scroller is the viewer's own body, which sits under a wrapper — matching on
      // "direct child of the pane body" silently recorded nothing once that wrapper existed
      if (el && el !== host && host.contains(el)) lastScroll.current = el.scrollTop
    }
    host.addEventListener('scroll', onScroll, true)
    return () => host.removeEventListener('scroll', onScroll, true)
  }, [])
  /**
   * FR-12 — seed the offset a split inherited, once the body is tall enough to hold it.
   *
   * Two things make this harder than a layout effect, and the first spelling of it got
   * both wrong (found by WB-R08, measured: the split tab landed at 0 every time).
   *
   *  · **`scrollHeight` is not a readiness signal.** An empty, laid-out scroller reports
   *    its own client height, never 0 — so a `!child.scrollHeight` guard lets the seed
   *    through against an empty body, the assignment clamps to 0, and the latch closes on
   *    a write that did nothing.
   *  · **This component does not re-render when the content lands.** The highlighted HTML
   *    arrives in the viewer's OWN state, so an effect that "runs on every render" of this
   *    component runs exactly once, before there is anything to scroll.
   *
   * So the readiness signal is the DOM itself: watch the subtree, retry on each mutation,
   * and latch only when the scroller actually KEPT the offset. A body that legitimately
   * cannot hold it (the file shrank under the split) simply never latches, which costs one
   * idle observer until the tab is closed and is the right way round — the alternative
   * silently discards the reader's position.
   */
  const seeded = useRef(false)
  useEffect(() => {
    if (!initialScrollTop || seeded.current) return
    const host = bodyRef.current
    if (!host) return
    const apply = (): void => {
      const child = host.querySelector<HTMLElement>('.code-body, .md-body, .idiff')
      if (!child) return
      child.scrollTop = initialScrollTop
      // `> 0` was wrong and wrong in a way that only shows on a big file: an early Shiki
      // mutation can clamp a 3000px seed to a few hundred, which is non-zero, so the latch
      // closed and the observer disconnected with the reader near the top — the very
      // WB-R08 failure this exists to prevent. Only reaching the offset counts.
      if (child.scrollTop === initialScrollTop) {
        seeded.current = true
        mo.disconnect()
      }
    }
    const mo = new MutationObserver(apply)
    mo.observe(host, { childList: true, subtree: true })
    apply()
    return () => mo.disconnect()
  }, [initialScrollTop, path])

  const swapRef = useRef({ path, view: current })
  useLayoutEffect(() => {
    const prev = swapRef.current
    swapRef.current = { path, view: current }
    if (prev.path !== path) {
      lastScroll.current = 0 // new file — never restore across files
      return
    }
    if (prev.view === current) return
    const host = bodyRef.current
    const want = lastScroll.current
    if (!host || !want) return
    // The new view's content arrives ASYNCHRONOUSLY — Shiki for a code body, the markdown
    // pipeline for a rendered one — so the box exists on this frame but is not yet tall
    // enough to hold the offset, and a single assignment (even one re-applied after paint)
    // clamps to 0. Watch the subtree and retry until it STICKS, the same shape the FR-12
    // seeding above needs and for the same reason.
    restoreTo.current = want
    const finish = (): void => {
      restoreTo.current = null
      mo.disconnect()
    }
    const apply = (): void => {
      const child = host.querySelector<HTMLElement>('.code-body, .md-body, .idiff')
      if (!child) return
      child.scrollTop = want
      if (child.scrollTop === want) finish()
    }
    const mo = new MutationObserver(apply)
    mo.observe(host, { childList: true, subtree: true })
    apply()
    // a view the offset simply does not fit (a diff shorter than the source) must not leave
    // an observer running — nor the listener muted — for the life of the tab
    const stop = setTimeout(finish, 4000)
    return () => {
      clearTimeout(stop)
      finish()
    }
  }, [path, current])

  // FR-32b: which section is being read. Tracked only while the list is open — the class it
  // feeds isn't rendered otherwise, and a scroll listener that measures every heading is a
  // cost a long document shouldn't pay for a closed panel.
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
      // the last heading that has passed the top of the viewport; the slack keeps one
      // parked exactly at the top counted as current
      let cur = 0
      for (let i = 0; i < els.length; i++) {
        if (els[i].getBoundingClientRect().top - top <= 8) cur = i
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

  /** Scroll a heading into view. Its anchor id is the contract; document position is the
   *  fallback for a heading that never got one (a title of pure punctuation). */
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

  /**
   * FR-34's fence, applied to EVERY in-document target rather than only to `path:line`
   * references. The retired FilePane could be laxer with plain links because routing only
   * ever let a *previewable* kind through; a `file` tab renders any text file, so a bare
   * `<a href="../../../etc/passwd">` would now be a real read. A target may only ever land
   * inside the tree the reader already declared: the workspace, or (with none known) the
   * document's own directory.
   */
  const fenced = useCallback(
    (candidate: string): string | null => {
      const fence = wsRoot ?? path.slice(0, path.lastIndexOf('/'))
      return candidate === fence || candidate.startsWith(`${fence}/`) ? candidate : null
    },
    [wsRoot, path]
  )

  // FR-34: a `path:line` reference inside the document. The path is resolved against the
  // document's own directory first and the workspace root second; one that matches neither
  // does nothing at all — no dialog, no toast.
  const openFileRef = (a: HTMLElement): void => {
    const rel = a.getAttribute('data-path')
    if (!rel) return
    const n = Number(a.getAttribute('data-line'))
    const at = Number.isInteger(n) && n > 0 ? n : undefined
    // previewLinkTarget resolves against the DIRECTORY of its second argument
    const raw = rel.startsWith('/')
      ? // normalized, not taken at face value: `/ws/../../.claude/.credentials.json` starts
        // with the workspace path and would walk straight out through the fence.
        // previewLinkTarget collapses `..` (a relative path already comes through it).
        [previewLinkTarget(rel, '/.')]
      : [previewLinkTarget(rel, path), ...(wsRoot ? [previewLinkTarget(rel, `${wsRoot}/.`)] : [])]
    const candidates = raw.map(fenced).filter((c): c is string => !!c)
    void (async () => {
      for (const c of candidates) {
        if (await fileExists(c)) {
          onNavigate(tabId, c, at)
          return
        }
      }
    })()
  }

  // SEC-2: a link in a rendered artifact must never navigate the host renderer — main's
  // will-navigate guard would only kill it silently. An `#anchor` scrolls this pane; a local
  // file retargets this tab (FR-34); an html page goes to a `web` tab carrying FR-56's
  // backlink to here (FR-11: a page renders only inside a guest).
  const onBodyClick = (e: ReactMouseEvent): void => {
    const target = e.target as HTMLElement
    // FR-54's first rung: an image blows up. The overlay is the panel's (Esc consumes it
    // there), so this only reports the click.
    const img = target.closest<HTMLImageElement>('.img-wrap img')
    if (img) {
      onZoomImage(img.src)
      return
    }
    // a file reference carries its target in data-* (it is not a navigable href at all)
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
    // a remote url is the browser's business and carries no path to fence
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(resolved)) {
      openWebPage(resolved, tabId)
      return
    }
    const inside = fenced(resolved)
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
          tick={kind === 'pdf' ? wvToken : reloadTick}
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
      {/* FR-32 — the outline list. The ≡ that opens it lives in the kind bar; the list
          belongs over the text it scrolls, which is here. */}
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
      {/* FR-54's first rung, rendered over the reading area exactly as it was when it hung
          off `.wb-body` — `.wb-host` fills that box, so the geometry is unchanged. The
          panel still OWNS the state; this only paints it. */}
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
