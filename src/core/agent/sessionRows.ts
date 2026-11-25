import type { BackendId, BackendSessionRow, DiscoveredFolder, SessionRow } from '@shared/types'
import { sourceOf } from '@shared/sessionBackend'

export interface WorkspacePlace {
  path: string
  realPath: string
  worktreeDirs(): Promise<string[]>
}

export interface RowsNow {
  bindings: Map<string, string>
  running: Set<string>
  hidden(id: string): boolean
}

export interface WorkspaceSessions<Row extends BackendSessionRow = BackendSessionRow> {
  starting: Row[]
  kept: Row[]
  ids: string[]
  hasMore: boolean
}

export interface RowsPassStart {
  everywhere: boolean
  bindings: Map<string, string>
  keptByAnother(id: string): boolean
}

export interface RowsPass {
  in(place: WorkspacePlace, now: () => RowsNow): Promise<WorkspaceSessions>
  done(): Promise<void>
  shown(): void
}

export interface WhereASessionIs {
  dir?: string
  worktree?: string
}

export type WhereNow = (row: BackendSessionRow) => WhereASessionIs

export interface SessionRowsSource {
  rowsReady(): Promise<void>
  rowsPass(start: RowsPassStart): RowsPass
  members(): ReadonlySet<string>
  usedFolders(): Promise<DiscoveredFolder[]>
  whereNow(): WhereNow
  liveKey(): string
}

export interface KeptInLayout {
  list(): readonly string[]
  add(ids: string[]): void
  remove(id: string): void
  keepOnly(ids: string[]): void
}

export function filterOwned<R extends BackendSessionRow>(
  rows: R[],
  owned: ReadonlySet<string>,
  running: ReadonlySet<string>
): R[] {
  return rows.filter((r) => owned.has(r.id) || running.has(r.id))
}

export function hasHistory(
  rows: BackendSessionRow[],
  owned: ReadonlySet<string>,
  running: ReadonlySet<string>
): boolean {
  return rows.some((r) => !owned.has(r.id) && !running.has(r.id))
}

export function keptOrRunning<Row extends BackendSessionRow>(
  rows: Row[],
  members: ReadonlySet<string>,
  now: RowsNow
): WorkspaceSessions<Row> {
  const visible = rows
    .filter((r) => !now.hidden(r.id))
    .map((r) => (!r.running && now.running.has(r.id) ? { ...r, running: true } : r))
  const listed = filterOwned(visible, members, now.running)
  return {
    starting: listed.filter((r) => r.pending),
    kept: listed.filter((r) => !r.pending),
    ids: rows.map((r) => r.id),
    hasMore: hasHistory(visible, members, now.running)
  }
}

export interface RowsOfEveryAgent {
  rowsReady(): Promise<void>
  rowsPass(start: Omit<RowsPassStart, 'keptByAnother'>): {
    in(place: WorkspacePlace, now: () => RowsNow): Promise<WorkspaceSessions<SessionRow>[]>
    done(): Promise<void>
    shown(): void
  }
  members(): Set<string>
  isMember(id: string): boolean
  usedFolders(): Promise<DiscoveredFolder[]>
  whereNow(): (row: SessionRow) => WhereASessionIs
  liveKey(): string
}

const BETWEEN_LIVE_KEYS = '\n'

export function rowsOfEveryAgent(
  agents: () => { id: BackendId; rows: SessionRowsSource }[]
): RowsOfEveryAgent {
  return {
    rowsReady: async () => {
      await Promise.all(agents().map((agent) => agent.rows.rowsReady()))
    },
    rowsPass: (start) => {
      const asked = agents()
      const passes = asked.map((agent) => ({
        id: agent.id,
        pass: agent.rows.rowsPass({
          ...start,
          keptByAnother: (id) =>
            asked.some((other) => other !== agent && other.rows.members().has(id))
        })
      }))
      return {
        in: async (place, now) => {
          const answers: WorkspaceSessions<SessionRow>[] = []
          for (const { id, pass } of passes) {
            const answer = await pass.in(place, now)
            const fromThisAgent = (r: BackendSessionRow): SessionRow => ({
              ...r,
              ...sourceOf(id, place.path)
            })
            answers.push({
              ...answer,
              starting: answer.starting.map(fromThisAgent),
              kept: answer.kept.map(fromThisAgent)
            })
          }
          return answers
        },
        done: async () => {
          for (const { pass } of passes) await pass.done()
        },
        shown: () => {
          for (const { pass } of passes) pass.shown()
        }
      }
    },
    members: () => new Set(agents().flatMap((agent) => [...agent.rows.members()])),
    isMember: (id) => agents().some((agent) => agent.rows.members().has(id)),
    usedFolders: async () =>
      (await Promise.all(agents().map((agent) => agent.rows.usedFolders()))).flat(),
    whereNow: () => {
      const readers = new Map(agents().map((agent) => [agent.id, agent.rows.whereNow()]))
      return (row) => readers.get(row.backendId)?.(row) ?? {}
    },
    liveKey: () =>
      agents()
        .map((agent) => agent.rows.liveKey())
        .join(BETWEEN_LIVE_KEYS)
  }
}
