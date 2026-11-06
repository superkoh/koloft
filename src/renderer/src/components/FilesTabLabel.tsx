import { useMemo, type JSX } from 'react'
import type { GitNumstatMap, GitStatusMap } from '@shared/types'
import type { ChangeTotals } from './changesModel'
import { changeTotals } from './workbenchPreviewModel'
import '../fileTree.css'

export function useChangeTotals(
  git: GitStatusMap,
  numstat: GitNumstatMap,
  root: string | null,
  base: string | null | undefined
): ChangeTotals | null {
  return useMemo(
    () => (root && base ? changeTotals(git, numstat, root) : null),
    [git, numstat, root, base]
  )
}

export function FilesTabLabel({ totals }: { totals: ChangeTotals | null }): JSX.Element {
  const label = !totals
    ? 'Files'
    : totals.files
      ? `${totals.files} ${totals.files === 1 ? 'file' : 'files'}`
      : 'No changes'
  return (
    <>
      <span className="lb">{label}</span>
      {totals && totals.files > 0 && (
        <span className="ft-delta">
          <span className="add">+{totals.added}</span>
          <span className="del">−{totals.removed}</span>
        </span>
      )}
    </>
  )
}
