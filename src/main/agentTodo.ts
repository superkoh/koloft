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
import { cutForATurn } from './agentGithub'
import {
  placedRows,
  resolveWorkspace,
  workspaceLabel,
  type PinnedWorkspace,
  type PlacedRow
} from './agentSessions'
import type { TodoPull, TodoPulls } from './github'
import { mapAtMost } from './mapAtMost'
import { mcpLines, type McpServer } from './mcpServers'
import { GITHUB_NOT_ASKED, type MergedHeads } from './sessionClose'

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

export interface ProjectFile {
  name: string
  path: string
}

export interface TodoVerbDeps {
  allowed(tabId: string): boolean
  sidebar(): WorkspaceRows[]
  pinnedWorkspaces(): PinnedWorkspace[]
  sessions(): SessionInfo[]
  asking(tabId: string): boolean
  asleep(sessionId: string): boolean
  workLeft(row: SessionRow, merged: MergedHeads): Promise<string[] | null>
  deleting(row: SessionRow): boolean
  worktrees(workspace: string): Promise<{ dir: string; branch?: string }[]>
  repoOf(workspace: string): Promise<string | null>
  pulls(workspace: string): Promise<TodoPulls | null>
  mergedHeadsByBranch(workspace: string): Promise<Map<string, string[]> | null>
  mergedHeads(dir: string, branch: string): Promise<string[] | null>
  notes(): Record<string, string>
  saveNote(key: string, text: string): void
  projectFiles(workspace: string): Promise<ProjectFile[]>
  readText(path: string): Promise<string>
  servers(): Promise<McpServer[]>
  butlerFolder(): string
  now(): number
}

interface WorkspaceFacts {
  path: string
  label: string
  repo: string | null
  lastUsed: number
  remote: boolean
}

interface Candidate {
  placed: PlacedRow
  busy: boolean
  branch?: string
  check: WorktreeCheck
}

type WorktreeCheck =
  | { state: 'skipped' }
  | { state: 'failed' }
  | { state: 'noWorktree' }
  | { state: 'deleting' }
  | { state: 'checked'; left: string[] }

interface PullsOfRepo {
  repo: string
  pulls: TodoPulls
}

const NOTHING_LEFT = 'nothing left in its worktree'
const NO_WORKTREE = 'closing it deletes no worktree'
const COULD_NOT_CHECK = 'Koloft could not check what is left in its worktree'
const DELETING = 'Koloft is deleting its worktree'

type SessionGroup = 'asking' | 'turnDone' | 'asleep' | 'workLeft' | 'closed'

const GROUP_TITLES: Record<SessionGroup, string> = {
  asking: 'Asking the owner a question',
  turnDone: 'Open, finished its turn',
  asleep: 'Open, asleep: its tab is kept but its agent is stopped, so it is not working',
  workLeft: 'Closed, with work left in its worktree, or Koloft could not check it',
  closed:
    'Closed, nothing left in a worktree (ask about these as one batch, together with the open and asleep sessions whose work is done)'
}

type TabState = Pick<TodoVerbDeps, 'asking' | 'asleep'>

function isBusy({ live, row }: PlacedRow, d: TabState): boolean {
  if (!live) return row.running && !d.asleep(row.id)
  return live.status === 'working' && !d.asking(live.tabId)
}

function groupOf(c: Candidate, d: TabState): SessionGroup {
  const { live, row } = c.placed
  if (live) return d.asking(live.tabId) || live.status === 'approval' ? 'asking' : 'turnDone'
  if (row.running) return 'asleep'
  const { check } = c
  return check.state === 'failed' || (check.state === 'checked' && check.left.length)
    ? 'workLeft'
    : 'closed'
}

function worktreeFacts(check: WorktreeCheck, group: SessionGroup): string[] {
  const openAndNotAsking = group === 'turnDone' || group === 'asleep'
  if (check.state === 'failed') return [COULD_NOT_CHECK]
  if (check.state === 'deleting') return [DELETING]
  if (check.state === 'noWorktree') return openAndNotAsking ? [NO_WORKTREE] : []
  if (check.state === 'skipped') return []
  if (check.left.length) return [leftSummary(check.left)]
  return openAndNotAsking ? [NOTHING_LEFT] : []
}

async function checkWorktree(
  workLeft: () => Promise<string[] | null>,
  deleting: () => boolean
): Promise<WorktreeCheck> {
  if (deleting()) return { state: 'deleting' }
  try {
    const left = await workLeft()
    if (deleting()) return { state: 'deleting' }
    return left ? { state: 'checked', left } : { state: 'noWorktree' }
  } catch {
    return deleting() ? { state: 'deleting' } : { state: 'failed' }
  }
}

