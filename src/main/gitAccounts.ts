import type { GitAccount, GitRepoPick, GitSshKeyState } from '@shared/types'
import { withOneDefaultPerHost } from '@shared/gitAccountOps'
import { loadSettings, saveSettings } from './settings'

export function listGitAccounts(): GitAccount[] {
  return loadSettings().gitAccounts
}

export function findGitAccount(id: string): GitAccount | undefined {
  return listGitAccounts().find((a) => a.id === id)
}

export function upsertGitAccount(a: GitAccount): void {
  const current = listGitAccounts()
  const at = current.findIndex((o) => o.id === a.id)
  const next = [...current]
  if (at >= 0) next[at] = { ...a, default: current[at].default }
  else next.push({ ...a, default: !current.some((o) => o.host === a.host) })
  saveSettings({ gitAccounts: next })
}

export function removeGitAccount(id: string): void {
  const accounts = listGitAccounts()
  const gone = accounts.find((a) => a.id === id)
  if (!gone) return
  let rest = accounts.filter((a) => a !== gone)
  const sameHost = rest.filter((a) => a.host === gone.host)
  if (gone.default && sameHost.length) {
    const oldest = sameHost.reduce((o, a) => (a.addedAt < o.addedAt ? a : o))
    rest = rest.map((a) => (a === oldest ? { ...a, default: true } : a))
  }
  const picks = listGitPicks()
  saveSettings({ gitAccounts: rest, gitPicks: picks.filter((p) => p.account !== id) })
}

export function setDefaultGitAccount(id: string): void {
  const accounts = listGitAccounts()
  const chosen = accounts.find((a) => a.id === id)
  if (!chosen) return
  saveSettings({
    gitAccounts: withOneDefaultPerHost(
      accounts.map((a) => (a.host === chosen.host ? { ...a, default: a === chosen } : a))
    )
  })
}

export function listGitPicks(): GitRepoPick[] {
  return loadSettings().gitPicks
}

export function setGitPick(repoKey: string, id: string | null): void {
  const rest = listGitPicks().filter((p) => p.repo !== repoKey)
  if (id !== null && !findGitAccount(id)) return
  saveSettings({ gitPicks: id === null ? rest : [...rest, { repo: repoKey, account: id }] })
}

export function setGitPickSshKey(repoKey: string, sshKey: GitSshKeyState): void {
  saveSettings({
    gitPicks: listGitPicks().map((p) => (p.repo === repoKey ? { ...p, sshKey } : p))
  })
}

export function dismissSuggestion(repoKey: string): void {
  if (suggestionDismissed(repoKey)) return
  saveSettings({ gitSuggestionsDismissed: [...loadSettings().gitSuggestionsDismissed, repoKey] })
}

export function suggestionDismissed(repoKey: string): boolean {
  return loadSettings().gitSuggestionsDismissed.includes(repoKey)
}
