import { pagePathOf } from '@shared/browserRoute'
import { isWebPagePath, previewKindForPath, writtenForTheAgent } from '@shared/preview'
import type { DocVerdict, GitNumstatMap, GitStatusMap, PreviewItem } from '@shared/types'
import type { OpenFile } from '../store'
import { buildEntries, totalDelta, type ChangeTotals } from './changesModel'
import type { WorkbenchTab } from './workbenchTabs'

type PreviewDocKind = 'markdown' | 'page'

export interface PreviewDoc {
  src: string
  kind: PreviewDocKind
  at: number
}

function previewDocKind(src: string): PreviewDocKind | null {
  if (previewKindForPath(src) === 'markdown') return 'markdown'
  return isWebPagePath(src) ? 'page' : null
}

export function previewDocs(input: {
  files: readonly PreviewItem[]
  verdicts?: Readonly<Record<string, DocVerdict>>
  webTabs: readonly WorkbenchTab[]
  openFile: Pick<OpenFile, 'src' | 'openedAt'> | null
}): PreviewDoc[] {
  const latest = new Map<string, PreviewDoc>()
  const note = (src: string, at: number | undefined): void => {
    const kind = previewDocKind(src)
    if (!kind || at === undefined) return
    if (at > (latest.get(src)?.at ?? -1)) latest.set(src, { src, kind, at })
  }
  for (const f of input.files) {
    if (f.access !== 'wrote' || writtenForTheAgent(f.src)) continue
    if (input.verdicts?.[f.src]?.show !== false) note(f.src, f.wroteAt)
  }
  for (const [src, v] of Object.entries(input.verdicts ?? {})) {
    if (v.show && !latest.has(src)) note(src, v.at)
  }
  for (const t of input.webTabs) {
    const p = t.kind === 'web' && t.url ? pagePathOf(t.url) : null
    if (p) note(p, t.agentOpenedAt)
  }
  if (input.openFile) note(input.openFile.src, input.openFile.openedAt)
  return [...latest.values()].sort((a, b) => b.at - a.at)
}

export function docLanding(doc: PreviewDoc): 'reading-rendered' | 'web-tab' {
  return doc.kind === 'markdown' ? 'reading-rendered' : 'web-tab'
}

export function changeTotals(
  git: GitStatusMap,
  numstat: GitNumstatMap,
  root: string
): ChangeTotals {
  return totalDelta(buildEntries({ git, numstat, root, written: new Set(), sections: {} }))
}
