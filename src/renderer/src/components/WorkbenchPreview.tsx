import { useCallback, useMemo, useState, type JSX } from 'react'
import { IconFile, IconFiles, IconWebPage } from '../icons'
import { routeFor } from '@shared/browserRoute'
import { basename, dirname } from '@shared/preview'
import { useStore } from '../store'
import { CHANGES_MSG } from './changesModel'
import { splitPath } from './filesModel'
import { useGitChangeSet, useWatchlessRefresh } from './gitChangeSet'
import { FilesTabLabel, useChangeTotals } from './FilesTabLabel'
import { docLanding, previewDocs, type PreviewDoc } from './workbenchPreviewModel'
import '../fileTree.css'

const WATCHLESS_REFRESH_SPARING_SSH_MS = 10_000

function docDir(src: string, root: string | null): string {
  if (root && src.startsWith(root + '/')) return splitPath(src, root).dir.replace(/\/$/, '')
  return basename(dirname(src))
}

function openDoc(tabId: string, doc: PreviewDoc): void {
  const st = useStore.getState()
  const label = basename(doc.src)
  if (docLanding(doc) === 'reading-rendered') st.setOpenFile({ src: doc.src, label }, tabId)
  else {
    const decision = routeFor(doc.src, 'user')
    if (decision.dest === 'browser') {
      st.openWorkbenchTarget(tabId, { url: decision.target, source: 'user' })
    }
  }
}

export function WorkbenchPreview({
  tabId,
  root,
  width
}: {
  tabId: string
  root: string | null
  width: number
}): JSX.Element {
  const session = useStore((s) => s.sessions.find((x) => x.tabId === tabId))
  const baseChoice = useStore((s) => s.changesBase[tabId] ?? 'merge-base')
  const webTabs = useStore((s) => s.workbench[tabId]?.tabs)
  const openFile = useStore((s) => s.openFiles[tabId] ?? null)

  const [refreshNonce, setRefreshNonce] = useState(0)
  const { git, numstat, base, watchDead } = useGitChangeSet(root, true, baseChoice, refreshNonce)
  const refresh = useCallback(() => setRefreshNonce((n) => n + 1), [])
  useWatchlessRefresh(watchDead, session?.updatedAt, WATCHLESS_REFRESH_SPARING_SSH_MS, refresh)

  const totals = useChangeTotals(git, numstat, root, base)
  const docs = useMemo(
    () =>
      previewDocs({
        files: session?.files ?? [],
        verdicts: session?.docVerdicts,
        webTabs: webTabs ?? [],
        openFile
      }),
    [session?.files, session?.docVerdicts, webTabs, openFile]
  )

  return (
    <div className="island wb-peek" style={{ width }}>
      <div className="wb-tabs">
        <div className="wb-pin">
          <span
            className="wb-tab pinned"
            role="button"
            title={totals?.files ? CHANGES_MSG.totals(totals) : 'Open Changes'}
            onClick={() => useStore.getState().openChanges(tabId)}
          >
            <span className="ic">
              <IconFiles size={13} />
            </span>
            <FilesTabLabel totals={totals} />
          </span>
        </div>
        <div className="wb-drag" />
      </div>
      {docs.length > 0 && (
        <div className="cv-list">
          <div className="cv-grp">Docs</div>
          {docs.map((d) => (
            <div
              key={d.src}
              className="ft-node ft-file"
              data-path={d.src}
              title={d.src}
              onClick={() => openDoc(tabId, d)}
            >
              <span className="ft-icon">
                {d.kind === 'page' ? <IconWebPage size={13} /> : <IconFile size={13} />}
              </span>
              <span className="ft-name">{basename(d.src)}</span>
              <span className="wb-peek-dir">{docDir(d.src, root)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
