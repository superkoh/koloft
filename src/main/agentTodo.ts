import type { BackendId, SessionInfo, SessionRow, WorkspaceRows } from '@shared/types'
import { BACKEND_LABEL } from '@shared/sessionBackend'
import { ageLabel } from '@shared/freshnessOps'
import { basename } from '@shared/preview'
import { isRemoteKey, parseRemoteKey } from '@shared/remoteKey'
import { TODO_METHOD } from '@shared/agentGuide'
import {
  answered,
  EXIT_USAGE,
  refused,
  splitAtDashes,
  type AgentReply,
  type AgentVerb
} from './agentRequests'
import { placedRows, resolveWorkspace, workspaceLabel, type PlacedRow } from './agentSessions'
import type { TodoPull, TodoPulls } from './github'
import { mapAtMost } from './mapAtMost'
import { mcpLines, type McpServer } from './mcpServers'

export const TODO_ONLY_FOR_THE_BUTLER =
  'koloft todo: only the butler and the helpers it starts in its own folder can use it.'
const TODO_USAGE =
  'koloft todo: run it alone, or: koloft todo note <workspace> [-- "<note>"] | koloft todo file <workspace> <file>'
const NOTE_USAGE =
  'koloft todo note: give a workspace, and a note after -- to save it, like: koloft todo note koloft -- "To-dos are GitHub issues assigned to me."'
const FILE_USAGE =
  'koloft todo file: give a workspace and one of the files koloft todo listed for it, like: koloft todo file koloft CLAUDE.md'

const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']
const TODO_FILE = /^todo\b/i
const GIT_LOOKUPS_AT_ONCE = 4
const READ_FILE_CHARS = 20_000

export interface WorkspaceFacts {
  path: string
  label: string
  repo: string | null
  lastUsed: number
  remote: boolean
}

export interface TodoVerbDeps {
  allowed(tabId: string): boolean
  sidebar(): WorkspaceRows[]
  sessions(): SessionInfo[]
  asking(tabId: string): boolean
  workLeft(row: SessionRow, workspace: string, tabId?: string): Promise<string[]>
  branches(workspace: string): Promise<{ dir: string; branch?: string }[]>
  repoOf(workspace: string): Promise<string | null>
  pulls(workspace: string): Promise<TodoPulls | null>
  notes(): Record<string, string>
  saveNote(key: string, text: string): void
  listFiles(workspace: string): Promise<string[]>
  readFile(workspace: string, name: string): Promise<string>
  servers(): Promise<McpServer[]>
  butlerFolder(): string
  now(): number
}

interface Candidate {
  placed: PlacedRow
  branch?: string
  left: string[]
}

type SessionGroup = 'asking' | 'turnDone' | 'workLeft' | 'closed'

const GROUP_TITLES: Record<SessionGroup, string> = {
  asking: 'Asking the owner a question',
  turnDone: 'Open, finished its turn',
  workLeft: 'Closed, with work left in its worktree',
  closed: 'Closed, nothing left in a worktree (ask about these as one batch)'
}

function groupOf(c: Candidate, asking: (tabId: string) => boolean): SessionGroup | null {
  const live = c.placed.live
  if (live) {
    if (asking(live.tabId) || live.status === 'approval') return 'asking'
    return live.status === 'working' ? null : 'turnDone'
  }
  if (c.placed.row.running) return null
  return c.left.length ? 'workLeft' : 'closed'
}

export function leftSummary(left: string[]): string {
  return left
    .map((block) => {
      const [head, ...items] = block.split('\n')
      return items.length ? `${head.replace(/:$/, '')}: ${items.length}` : head
    })
    .join('; ')
}

