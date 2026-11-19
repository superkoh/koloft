import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { ageLabel } from '@shared/freshnessOps'
import type { GithubItem, GithubOpenItems } from '@shared/types'
import { issueWorktreeName, type LaunchSeed, type WorktreeItem } from '@renderer/newSession'
import type { IssueLaunch, WorktreeItemsView } from '@renderer/slots'

const ITEMS_PLACEHOLDER = 'name a new worktree, or pick a worktree, issue or PR below…'

export function itemLabel(item: GithubItem): string {
  return `#${item.number} ${item.title}`
}

export function itemLaunchExtras(item: GithubItem): LaunchSeed {
  const [what, view] =
    item.kind === 'pr' ? ['pull request', 'gh pr view'] : ['issue', 'gh issue view']
  const firstPrompt = `${itemLabel(item)}\n${item.url}\n\nRead this ${what} and its comments yourself (${view} ${item.number} --comments), then work on it.`
  return { firstPrompt, name: itemLabel(item), trustFolder: true }
}

function ItemHint({
  item,
  name,
  dir
}: {
  item: GithubItem
  name: string
  dir: string | null
}): JSX.Element {
  const n = `#${item.number}`
  const onBranch = item.branch && name !== `pr-${item.number}`
  return (
    <>
      {dir ? (
        <>
          Open the worktree <code>{name}</code>
          {onBranch && (
            <>
              {' '}
              — it is already on {n}'s branch <code>{item.branch}</code> —
            </>
          )}{' '}
          and
        </>
      ) : item.kind === 'issue' ? (
        <>
          Create a worktree named <code>{name}</code> from the repo root, and
        </>
      ) : (
        <>
          Create a worktree named <code>{name}</code> on {n}'s branch{' '}
          <code>{item.branch}</code>, fetched from GitHub if it is not here yet, and
        </>
      )}{' '}
      send {n}'s title and link as the first message.
    </>
  )
}

export function worktreeItem(wsPath: string, item: GithubItem, now: number): WorktreeItem {
  const label = itemLabel(item)
  return {
    key: `${item.kind}-${item.number}`,
    label,
    filterText: item.branch ? `${label} ${item.branch}` : label,
    note: item.branch ? `branch ${item.branch}` : ageLabel(Date.parse(item.updatedAt), now),
    ref: `#${item.number}`,
    worktreeName: item.kind === 'issue' ? issueWorktreeName(item.number) : `pr-${item.number}`,
    ...(item.branch !== undefined && { branch: item.branch }),
    fromRepoRoot: item.kind === 'issue',
    launch: itemLaunchExtras(item),
    ...(item.kind === 'pr' && {
      makeWorktree: async () => {
        const made = await window.api.github.prWorktree(wsPath, item.number, item.branch ?? '')
        if (!made.ok) throw new Error(made.reason)
        return made.dir
      }
    }),
    hint: (name, dir) => <ItemHint item={item} name={name} dir={dir} />
  }
}

export function useWorktreeItems(wsPath: string, isGit: boolean): WorktreeItemsView {
  const [items, setItems] = useState<GithubOpenItems | null>(null)

  useEffect(() => {
    if (!isGit) return
    let live = true
    void window.api.github.openItems(wsPath).then(
      (r) => {
        if (live) setItems(r)
      },
      () => {
        if (live) setItems({ state: 'failed' })
      }
    )
    return () => {
      live = false
    }
  }, [wsPath, isGit])

  const listed = useMemo(() => {
    if (items?.state !== 'items') return []
    const now = Date.now()
    return [...items.issues, ...items.prs].map((item) => worktreeItem(wsPath, item, now))
  }, [items, wsPath])

  const box = useCallback(
    ({
      loaded,
      first,
      row
    }: {
      loaded: boolean
      first: number
      row: (index: number, item: WorktreeItem) => ReactNode
    }): ReactNode => {
      if (!isGit || items?.state === 'no-repo') return null
      if (!items || !loaded) return <p className="field-hint">Loading issues and pull requests…</p>
      if (items.state !== 'items')
        return (
          <p className="field-hint">
            {items.state === 'no-gh' ? (
              <>
                No issue or PR list — <code>gh</code> is not installed on this Mac.
              </>
            ) : items.state === 'signed-out' ? (
              <>
                No issue or PR list — run <code>gh auth login</code> on this Mac.
              </>
            ) : (
              'Could not load issues and pull requests from GitHub.'
            )}
          </p>
        )
      if (listed.length === 0)
        return <p className="field-hint">No open issues or pull requests in {items.repo}.</p>
      const issues = listed.slice(0, items.issues.length)
      const prs = listed.slice(items.issues.length)
      return (
        <div className="wt-list gh-items">
          {issues.length > 0 && <div className="cb-hd">Open issues · {items.repo}</div>}
          {issues.map((item, j) => row(first + j, item))}
          {prs.length > 0 && (
            <div className="cb-hd">
              Open pull requests{issues.length > 0 ? '' : ` · ${items.repo}`}
            </div>
          )}
          {prs.map((item, j) => row(first + issues.length + j, item))}
        </div>
      )
    },
    [isGit, items, listed]
  )

  return { items: listed, placeholder: ITEMS_PLACEHOLDER, box }
}

export const issueLaunch: IssueLaunch = async (wsPath, issue) => {
  const items = await window.api.github.openItems(wsPath).catch(() => null)
  const item =
    items?.state === 'items'
      ? items.issues.find((i) => i.kind === 'issue' && i.number === issue)
      : undefined
  return item ? itemLaunchExtras(item) : null
}
