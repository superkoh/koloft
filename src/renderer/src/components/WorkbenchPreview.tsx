import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { LuFileText, LuGlobe, LuListTree } from 'react-icons/lu'
import { routeFor } from '@shared/browserRoute'
import { basename, dirname } from '@shared/preview'
import { parseRemoteKey } from '@shared/remoteKey'
import type { SessionInfo } from '@shared/types'
import { useStore } from '../store'
import { CHANGES_MSG } from './changesModel'
import { useGitChangeSet } from './gitChangeSet'
import { relOf } from './filesModel'
import { changeTotals, docLanding, previewDocs, type PreviewDoc } from './workbenchPreviewModel'

const WATCHLESS_REFRESH_SPARING_SSH_MS = 10_000

function docDir(src: string, root: string | null): string {
  const dir = dirname(src)
  if (root && (dir === root || dir.startsWith(root + '/'))) return relOf(dir, root)
  return basename(parseRemoteKey(dir)?.path ?? dir)
}

function openDoc(tabId: string, doc: PreviewDoc): void {
  const st = useStore.getState()
  const label = basename(doc.src)
  const landing = docLanding(doc)
  if (landing === 'reading-rendered') st.setOpenFile({ src: doc.src, label }, tabId)
  else if (landing === 'reading-source') {
    st.setOpenFile({ src: doc.src, label, view: 'source' }, tabId)
  } else {
    const decision = routeFor(doc.src, 'user')
    if (decision.dest === 'browser') {
      st.openWorkbenchTarget(tabId, { url: decision.target, source: 'user' })
    }
  }
}

export function WorkbenchPreview({
  tabId,
  root,
  session,
  width
}: {
  tabId: string
  root: string | null
  session: SessionInfo | null
  width: number
}): JSX.Element {
  const baseChoice = useStore((s) => s.changesBase[tabId] ?? 'merge-base')
  const webTabs = useStore((s) => s.workbench[tabId]?.tabs)
  const openFile = useStore((s) => s.openFiles[tabId] ?? null)

  const [refreshNonce, setRefreshNonce] = useState(0)
  const { git, numstat, base, watchDead } = useGitChangeSet(root, true, baseChoice, refreshNonce)

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!watchDead || timer.current) return
    timer.current = setTimeout(() => {
      timer.current = null
      setRefreshNonce((n) => n + 1)
    }, WATCHLESS_REFRESH_SPARING_SSH_MS)
  }, [watchDead, session?.updatedAt])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
      timer.current = null
    },
    [root]
  )

  const totals = useMemo(
    () => (root && base ? changeTotals(git, numstat, root) : null),
    [git, numstat, root, base]
  )
  const docs = useMemo(
    () => previewDocs({ files: session?.files ?? [], webTabs: webTabs ?? [], openFile }),
    [session?.files, webTabs, openFile]
  )

  const label = !totals
    ? 'Files'
    : totals.files
      ? `${totals.files} ${totals.files === 1 ? 'file' : 'files'}`
      : 'No changes'

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
              <LuListTree size={13} />
            </span>
            <span className="lb">{label}</span>
            {totals && totals.files > 0 && (
              <span className="ft-delta">
                <span className="add">+{totals.added}</span>
                <span className="del">−{totals.removed}</span>
              </span>
            )}
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
                {d.kind === 'page' ? <LuGlobe size={13} /> : <LuFileText size={13} />}
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
