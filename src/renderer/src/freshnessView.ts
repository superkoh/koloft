import type { WorkspaceFreshness, WorkspacePullSummary } from '@shared/types'
import { ageLabel } from '@shared/freshnessOps'
import { basename } from '@shared/preview'

function fetchAge(f: WorkspaceFreshness, now: number): string {
  return f.fetchedAt === null ? 'never' : ageLabel(f.fetchedAt, now)
}

function explainOnly(f: WorkspaceFreshness): string | null {
  if (f.linked)
    return "This workspace is a linked worktree — Koloft only pulls a main checkout's default branch."
  if (!f.onDefault) return `Root is on ${f.branch} — Koloft only pulls the default branch.`
  return null
}

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

export function pickerBehindNote(f: WorkspaceFreshness | undefined, now: number): string | null {
  return behindBadge(f, now) && f ? `behind ${f.behind}` : null
}

export function headAge(f: WorkspaceFreshness, now: number): string {
  if (f.fetchedAt === null) return 'never fetched'
  return f.state === 'error' ? `last fetch ${fetchAge(f, now)}` : `fetched ${fetchAge(f, now)}`
}

export interface PullNote {
  text: string
  tone: 'plain' | 'warn' | 'alarm'
  extra?: string
}

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

export function pullToast(wsPath: string, branch: string, s: WorkspacePullSummary): string {
  return `${basename(wsPath)} · ${branch}: fast-forwarded ${s.count} commit${
    s.count === 1 ? '' : 's'
  } (${s.from} → ${s.to})`
}
