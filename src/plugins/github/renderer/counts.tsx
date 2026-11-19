import type { JSX, MouseEvent, ReactNode } from 'react'
import { IconIssue, IconPullRequest } from '@renderer/icons'
import { useStore } from '@renderer/store'
import type { WorkspaceRows } from '@shared/types'
import { countLabel, openIssuesLabel, openPullsLabel } from './labels'
import { openWorkspaceList } from './lists'

export const hasGithub = (ws: WorkspaceRows['workspace']): boolean => !!ws.github

export function CountsMark({
  path,
  reachable,
  closeCards
}: {
  path: string
  reachable: boolean
  closeCards: () => void
}): JSX.Element | null {
  const github = useStore(
    (s) => s.workspaceRows.find((r) => r.workspace.path === path)?.workspace.github
  )
  const issues = github?.issues ?? 0
  const prs = github?.prs ?? 0
  if (issues <= 0 && prs <= 0) return null
  const open = (e: MouseEvent, what: 'issues' | 'pulls'): void => {
    e.stopPropagation()
    closeCards()
    openWorkspaceList(path, what)
  }
  return (
    <span className="ws-gh">
      {issues > 0 && (
        <button
          aria-label={openIssuesLabel(issues)}
          disabled={!reachable}
          onClick={(e) => open(e, 'issues')}
        >
          <IconIssue size={12} />
          {countLabel(issues)}
        </button>
      )}
      {prs > 0 && (
        <button
          aria-label={openPullsLabel(prs)}
          disabled={!reachable}
          onClick={(e) => open(e, 'pulls')}
        >
          <IconPullRequest size={12} />
          {countLabel(prs)}
        </button>
      )}
    </span>
  )
}

export function GithubSection({
  ws,
  offline,
  account,
  onClose,
  children
}: {
  ws: WorkspaceRows['workspace']
  offline: boolean
  account: string | undefined
  onClose: () => void
  children: ReactNode
}): JSX.Element | null {
  const github = ws.github
  if (!github) return null
  const openList = (what: 'issues' | 'pulls'): void => {
    onClose()
    openWorkspaceList(ws.path, what)
  }
  return (
    <>
      <div className="tbu-pop-head">
        <span>GitHub · {github.repo}</span>
        {account && <span className="age">as {account}</span>}
      </div>
      <button className="tbu-act" disabled={offline} onClick={() => openList('issues')}>
        <IconIssue size={14} />
        {openIssuesLabel(github.issues)}
      </button>
      <button className="tbu-act" disabled={offline} onClick={() => openList('pulls')}>
        <IconPullRequest size={14} />
        {openPullsLabel(github.prs)}
      </button>
      {children}
    </>
  )
}
