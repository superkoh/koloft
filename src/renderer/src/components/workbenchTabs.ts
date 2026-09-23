import { dedupKey } from '@shared/browserRoute'
import { basename, dirname } from '@shared/preview'
import type { ArtifactView, PersistedTab, WorkbenchTabKind } from '@shared/types'
import { PERSISTED_TAB_CAP } from '@shared/workbenchState'

/**
 * The Workbench's per-session tab model, as pure functions over one immutable set.
 *
 * A generalization of the former `browserTabs.ts` over FR-03's three kinds rather than a
 * rewrite: the semantics it pinned — `activateTab` clears unread, source-forked dedup,
 * the per-session cap with least-recently-viewed eviction, `moveTab` drag ordering —
 * all carry over unchanged. What is new is that the cap counts PER KIND (FR-22: `web`
 * and `file` each cap at 8), the pinned `files` tab is exempt from every rule that could
 * remove or reorder it (FR-02/18/21), and titles disambiguate by parent directory
 * (FR-27).
 *
 * Every caller mutates a session's strip through here — the panel itself (＋, ⌘T, a
 * clicked html file), the main-process open-request path (an agent's `open`), and the
 * restore path — so dedup and the cap cannot drift between them.
 *
 * Persistence keeps only what `PersistedTab` names. `activeId`, `unread`, `recency`,
 * scroll offsets, the anchor `line` and the FR-56 backlink are runtime state, rebuilt by
 * `restoreTabSet` on the way back in.
 */

/** FR-22 — the per-kind cap. The ninth open of a kind really closes one of that kind.
 *  The number is the shared sanitizer's, imported rather than restated: the strip a ＋
 *  can build and the strip a restore lets back in are one cap by construction, where two
 *  hand-mirrored `8`s could drift apart without a single test noticing. */
export const KIND_TAB_CAP = PERSISTED_TAB_CAP

/** The cap for a kind. `web` reads the e2e seam (`KOLOFT_BROWSER_TAB_CAP`) so a cap
 *  case can reach the limit without loading eight pages; outside a test run, and for
 *  `file` and `terminal` (nothing drives either remotely), it is the constant above,
 *  always. */
function capFor(kind: 'web' | 'file' | 'terminal'): number {
  if (kind !== 'web') return KIND_TAB_CAP
  return (typeof window !== 'undefined' && window.api?.browserTabCap) || KIND_TAB_CAP
}

/** FR-02: the pinned tab's id is a constant, not a minted one. It is the same tab for
 *  the life of the session, it is never persisted (it is implied by FR-02), and code
 *  that asks "is this the files tab" compares against this rather than against an index
 *  — an index would silently become wrong the moment drag ordering (FR-21) ran. */
export const FILES_TAB_ID = 'files'

export interface WorkbenchTab {
  id: string
  kind: WorkbenchTabKind
  /** kind 'web': the url. Empty for a blank tab that has not navigated yet. */
  url?: string
  /** kind 'file': the absolute path. */
  path?: string
  /** The page's OWN title / the file's own name — empty until something reports one. An
   *  agent tab, a restored tab and a frozen tab are all pages that have never run, so
   *  empty is the common case and `tabLabel` derives a label from url/path instead. */
  title: string
  /** agent-opened and not looked at yet — the strip's left-edge accent dot (FR-16). */
  unread: boolean
  /** kind 'file': which of the three views is showing (FR-30/31). */
  view?: ArtifactView
  /** FR-56: the tab this one was rendered out of ('files', or a `file` tab's id) — the
   *  "← Back to source" backlink. Runtime only: gone after a restart, and gone the
   *  moment the source tab closes. */
  sourceTabId?: string
  /** FR-56, the `files` case: WHICH file in the source tab this page was rendered out of.
   *  A `file` tab is its own answer, but `files` holds a whole change set, so returning
   *  to it has to scroll the stream to that file's anchor (WB-R13) — and only the path
   *  can say which one. Runtime only, like the backlink it qualifies. */
  sourcePath?: string
  /** kind 'file': the line to scroll to on activation (a `path:line` jump, FR-34, or a
   *  content-search hit, FR-45). Consumed by the renderer, never persisted. */
  line?: number
  /** kind 'file': the scroll offset a FR-12 split inherited from the artifact it came
   *  out of. Seeded once by the renderer, then owned by the DOM; never persisted. */
  scrollTop?: number
  /** kind 'terminal' (R19): the directory the shell is standing in — its
   *  spawn cwd, then whatever main's OSC 7 tracker reports it `cd`ed to. The kind bar's
   *  whole content. Runtime only, like the tab itself (D4). */
  cwd?: string
}

