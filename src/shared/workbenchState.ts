import type { ArtifactView, PersistedTab, SessionWorkbenchState } from './types'

/**
 * Boundary validation for the Workbench's persisted state — the one place that decides
 * what a `PersistedTab` may be.
 *
 * It is shared rather than main-side because three callers must agree exactly: the v2→v3
 * migration (a converted document is untrusted the same way a hand-edited one is), the
 * `workbench.setState` write path, and the read path. The retired `sanitizeSessionBrowser`
 * validated per item and NEVER truncated — truncation lived on the renderer's restore side
 * — so a cap change on one side silently disagreed with the other. This one does both.
 *
 * The rule §Edge sets is per-item repair, never wholesale rejection: one dirty entry drops
 * and the rest of the panel restores. Blanking the whole panel over a single bad tab is
 * the failure this shape exists to prevent.
 */

/** FR-22 — THE per-kind cap. The renderer's `KIND_TAB_CAP` imports it rather than
 *  restating it, so the strip a ＋ can build and the strip this sanitizer lets back in are
 *  one number by construction. A doc that says otherwise (hand-edited, or written by a
 *  build with a higher cap) truncates to a strip the ＋ could actually have built. */
export const PERSISTED_TAB_CAP = 8

/** The panel a session nobody has configured starts with: COLLAPSED. This is the shipped
 *  value of layout v4's `workbench.defaultOpen`, and the fallback every reader uses when
 *  that flag is missing or corrupt — main's migration, `resolveWorkbenchState`, and the
 *  renderer's write path — so "hidden unless the user opened it" is one number here rather
 *  than a `true`/`false` literal repeated at each site. It became `false` on:
 *  until then it shipped as `true`, no UI could change it, and every session entry was
 *  seeded from it at bind, so the panel expanded on every new session and every resume. */
export const DEFAULT_PANEL_OPEN = false

const VIEWS: readonly ArtifactView[] = ['render', 'diff', 'source']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** One tab, repaired or dropped. A `web` tab with no url and a `file` tab with no path
 *  are both unrenderable — there is nothing to repair them WITH, so they drop. An
 *  unknown `view` degrades to absent (FR-30 re-routes by kind) rather than dropping the
 *  tab, since the view is a preference and the path is the tab. */
export function sanitizeTab(raw: unknown): PersistedTab | null {
  if (!isRecord(raw)) return null
  const title = typeof raw.title === 'string' ? raw.title : ''
  if (raw.kind === 'web') {
    const url = str(raw.url)
    return url ? { kind: 'web', title, url } : null
  }
  if (raw.kind === 'file') {
    const path = str(raw.path)
    if (!path) return null
    const view = VIEWS.find((v) => v === raw.view)
    return { kind: 'file', title, path, ...(view ? { view } : {}) }
  }
  // FR-02: `files` is implied, never stored — a document carrying one is from a build
  // that got this wrong, and the pinned tab exists regardless. Any other kind is unknown.
  return null
}

/** A whole session entry. `open` defaults to the caller's `defaultOpen` when the stored
 *  value is not a boolean, so a corrupt flag lands on the user's own default rather than
 *  on a hardcoded one. Truncation is per kind, matching FR-22's per-kind cap. */
export function sanitizeSessionWorkbench(
  raw: unknown,
  defaultOpen: boolean
): SessionWorkbenchState {
  if (!isRecord(raw)) return { open: defaultOpen, tabs: [] }
  const open = typeof raw.open === 'boolean' ? raw.open : defaultOpen
  const list = Array.isArray(raw.tabs) ? raw.tabs : []
  const tabs: PersistedTab[] = []
  const counts = { web: 0, file: 0 }
  for (const item of list) {
    const tab = sanitizeTab(item)
    if (!tab) continue
    if (counts[tab.kind] >= PERSISTED_TAB_CAP) continue
    counts[tab.kind] += 1
    tabs.push(tab)
  }
  return { open, tabs }
}
