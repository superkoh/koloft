import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'
import { ageLabel } from '@shared/freshnessOps'
import type { GithubItem, GithubOpenItems } from '@shared/types'
import { issueWorktreeName, type LaunchSeed, type WorktreeItem } from '@renderer/newSession'
import type { IssueLaunch, WorktreeItemsView } from '@renderer/slots'

function itemLabel(item: GithubItem): string {
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
  worktreeName,
  name,
  dir
}: {
  item: GithubItem
  worktreeName: string
  name: string
  dir: string | null
}): JSX.Element {
  const n = `#${item.number}`
  const onBranch = item.branch && name !== worktreeName
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
        // prettier-ignore
        <>
          Create a worktree named <code>{name}</code> on {n}'s branch{' '}
          <code>{item.branch}</code>, fetched from GitHub if it is not here yet, and
        </>
      )}{' '}
      send {n}'s title and link as the first message.
    </>
  )
}

export function worktreeItem(wsPath: string, item: GithubItem): WorktreeItem {
  const label = itemLabel(item)
  const branch = item.branch
  const worktreeName = item.kind === 'issue' ? issueWorktreeName(item.number) : `pr-${item.number}`
  return {
    key: `${item.kind}-${item.number}`,
    label,
    filterText: branch ? `${label} ${branch}` : label,
    note: (now) => (branch ? `branch ${branch}` : ageLabel(Date.parse(item.updatedAt), now)),
    ref: `#${item.number}`,
    worktreeName,
    ...(branch !== undefined && { branch }),
    launch: itemLaunchExtras(item),
    ...(item.kind === 'pr' && {
      makeWorktree: async () => {
        const made = await window.api.github.prWorktree(wsPath, item.number, item.branch ?? '')
        if (!made.ok) throw new Error(made.reason)
        return made.dir
      }
    }),
    hint: (name, dir) => <ItemHint item={item} worktreeName={worktreeName} name={name} dir={dir} />
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
    return [...items.issues, ...items.prs].map((item) => worktreeItem(wsPath, item))
  }, [items, wsPath])

  const box = ({
    loaded,
    row
  }: {
    loaded: boolean
    row: (item: WorktreeItem) => ReactNode
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
        {issues.map(row)}
        {prs.length > 0 && (
          <div className="cb-hd">
            Open pull requests{issues.length > 0 ? '' : ` · ${items.repo}`}
          </div>
        )}
        {prs.map(row)}
      </div>
    )
  }

  return { items: listed, pickWhat: 'issue or PR', box }
}

export const issueLaunch: IssueLaunch = async (wsPath, issue) => {
  const items = await window.api.github.openItems(wsPath).catch(() => null)
  const item = items?.state === 'items' ? items.issues.find((i) => i.number === issue) : undefined
  return item ? itemLaunchExtras(item) : null
}