export interface WorkbenchTabSet {
  /** `files` is always index 0 (FR-02) — every mutation below preserves that. */
  tabs: WorkbenchTab[]
  /** never null: FR-02 keeps `files` present and FR-19 falls back to it. */
  activeId: string
  /** tab ids least-recently-touched first, where "touched" is created or made current.
   *  A tab never activated keeps its creation moment, which is exactly FR-22's recency
   *  definition and makes the eviction victim the head of this list. */
  recency: string[]
}

export interface OpenTabResult {
  set: WorkbenchTabSet
  /** the tab the target ended up in — the reused one when dedup hit */
  tabId: string
  created: boolean
  /** the tab the cap closed to make room (FR-22); the caller owns the toast (FR-23) */
  evicted: WorkbenchTab | null
  /** The open did not happen, for one of three reasons. 'tab-cap' (D5): every tab the
   *  cap could have taken is being driven by a CDP client — only a 'cdp' open is ever
   *  refused this way, the user always wins. 'all-dirty' (B-27): every tab the cap could
   *  have closed is holding unsaved text — set only when the caller passed `isDirty`.
   *  'cap' (R2): the kind is `terminal` and its eight are already open, and that kind
   *  refuses rather than evicting. The caller owns the notice in every case. */
  refused?: 'tab-cap' | 'all-dirty' | 'cap'
}

let seq = 0

function mintId(): string {
  seq += 1
  return `wt${seq}`
}

function filesTab(): WorkbenchTab {
  return { id: FILES_TAB_ID, kind: 'files', title: 'Files', unread: false }
}

export function emptyTabSet(): WorkbenchTabSet {
  return { tabs: [filesTab()], activeId: FILES_TAB_ID, recency: [FILES_TAB_ID] }
}

/**
 * Rebuild a set from layout.json. Two truncations happen here rather than in the
 * sanitizer alone: a document that says otherwise (hand-edited, or written by a build
 * with a higher cap) would come back as a strip no ＋ could ever have built.
 *
 * The active tab lands on `files` and every restored tab comes back `unread: false` —
 * both are the standing "selection is not persisted" call, not an oversight.
 */
export function restoreTabSet(tabs: PersistedTab[]): WorkbenchTabSet {
  const kept: WorkbenchTab[] = []
  const counts = { web: 0, file: 0 }
  for (const t of tabs) {
    if (t.kind !== 'web' && t.kind !== 'file') continue
    if (counts[t.kind] >= capFor(t.kind)) continue
    counts[t.kind] += 1
    kept.push({
      id: mintId(),
      kind: t.kind,
      url: t.kind === 'web' ? (t.url ?? '') : undefined,
      path: t.kind === 'file' ? t.path : undefined,
      title: t.title ?? '',
      unread: false,
      view: t.kind === 'file' ? t.view : undefined
    })
  }
  const all = [filesTab(), ...kept]
  return { tabs: all, activeId: FILES_TAB_ID, recency: all.map((t) => t.id) }
}

/** The inverse: what travels to `workbench.setState`. `files` is implied by FR-02 and a
 *  `terminal` is a live process nothing can bring back (D4) — neither is written; the
 *  loop names the two kinds that ARE persisted rather than subtracting the two that are
 *  not, so a fifth kind cannot leak onto disk by default. Runtime-only fields drop too.
 *
 *  Load-bearing for more than the file: `samePersistedTabs` compares this projection to
 *  decide whether a strip change needs a disk write at all, so a terminal slipping through
 *  here would turn every shell opening and closing into a layout.json write. */
export function persistTabs(set: WorkbenchTabSet): PersistedTab[] {
  const out: PersistedTab[] = []
  for (const t of set.tabs) {
    if (t.kind === 'web') out.push({ kind: 'web', title: t.title, url: t.url ?? '' })
    else if (t.kind === 'file') {
      out.push({ kind: 'file', title: t.title, path: t.path ?? '', view: t.view })
    }
  }
  return out
}

function touch(recency: string[], id: string): string[] {
  return [...recency.filter((r) => r !== id), id]
}

