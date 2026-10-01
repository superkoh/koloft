import { isWebPagePath, previewKindForPath } from '@shared/preview'
import { isRemoteKey } from '@shared/remoteKey'
import type { GitNumstatMap, GitStatusMap, PreviewItem } from '@shared/types'
import { buildEntries, totalDelta, type ChangeTotals } from './changesModel'
import type { WorkbenchTab } from './workbenchTabs'

export type PreviewDocKind = 'markdown' | 'page'

export interface PreviewDoc {
  src: string
  kind: PreviewDocKind
  at: number
}

export interface AgentOpenedFile {
  src: string
  source?: 'intercept'
  openedAt?: number
}

export function previewDocKind(src: string): PreviewDocKind | null {
  if (previewKindForPath(src) === 'markdown') return 'markdown'
  return isWebPagePath(src) ? 'page' : null
}

function fileUrlPath(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'file:' ? decodeURIComponent(u.pathname) : null
  } catch {
    return null
  }
}

export function previewDocs(input: {
  files: readonly PreviewItem[]
  webTabs: readonly WorkbenchTab[]
  openFile: AgentOpenedFile | null
}): PreviewDoc[] {
  const latest = new Map<string, number>()
  const note = (src: string, at: number): void => {
    if (!previewDocKind(src)) return
    latest.set(src, Math.max(latest.get(src) ?? 0, at))
  }
  for (const f of input.files) if (f.access === 'wrote') note(f.src, f.wroteAt ?? 0)
  for (const t of input.webTabs) {
    if (t.kind !== 'web' || !t.openedByAgent || !t.url) continue
    const p = fileUrlPath(t.url)
    if (p) note(p, t.agentOpenedAt ?? 0)
  }
  const of = input.openFile
  if (of?.source === 'intercept') note(of.src, of.openedAt ?? 0)
  return [...latest]
    .map(([src, at]) => ({ src, kind: previewDocKind(src) as PreviewDocKind, at }))
    .sort((a, b) => b.at - a.at)
}

export type DocLanding = 'reading-rendered' | 'reading-source' | 'web-tab'

export function docLanding(doc: PreviewDoc): DocLanding {
  if (doc.kind === 'markdown') return 'reading-rendered'
  return isRemoteKey(doc.src) ? 'reading-source' : 'web-tab'
}

export function changeTotals(
  git: GitStatusMap,
  numstat: GitNumstatMap,
  root: string
): ChangeTotals {
  return totalDelta(buildEntries({ git, numstat, root, written: new Set(), sections: {} }))
}
