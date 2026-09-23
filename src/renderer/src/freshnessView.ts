import type { WorkspaceFreshness, WorkspacePullSummary } from '@shared/types'
import { ageLabel } from '@shared/freshnessOps'
import { basename } from '@shared/preview'

// Wording for the sidebar's freshness surfaces (workspace-git-pull design)
// §02/§03). Kept out of the component so the badge rules and the popover's one note
// line are judged by tests rather than by reading JSX.

/** Every freshness number the UI shows carries the age of the fetch behind it — a
 *  count with no age reads as fresh when it may be hours old (D10). */
function fetchAge(f: WorkspaceFreshness, now: number): string {
  return f.fetchedAt === null ? 'never' : ageLabel(f.fetchedAt, now)
}

/** The reason Koloft can only explain this checkout, never pull it — decides the grey
 *  badge and is the popover's note. `null` when the shape is one Koloft's write hand
 *  may touch (D5). */
function explainOnly(f: WorkspaceFreshness): string | null {
  if (f.linked)
    return "This workspace is a linked worktree — Koloft only pulls a main checkout's default branch."
  if (!f.onDefault) return `Root is on ${f.branch} — Koloft only pulls the default branch.`
  return null
}

/** The feature's only resident pixel (D5): the count after the head's git mark,
 *  visible solely when the root checkout is measurably behind — amber when Koloft can
 *  fix it, grey when it can only explain. Unknown, synced and ahead-only all draw
 *  nothing; unknown is never "up to date". `name` is the button's accessible name, not
 *  a tooltip: hovering the count opens the card, which says everything a tooltip
 *  could, and a tooltip would land on top of it. */
export function behindBadge(
  f: WorkspaceFreshness | undefined,
  now: number
): { cls: string; label: string; name: string } | null {
  if (!f || f.behind <= 0) return null
  const why = explainOnly(f)
  const measured = `${f.branch} is ${f.behind} commit${f.behind === 1 ? '' : 's'} behind ${
    f.defRef
  } · last fetch ${fetchAge(f, now)}`
  return {
    cls: 'ws-behind' + (why ? ' info' : ''),
    label: `${f.behind}`,
    name: why ? `${measured} · ${why}` : measured
  }
}

/** The C10 picker row's freshness note (§03A/D12: literally `behind n`). Lives here so
 *  badge policy has one home — visibility follows behindBadge's own rule (a count only
 *  when measurably behind). D12 pins the wording WITHOUT the fetch age and WITHOUT the
 *  explain-only distinction the badge name carries; widening the row note to match is
 *  a copy decision recorded for the design owner, not taken here. */
export function pickerBehindNote(f: WorkspaceFreshness | undefined, now: number): string | null {
  return behindBadge(f, now) && f ? `behind ${f.behind}` : null
}

export function headAge(f: WorkspaceFreshness, now: number): string {
  if (f.fetchedAt === null) return 'never fetched'
  // after a failed fetch the counts below are the PREVIOUS ones — say so
  return f.state === 'error' ? `last fetch ${fetchAge(f, now)}` : `fetched ${fetchAge(f, now)}`
}

export interface PullNote {
  text: string
  tone: 'plain' | 'warn' | 'alarm'
  /** a second line, only ever alongside the pullable one: a fast-forward moves the
   *  gitlinks but not the submodule checkouts (§03) */
  extra?: string
}

/** The popover's single note line: why Pull is (un)available, one reason by
 *  precedence — linked → off-default → offline → dirty → diverged → clean (§03 M2). */
export function pullNote(f: WorkspaceFreshness): PullNote {
  const why = explainOnly(f)
  if (why) return { text: why, tone: 'plain' }
  if (f.state === 'error')
    return { text: "can't reach origin — check network or credentials.", tone: 'alarm' }
  if (f.dirty)
    return {
      text: 'Koloft only pulls into a clean tree — commit or discard local changes first.',
      tone: 'warn'
    }
  if (f.ahead > 0)
    return {
      text: `Local commits diverge from ${f.defRef} — merge or rebase outside Koloft.`,
      tone: 'warn'
    }
  const clean: PullNote = { text: 'Working tree clean — fast-forward is safe.', tone: 'plain' }
  return f.hasSubmodules
    ? { ...clean, extra: 'Submodules are not updated by pull — run git submodule update after.' }
    : clean
}

/** The toast is one global slot, so a later repo's success overwrites an earlier
 *  one — the workspace name in front is what keeps it readable. */
export function pullToast(wsPath: string, branch: string, s: WorkspacePullSummary): string {
  return `${basename(wsPath)} · ${branch}: fast-forwarded ${s.count} commit${
    s.count === 1 ? '' : 's'
  } (${s.from} → ${s.to})`
}