/** FR-15's dedup key, forked by kind: a url normalizes through the shared router's rule
 *  (so `http://h/p` and `http://h/p/` are one tab), a file is its exact absolute path. */
function sameTarget(
  tab: WorkbenchTab,
  target: { kind: 'web' | 'file' | 'terminal'; url?: string; path?: string }
): boolean {
  // Never reached for a `terminal`: R2's "never deduped" is enforced one level up, where
  // `hasTarget` is false for the kind and no lookup happens at all.
  if (tab.kind !== target.kind) return false
  if (target.kind === 'web') {
    return !!tab.url && !!target.url && dedupKey(tab.url) === dedupKey(target.url)
  }
  return !!tab.path && tab.path === target.path
}

/** whether a guest's dialog still has someone to answer it. The modal is one
 *  App-level slot, so when the session on screen goes cold the dialog in it may belong
 *  to a background session whose guest is alive and well (NFR-03); cancelling that one
 *  hands its page a `false` it never earned. A dialog with no guest (an auth challenge),
 *  or whose guest no tab can name any more, has no owner to wait for. */
export function dialogHasLiveOwner(
  dialog: { guestId?: number },
  ownerOfGuest: (guestId: number) => string | undefined,
  liveTabs: ReadonlySet<string>
): boolean {
  if (!dialog.guestId) return false
  const owner = ownerOfGuest(dialog.guestId)
  return !!owner && liveTabs.has(owner)
}

/** FR-16: activation is the ONLY thing that clears an unread mark — expanding the panel
 *  never batch-clears, which is why no other function here touches the flag. */
export function activateTab(set: WorkbenchTabSet, id: string): WorkbenchTabSet {
  if (!set.tabs.some((t) => t.id === id)) return set
  return {
    tabs: set.tabs.map((t) => (t.id === id ? { ...t, unread: false } : t)),
    activeId: id,
    recency: touch(set.recency, id)
  }
}

/**
 * FR-13/15/22/23 — open a `web` or `file` target.
 *
 * The source fork is the load-bearing part: a USER open focuses the tab it found or made,
 * while an AGENT open may only light the unread dot. "Never switches away from the
 * current tab" is an invariant an agent action may not breach, so the agent branch never
 * writes `activeId` — not on a dedup hit, and not on a fresh tab either.
 *
 * B-27 — `isDirty` (a tab holding unsaved text) makes the cap refuse rather than destroy:
 * such a tab is never the eviction victim, and when the kind has no other candidate left
 * the open is dropped and reported back as `refused`. A confirmation dialog is not an
 * option here: an agent's own `open` reaches this line, and "an agent action never takes
 * the page away from the user" is the same hard rule the source fork above enforces.
 */