function leftSummary(left: string[]): string {
  return left
    .map((block) => {
      const [head, ...lines] = block.split('\n')
      const items = lines.filter((l) => l !== GITHUB_NOT_ASKED)
      const notAsked = items.length < lines.length ? ` (${GITHUB_NOT_ASKED})` : ''
      return items.length ? `${head.replace(/:$/, '')}: ${items.length}${notAsked}` : head
    })
    .join('; ')
}

function pullFacts(p: TodoPull, me: string | null, now: number): string {
  return [
    `#${p.number} "${p.title}"`,
    me && p.author === me ? 'opened by the owner' : `opened by ${p.author || 'someone'}`,
    ...(me && p.reviewers.includes(me) ? ['asks the owner to review'] : []),
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

function sessionLine(c: Candidate, group: SessionGroup, pulls: string[], now: number): string {
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
    ...worktreeFacts(c.check, group),
    ...pulls
  ].join(' · ')
}

function pullKey(repo: string, p: TodoPull): string {
  return `${repo}#${p.number}`
}

function pullSection(
  repos: PullsOfRepo[],
  withSession: Set<string>,
  workingSession: Map<string, string>,
  now: number
): string[] {
  return repos.flatMap(({ repo, pulls }) => {
    if (pulls.state === 'failed')
      return [`${repo}: Koloft could not list its pull requests: ${pulls.why}`]
    const { me, closesUnknown } = pulls
    const owners: string[] = []
    const others: string[] = []
    for (const p of pulls.pulls) {
      const key = pullKey(repo, p)
      if (withSession.has(key)) continue
      const working = workingSession.get(key)
      if (isOwners(p, me))
        owners.push(
          `- ${pullFacts(p, me, now)}${working ? ` · its session "${working}" is working` : ''}`
        )
      else others.push(`#${p.number}`)
    }
    const closing = pulls.pulls.filter((p) => p.closes.length)
    return [
      `${repo} (the owner is ${me ?? 'unknown'} on GitHub here; ${pulls.pulls.length} open):`,
      ...(owners.length
        ? owners
        : ['- none opened by the owner or asking the owner to review, outside a session']),
      ...(others.length
        ? [
            `- other open pull requests, not tied to a session: ${others.join(', ')} (list them with koloft gh pr list --repo ${repo} if the to-do note counts them)`
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

function workspaceLine(
  w: WorkspaceFacts,
  notes: Record<string, string>,
  files: string[],
  now: number
): string {
  const note = notes[w.repo ?? w.path]
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

function isProjectFile(name: string): boolean {
  return INSTRUCTION_FILES.includes(name) || TODO_FILE.test(name)
}

async function listedFiles(d: TodoVerbDeps, workspace: string): Promise<ProjectFile[]> {
  return (await d.projectFiles(workspace)).filter((f) => isProjectFile(f.name))
}

async function pullsOfRepos(d: TodoVerbDeps, workspaces: WorkspaceFacts[]): Promise<PullsOfRepo[]> {
  const repos = [...new Set(workspaces.flatMap((w) => (w.repo ? [w.repo] : [])))]
  const pulled = await Promise.all(
    repos.map(async (repo) => {
      const ws =
        workspaces.find((w) => w.repo === repo && !w.remote) ??
        workspaces.find((w) => w.repo === repo)
      const pulls = ws ? await d.pulls(ws.path).catch(() => null) : null
      return pulls && { repo, pulls }
    })
  )
  return pulled.filter((p): p is PullsOfRepo => !!p)
}

async function gather(d: TodoVerbDeps, me: BackendId): Promise<string> {
  const now = d.now()
  const sidebar = d.sidebar().filter((w) => !w.workspace.butler)
  const all = placedRows(sidebar, d.sessions())
  const notes = d.notes()
  const [workspaces, trees, servers] = await Promise.all([
    Promise.all(
      sidebar.map(async ({ workspace, rows }): Promise<WorkspaceFacts> => ({
        path: workspace.path,
        label: workspaceLabel(workspace.path),
        repo: workspace.missing ? null : await d.repoOf(workspace.path).catch(() => null),
        lastUsed: Math.max(0, ...rows.map((r) => r.mtime)),
        remote: isRemoteKey(workspace.path)
      }))
    ),
    Promise.all(sidebar.map((w) => d.worktrees(w.workspace.path).catch(() => []))),
    d.servers().catch(() => [])
  ])
  const treeOf = (p: PlacedRow): { dir: string; branch?: string } | undefined =>
    trees[sidebar.findIndex((w) => w.workspace.path === p.workspace)]?.find(
      (t) => t.dir === p.row.cwd
    )
  const repoOf = new Map(workspaces.map((w) => [w.path, w.repo]))
  const mergedOfRepo = new Map<string, Promise<Map<string, string[]> | null>>()
  const mergedIn = (workspace: string): MergedHeads => {
    const key = repoOf.get(workspace) ?? workspace
    return async (dir, branch) => {
      const heads = mergedOfRepo.get(key) ?? d.mergedHeadsByBranch(workspace).catch(() => null)
      mergedOfRepo.set(key, heads)
      const byBranch = await heads
      return byBranch && (byBranch.get(branch) ?? d.mergedHeads(dir, branch))
    }
  }
  const [files, pullsOf, candidates] = await Promise.all([
    Promise.all(
      workspaces.map((w) =>
        notes[w.repo ?? w.path] === undefined
          ? listedFiles(d, w.path).then(
              (found) => found.map((f) => f.name),
              () => []
            )
          : []
      )
    ),
    pullsOfRepos(d, workspaces),
    mapAtMost(all, GIT_LOOKUPS_AT_ONCE, async (placed): Promise<Candidate> => {
      const tree = treeOf(placed)
      const busy = isBusy(placed, d)
      const open = !!placed.live || placed.row.running
      const checkable = (!!tree || open) && !isRemoteKey(placed.workspace) && !busy
      return {
        placed,
        busy,
        branch: tree?.branch,
        check:
          checkable || d.deleting(placed.row)
            ? await checkWorktree(
                () => d.workLeft(placed.row, mergedIn(placed.workspace)),
                () => d.deleting(placed.row)
              )
            : { state: 'skipped' }
      }
    })
  ])
  const withSession = new Set<string>()
  const workingSession = new Map<string, string>()
  const groups = new Map<SessionGroup, string[]>()
  for (const c of candidates) {
    const repo = repoOf.get(c.placed.workspace)
    const found = pullsOf.find((p) => p.repo === repo)?.pulls
    const own =
      repo && c.branch && found?.state === 'ok'
        ? found.pulls.filter((p) => p.branch === c.branch)
        : []
    if (c.busy) {
      for (const p of own) workingSession.set(pullKey(repo!, p), c.placed.title)
      continue
    }
    for (const p of own) withSession.add(pullKey(repo!, p))
    const me = found?.state === 'ok' ? found.me : null
    const group = groupOf(c, d)
    const line = sessionLine(
      c,
      group,
      own.map((p) => `its pull request: ${pullFacts(p, me, now)}`),
      now
    )
    groups.set(group, [...(groups.get(group) ?? []), `- ${line}`])
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
    "PULL REQUESTS (a pull request whose branch is a listed worktree session's is listed with that session above)",
    '',
    ...(pullsOf.length
      ? pullSection(pullsOf, withSession, workingSession, now)
      : ['No workspace is on GitHub.']),
    '',
    'TOOLS SET UP FOR THE AGENTS (MCP servers; to-do tools such as Linear or Jira are among them)',
    '',
    ...mcpLines(servers, me, d.butlerFolder())
  ].join('\n')
}

async function noteVerb(d: TodoVerbDeps, rest: string[]): Promise<AgentReply> {
  const { before, after } = splitAtDashes(rest)
  if (before.length !== 1) return refused(NOTE_USAGE, EXIT_USAGE)
  const found = resolveWorkspace(before[0], d.pinnedWorkspaces())
  if (!found.ok) return refused(`koloft todo note: ${found.error}`)
  const repo = await d.repoOf(found.value.path).catch(() => null)
  const key = repo ?? found.value.path
  const what = repo ? `repository ${repo}` : `workspace ${workspaceLabel(found.value.path)}`
  if (!rest.includes('--')) {
    const note = d.notes()[key]
    return answered(note === undefined ? `The ${what} has no to-do note yet.` : note)
  }
  d.saveNote(key, after)
  return answered(
    after ? `Saved the to-do note of the ${what}.` : `Removed the to-do note of the ${what}.`
  )
}

async function fileVerb(d: TodoVerbDeps, rest: string[]): Promise<AgentReply> {
  if (rest.length !== 2) return refused(FILE_USAGE, EXIT_USAGE)
  const found = resolveWorkspace(rest[0], d.pinnedWorkspaces())
  if (!found.ok) return refused(`koloft todo file: ${found.error}`)
  const files = await listedFiles(d, found.value.path)
  const file = files.find((f) => f.name === rest[1])
  if (!file)
    return refused(
      `koloft todo file: ${rest[1]} is not one of the files koloft todo reads there${files.length ? ` (${files.map((f) => f.name).join(', ')})` : ''}.`
    )
  return answered(cutForATurn(await d.readText(file.path)))
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
