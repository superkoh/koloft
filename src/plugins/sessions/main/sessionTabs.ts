import type { BackendId, CreateTabOptions, SessionInfo } from '@shared/types'
import { PEER_TRAITS, namedAtLaunch } from '@shared/sessionBackend'
import { formatRemoteKey, isRemoteKey } from '@shared/remoteKey'
import type { KoloftAsk } from './dialog'
import type { StepHolder } from './heldSteps'
import { errorText } from '@core/errorText'
import { withHandover } from './handoverPreamble'
import type { StartedSessions } from './startedSessions'

export interface TabPlace {
  workspace: string
  folder: string
  machine?: string
}

export interface BesideSpec {
  role: string
  task: string
  permission: 'bypass' | 'default'
  backend?: BackendId
  model?: CreateTabOptions['model']
  effort?: CreateTabOptions['effort']
  name?: string
}

export type BesideResult = { ok: true; tabId: string } | { ok: false; why: string }

export interface SessionTabs {
  askOf(tabId: string): Promise<KoloftAsk | undefined>
  answer(tabId: string, reply: string, byTheOverseer: boolean): Promise<string | undefined>
  placeOf(tabId: string): TabPlace | undefined
  ownerWordsOf(tabId: string): Promise<string | undefined>
  lookedAt(): string | null
  ownerTypedSince(tabId: string, at: number): boolean
  waitsOnAnother(tabId: string): boolean
  butlerSide(tabId: string): boolean
  markAnswerable(tabId: string, on: boolean): void
  tellAs(tabId: string, opening: string, text: string): Promise<boolean>
  startBeside(tabId: string, spec: BesideSpec): Promise<BesideResult>
  holdSteps(holder: StepHolder): void
  letGo(tabId: string, note?: string): void
  take(tabId: string): void
}

export interface BesideDeps {
  sessionOfTab(tabId: string): SessionInfo | undefined
  launch(options: CreateTabOptions & { kind: BackendId }): Promise<string | null>
  pinnedWorkspaces(): { path: string }[]
  turnedOff(backend: BackendId): string | null
  shownUnder: Pick<StartedSessions, 'started'>
}

export const folderOf = (s: SessionInfo): string =>
  s.remote ? formatRemoteKey(s.remote.host, s.cwd) : s.cwd

// CODEX§17
export const roleAndTask = (
  backend: BackendId,
  role: string,
  task: string
): Pick<CreateTabOptions, 'role' | 'firstPrompt'> =>
  PEER_TRAITS[backend].handoverAsRole
    ? { role, firstPrompt: task }
    : { firstPrompt: withHandover(role, task) }

const inAWorkspace = (folder: string, workspaces: { path: string }[]): boolean =>
  workspaces.some((w) => folder === w.path || folder.startsWith(`${w.path}/`))

export async function startBeside(
  d: BesideDeps,
  tabId: string,
  spec: BesideSpec
): Promise<BesideResult> {
  const beside = d.sessionOfTab(tabId)
  if (!beside?.alive || !beside.sessionId)
    return { ok: false, why: 'There is no open session in that tab' }
  const folder = folderOf(beside)
  const backend = spec.backend ?? beside.backendId
  const off = d.turnedOff(backend)
  if (off) return { ok: false, why: off }
  let why = 'Koloft could not start the session'
  const tab = await d
    .launch({
      kind: backend,
      cwd: folder,
      name: namedAtLaunch(backend, isRemoteKey(folder)) ? spec.name : undefined,
      model: spec.model,
      effort: spec.effort,
      permission: spec.permission,
      // ADR-0026
      trustFolder: inAWorkspace(folder, d.pinnedWorkspaces()),
      ...roleAndTask(backend, spec.role, spec.task)
    })
    .catch((error: unknown) => {
      why = errorText(error)
      return null
    })
  if (!tab) return { ok: false, why }
  d.shownUnder.started(tab, beside.sessionId)
  return { ok: true, tabId: tab }
}