export function openTab(
  set: WorkbenchTabSet,
  opts: {
    kind: 'web' | 'file' | 'terminal'
    /** kind 'terminal' only: the tab's id IS the shell's pty id, so it is handed in
     *  rather than minted — every report main sends about that shell names the pty. */
    id?: string
    /** kind 'terminal' only: the shell's spawn directory (R19) */
    cwd?: string
    url?: string
    path?: string
    /** 'cdp' is a client's `Target.createTarget` — see the dedup and cap notes */
    source: 'agent' | 'user' | 'cdp'
    title?: string
    view?: ArtifactView
    sourceTabId?: string
    sourcePath?: string
    line?: number
    scrollTop?: number
    /** D5: tabs a CDP client is driving. The cap steps over them. */
    pinned?: ReadonlySet<string>
    /** B-27: tabs holding unsaved text. The cap steps over them too, and refuses the open
     *  when nothing else is left. */
    isDirty?: (tabId: string) => boolean
  }
): OpenTabResult {
  // Three things have no dedup key, for three reasons. A blank tab (＋ / ⌘T on a web tab)
  // has no target yet — two of them are two tabs, not one. A terminal never has one at all
  // (R2): two shells are two shells, whatever they are standing in. And a CDP client's
  // pages are the first case for a different reason (§4.1c): `newPage()` twice means two
  // pages, both starting at about:blank — deduping them would hand the client one page and
  // a second targetId that is a lie.
  const hasTarget = opts.kind === 'web' ? !!opts.url : opts.kind === 'file' ? !!opts.path : false
  const hit =
    hasTarget && opts.source !== 'cdp' ? set.tabs.find((t) => sameTarget(t, opts)) : undefined
  if (hit) {
    if (opts.source === 'user') {
      // a re-open may carry a fresh anchor (a second `path:line` click on the same file)
      const withLine =
        opts.line === undefined
          ? set
          : { ...set, tabs: set.tabs.map((t) => (t.id === hit.id ? { ...t, line: opts.line } : t)) }
      return { set: activateTab(withLine, hit.id), tabId: hit.id, created: false, evicted: null }
    }
    // the mark says "something you have not looked at". The tab in front of the
    // user is being looked at, so a re-open of THAT one leaves the set untouched — a
    // dot on the page on screen was a prompt to click what is already open.
    if (hit.id === set.activeId) {
      return { set, tabId: hit.id, created: false, evicted: null }
    }
    return {
      set: { ...set, tabs: set.tabs.map((t) => (t.id === hit.id ? { ...t, unread: true } : t)) },
      tabId: hit.id,
      created: false,
      evicted: null
    }
  }

  let base = set
  let evicted: WorkbenchTab | null = null
  // FR-22: the cap counts this kind alone, so eight web tabs never evict a file tab.
  // `files` is not of either kind, so it is exempt by construction rather than by a guard.
  if (base.tabs.filter((t) => t.kind === opts.kind).length >= capFor(opts.kind)) {
    // R2 — a full terminal strip REFUSES; it never evicts. The least-recently-viewed shell
    // is the one most likely to be running something long, and closing it would kill that
    // process to make room for an empty prompt. Every other kind is a page or a file that
    // comes back from its url/path, which is why only this one refuses outright.
    if (opts.kind === 'terminal') {
      return { set, tabId: '', created: false, evicted: null, refused: 'cap' }
    }
    // D5: a tab a client is driving is not a candidate either — closing it would pull the
    // page out from under a running command. A USER open steps over that protection (their
    // ＋ must not be refused because an agent holds the strip); a client's own open is
    // refused instead, with a standard error it can act on.
    const pinned = opts.pinned
    const skip = (id: string): boolean =>
      id === base.activeId || (opts.source === 'cdp' && pinned !== undefined && pinned.has(id))
    const candidates = base.recency.filter(
      (id) => !skip(id) && base.tabs.some((t) => t.id === id && t.kind === opts.kind)
    )
    // B-27: …and neither is a tab holding unsaved text. The two exemptions compose: a
    // driven tab is stepped over first, then the dirty ones among what is left.
    const victimId = opts.isDirty ? candidates.find((id) => !opts.isDirty!(id)) : candidates[0]
    const victim = base.tabs.find((t) => t.id === victimId)
    if (victim) {
      evicted = victim
      base = closeTab(base, victim.id)
    } else if (opts.source === 'cdp') {
      return { set, tabId: '', created: false, evicted: null, refused: 'tab-cap' }
    } else if (opts.isDirty) {
      return { set, tabId: '', created: false, evicted: null, refused: 'all-dirty' }
    }
  }

  const tab: WorkbenchTab = {
    id: opts.id ?? mintId(),
    kind: opts.kind,
    url: opts.kind === 'web' ? (opts.url ?? '') : undefined,
    path: opts.kind === 'file' ? opts.path : undefined,
    // no page has run and no file has been read yet, so the tab has no title of its own —
    // one written here would outlive the target it was minted from
    title: opts.title ?? '',
    // D3: a page a client opened is a background page nobody has looked at — the same
    // landing an agent's `open` gets, dot and all
    unread: opts.source !== 'user',
    view: opts.kind === 'file' ? opts.view : undefined,
    sourceTabId: opts.sourceTabId,
    sourcePath: opts.sourcePath,
    line: opts.line,
    scrollTop: opts.scrollTop,
    cwd: opts.cwd
  }
  // R2 — terminals sit at the right end of the strip, so a new web/file tab is inserted
  // in FRONT of them rather than appended. Splice rather than a sort: the drag order
  // (FR-21) of everything to its left has to survive untouched.
  const at =
    opts.kind === 'terminal' ? base.tabs.length : base.tabs.findIndex((t) => t.kind === 'terminal')
  const tabs =
    at < 0 ? [...base.tabs, tab] : [...base.tabs.slice(0, at), tab, ...base.tabs.slice(at)]
  return {
    set: {
      tabs,
      activeId: opts.source === 'user' ? tab.id : base.activeId,
      recency: [...base.recency, tab.id]
    },
    tabId: tab.id,
    created: true,
    evicted
  }
}

