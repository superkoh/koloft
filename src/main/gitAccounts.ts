import type { GitAccount, GitMachine, GitRepoPick, GitSshKeyState } from '@shared/types'
import { withOneDefaultPerHost } from '@shared/gitAccountOps'
import { loadSettings, saveSettings } from './settings'

function scopeOf(machine: string | undefined): GitMachine {
  const s = loadSettings()
  if (machine) return s.gitMachines[machine] ?? { accounts: [], picks: [], dismissed: [] }
  return { accounts: s.gitAccounts, picks: s.gitPicks, dismissed: s.gitSuggestionsDismissed }
}

function saveScope(machine: string | undefined, patch: Partial<GitMachine>): void {
  if (machine) {
    const all = loadSettings().gitMachines
    saveSettings({ gitMachines: { ...all, [machine]: { ...scopeOf(machine), ...patch } } })
    return
  }
  saveSettings({
    ...(patch.accounts && { gitAccounts: patch.accounts }),
    ...(patch.picks && { gitPicks: patch.picks }),
    ...(patch.dismissed && { gitSuggestionsDismissed: patch.dismissed })
  })
}

export function gitMachineNames(): string[] {
  return Object.keys(loadSettings().gitMachines)
}

export function listGitAccounts(machine?: string): GitAccount[] {
  return scopeOf(machine).accounts
}

export function findGitAccount(id: string, machine?: string): GitAccount | undefined {
  return listGitAccounts(machine).find((a) => a.id === id)
}

export function upsertGitAccount(a: GitAccount, machine?: string): void {
  const current = listGitAccounts(machine)
  const at = current.findIndex((o) => o.id === a.id)
  const next = [...current]
  if (at >= 0) next[at] = { ...a, default: current[at].default }
  else next.push({ ...a, default: !current.some((o) => o.host === a.host) })
  saveScope(machine, { accounts: next })
}

export function removeGitAccount(id: string, machine?: string): void {
  const accounts = listGitAccounts(machine)
  const gone = accounts.find((a) => a.id === id)
  if (!gone) return
  let rest = accounts.filter((a) => a !== gone)
  const sameHost = rest.filter((a) => a.host === gone.host)
  if (gone.default && sameHost.length) {
    const oldest = sameHost.reduce((o, a) => (a.addedAt < o.addedAt ? a : o))
    rest = rest.map((a) => (a === oldest ? { ...a, default: true } : a))
  }
  const picks = listGitPicks(machine)
  saveScope(machine, { accounts: rest, picks: picks.filter((p) => p.account !== id) })
}

export function setDefaultGitAccount(id: string, machine?: string): void {
  const accounts = listGitAccounts(machine)
  const chosen = accounts.find((a) => a.id === id)
  if (!chosen) return
  saveScope(machine, {
    accounts: withOneDefaultPerHost(
      accounts.map((a) => (a.host === chosen.host ? { ...a, default: a === chosen } : a))
    )
  })
}

export function listGitPicks(machine?: string): GitRepoPick[] {
  return scopeOf(machine).picks
}

export function setGitPick(repoKey: string, id: string | null, machine?: string): void {
  const rest = listGitPicks(machine).filter((p) => p.repo !== repoKey)
  if (id !== null && !findGitAccount(id, machine)) return
  saveScope(machine, { picks: id === null ? rest : [...rest, { repo: repoKey, account: id }] })
}

export function setGitPickSshKey(repoKey: string, sshKey: GitSshKeyState): void {
  saveSettings({
    gitPicks: listGitPicks().map((p) => (p.repo === repoKey ? { ...p, sshKey } : p))
  })
}

export function dismissSuggestion(repoKey: string, machine?: string): void {
  if (suggestionDismissed(repoKey, machine)) return
  saveScope(machine, { dismissed: [...scopeOf(machine).dismissed, repoKey] })
}

export function suggestionDismissed(repoKey: string, machine?: string): boolean {
  return scopeOf(machine).dismissed.includes(repoKey)
}
