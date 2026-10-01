import { fileUrlPath } from '@shared/browserRoute'
import { isWebPagePath, previewKindForPath } from '@shared/preview'
import { isRemoteKey } from '@shared/remoteKey'
import type { GitNumstatMap, GitStatusMap, PreviewItem } from '@shared/types'
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

// CC§2 CC§9
const AGENT_ONLY_PATHS = [
  /\/(CLAUDE|AGENTS|SKILL)\.md$/,
  /\/\.claude\/projects\/[^/]+\/memory\//,
  /\/\.claude\/(skills|agents|commands)\//,
  /\/skills\/[^/]+\/references\//
]

function writtenForTheAgent(src: string): boolean {
  return AGENT_ONLY_PATHS.some((p) => p.test(src))
}

export function previewDocs(input: {
  files: readonly PreviewItem[]
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
    if (f.access === 'wrote' && !writtenForTheAgent(f.src)) note(f.src, f.wroteAt)
  }
  for (const t of input.webTabs) {
    const p = t.kind === 'web' && t.url ? fileUrlPath(t.url) : null
    if (p) note(p, t.agentOpenedAt)
  }
  if (input.openFile) note(input.openFile.src, input.openFile.openedAt)
  return [...latest.values()].sort((a, b) => b.at - a.at)
}

export function docLanding(doc: PreviewDoc): 'reading-rendered' | 'reading-source' | 'web-tab' {
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