/**
 * FR-18/19 — close a tab. `files` is not closable and the call is a no-op for it, which
 * is what makes ⌘W on the pinned tab "do nothing" rather than need a caller-side guard.
 *
 * When the ACTIVE tab closes focus goes to the right neighbour, else the left; closing a
 * background tab leaves `activeId` alone. FR-56's backlinks pointing at the closed tab
 * are dropped in the same pass — a "← Back to source" whose source is gone must vanish,
 * not dangle.
 */
export function closeTab(set: WorkbenchTabSet, id: string): WorkbenchTabSet {
  if (id === FILES_TAB_ID) return set
  const idx = set.tabs.findIndex((t) => t.id === id)
  if (idx < 0) return set
  const tabs = set.tabs
    .filter((t) => t.id !== id)
    .map((t) => (t.sourceTabId === id ? { ...t, sourceTabId: undefined } : t))
  const activeId =
    set.activeId === id ? (tabs[idx]?.id ?? tabs[idx - 1]?.id ?? FILES_TAB_ID) : set.activeId
  return { tabs, activeId, recency: set.recency.filter((r) => r !== id) }
}

/**
 * FR-21 — drag reorder, `files` excepted in both directions: it can neither be dragged
 * nor displaced, so every target index clamps to 1 or above.
 *
 * Nothing else about the set moves: same active tab, same tab OBJECTS (per-tab markers
 * like the unread dot hang off the object, so rebuilding them here would make markers
 * jump to whoever now sits in that slot). Out-of-range drops clamp to the ends rather
 * than being refused — the pointer can leave the strip mid-drag, and "nothing happened"
 * is the wrong answer to a deliberate drop.
 */
export function moveTab(set: WorkbenchTabSet, id: string, to: number): WorkbenchTabSet {
  if (id === FILES_TAB_ID) return set
  const from = set.tabs.findIndex((t) => t.id === id)
  if (from < 0) return set
  // R2 — a terminal takes no part in drag ordering, in either direction: it is pinned to
  // the right end the way `files` is pinned to the left, so it can neither be dragged nor
  // displaced. The clamp below therefore stops before the first terminal.
  if (set.tabs[from].kind === 'terminal') return set
  const firstTerm = set.tabs.findIndex((t) => t.kind === 'terminal')
  const right = (firstTerm < 0 ? set.tabs.length : firstTerm) - 1
  const target = Math.max(1, Math.min(right, to))
  if (target === from) return set
  const tabs = set.tabs.slice()
  const [moved] = tabs.splice(from, 1)
  tabs.splice(target, 0, moved)
  return { ...set, tabs }
}

/** FR-53 — ⌘⌥←/→ cycle in strip order, wrapping at both ends. `files` is part of the
 *  cycle (it is a tab like any other to switch TO), so no filtering happens here. */
export function cycleTab(set: WorkbenchTabSet, dir: 1 | -1): WorkbenchTabSet {
  if (set.tabs.length < 2) return set
  const at = set.tabs.findIndex((t) => t.id === set.activeId)
  const next = set.tabs[(at + dir + set.tabs.length) % set.tabs.length]
  return activateTab(set, next.id)
}

export function navigateTab(set: WorkbenchTabSet, id: string, url: string): WorkbenchTabSet {
  return { ...set, tabs: set.tabs.map((t) => (t.id === id ? { ...t, url } : t)) }
}

export function retitleTab(set: WorkbenchTabSet, id: string, title: string): WorkbenchTabSet {
  return { ...set, tabs: set.tabs.map((t) => (t.id === id ? { ...t, title } : t)) }
}

export function setTabView(set: WorkbenchTabSet, id: string, view: ArtifactView): WorkbenchTabSet {
  return { ...set, tabs: set.tabs.map((t) => (t.id === id ? { ...t, view } : t)) }
}

/**
 * FR-34 — a reference followed inside a `file` tab opens IN THAT TAB: the `file`
 * counterpart of `navigateTab`, which only knows a `web` url. The path and the anchor
 * line move to the new target; the title and the stored view are DROPPED rather than
 * carried, because the title was the old file's own name and the next file's kind decides
 * its own default view (FR-30). Everything else on the tab — its id, its unread mark, its
 * FR-56 backlink — stays, and no other tab is touched.
 *
 * Deliberately NO dedup against a tab already open on the target path: FR-34's rule is
 * "same tab", and folding two tabs into one here would close a tab nobody asked to close.
 * Whether a retarget onto an already-open path should focus that tab instead is a
 * follow-up question, not a side effect to slip in.
 */
