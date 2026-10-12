import type { GitAccount, GitRepoPick } from '@shared/types'
import { loadSettings, saveSettings } from './settings'

function sameLogin(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

export function listGitAccounts(): GitAccount[] {
  return loadSettings().gitAccounts
}

export function findGitAccount(login: string): GitAccount | undefined {
  return listGitAccounts().find((a) => sameLogin(a.login, login))
}

export function upsertGitAccount(a: GitAccount): void {
  const current = listGitAccounts()
  const at = current.findIndex((o) => sameLogin(o.login, a.login))
  const next = [...current]
  if (at >= 0) next[at] = { ...a, default: current[at].default }
  else next.push({ ...a, default: current.length === 0 })
  saveSettings({ gitAccounts: next })
}

export function removeGitAccount(login: string): void {
  const accounts = listGitAccounts()
  const gone = accounts.find((a) => sameLogin(a.login, login))
  if (!gone) return
  let rest = accounts.filter((a) => a !== gone)
  if (gone.default && rest.length) {
    const oldest = rest.reduce((o, a) => (a.addedAt < o.addedAt ? a : o))
    rest = rest.map((a) => ({ ...a, default: a === oldest }))
  }
  const picks = listGitPicks()
  saveSettings({ gitAccounts: rest, gitPicks: picks.filter((p) => !sameLogin(p.login, login)) })
}

export function setDefaultGitAccount(login: string): void {
  const accounts = listGitAccounts()
  if (!accounts.some((a) => sameLogin(a.login, login))) return
  saveSettings({ gitAccounts: accounts.map((a) => ({ ...a, default: sameLogin(a.login, login) })) })
}

export function listGitPicks(): GitRepoPick[] {
  return loadSettings().gitPicks
}

export function setGitPick(repoKey: string, login: string | null): void {
  const rest = listGitPicks().filter((p) => p.repo !== repoKey)
  const account = login === null ? undefined : findGitAccount(login)
  if (login !== null && !account) return
  saveSettings({
    gitPicks: account
      ? [...rest, { repo: repoKey, host: account.host, login: account.login }]
      : rest
  })
}

export function dismissSuggestion(repoKey: string): void {
  if (suggestionDismissed(repoKey)) return
  saveSettings({ gitSuggestionsDismissed: [...loadSettings().gitSuggestionsDismissed, repoKey] })
}

export function suggestionDismissed(repoKey: string): boolean {
  return loadSettings().gitSuggestionsDismissed.includes(repoKey)
}