function pullFacts(p: TodoPull, me: string | null, now: number): string {
  const whose = [
    me && p.author === me ? 'opened by the owner' : `opened by ${p.author || 'someone'}`,
    ...(me && p.reviewers.includes(me) ? ['asks the owner to review'] : [])
  ]
  return [
    `#${p.number} "${p.title}"`,
    ...whose,
    ...(p.draft ? ['draft'] : []),
    `checks: ${p.checks}`,
    `${p.files} file${p.files === 1 ? '' : 's'} changed`,
    `open ${ageLabel(Date.parse(p.openedAt) || now, now).replace(/ ago$/, '')}`,
    ...(p.closes.length ? [`closes ${p.closes.map((n) => `#${n}`).join(', ')}`] : [])
  ].join(' · ')
}

function isOwners(p: TodoPull, me: string | null): boolean {
  return !!me && (p.author === me || p.reviewers.includes(me))
}

export function sessionLine(c: Candidate, pulls: string[], now: number): string {
  const { placed } = c
  const { row } = placed
  return [
    `"${placed.title}"`,
    BACKEND_LABEL[row.backendId],
    placed.shownAs,
    parseRemoteKey(placed.workspace)?.host ?? 'local',
    `last active ${ageLabel(row.mtime, now)}`,
    `id: ${row.nativeSessionId ?? row.id}`,
    ...(c.branch ? [`branch: ${c.branch}`] : []),
    ...(c.left.length ? [leftSummary(c.left)] : []),
    ...pulls
  ].join(' · ')
}

export interface PullsOfRepo {
  repo: string
  pulls: TodoPulls
}

export function pullSection(
  repos: PullsOfRepo[],
  bySession: Map<string, string>,
  now: number
): string[] {
  return repos.flatMap(({ repo, pulls }) => {
    if (pulls.state === 'failed') return [`${repo}: Koloft could not list its pull requests: ${pulls.why}`]
    const { me, closesUnknown } = pulls
    const free = pulls.pulls.filter((p) => !bySession.has(`${repo}#${p.number}`))
    const owners = free.filter((p) => isOwners(p, me))
    const others = free.filter((p) => !isOwners(p, me))
    const closing = pulls.pulls.filter((p) => p.closes.length)
    return [
      `${repo} (the owner is ${me ?? 'unknown'} on GitHub here; ${pulls.pulls.length} open):`,
      ...(owners.length
        ? owners.map((p) => `- ${pullFacts(p, me, now)}`)
        : ['- none opened by the owner or asking the owner to review, outside a session']),
      ...(others.length
        ? [
            `- other open pull requests, not tied to a session: ${others.map((p) => `#${p.number}`).join(', ')} (list them with koloft gh pr list --repo ${repo} if the to-do note counts them)`
          ]
        : []),
      closesUnknown
        ? `- which issues a pull request closes: the gh that lists them is too old to tell.`
        : closing.length
          ? `- issues an open pull request says it closes: ${closing.map((p) => `${p.closes.map((n) => `#${n}`).join(', ')} (#${p.number})`).join('; ')}`
          : '- no open pull request says it closes an issue.'
    ]
  })
}

function workspaceLine(w: WorkspaceFacts, notes: Record<string, string>, files: string[], now: number): string {
  const key = w.repo ?? w.path
  const note = notes[key]
  return [
    basename(w.path),
    w.label,
    w.repo ? `GitHub ${w.repo}` : 'no GitHub repository',
    w.lastUsed ? `last used ${ageLabel(w.lastUsed, now)}` : 'no sessions yet',
    note === undefined
      ? 'no to-do note yet'
      : `to-do note${w.repo ? ` (for every workspace of ${w.repo})` : ''}: ${JSON.stringify(note)}`,
    ...(note === undefined && files.length ? [`files: ${files.join(', ')}`] : [])
  ].join(' · ')
}

export function pickProjectFiles(names: string[]): string[] {
  return names.filter((n) => INSTRUCTION_FILES.includes(n) || TODO_FILE.test(n))
}

async function gather(d: TodoVerbDeps, me: BackendId): Promise<string> {
  const now = d.now()
  const sidebar = d.sidebar().filter((w) => !w.workspace.butler)
  const all = placedRows(sidebar, d.sessions())
  const workspaces = await Promise.all(
    sidebar.map(async ({ workspace, rows }) => ({
      path: workspace.path,
      label: workspaceLabel(workspace.path),
      repo: workspace.missing ? null : await d.repoOf(workspace.path).catch(() => null),
      lastUsed: Math.max(0, ...rows.map((r) => r.mtime)),
      remote: isRemoteKey(workspace.path)
    }))
  )
  const notes = d.notes()
  const [files, branches, servers] = await Promise.all([
    Promise.all(
      workspaces.map((w) =>
        notes[w.repo ?? w.path] === undefined
          ? d.listFiles(w.path).then(pickProjectFiles, () => [])
          : Promise.resolve([])
      )
    ),
    Promise.all(workspaces.map((w) => d.branches(w.path).catch(() => []))),
    d.servers().catch(() => [])
  ])
  const branchOf = (p: PlacedRow): string | undefined => {
    const trees = branches[workspaces.findIndex((w) => w.path === p.workspace)] ?? []
    return trees.find((t) => t.dir === p.row.cwd)?.branch
  }
  const candidates: Candidate[] = await mapAtMost(all, GIT_LOOKUPS_AT_ONCE, async (placed) => ({
    placed,
    branch: branchOf(placed),
    left: isRemoteKey(placed.workspace)
      ? []
      : await d.workLeft(placed.row, placed.workspace, placed.live?.tabId).catch(() => [])
  }))
  const repos = [...new Set(workspaces.flatMap((w) => (w.repo ? [w.repo] : [])))]
  const pulled = await Promise.all(
    repos.map(async (repo) => {
      const ws = workspaces.find((w) => w.repo === repo && !w.remote) ??
        workspaces.find((w) => w.repo === repo)
      const pulls = ws ? await d.pulls(ws.path).catch(() => null) : null
      return pulls && { repo, pulls }
    })
  )
  const pullsOf = pulled.filter((p): p is PullsOfRepo => !!p)
  const bySession = new Map<string, string>()
  const sessionPulls = (c: Candidate): string[] => {
    const repo = workspaces.find((w) => w.path === c.placed.workspace)?.repo
    const found = pullsOf.find((p) => p.repo === repo)?.pulls
    if (!c.branch || found?.state !== 'ok') return []
    return found.pulls
      .filter((p) => p.branch === c.branch)
      .map((p) => {
        bySession.set(`${repo}#${p.number}`, c.placed.title)
        return `its pull request: ${pullFacts(p, found.me, now)}`
      })
  }
  const groups = new Map<SessionGroup, string[]>()
  for (const c of candidates) {
    const pulls = sessionPulls(c)
    const group = groupOf(c, d.asking)
    if (group) groups.set(group, [...(groups.get(group) ?? []), `- ${sessionLine(c, pulls, now)}`])
  }
  const sessionPart = (Object.keys(GROUP_TITLES) as SessionGroup[]).flatMap((g) =>
    groups.has(g) ? [`${GROUP_TITLES[g]}:`, ...(groups.get(g) ?? [])] : []
  )
  return [
    TODO_METHOD,
    '',
    'WORKSPACES',
    '',
    ...workspaces.map((w, i) => workspaceLine(w, notes, files[i], now)),
    '',
    'SESSIONS (every workspace; the butler and its helpers left out; working sessions left out; a session on another machine shows no work left, which Koloft cannot check there)',
    '',
    ...(sessionPart.length ? sessionPart : ['None.']),
    '',
    'PULL REQUESTS (a pull request whose branch is an open worktree session\'s is listed with that session above)',
    '',
    ...(pullsOf.length ? pullSection(pullsOf, bySession, now) : ['No workspace is on GitHub.']),
    '',
    'TOOLS SET UP FOR THE AGENTS (MCP servers; to-do tools such as Linear or Jira are among them)',
    '',
    ...mcpLines(servers, me, d.butlerFolder())
  ].join('\n')
}

async function noteVerb(d: TodoVerbDeps, rest: string[]): Promise<AgentReply> {
  const { before, after } = splitAtDashes(rest)
  if (before.length !== 1) return refused(NOTE_USAGE, EXIT_USAGE)
  const found = resolveWorkspace(before[0], pinnedOf(d))
  if (!found.ok) return refused(`koloft todo note: ${found.error}`)
  const repo = await d.repoOf(found.value.path).catch(() => null)
  const key = repo ?? found.value.path
  const what = repo ? `repository ${repo}` : `workspace ${workspaceLabel(found.value.path)}`
  if (!rest.includes('--')) {
    const note = d.notes()[key]
    return answered(note === undefined ? `The ${what} has no to-do note yet.` : note)
  }
  d.saveNote(key, after)
  return answered(after ? `Saved the to-do note of the ${what}.` : `Removed the to-do note of the ${what}.`)
}

function pinnedOf(d: TodoVerbDeps): { path: string; missing: boolean }[] {
  return d
    .sidebar()
    .filter((w) => !w.workspace.butler)
    .map((w) => ({ path: w.workspace.path, missing: w.workspace.missing }))
}

async function fileVerb(d: TodoVerbDeps, rest: string[]): Promise<AgentReply> {
  if (rest.length !== 2) return refused(FILE_USAGE, EXIT_USAGE)
  const found = resolveWorkspace(rest[0], pinnedOf(d))
  if (!found.ok) return refused(`koloft todo file: ${found.error}`)
  const files = pickProjectFiles(await d.listFiles(found.value.path))
  if (!files.includes(rest[1]))
    return refused(
      `koloft todo file: ${rest[1]} is not one of the files koloft todo reads there${files.length ? ` (${files.join(', ')})` : ''}.`
    )
  const text = await d.readFile(found.value.path, rest[1])
  return answered(
    text.length <= READ_FILE_CHARS
      ? text
      : `${text.slice(0, READ_FILE_CHARS)}\n[koloft: cut at ${READ_FILE_CHARS} characters]`
  )
}

export function todoVerb(d: TodoVerbDeps): AgentVerb {
  return async (args, caller) => {
    if (!d.allowed(caller.tabId)) return refused(TODO_ONLY_FOR_THE_BUTLER)
    const [sub, ...rest] = args
    if (sub === undefined) return answered(await gather(d, caller.session.backendId))
    if (sub === 'note') return noteVerb(d, rest)
    if (sub === 'file') return fileVerb(d, rest)
    return refused(TODO_USAGE, EXIT_USAGE)
  }
}