export function retargetTab(
  set: WorkbenchTabSet,
  id: string,
  path: string,
  line?: number
): WorkbenchTabSet {
  return {
    ...set,
    tabs: set.tabs.map((t) => (t.id === id ? { ...t, path, line, title: '', view: undefined } : t))
  }
}

export interface RetargetResult {
  set: WorkbenchTabSet
  /** the tab the reference ended up in — the same one on a retarget, another one on a
   *  fallback open, and empty when B-27 refused the fallback */
  tabId: string
  /** the reference went to a NEW tab because the old one had unsaved text (B-28) */
  openedNew: boolean
  /** B-27, forwarded from the fallback open it had to make */
  refused?: OpenTabResult['refused']
}

/**
 * B-28 — the same jump as `retargetTab`, except that a tab holding unsaved text is not
 * overwritten: the reference opens elsewhere instead, and the typing stays where it is.
 *
 * The fallback is a plain `openTab`, so it dedups: FR-34's "no dedup" rule belongs to
 * retargeting in place, while opening has always folded onto a tab already showing that
 * file. It is also a USER open, because a reference is only ever followed by a click.
 *
 * With no `isDirty` this is `retargetTab` exactly, which is what a session with no editor
 * in it does.
 */
export function retargetOrOpenTab(
  set: WorkbenchTabSet,
  id: string,
  path: string,
  line?: number,
  isDirty?: (tabId: string) => boolean
): RetargetResult {
  if (!isDirty?.(id)) return { set: retargetTab(set, id, path, line), tabId: id, openedNew: false }
  const r = openTab(set, { kind: 'file', path, source: 'user', line, isDirty })
  return {
    set: r.set,
    tabId: r.tabId,
    openedNew: !r.refused,
    refused: r.refused
  }
}

/** wide enough that host + page survive, short enough that a hostile url cannot push a
 *  kilobyte of text through the strip (the 180px column ellipsizes long before this) */
const MAX_LABEL = 40

function lastSegment(pathname: string): string {
  const segs = pathname.split('/').filter(Boolean)
  const last = segs[segs.length - 1] ?? ''
  try {
    return decodeURIComponent(last)
  } catch {
    return last
  }
}

/** FR-27's `web` half: the page title, or `host/last-segment` before load. A tab with no
 *  page title yet is the common case, not the exception (FR-13), so the url has to carry
 *  the label — the host alone would make every page of one site the same tab, which is
 *  exactly the sameness the user opened two tabs to tell apart. Query and hash drop. */
function webLabel(tab: { url?: string; title: string }): string {
  if (tab.title) return tab.title
  // about:blank is what a blank tab's own guest reports once it attaches — still no page
  if (!tab.url || tab.url === 'about:blank') return 'New tab'
  let derived = tab.url
  try {
    const u = new URL(tab.url)
    const page = lastSegment(u.pathname)
    // a file:// url has no host to fall back on, and its name IS the page
    derived = u.host ? (page ? `${u.host}/${page}` : u.host) : page || tab.url
  } catch {
    /* not a url (the address bar refuses those, but a persisted set can hold one) */
  }
  return derived.length > MAX_LABEL ? `${derived.slice(0, MAX_LABEL - 1)}…` : derived
}

/**
 * FR-27's `file` half: the file name, prefixing parent directories level by level until
 * distinct. Uniqueness is scoped to the session's own tab set — two `config.ts` tabs from
 * `a/` and `b/` become `a/config.ts` and `b/config.ts`, while a lone `config.ts` stays
 * bare no matter how deep it sits.
 *
 * Computed over the whole set rather than per tab because the answer is a property of the
 * SET: opening a second `config.ts` has to relabel the first one too.
 */
