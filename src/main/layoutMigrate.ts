import type { LayoutV3, LayoutV4, PersistedTab, SessionWorkbenchState } from '@shared/types'
import { DEFAULT_PANEL_OPEN, sanitizeSessionWorkbench } from '@shared/workbenchState'

/**
 * Injected filesystem seam: callers wire the real `fs.existsSync`-style check and
 * `projectInfoFor(p).root`; tests inject fakes. Keeping the module free of direct
 * fs/git access is what makes the migration rules unit-testable in isolation.
 */
export interface MigrateDeps {
  dirExists(p: string): boolean
  projectRootOf(p: string): string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/**
 * v3 and v4 share one shape, so one structural guard serves both, gated on the version.
 * The guard accepts every shape it knows rather than only the current one, and that is
 * the whole point of a version bump.
 *
 * The trap (from the v3 bump): the old guard required `isRecord(raw.aux)`, and anything it
 * did not recognize degraded to the safe EMPTY document. Renaming `aux` → `workbench`
 * without gating on the version would therefore have dropped every existing layout.json
 * into the v1 branch, degraded it to an empty v2, and wiped the user's workspace list.
 * One shape, one guard per version, one converter between them (NFR-06).
 *
 * `workbench` is optional since v4: `defaultOpen` is a knob with a shipped value, so a
 * document that never mentions it is a complete document, not a damaged one.
 */
function isPanelLayout(raw: unknown, version: number): boolean {
  return (
    isRecord(raw) &&
    raw.version === version &&
    Array.isArray(raw.workspaces) &&
    (raw.workbench === undefined || isRecord(raw.workbench)) &&
    isRecord(raw.sessions)
  )
}

function isLayoutV2(raw: unknown): boolean {
  return (
    isRecord(raw) &&
    raw.version === 2 &&
    Array.isArray(raw.workspaces) &&
    isRecord(raw.aux) &&
    isRecord(raw.sessions)
  )
}

/** The one serializer the save path uses; load = JSON.parse + migrateLayout, so
 *  serialize→load round-trips a v4 doc bit-for-bit. */
export function serializeLayout(layout: LayoutV4): string {
  return JSON.stringify(layout, null, 2)
}

// §06: the former global terminal island's `globalTerminal` key is DROPPED here
// rather than carried. It used to ride through unvalidated as "not this feature's data",
// but there is no island any more and nothing will ever read it again — carrying it would
// keep rewriting a dead key into every document the app touches. The version stays 4: the
// shape of everything still read is unchanged, so this is a key going quiet, not a
// migration. A document that still holds it simply loses it on the next write.

/** Only `{path}` survives from a workspace record — an entry that is not a record, or
 *  whose path is not a string, is dropped rather than carried forward as `undefined`. */
function keepWorkspaces(raw: unknown): { path: string }[] {
  if (!Array.isArray(raw)) return []
  const out: { path: string }[] = []
  for (const w of raw) {
    if (isRecord(w) && typeof w.path === 'string' && w.path) out.push({ path: w.path })
  }
  return out
}

/** A v3/v4 document's per-session entries, each through the ONE sanitizer the write path
 *  uses (§Edge: per-item repair, never wholesale rejection). */
function readSessions(doc: Record<string, unknown>, defaultOpen: boolean): LayoutV4['sessions'] {
  const sessions: Record<string, SessionWorkbenchState> = {}
  for (const [id, entry] of Object.entries(doc.sessions as Record<string, unknown>)) {
    sessions[id] = sanitizeSessionWorkbench(entry, defaultOpen)
  }
  return sessions
}

function readDefaultOpen(doc: Record<string, unknown>, fallback: boolean): boolean {
  const wb = doc.workbench
  return isRecord(wb) && typeof wb.defaultOpen === 'boolean' ? wb.defaultOpen : fallback
}

/**
 * v2 → v3, per session. The Browser's tab set converts one by one to `kind:'web'`, order
 * preserved; `unread` has no counterpart and does not migrate — it was never persisted
 * in v2 either (`restoreTabSet` rebuilt every tab with `unread: false`).
 *
 * `auxMode` is deliberately NOT projected onto `open` any more. It was a three-valued
 * mode where `null` meant collapsed, and v2 seeded it from `aux.defaultMode` at every
 * bind — the same seeding v3 did with `open`, and the reason v4 exists. Every v2 document
 * lands collapsed like every v3 one (`startCollapsed`), so a projection here would be
 * computed only to be thrown away.
 */
function sessionV2toV3(entry: unknown): SessionWorkbenchState {
  if (!isRecord(entry)) return { open: false, tabs: [] }
  const browser = entry.browser
  const raw = isRecord(browser) && Array.isArray(browser.tabs) ? browser.tabs : []
  const tabs: PersistedTab[] = []
  for (const t of raw) {
    if (!isRecord(t) || typeof t.url !== 'string' || !t.url) continue
    tabs.push({ kind: 'web', title: typeof t.title === 'string' ? t.title : '', url: t.url })
  }
  // route through the same sanitizer the write path uses: a v2 document is untrusted in
  // exactly the ways a v4 one is, and the cap has to apply on this path too
  return sanitizeSessionWorkbench({ open: false, tabs }, false)
}

/**
 * Everything before v4, brought to v3's shape. The v1 branch is unchanged in substance
 * from the original one-shot: v1 claude tabs contribute only their cwd — merged to the
 * canonical project root (covers worktree and subdir drift), skipped when that root no
 * longer exists, deduped, written alphabetically. Everything else in v1 (shell tabs,
 * titles, activeIndex) is intentionally dropped: sessions re-aggregate from Claude's own
 * storage. Anything unrecognizable degrades to the safe empty document rather than
 * throwing.
 */
function toV3(raw: unknown, deps: MigrateDeps): LayoutV3 {
  if (isPanelLayout(raw, 3)) {
    const doc = raw as Record<string, unknown>
    // the flags are about to be reset, so the fallback for a corrupt one is immaterial
    const defaultOpen = readDefaultOpen(doc, true)
    return {
      version: 3,
      workspaces: keepWorkspaces(doc.workspaces),
      workbench: { defaultOpen },
      sessions: readSessions(doc, defaultOpen)
    }
  }

  if (isLayoutV2(raw)) {
    const doc = raw as Record<string, unknown>
    const sessions: Record<string, SessionWorkbenchState> = {}
    for (const [id, entry] of Object.entries(doc.sessions as Record<string, unknown>)) {
      sessions[id] = sessionV2toV3(entry)
    }
    return {
      version: 3,
      workspaces: keepWorkspaces(doc.workspaces),
      workbench: { defaultOpen: false },
      sessions
    }
  }

  const out: LayoutV3 = {
    version: 3,
    workspaces: [],
    workbench: { defaultOpen: false },
    sessions: {}
  }
  if (!isRecord(raw) || !Array.isArray(raw.tabs)) return out

  const roots = new Set<string>()
  for (const tab of raw.tabs) {
    if (!isRecord(tab) || tab.kind !== 'claude' || typeof tab.cwd !== 'string') continue
    roots.add(deps.projectRootOf(tab.cwd))
    // Decided: the sidebar lists only sessions Koloft drove, and a v1 claude tab
    // IS one — seed its ownership entry or the upgrade would blank the sidebar. An id
    // whose jsonl no longer exists is GC'd on the first rescan (gcSessions).
    if (typeof tab.sessionId === 'string' && tab.sessionId) {
      out.sessions[tab.sessionId] = { open: false, tabs: [] }
    }
  }
  out.workspaces = [...roots]
    .filter((root) => deps.dirExists(root))
    .sort()
    .map((path) => ({ path }))
  return out
}

/**
 * v3 → v4: the ONE thing the bump does — every panel lands collapsed, and the default a
 * never-seen session inherits is the shipped one.
 *
 * Why every entry and not just the default: no build before v4 ever let the user set
 * `defaultOpen`, it shipped as `true`, and `onSessionBound` seeded each session's `open`
 * from it — so a stored `open: true` is indistinguishable from "never touched", and
 * honoring it would keep the panel springing open on every resume, which is the bug this
 * bump fixes. A stored `open: false` WAS the user's collapse, and false stays false. The
 * tab set is the user's work and is carried untouched (FR-29's spirit: a panel's tabs are
 * never dropped by a bookkeeping change).
 */
function startCollapsed(v3: LayoutV3): LayoutV4 {
  const sessions: Record<string, SessionWorkbenchState> = {}
  for (const [id, entry] of Object.entries(v3.sessions)) {
    sessions[id] = { open: false, tabs: entry.tabs }
  }
  return {
    version: 4,
    workspaces: v3.workspaces,
    workbench: { defaultOpen: DEFAULT_PANEL_OPEN },
    sessions
  }
}

/**
 * layout.json migration, run on every read. Idempotent: a well-formed v4 document passes
 * through sanitized (a second cold start of an upgraded document is byte-identical to the
 * first, NFR-06), a v3 or v2 one converts and lands collapsed, a v1 one seeds workspaces
 * and ownership, and anything unrecognizable degrades to the safe empty v4 rather than
 * throwing.
 */
export function migrateLayout(raw: unknown, deps: MigrateDeps): LayoutV4 {
  if (isPanelLayout(raw, 4)) {
    const doc = raw as Record<string, unknown>
    const defaultOpen = readDefaultOpen(doc, DEFAULT_PANEL_OPEN)
    return {
      version: 4,
      workspaces: keepWorkspaces(doc.workspaces),
      workbench: { defaultOpen },
      sessions: readSessions(doc, defaultOpen)
    }
  }
  return startCollapsed(toV3(raw, deps))
}
