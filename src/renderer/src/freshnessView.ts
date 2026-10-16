import type {
  GitAccountSuggestion,
  GitClueReason,
  WorkspaceFreshness,
  WorkspaceGitAccount
} from '@shared/types'
import { ageLabel } from '@shared/freshnessOps'

function fetchAge(f: WorkspaceFreshness, now: number): string {
  return f.fetchedAt === null ? 'never' : ageLabel(f.fetchedAt, now)
}

function explainOnly(f: WorkspaceFreshness): string | null {
  if (f.linked)
    return "This workspace is a linked worktree — Koloft only pulls a main checkout's default branch."
  if (!f.onDefault) return `Root is on ${f.branch} — Koloft only pulls the default branch.`
  return null
}

export function countLabel(n: number): string {
  return n < 1000 ? `${n}` : `${Math.floor(n / 100) / 10}k`
}

export function openIssuesLabel(n: number): string {
  return `${n} open issue${n === 1 ? '' : 's'}`
}

export function openPullsLabel(n: number): string {
  return `${n} open pull request${n === 1 ? '' : 's'}`
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

export function pullNote(f: WorkspaceFreshness, machine?: string): PullNote {
  const why = explainOnly(f)
  if (why) return { text: why, tone: 'plain' }
  if (f.state === 'error')
    return {
      text: machine
        ? `can't reach origin from ${machine} — check its network or credentials.`
        : "can't reach origin — check network or credentials.",
      tone: 'alarm'
    }
  if (f.behind === 0) return { text: `Up to date with ${f.defRef}.`, tone: 'plain' }
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

function siteName(host: string): string {
  return host === 'github.com' ? 'GitHub' : host
}

export function clueText(reason: GitClueReason, login: string, host = 'github.com'): string {
  switch (reason) {
    case 'url-user':
      return `The repository address names ${login}`
    case 'config-user':
      return `Git is set to use ${login} for this site`
    case 'gh-user':
      return `Your gh is signed in as ${login}`
    case 'ssh-greeting':
      return `This repository's SSH key belongs to ${login} on ${siteName(host)}`
    case 'commit-email':
      return `Commits here use ${login}'s ${siteName(host)} email`
  }
}

export function suggestionText(s: GitAccountSuggestion): string | null {
  switch (s.kind) {
    case 'off':
    case 'none':
      return null
    case 'use':
    case 'hint':
      return `${clueText(s.reason, s.login, s.host)} — use ${s.login}?`
    case 'add':
      return `This repository was used with ${s.login}, who is not in Koloft yet. Add ${s.login}?`
    case 'cannot-push':
      return `${clueText(s.reason, s.login, s.host)}, but ${s.login} can't push here.`
    case 'only-one-can-push':
      return `Only ${s.login} can push here — use ${s.login}?`
    case 'default-can-push':
      return `Several accounts can push here — use your default, ${s.login}?`
    case 'org-blocked':
      return orgBlockedText(s.org, s.login)
  }
}

export function orgBlockedText(org: string, login: string): string {
  return `${org} only lets apps it has approved reach its repositories. Ask an owner of ${org} to approve GitHub CLI, or use a token for ${login}.`
}

export function authorLine(a: WorkspaceGitAccount): string {
  return a.author
    ? `Commits as ${a.author.name} <${a.author.email}>`
    : 'Commits keep your own name and email'
}