export function fileLabels(set: WorkbenchTabSet): Record<string, string> {
  const fileTabs = set.tabs.filter((t) => t.kind === 'file' && t.path)
  const out: Record<string, string> = {}
  // segment depth 0 = basename, 1 = parent/basename, … grown only for the tabs that
  // still collide at the current depth, so an unambiguous tab never grows a prefix
  const depth = new Map<string, number>()
  for (const t of fileTabs) depth.set(t.id, 0)
  const labelAt = (p: string, d: number): string => {
    let head = dirname(p)
    const parts: string[] = [basename(p)]
    for (let i = 0; i < d && head && head !== '/' && head !== '.'; i++) {
      parts.unshift(basename(head))
      head = dirname(head)
    }
    return parts.join('/')
  }
  // at most as many rounds as the deepest path has segments; the guard is the round in
  // which nothing changed, which also terminates on genuinely identical paths
  for (let round = 0; round < 32; round++) {
    const byLabel = new Map<string, string[]>()
    for (const t of fileTabs) {
      const l = labelAt(t.path!, depth.get(t.id)!)
      byLabel.set(l, [...(byLabel.get(l) ?? []), t.id])
    }
    let grew = false
    for (const [, ids] of byLabel) {
      if (ids.length < 2) continue
      for (const id of ids) {
        const t = fileTabs.find((x) => x.id === id)!
        // stop growing a path that has run out of parents — two tabs on the SAME path
        // cannot be told apart by more prefix, and dedup makes that unreachable anyway
        if (labelAt(t.path!, depth.get(id)! + 1) === labelAt(t.path!, depth.get(id)!)) continue
        depth.set(id, depth.get(id)! + 1)
        grew = true
      }
    }
    if (!grew) break
  }
  for (const t of fileTabs) out[t.id] = labelAt(t.path!, depth.get(t.id)!)
  return out
}

/** What the strip writes on a tab; its tooltip stays the whole url/path. */
export function tabLabel(set: WorkbenchTabSet, tab: WorkbenchTab): string {
  if (tab.kind === 'files') return 'Files'
  // R19 — a shell's label is its title and nothing else: `zsh` until main reports a
  // foreground process, then that. No path is derived from the cwd; the kind bar has it.
  if (tab.kind === 'terminal') return tab.title
  if (tab.kind === 'web') return webLabel(tab)
  return fileLabels(set)[tab.id] ?? tab.title ?? ''
}

/**
 * FR-24 — which `web` tabs may hold a LIVE guest, given the global cap the main process
 * sets. The overflow is the least-recently-viewed, and it is FROZEN, never closed: the
 * tab keeps its url and title and reloads when clicked.
 *
 * The active tab is always live regardless of the cap — freezing what the user is
 * looking at would be a blank pane, not a saving.
 */
export function liveWebTabs(set: WorkbenchTabSet, limit: number): Set<string> {
  const web = set.tabs.filter((t) => t.kind === 'web')
  // most-recently-touched first, with the active tab pinned to the head
  const ranked = [...web].sort((a, b) => {
    if (a.id === set.activeId) return -1
    if (b.id === set.activeId) return 1
    return set.recency.indexOf(b.id) - set.recency.indexOf(a.id)
  })
  return new Set(ranked.slice(0, Math.max(1, limit)).map((t) => t.id))
}

// ---- the `terminal` kind's three notices and its cwd label (R2/R4/R19) ----
// Moved here whole from the former `auxTabs.ts` when the global terminal island became
// the panel's fourth tab kind: they belong beside the model that now owns the tab.

/** R2 — the ninth shell of one conversation tab. The panel says no and keeps all eight;
 *  it never evicts, so the sentence promises nothing about making room. */
export const TERMINAL_CAP_NOTICE = 'Terminal limit reached: at most 8 per session'

/** The shell behind a ⌃` / ＋ / ⌘T never started. Silence would read as a dead shortcut,
 *  since the only other evidence is a strip that did not change. */
export const TERM_SPAWN_FAILED_NOTICE = 'Could not open a terminal'

/** R4 — the conversation tab's root directory has vanished (a cleaned-up worktree,
 *  usually), so main put the shell wherever `resolveSpawnCwd` could. The shell opens
 *  either way; the notice is what stops it from silently coming back somewhere else. */
export function cwdFallbackNotice(resolved: string): string {
  return `Folder is gone — terminal opened in ${shortAuxCwd(resolved)}`
}

/** R19 — the kind bar's directory label: the tail of the shell's cwd, elided at the
 *  front so the identifying part (the worktree name) survives the width cap. */
export function shortAuxCwd(cwd: string): string {
  const parts = cwd.split('/').filter(Boolean)
  if (parts.length <= 2) return cwd.length > 1 ? cwd.replace(/\/$/, '') : cwd
  return '…/' + parts.slice(-2).join('/')
}
