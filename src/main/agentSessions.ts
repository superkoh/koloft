import type {
  BackendId,
  CreateTabOptions,
  QueuedLaunch,
  SessionInfo,
  SessionRow,
  SessionStatus,
  WorkspaceRows,
  WorktreeInfo
} from '@shared/types'
import { BUTLER_SAYS_OPENING, DISCORD_PREFIX, ownerSays } from '@shared/agentGuide'
import {
  BACKEND_LABEL,
  PEER_TRAITS,
  reachedBySendMessage,
  SESSION_BACKENDS,
  backendIdOf,
  messagingOf,
  namedAtLaunch
} from '@shared/sessionBackend'
import { isValidWorktreeName } from '@shared/worktreeName'
import { withoutBlankEdges } from './messageText'
import { freshWorktreeName } from '@shared/sessionRoute'
import { isRemoteKey, parseRemoteKey, remoteCopyText } from '@shared/remoteKey'
import { basename } from '@shared/preview'
import { scopeName } from '@shared/conductors'
import { ageLabel } from '@shared/freshnessOps'
import { MAX_READ_TURNS, type Turn } from '@shared/turns'
import { MYSELF, slashCommandProblem } from '@shared/slashCommands'
import {
  answered,
  errorText,
  EXIT_USAGE,
  fail,
  refused,
  splitAtDashes,
  type AgentCaller,
  type AgentReply,
  type AgentVerb,
  type Parsed
} from './agentRequests'
import { AGENT_SHIM_WAITS_MS } from './agentShim'
import {
  A_HELPER_HAS_IT_IN_OLDER_TRANSCRIPTS,
  FROM_A_SESSION,
  FROM_KOLOFT,
  crossSessionLine,
  type ModeClass
} from './crossSessionMessage'
import {
  OWNER_WORDS_QUOTED_CHARS,
  handoverInOwnersLanguage,
  withHandover,
  type SessionCaller
} from './handover'
import { nameForTask } from './sessionTitle'
import type { Assist } from './assist'
import { keysFor } from './typeKeys'
import type { StartedSessions } from './startedSessions'

export interface ButlerHelperTask {
  prompt: string
  name?: string
  ownerWords: string
  backend: BackendId
}

export interface NewSessionArgs {
  name?: string
  workspace?: string
  worktree?: string
  model?: string
  backend?: BackendId
  prompt: string
}

const NEW_FLAGS: Record<string, 'name' | 'workspace' | 'worktree' | 'model' | 'backend'> = {
  '--name': 'name',
  '--workspace': 'workspace',
  '-w': 'worktree',
  '--model': 'model',
  '--backend': 'backend'
}

const PROMPT_AFTER_DASHES =
  'put the first message after --, like: -- "Fix the broken links in docs/."'

export function parseNewSessionArgs(args: string[]): Parsed<NewSessionArgs> {
  const flags: Omit<NewSessionArgs, 'prompt'> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') {
      const prompt = args
        .slice(i + 1)
        .join(' ')
        .trim()
      return prompt ? { ok: true, value: { ...flags, prompt } } : fail(PROMPT_AFTER_DASHES)
    }
    const key = Object.hasOwn(NEW_FLAGS, arg) ? NEW_FLAGS[arg] : undefined
    if (!key) return fail(`did not expect "${arg}". ${PROMPT_AFTER_DASHES}`)
    const value = args[i + 1]
    if (value === undefined || value === '--') return fail(`${arg} needs a value.`)
    if (key === 'worktree' && !isValidWorktreeName(value))
      return fail(`"${value}" cannot be a worktree name. Use letters, digits, dots, - and _.`)
    if (key === 'backend') {
      const backend = backendIdOf(value)
      if (!backend) return fail(`--backend is one of ${SESSION_BACKENDS.join(', ')}.`)
      flags.backend = backend
    } else flags[key] = value
    i++
  }
  return fail(PROMPT_AFTER_DASHES)
}

const ASKING = 'asking the owner a question'

const STATE_WORDS: Record<SessionStatus, string> = {
  working: 'working',
  approval: ASKING,
  waiting: 'finished its turn',
  idle: 'idle'
}

function stateWords(info: SessionInfo | undefined, asking: (tabId: string) => boolean): string {
  return info && asking(info.tabId) ? ASKING : STATE_WORDS[info?.status ?? 'idle']
}

interface ListedSession {
  info: SessionInfo
  peerName?: string
  starter?: string
}

function idToReach(s: SessionInfo): string {
  return s.nativeSessionId ?? s.sessionId
}

function starterPart(starter: string | undefined): string[] {
  return starter ? [`started by: ${starter}`] : []
}

// CC§13
function sendMessageReaches(
  from: SessionInfo,
  to: BackendId,
  toMachine: string | undefined
): boolean {
  return (
    reachedBySendMessage(from.backendId) &&
    reachedBySendMessage(to) &&
    from.remote?.host === toMachine
  )
}

function openSessionLines(
  sessions: ListedSession[],
  me: SessionInfo,
  asking: (tabId: string) => boolean
): string[] {
  return sessions.map(({ info, peerName, starter }) => {
    const parts = [
      `${info.title}${info.tabId === me.tabId ? ' (you)' : ''}`,
      BACKEND_LABEL[info.backendId],
      stateWords(info, asking)
    ]
    if (!reachedBySendMessage(info.backendId) || info.remote?.host !== me.remote?.host)
      parts.push(`id: ${idToReach(info)}`)
    if (peerName) parts.push(`name: ${peerName}`)
    parts.push(...starterPart(starter))
    const transcript = info.details?.claude?.jsonlPath
    if (transcript) parts.push(`transcript: ${transcript}`)
    return parts.join(' · ')
  })
}

export interface PinnedWorkspace {
  path: string
  missing: boolean
}

export function workspaceLabel(wsPath: string): string {
  const key = parseRemoteKey(wsPath)
  return key ? remoteCopyText(key.host, key.path) : wsPath
}

export interface PlacedRow {
  workspace: string
  shownAs: string
  row: SessionRow
  title: string
  live?: SessionInfo
}

const THE_BUTLERS_FOLDER = "the butler's own folder"

export function placedRows(sidebar: WorkspaceRows[], sessions: SessionInfo[]): PlacedRow[] {
  return sidebar.flatMap((w) =>
    w.rows
      .filter((row) => !row.pending)
      .map((row) => {
        const live = sessions.find((s) => s.alive && s.sessionId === row.id)
        return {
          workspace: w.workspace.path,
          shownAs: w.workspace.butler ? THE_BUTLERS_FOLDER : workspaceLabel(w.workspace.path),
          row,
          title: live?.title ?? row.title,
          live
        }
      })
  )
}

function peerNamesOf(d: SessionVerbDeps, placed: PlacedRow[]): Promise<(string | null)[]> {
  const nameOf = d.peerNames()
  return Promise.all(placed.map((p) => (p.live ? nameOf(p.live) : null)))
}

function rowLines(
  placed: PlacedRow[],
  names: (string | null)[],
  starters: (string | undefined)[],
  withWorkspace: boolean,
  now: number,
  asking: (tabId: string) => boolean
): string[] {
  return placed.map(({ workspace, shownAs, row, title, live: info }, i) => {
    const parts = [
      title,
      BACKEND_LABEL[row.backendId],
      parseRemoteKey(workspace)?.host ?? 'local',
      info || row.running ? stateWords(info, asking) : 'closed',
      `last active ${ageLabel(row.mtime, now)}`,
      `id: ${row.nativeSessionId ?? row.id}`
    ]
    if (names[i]) parts.push(`name: ${names[i]}`)
    parts.push(...starterPart(starters[i]))
    if (withWorkspace) parts.push(`workspace: ${shownAs}`)
    return parts.join(' · ')
  })
}

function formatTurns(turns: Turn[]): string {
  return turns
    .map((turn) =>
      [
        ...turn.said.map((line) => `${line.who}: ${line.text}`),
        ...(turn.reply ? [`assistant: ${turn.reply}`] : [])
      ].join('\n')
    )
    .join('\n\n')
}

export function resolveWorkspace(ref: string, pinned: PinnedWorkspace[]): Parsed<PinnedWorkspace> {
  const hits = pinned.filter(
    (w) => w.path === ref || workspaceLabel(w.path) === ref || basename(w.path) === ref
  )
  const labels = (ws: PinnedWorkspace[]): string =>
    ws.map((w) => `  ${workspaceLabel(w.path)}`).join('\n')
  if (hits.length === 0)
    return fail(
      `there is no workspace "${ref}" in Koloft's sidebar. Give the folder name or full path of one of these:\n${labels(pinned)}`
    )
  if (hits.length > 1)
    return fail(
      `${hits.length} workspaces are named "${ref}". Give the full path:\n${labels(hits)}`
    )
  return { ok: true, value: hits[0] }
}

function startableWorkspace(ref: string, pinned: PinnedWorkspace[]): Parsed<string> {
  const found = resolveWorkspace(ref, pinned)
  if (!found.ok) return fail(found.error)
  if (found.value.missing) return fail(`the folder of workspace "${found.value.path}" is missing.`)
  return { ok: true, value: found.value.path }
}

const CLAUDE_USES_SEND_MESSAGE =
  'a Claude session talks to another Claude session on the same machine with its SendMessage tool; ListAgents shows their names. This command reaches Codex, Muse and Antigravity sessions, Claude sessions on another machine, and the session or Assist that started you.'

function matchRef<T>(
  items: T[],
  ref: string,
  isId: (item: T, i: number) => boolean,
  titleOf: (item: T) => string
): Parsed<T> | null {
  const byId = items.find(isId)
  const hits = byId ? [byId] : items.filter((item) => titleOf(item) === ref)
  if (hits.length > 1)
    return fail(
      `${hits.length} sessions are named "${ref}". Use the id from "koloft session list".`
    )
  return hits.length ? { ok: true, value: hits[0] } : null
}

function matchOpen(sessions: SessionInfo[], ref: string): Parsed<SessionInfo> | null {
  return matchRef(
    sessions,
    ref,
    (s) => s.nativeSessionId === ref || s.sessionId === ref || s.tabId === ref,
    (s) => s.title
  )
}

export function findSiblingTarget(
  sessions: SessionInfo[],
  ref: string,
  from: SessionInfo
): Parsed<SessionInfo> {
  const hit = matchOpen(sessions, ref)
  if (!hit) return fail(`there is no open session "${ref}". Run "koloft session list" to see them.`)
  return hit.ok && sendMessageReaches(from, hit.value.backendId, hit.value.remote?.host)
    ? fail(CLAUDE_USES_SEND_MESSAGE)
    : hit
}

function openTarget(s: SessionInfo & { tabId: string }): Target {
  return {
    key: s.sessionId,
    name: s.title,
    backend: s.backendId,
    remote: !!s.remote,
    tabId: s.tabId,
    open: async () => s.tabId
  }
}

export interface ClosableSession {
  sessionId: string
  nativeSessionId?: string
  backendId: BackendId
  title: string
  treeRoot: string
  tabId?: string
}

export type PeerNameOf = (s: { backendId: BackendId; sessionId: string }) => Promise<string | null>

export async function findClosable(
  sessions: ClosableSession[],
  ref: string,
  nameOf: PeerNameOf
): Promise<Parsed<ClosableSession>> {
  const names = await Promise.all(sessions.map((s) => nameOf(s)))
  const hit = matchRef(
    sessions,
    ref,
    (s, i) =>
      s.sessionId === ref || s.nativeSessionId === ref || s.tabId === ref || names[i] === ref,
    (s) => s.title
  )
  if (hit && !hit.ok) return fail(`koloft session close: ${hit.error}`)
  return (
    hit ??
    fail(
      `koloft session close: you did not start a session "${ref}". You can close only this session, or one started with koloft session new by you or by a session you started.`
    )
  )
}

export interface WaitingLaunches {
  list(): QueuedLaunch[]
  notStartedYet(): QueuedLaunch[]
  hold(tabId: string, sendOnceStarted: () => Promise<unknown>): boolean
  drop(tabId: string): boolean
}

function queuedLines(d: SessionVerbDeps, me: SessionInfo, workspace: string): string[] {
  const now = Date.now()
  return d.waiting
    .list()
    .filter((q) => d.workspaceOf(q.tabId) === workspace || q.cwd === workspace)
    .map(
      (q) =>
        `- "${q.title}" (${q.tabId}): queued, waiting for the machine to have room (since ${ageLabel(q.since, now)})${d.startedSessions.startedBy({ sessionId: '', tabId: q.tabId }, me) ? ' — started by: you' : ''}`
    )
}

function queuedStartedBy(
  d: SessionVerbDeps,
  me: SessionInfo,
  ref: string
): QueuedLaunch | undefined {
  return d.waiting
    .notStartedYet()
    .find(
      (q) =>
        (q.tabId === ref || q.title === ref) &&
        d.startedSessions.startedBy({ sessionId: '', tabId: q.tabId }, me)
    )
}

export interface SessionVerbDeps {
  workspaceOf(tabId: string): string | undefined
  allSessions(): SessionInfo[]
  pinnedWorkspaces(): PinnedWorkspace[]
  peerNames(): PeerNameOf
  launch(options: CreateTabOptions & { kind: BackendId }): Promise<string | null>
  waiting: WaitingLaunches
  assist: Assist
  queue(tabId: string, text: string, clientId?: string): Promise<void>
  startedSessions: StartedSessions
  closable(): ClosableSession[]
  whatIsLeft(target: ClosableSession, waitUntil: number): Promise<string[]>
  closeSoon(
    inOrder: ClosableSession[],
    tellStarter: (closed: ClosableSession, text: string) => void
  ): void
  isButler(tabId: string): boolean
  speaksForTheOwner(tabId: string): boolean
  butlerFolder(): string
  butlerHelperRole(): string
  sidebar(): WorkspaceRows[]
  worktrees(workspace: string): Promise<WorktreeInfo[]>
  readTurns(key: string, n: number): Promise<Turn[]>
  quotedPrompt(tabId: string): string | undefined
  butlerTarget(ref: string): Target | undefined
  resume(row: SessionRow): Promise<string>
  ready(tabId: string, ms: number, turnEnded: boolean): Promise<boolean>
  bound(tabId: string, ms: number): Promise<boolean>
  asking(tabId: string): boolean
  sendLine(tabId: string, line: string, ms: number): Promise<void>
  press(tabId: string, keys: string[]): Promise<void>
  deliver(tabId: string, text: string): Promise<boolean>
  modeOf(tabId: string): ModeClass
  stop(tabId: string): void
  answer(tabId: string, reply: string): Promise<string | undefined>
  undelivered(callerTab: string, target: Target, why: string): void
  command(
    callerTab: string,
    target: Target,
    text: string,
    tellCaller: (said: string) => void
  ): Promise<string>
  screen(tabId: string): Promise<SessionScreen>
}

export type SessionScreen = { lines: string[]; notes: string[] } | { error: string }

export interface Target {
  key: string
  name: string
  backend: BackendId
  remote: boolean
  workspace?: string
  tabId?: string
  butler?: true
  open(): Promise<string>
}

const SESSION_USAGE =
  'koloft session: use list, read, new, send, command, screen, keys, answer, resume, stop or close. Run "koloft help" to see how.'
const READ_USAGE = `koloft session read: give an id or name, and if you like --last <1 to ${MAX_READ_TURNS}>, like: koloft session read fix-login --last 3`
const BUTLER_LIST_USAGE =
  'koloft session list: it takes no options here; it lists every session in every workspace.'
const SEND_USAGE =
  'koloft session send: give an id or name, then the message, like: koloft session send <id> "Tell me what you found."'
const NO_WORKSPACE = 'koloft session: Koloft does not know which workspace this session is in.'
const LIST_USAGE =
  'koloft session list: the only option is --workspace <folder name or path>, like: koloft session list --workspace koloft'
const aSessionOf = (backend: BackendId): string => {
  const label = BACKEND_LABEL[backend]
  return `${/^[AEIOU]/.test(label) ? 'an' : 'a'} ${label} session`
}
const hasNoName = (backend: BackendId): string =>
  `koloft session new: ${aSessionOf(backend)} in a remote workspace has no name, so leave out --name. Koloft prints an id to reach it by.`

function starterNamer(
  d: SessionVerbDeps,
  everyRow: PlacedRow[],
  me: { sessionId: string }
): (target: { sessionId: string; tabId?: string }) => string | undefined {
  const titles = new Map(everyRow.map((p) => [p.row.id, p.title]))
  return (target) => {
    const [starter] = d.startedSessions.startersOf(target)
    return starter === me.sessionId ? 'you' : starter && titles.get(starter)
  }
}

function placedStarters(
  d: SessionVerbDeps,
  everyRow: PlacedRow[],
  placed: PlacedRow[],
  me: { sessionId: string }
): (string | undefined)[] {
  const starterOf = starterNamer(d, everyRow, me)
  return placed.map((p) => starterOf({ sessionId: p.row.id, tabId: p.live?.tabId }))
}

async function listSessions(
  d: SessionVerbDeps,
  sessions: SessionInfo[],
  me: SessionInfo,
  workspace: string
): Promise<AgentReply> {
  const everyRow = placedRows(d.sidebar(), sessions)
  const starterOf = starterNamer(d, everyRow, me)
  const peerName = d.peerNames()
  const listed = await Promise.all(
    sessions.map(async (info) => ({
      info,
      peerName: (await peerName(info)) ?? undefined,
      starter: starterOf(info)
    }))
  )
  const open = new Set(sessions.map((s) => s.sessionId))
  const notOpen = everyRow.filter((p) => p.workspace === workspace && !open.has(p.row.id))
  const lines = [
    ...openSessionLines(listed, me, d.asking),
    ...queuedLines(d, me, workspace),
    ...rowLines(notOpen, [], placedStarters(d, everyRow, notOpen, me), false, Date.now(), d.asking)
  ]
  return answered(lines.join('\n') || 'This workspace has no sessions.')
}

async function startSibling(
  d: SessionVerbDeps,
  args: NewSessionArgs,
  me: SessionInfo,
  workspace: string,
  conductorTab: string | undefined,
  ownerWords: string | undefined,
  oweReply: (tabId: string) => void,
  helperRole?: string
): Promise<AgentReply> {
  const backend = args.backend ?? me.backendId
  if (!namedAtLaunch(backend, isRemoteKey(workspace)) && args.name !== undefined)
    return refused(hasNoName(backend), EXIT_USAGE)
  const launched = await launchSibling(
    d,
    args,
    me,
    workspace,
    conductorTab,
    ownerWords,
    oweReply,
    helperRole
  )
  if (!launched) return refused('koloft session new: Koloft could not start the session.')
  const { tabId, name } = launched
  const unnamed = aSessionOf(backend)
  const bySendMessage = sendMessageReaches(me, backend, parseRemoteKey(workspace)?.host)
  if (d.waiting.list().some((q) => q.tabId === tabId))
    return answered(
      `Queued ${name ? `session "${name}"` : unnamed} (${tabId}): Koloft starts it in turn, once this machine has room. Do not start it again. "koloft session list" shows it as queued; ${
        name && bySendMessage
          ? `once it starts, talk to it with SendMessage to "${name}"`
          : `"koloft session send ${tabId} <message>" is kept and handed to it once it starts`
      }; "koloft session close ${tabId}" takes it off the queue.`
    )
  if (conductorTab)
    return answered(
      `Started ${name ? `session "${name}"` : unnamed} in a new tab. "koloft session list" shows its id once it starts; reach it with koloft session send.`
    )
  const listHint =
    args.workspace === undefined
      ? 'koloft session list'
      : `koloft session list --workspace ${JSON.stringify(workspace)}`
  return answered(
    bySendMessage
      ? `Started session "${name}" in a new tab. Talk to it with SendMessage to "${name}".`
      : `Started ${name ? `${BACKEND_LABEL[backend]} session "${name}"` : unnamed} in a new tab: ${tabId}. Its id shows in "${listHint}" once it starts; "koloft session send ${tabId} <message>" also reaches it.`
  )
}

async function launchSibling(
  d: SessionVerbDeps,
  args: NewSessionArgs,
  me: SessionInfo,
  workspace: string,
  conductorTab: string | undefined,
  ownerWords: string | undefined,
  oweReply: (tabId: string) => void,
  helperRole?: string
): Promise<{ tabId: string; name: string | undefined } | null> {
  const backend = args.backend ?? me.backendId
  const traits = PEER_TRAITS[backend]
  const caller: SessionCaller = {
    name: (await d.peerNames()(me)) ?? (reachedBySendMessage(me.backendId) ? me.title : undefined),
    id: idToReach(me),
    label: BACKEND_LABEL[me.backendId],
    assist: conductorTab !== undefined,
    ownerWords
  }
  const [name, handover] = await Promise.all([
    !namedAtLaunch(backend, isRemoteKey(workspace))
      ? undefined
      : (args.name ??
        nameForTask(
          args.prompt,
          d.assist,
          new Set(d.allSessions().map((s) => s.title)),
          ownerWords
        )),
    handoverInOwnersLanguage(caller, d.assist)
  ])
  const preamble = helperRole ? `${helperRole}\n\n${handover}` : handover
  const gitWorkspace = d.sidebar().some((w) => w.workspace.path === workspace && w.workspace.isGit)
  const worktree =
    gitWorkspace && (args.worktree || caller.assist)
      ? freshWorktreeName(await d.worktrees(workspace), Date.now(), args.worktree)
      : args.worktree
  const tabId = await d.launch({
    kind: backend,
    cwd: workspace,
    name,
    worktree,
    model: args.model,
    // ADR-0028
    permission: d.modeOf(me.tabId) === 'bypass' ? 'bypass' : 'default',
    ownerWords,
    // ADR-0026
    trustFolder:
      !worktree && (!!helperRole || d.pinnedWorkspaces().some((w) => w.path === workspace)),
    // CODEX§17
    ...(traits.handoverAsRole
      ? { role: preamble, firstPrompt: args.prompt }
      : { firstPrompt: withHandover(preamble, args.prompt) })
  })
  if (!tabId) return null
  oweReply(tabId)
  d.startedSessions.started(tabId, me.sessionId)
  return { tabId, name }
}

function parseReadArgs(rest: string[]): Parsed<{ ref: string; last: number }> {
  const flag = rest.indexOf('--last')
  const ref = (flag < 0 ? rest : rest.slice(0, flag)).join(' ')
  if (!ref) return fail(READ_USAGE)
  if (flag < 0) return { ok: true, value: { ref, last: 1 } }
  const [value, ...extra] = rest.slice(flag + 1)
  const last = Number(value)
  if (extra.length > 0 || !Number.isInteger(last) || last < 1 || last > MAX_READ_TURNS)
    return fail(READ_USAGE)
  return { ok: true, value: { ref, last } }
}

function nameThenWords(
  words: string[],
  isName: (ref: string) => boolean
): Parsed<{ ref: string; tail: string[] }> {
  const heads = words.slice(0, -1).map((_, i) => words.slice(0, i + 1).join(' '))
  const named = heads.filter(isName)
  if (named.length > 1)
    return fail(
      `${named.map((n) => `"${n}"`).join(' and ')} are all session names, so Koloft cannot tell where the name ends. Give the session's id from "koloft session list" instead.`
    )
  const count = named.length ? heads.indexOf(named[0]) + 1 : 1
  return { ok: true, value: { ref: words.slice(0, count).join(' '), tail: words.slice(count) } }
}

function wholeName(words: string[]): Parsed<{ ref: string; tail: string[] }> {
  return { ok: true, value: { ref: words.join(' '), tail: [] } }
}

function asArgument(ref: string): string {
  return /\s/.test(ref) ? JSON.stringify(ref) : ref
}

function matchRow(
  placed: PlacedRow[],
  ref: string,
  names: (string | null)[] = []
): Parsed<PlacedRow> | null {
  return matchRef(
    placed,
    ref,
    (p, i) => p.row.id === ref || p.row.nativeSessionId === ref || names[i] === ref,
    (p) => p.title
  )
}

function rowTarget(d: SessionVerbDeps, p: PlacedRow): Target {
  return {
    key: p.row.id,
    name: p.title,
    backend: p.row.backendId,
    remote: isRemoteKey(p.workspace),
    workspace: p.workspace,
    tabId: p.live?.tabId,
    open: () => d.resume(p.row)
  }
}

function starterRow(
  d: SessionVerbDeps,
  caller: AgentCaller,
  open: SessionInfo[]
): PlacedRow | undefined {
  const [id] = d.startedSessions.startersOf({ ...caller.session, tabId: caller.tabId })
  return id === undefined ? undefined : placedRows(d.sidebar(), open).find((r) => r.row.id === id)
}

function sessionTarget(d: SessionVerbDeps, id: string): Target | undefined {
  const row = placedRows(d.sidebar(), d.allSessions()).find((r) => r.row.id === id)
  return d.butlerTarget(id) ?? (row && rowTarget(d, row))
}

interface NamedRows {
  all: PlacedRow[]
  names: (string | null)[]
}

async function allRows(d: SessionVerbDeps): Promise<NamedRows> {
  const all = placedRows(d.sidebar(), d.allSessions())
  return { all, names: await peerNamesOf(d, all) }
}

function namesARow({ all, names }: NamedRows, ref: string): boolean {
  return matchRow(all, ref, names) !== null
}

async function findRow(d: SessionVerbDeps, verb: string, ref: string): Promise<Parsed<PlacedRow>> {
  return findAmong(await allRows(d), verb, ref)
}

function findAmong({ all, names }: NamedRows, verb: string, ref: string): Parsed<PlacedRow> {
  const hit = matchRow(all, ref, names)
  if (hit && !hit.ok) return fail(`koloft session ${verb}: ${hit.error}`)
  if (hit) {
    const name = names[all.indexOf(hit.value)]
    return { ok: true, value: name ? { ...hit.value, title: name } : hit.value }
  }
  return fail(
    `koloft session ${verb}: there is no session "${ref}". Run "koloft session list" to see them.`
  )
}

async function readSession(d: SessionVerbDeps, rest: string[]): Promise<AgentReply> {
  const args = parseReadArgs(rest)
  if (!args.ok) return refused(args.error, EXIT_USAGE)
  const { ref, last } = args.value
  const found = await findRow(d, 'read', ref)
  if (!found.ok) return refused(found.error)
  const { row, title } = found.value
  const turns = await d.readTurns(row.id, last)
  return answered(turns.length > 0 ? formatTurns(turns) : `${title} has said nothing yet.`)
}

async function sessionOnThisComputer(
  d: SessionVerbDeps,
  ref: string
): Promise<Parsed<ClosableSession>> {
  const found = await findRow(d, 'close', ref)
  if (!found.ok) return found
  const { row, title, workspace } = found.value
  if (isRemoteKey(workspace))
    return fail(
      `koloft session close: ${title} runs on another machine, where Koloft cannot check what closing it would lose.`
    )
  const target = d.closable().find((s) => s.sessionId === row.id)
  if (!target) return fail(`koloft session close: ${title} is gone.`)
  if (target.tabId && d.isButler(target.tabId))
    return fail(`koloft session close: ${title} is the butler, which only closes itself.`)
  return { ok: true, value: target }
}

interface StartedSessionsToClose {
  close: ClosableSession[]
  kept: string[]
  open: string[]
}

async function startedSessionsToClose(
  d: SessionVerbDeps,
  target: ClosableSession,
  callerTab: string,
  waitUntil: number
): Promise<StartedSessionsToClose> {
  const found: StartedSessionsToClose = { close: [], kept: [], open: [] }
  const all = d.closable()
  const alive = new Set(d.allSessions().flatMap((s) => (s.alive ? [s.sessionId] : [])))
  const seen = new Set([target.sessionId])
  const visit = async (parent: string): Promise<void> => {
    const kids = all.filter(
      (s) => !seen.has(s.sessionId) && d.startedSessions.startersOf(s).includes(parent)
    )
    for (const kid of kids) seen.add(kid.sessionId)
    const ended = kids.filter((kid) => {
      if (!alive.has(kid.sessionId)) return true
      if (kid.tabId !== callerTab) found.open.push(`"${kid.title}"`)
      return false
    })
    const lefts = await Promise.all(
      ended.map((kid) => (kid.treeRoot === target.treeRoot ? [] : d.whatIsLeft(kid, waitUntil)))
    )
    const closing = ended.filter((kid, i) => {
      if (!lefts[i].length) return true
      found.kept.push(`"${kid.title}":\n${lefts[i].join('\n')}`)
      return false
    })
    found.close.push(...closing)
    for (const kid of closing) await visit(kid.sessionId)
  }
  await visit(target.sessionId)
  return found
}

function startedSessionsLines({ close, kept, open }: StartedSessionsToClose): string[] {
  const lines = [
    close.length &&
      `Also closing the ended sessions it started: ${close.map((s) => `"${s.title}"`).join(', ')}.`,
    kept.length &&
      `Left these ended sessions it started, since closing them would lose this:\n\n${kept.join('\n\n')}`,
    open.length && `Left these sessions it started open: ${open.join(', ')}.`
  ]
  return lines.filter((line): line is string => !!line)
}

export const THAT_IS_YOU = 'That is you.'
const TIME_FOR_THE_REPLY_TO_REACH_THE_SHIM_MS = 2_000
const REPLY_INSIDE_THE_KOLOFT_SHIM_WAIT_MS =
  AGENT_SHIM_WAITS_MS - TIME_FOR_THE_REPLY_TO_REACH_THE_SHIM_MS
const ROOM_FOR_THE_CLOSE_CHECK_ITSELF_MS = 5_000
export const A_REMOVAL_UNDER_WAY_IS_WAITED_FOR_MS =
  AGENT_SHIM_WAITS_MS - ROOM_FOR_THE_CLOSE_CHECK_ITSELF_MS
const RESUME_USAGE =
  'koloft session resume: give an id or name, and if you like a first message after --, like: koloft session resume fix-login -- "Carry on."'
const STOP_USAGE = 'koloft session stop: give an id or name, like: koloft session stop fix-login'
const ANSWER_USAGE =
  'koloft session answer: give an id or name, then an option number, yes, no or your own words, like: koloft session answer fix-login 2'
export const WAITS_FOR_A_CLOSED_OR_BUSY_TARGET_MS = 10 * 60_000
const FIRST_PROMPT_BINDS_WITHIN_MS = 10_000
const SHOWS_NOTHING_WHILE_CLOSED = 'it is not open, so it shows no question.'
const NO_WORKTREE_IN_BUTLER_FOLDER =
  'koloft session new: your own folder is no git repository, so -w needs --workspace <workspace>; "koloft workspace list" shows them.'

const COMMAND_USAGE = `koloft session command: give an id or name (or "me" for yourself), then one slash command, like: koloft session command fix-login /compact`
const SCREEN_USAGE = `koloft session screen: give an id or name (or "me" for yourself), like: koloft session screen fix-login`
const KEYS_USAGE = `koloft session keys: give an id or name, then the keys to press in order, like: koloft session keys fix-login Down Enter`

function seeAndPress(ref: string): string {
  const arg = asArgument(ref)
  return `To answer it anyway, see what it shows with koloft session screen ${arg}, then press the keys with koloft session keys ${arg} <keys>.`
}

const SESSION_ACT_USAGE: Record<string, string> = {
  send: SEND_USAGE,
  command: COMMAND_USAGE,
  screen: SCREEN_USAGE,
  keys: KEYS_USAGE,
  answer: ANSWER_USAGE,
  resume: RESUME_USAGE,
  stop: STOP_USAGE
}

export function formatScreen(name: string, screen: SessionScreen): string {
  if ('error' in screen) return `${name}: ${screen.error}`
  const lines = withoutBlankEdges(screen.lines)
  const shown = lines.length ? `\`\`\`\n${lines.join('\n')}\n\`\`\`` : '(the screen is empty)'
  return [`The screen of ${name} right now:`, shown, ...screen.notes].join('\n')
}

function readsItAfterTheQuestion(name: string): string {
  const arg = asArgument(name)
  return `But ${name} is asking the owner a question, so it reads your message only once that is answered. See the question with koloft session screen ${arg} and pass it on to the owner.`
}

const SESSION_SAYS_OPENING = `${FROM_A_SESSION}"`

export function sessionSays(from: SessionInfo, text: string): string {
  return `${SESSION_SAYS_OPENING}${from.title}", id ${idToReach(from)}:) ${text}`
}

const ASSIST_SAYS_OPENING_IN_OLDER_TRANSCRIPTS = "(From Assist, Koloft's AI, for your owner."

const KOLOFT_ENVELOPES = [
  SESSION_SAYS_OPENING,
  BUTLER_SAYS_OPENING,
  ASSIST_SAYS_OPENING_IN_OLDER_TRANSCRIPTS,
  FROM_KOLOFT,
  A_HELPER_HAS_IT_IN_OLDER_TRANSCRIPTS
]

type OwnerWordsHolder = Pick<SessionInfo, 'sessionId' | 'backendId'> & { tabId?: string }

export function lastOwnerWords(turns: Turn[]): string | undefined {
  const line = turns
    .flatMap((t) => t.said)
    .findLast((l) => l.who === 'owner' && !KOLOFT_ENVELOPES.some((e) => l.text.startsWith(e)))
  if (!line) return undefined
  const relayed = `${DISCORD_PREFIX} `
  const words = line.text.startsWith(relayed) ? line.text.slice(relayed.length) : line.text
  return words.slice(0, OWNER_WORDS_QUOTED_CHARS)
}

function isMe(
  ref: string,
  me: SessionInfo,
  mine: Target | undefined,
  callerTabId: string
): boolean {
  return (
    mine?.tabId === callerTabId ||
    [MYSELF, me.sessionId, me.nativeSessionId, me.title].includes(ref)
  )
}

interface OwedReply {
  owner: string
  asked?: string
}

export function sessionVerb(d: SessionVerbDeps): {
  verb: AgentVerb
  turnEnded(tabId: string, turn: Turn): boolean
  waitsOnAnother(sessionId: string): boolean
  startButlerHelper(butler: SessionInfo, task: ButlerHelperTask): Promise<string | null>
  tabMoved(oldTabId: string, newTabId: string): void
} {
  const opening = new Map<string, Promise<string | null>>()
  let queued = 0
  let lined = 0
  const replyOwed = new Map<string, OwedReply>()
  const messagedBy = new Map<string, Set<string>>()

  // ADR-0031
  const ownerWordsOf = async (
    s: OwnerWordsHolder,
    seen = new Set<string>()
  ): Promise<string | undefined> => {
    if (PEER_TRAITS[s.backendId].quotesOwnerWordsInHooks)
      return s.tabId ? d.quotedPrompt(s.tabId) : undefined
    seen.add(s.sessionId)
    const [parent] = d.startedSessions.startersOf(s)
    const holder = parent && !seen.has(parent) ? holderOf(parent) : undefined
    if (holder) return ownerWordsOf(holder, seen)
    return lastOwnerWords(await d.readTurns(s.sessionId, MAX_READ_TURNS))
  }

  const holderOf = (sessionId: string): OwnerWordsHolder | undefined => {
    const open = d.allSessions().find((s) => s.sessionId === sessionId)
    if (open) return open
    const assist = d.butlerTarget(sessionId)
    return assist && { sessionId, tabId: assist.tabId, backendId: assist.backend }
  }

  const owing = async <T>(
    tab: string,
    owed: OwedReply | undefined,
    act: () => Promise<T>,
    failed: (result: T) => boolean = () => false
  ): Promise<T> => {
    const before = replyOwed.get(tab)
    if (owed) replyOwed.set(tab, owed)
    const takeBack = (): void => {
      if (!owed || replyOwed.get(tab) !== owed) return
      if (before) replyOwed.set(tab, before)
      else replyOwed.delete(tab)
    }
    try {
      const result = await act()
      if (failed(result)) takeBack()
      return result
    } catch (error) {
      takeBack()
      throw error
    }
  }

  const openReady = (t: Target, until: number): Promise<string | null> => {
    const inflight = opening.get(t.key)
    if (inflight) return inflight
    const p = (async (): Promise<string | null> => {
      const tab = await t.open()
      return (await d.ready(tab, until - Date.now(), false)) ? tab : null
    })().finally(() => opening.delete(t.key))
    opening.set(t.key, p)
    return p
  }

  const sendNow = async (
    t: Target,
    text: string,
    line: string | undefined,
    until: number,
    from: string,
    assist?: string
  ): Promise<string> => {
    const tab = t.tabId ?? (await openReady(t, until))
    if (!tab) throw new Error(`${t.name} was resumed but did not get ready in time.`)
    const owed = assist
      ? {
          owner: assist,
          asked: messagingOf(t.backend, !!t.remote) === 'queue' ? text : undefined
        }
      : undefined
    const sent = await owing(tab, owed, () => sendInto(t, tab, text, line, until))
    messagedBy.set(tab, (messagedBy.get(tab) ?? new Set()).add(from))
    return sent
  }

  const sendInto = async (
    t: Target,
    tab: string,
    text: string,
    line: string | undefined,
    until: number
  ): Promise<string> => {
    if (messagingOf(t.backend, !!t.remote) === 'queue') {
      await d.queue(tab, text, `koloft-conductor-${++queued}`)
      return `Sent to ${t.name}.`
    }
    if (line) {
      await d.sendLine(tab, line, until - Date.now())
      return `Sent to ${t.name}.`
    }
    if (await d.deliver(tab, text)) return `Sent to ${t.name}.`
    if (!(await d.ready(tab, until - Date.now(), true)))
      throw new Error(
        `${t.name} stayed busy. ${t.remote ? 'It runs on another machine, where Koloft' : 'Koloft'} can only type into it once its turn has ended and it shows no question.`
      )
    const first = !(await d.bound(tab, 0))
    await d.press(tab, [text, '\r'])
    // AGY§8
    if (first && !(await d.bound(tab, Math.min(until - Date.now(), FIRST_PROMPT_BINDS_WITHIN_MS))))
      return `Typed into ${t.name}, but it has not started a conversation yet.`
    return `Typed into ${t.name}.`
  }

  const deliver = async (
    verb: string,
    t: Target,
    text: string,
    caller: Pick<AgentCaller, 'tabId' | 'session'>,
    fromAssist: boolean
  ): Promise<AgentReply> => {
    const route = messagingOf(t.backend, !!t.remote)
    const typed = route === 'typed'
    const line =
      route !== 'peerLine'
        ? undefined
        : crossSessionLine(d.modeOf(caller.tabId), text, `koloft-session-${++lined}`)
    if (line === null)
      return refused(
        `koloft session ${verb}: the message cannot hold the text </cross-session-message>.`,
        EXIT_USAGE
      )
    const busy = typed && t.tabId !== undefined && !(await d.ready(t.tabId, 0, true))
    const assist = fromAssist ? caller.session.sessionId : undefined
    if (t.tabId && !busy) {
      // CC§14
      const asking = fromAssist && d.asking(t.tabId)
      const sent = await sendNow(
        t,
        text,
        line,
        Date.now() + REPLY_INSIDE_THE_KOLOFT_SHIM_WAIT_MS,
        caller.session.sessionId,
        assist
      )
      return answered(asking ? `${sent} ${readsItAfterTheQuestion(t.name)}` : sent)
    }
    void sendNow(
      t,
      text,
      line,
      Date.now() + WAITS_FOR_A_CLOSED_OR_BUSY_TARGET_MS,
      caller.session.sessionId,
      assist
    ).catch((error: unknown) => d.undelivered(caller.tabId, t, errorText(error)))
    return answered(`Will deliver when ${t.name} is ready.`)
  }

  const waitsOnAnother = (sessionId: string): boolean =>
    d
      .allSessions()
      .some(
        (s) =>
          s.alive &&
          (s.status === 'working' || s.status === 'approval') &&
          (replyOwed.get(s.tabId)?.owner === sessionId || !!messagedBy.get(s.tabId)?.has(sessionId))
      )

  const turnEnded = (tabId: string, turn: Turn): boolean => {
    messagedBy.delete(tabId)
    const owed = replyOwed.get(tabId)
    if (!owed) return false
    const { owner, asked } = owed
    if (asked !== undefined && !turn.said.some((l) => l.text.includes(asked))) return false
    replyOwed.delete(tabId)
    if (!turn.reply.trim()) return false
    const to = sessionTarget(d, owner)
    if (!to) return false
    const session = d.allSessions().find((s) => s.tabId === tabId)
    if (!session) return false
    deliverOrReport({ tabId, session }, to, sessionSays(session, turn.reply))
    return true
  }

  const deliverOrReport = (
    from: Pick<AgentCaller, 'tabId' | 'session'>,
    to: Target,
    text: string
  ): void =>
    void deliver('send', to, text, from, false)
      .then((reply) => reply.exit === 0 || d.undelivered(from.tabId, to, reply.text))
      .catch((error: unknown) => d.undelivered(from.tabId, to, errorText(error)))

  const commandFrom = (caller: AgentCaller, text: string, into?: Target): Promise<string> => {
    const butler = d.butlerTarget(caller.session.sessionId)
    const me =
      butler?.tabId === caller.tabId
        ? butler
        : openTarget({ ...caller.session, tabId: caller.tabId })
    return d.command(caller.tabId, into ?? me, text, (said) =>
      deliverOrReport(caller, me, `${FROM_KOLOFT}${said}`)
    )
  }

  const sessionAct = async (
    sub: string,
    rest: string[],
    caller: AgentCaller,
    asButler: boolean
  ): Promise<AgentReply> => {
    const takesWords = sub === 'send' || sub === 'answer' || sub === 'command' || sub === 'keys'
    const resume = splitAtDashes(rest)
    const rows = await allRows(d)
    const split = takesWords
      ? nameThenWords(
          rest,
          (r) =>
            isMe(r, caller.session, d.butlerTarget(r), caller.tabId) ||
            d.butlerTarget(r) !== undefined ||
            namesARow(rows, r)
        )
      : wholeName(sub === 'resume' ? resume.before : rest)
    if (!split.ok) return refused(`koloft session ${sub}: ${split.error}`, EXIT_USAGE)
    const { ref, tail } = split.value
    const text = sub === 'resume' ? resume.after : tail.join(' ').trim()
    if (!ref || (takesWords && !text)) return refused(SESSION_ACT_USAGE[sub], EXIT_USAGE)
    if (sub === 'command') {
      const problem = slashCommandProblem(text)
      if (problem) return refused(`koloft session command: ${problem}`, EXIT_USAGE)
    }
    const self = isMe(ref, caller.session, d.butlerTarget(ref), caller.tabId)
    if (self && sub === 'screen') return answered(formatScreen('you', await d.screen(caller.tabId)))
    if (self && sub === 'command') return answered(await commandFrom(caller, text))
    if (self) return refused(`koloft session ${sub}: ${THAT_IS_YOU}`)
    const found = d.butlerTarget(ref) ?? findAmong(rows, sub, ref)
    if ('ok' in found && !found.ok) return refused(found.error)
    const t = 'ok' in found ? rowTarget(d, found.value) : found
    if (sub === 'screen')
      return t.tabId
        ? answered(formatScreen(t.name, await d.screen(t.tabId)))
        : refused(`koloft session screen: ${t.name} is not open, so it has no screen.`)
    if (sub === 'stop') {
      if (!t.tabId) return refused(`koloft session stop: ${t.name} is not open.`)
      d.stop(t.tabId)
      return answered(`Closed ${t.name}. It stays in the list and can be resumed.`)
    }
    if (sub === 'keys' && !t.tabId) return refused(`koloft session keys: ${t.name} is not open.`)
    if (sub === 'command') return answered(await commandFrom(caller, text, t))
    if (sub === 'keys' && t.tabId) {
      const tab = t.tabId
      const owed = d.asking(tab) ? { owner: caller.session.sessionId } : undefined
      await owing(tab, owed, () => d.press(tab, keysFor(tail)))
      return answered(
        `Pressed ${text} in ${t.name}. See what it shows now with koloft session screen ${asArgument(ref)}.`
      )
    }
    if (sub === 'answer') {
      if (!t.tabId)
        return refused(`koloft session answer: ${t.name}: ${SHOWS_NOTHING_WHILE_CLOSED}`)
      const tab = t.tabId
      const error = await owing(
        tab,
        { owner: caller.session.sessionId },
        () => d.answer(tab, text),
        (e) => e !== undefined
      )
      return error
        ? refused(`koloft session answer: ${t.name}: ${error} ${seeAndPress(ref)}`)
        : answered(`Answered ${t.name}.`)
    }
    if (sub === 'resume' && !text) {
      if (t.tabId) return answered(`${t.name} is already open.`)
      await (opening.get(t.key) ?? t.open())
      return answered(`Resumed ${t.name}.`)
    }
    const toAnotherHelper = !d.isButler(caller.tabId) && t.workspace === d.butlerFolder()
    return asButler && !t.butler && !toAnotherHelper
      ? deliver(sub, t, ownerSays(text), caller, true)
      : deliver(sub, t, sessionSays(caller.session, text), caller, false)
  }

  const verb: AgentVerb = async (args, caller): Promise<AgentReply> => {
    const [sub, ...rest] = args
    const ws = d.workspaceOf(caller.tabId)
    const sessionsIn = (workspace: string): SessionInfo[] =>
      d.allSessions().filter((s) => d.workspaceOf(s.tabId) === workspace)
    const butler = d.isButler(caller.tabId)
    const forTheOwner = d.speaksForTheOwner(caller.tabId)
    if (sub === 'list' && butler) {
      if (rest.length > 0) return refused(BUTLER_LIST_USAGE, EXIT_USAGE)
      const placed = placedRows(d.sidebar(), d.allSessions())
      if (placed.length === 0) return answered('There are no sessions to look after.')
      return answered(
        rowLines(
          placed,
          await peerNamesOf(d, placed),
          placedStarters(d, placed, placed, caller.session),
          true,
          Date.now(),
          d.asking
        ).join('\n')
      )
    }
    if (sub === 'read') return readSession(d, rest)
    if (sub === 'list') {
      const listsOther = rest.length === 2 && rest[0] === '--workspace'
      if (rest.length > 0 && !listsOther) return refused(LIST_USAGE, EXIT_USAGE)
      if (!listsOther)
        return ws ? listSessions(d, sessionsIn(ws), caller.session, ws) : refused(NO_WORKSPACE)
      const found = resolveWorkspace(rest[1], d.pinnedWorkspaces())
      if (!found.ok) return refused(`koloft session list: ${found.error}`)
      return listSessions(d, sessionsIn(found.value.path), caller.session, found.value.path)
    }
    if (sub === 'new') {
      const parsed = parseNewSessionArgs(rest)
      if (!parsed.ok) return refused(`koloft session new: ${parsed.error}`, EXIT_USAGE)
      const where = parsed.value.workspace
      const start = async (
        workspace: string,
        conductorTab?: string,
        helperRole?: string
      ): Promise<AgentReply> => {
        const ownerWords = await ownerWordsOf(caller.session)
        return startSibling(
          d,
          parsed.value,
          caller.session,
          workspace,
          conductorTab,
          ownerWords,
          (tab) => replyOwed.set(tab, { owner: caller.session.sessionId }),
          helperRole
        )
      }
      if (where !== undefined) {
        const target = startableWorkspace(where, d.pinnedWorkspaces())
        if (!target.ok) return refused(`koloft session new: ${target.error}`)
        return start(target.value, butler ? caller.tabId : undefined)
      }
      if (butler) {
        if (parsed.value.worktree !== undefined) return refused(NO_WORKTREE_IN_BUTLER_FOLDER)
        return start(d.butlerFolder(), caller.tabId, d.butlerHelperRole())
      }
      return ws ? start(ws) : refused(NO_WORKSPACE)
    }
    if (butler && Object.hasOwn(SESSION_ACT_USAGE, sub)) return sessionAct(sub, rest, caller, true)
    if (sub === 'send') {
      const open = d.allSessions()
      const parent = starterRow(d, caller, open)
      const starter = (ref: string): Target | undefined =>
        d.butlerTarget(ref) ??
        (parent && matchRow([parent], ref) ? rowTarget(d, parent) : undefined)
      const split = nameThenWords(
        rest,
        (ref) =>
          starter(ref) !== undefined ||
          matchOpen(open, ref) !== null ||
          queuedStartedBy(d, caller.session, ref) !== undefined
      )
      if (!split.ok) return refused(`koloft session send: ${split.error}`, EXIT_USAGE)
      const { ref, tail } = split.value
      const text = tail.join(' ').trim()
      if (!ref || !text) return refused(SEND_USAGE, EXIT_USAGE)
      const said = sessionSays(caller.session, text)
      const queued = queuedStartedBy(d, caller.session, ref)
      if (
        queued &&
        sendMessageReaches(caller.session, queued.kind, parseRemoteKey(queued.cwd)?.host)
      )
        return refused(
          `koloft session send: "${queued.title}" is still queued for the machine; once it starts, talk to it with SendMessage to "${queued.title}".`
        )
      const sendOnceStarted = async (): Promise<AgentReply> =>
        verb(['send', queued?.tabId ?? ref, text], caller)
      if (queued && d.waiting.hold(queued.tabId, sendOnceStarted))
        return answered(
          `"${queued.title}" is still queued for the machine; your message is kept and handed to it once it starts.`
        )
      const to = starter(ref)
      if (to) replyOwed.delete(caller.tabId)
      if (to) return deliver('send', to, said, caller, false)
      if (forTheOwner || matchOpen(open, ref) === null)
        return sessionAct(sub, rest, caller, forTheOwner)
      const target = findSiblingTarget(open, ref, caller.session)
      if (!target.ok) return refused(`koloft session send: ${target.error}`)
      return deliver('send', openTarget(target.value), said, caller, false)
    }
    if (Object.hasOwn(SESSION_ACT_USAGE, sub)) return sessionAct(sub, rest, caller, forTheOwner)
    if (sub === 'close') {
      const waitUntil = Date.now() + A_REMOVAL_UNDER_WAY_IS_WAITED_FOR_MS
      const ref = rest.length > 0 ? rest.join(' ') : undefined
      let target: ClosableSession = caller.session
      const queued = ref !== undefined ? queuedStartedBy(d, caller.session, ref) : undefined
      if (queued && d.waiting.drop(queued.tabId))
        return answered(`Took "${queued.title}" off the queue; it will not start.`)
      if (ref !== undefined) {
        const mine = d.closable().filter((s) => d.startedSessions.startedBy(s, caller.session))
        let hit = await findClosable(mine, ref, d.peerNames())
        if (!hit.ok) hit = await sessionOnThisComputer(d, ref)
        if (!hit.ok) return refused(hit.error)
        target = hit.value
      }
      const left = await d.whatIsLeft(target, waitUntil)
      if (left.length > 0)
        return refused(
          `koloft session close: nothing was closed.\n\n${left.join('\n\n')}\n\nCommit and push every change, end any other session in that worktree, then run koloft session close again.`
        )
      const started = await startedSessionsToClose(d, target, caller.tabId, waitUntil)
      d.closeSoon([target, ...started.close], (closed, text) => {
        const [id] = d.startedSessions.startersOf(closed)
        const starter = id === undefined ? undefined : sessionTarget(d, id)
        if (starter?.tabId && !starter.butler)
          void deliver('send', starter, `${FROM_KOLOFT}${text}`, caller, false).catch(() => {})
      })
      return answered(
        [
          target.tabId === caller.tabId
            ? 'Closing this session now: its tab, its row in the sidebar, and its git worktree and branch if it has one.'
            : `Closing "${target.title}" now: its tab if it is open, its row in the sidebar, and its git worktree and branch if it has one.`,
          ...startedSessionsLines(started)
        ].join('\n\n')
      )
    }
    return refused(SESSION_USAGE, EXIT_USAGE)
  }

  const startButlerHelper = async (
    butler: SessionInfo,
    { prompt, name, ownerWords, backend }: ButlerHelperTask
  ): Promise<string | null> =>
    (
      await launchSibling(
        d,
        { prompt, name, backend },
        butler,
        d.butlerFolder(),
        butler.tabId,
        ownerWords,
        (tab) => replyOwed.set(tab, { owner: butler.sessionId }),
        d.butlerHelperRole()
      )
    )?.tabId ?? null

  const tabMoved = (oldTabId: string, newTabId: string): void => {
    const owed = replyOwed.get(oldTabId)
    if (owed === undefined) return
    replyOwed.delete(oldTabId)
    replyOwed.set(newTabId, owed)
  }

  return { verb, turnEnded, waitsOnAnother, startButlerHelper, tabMoved }
}

export interface WorkspaceVerbDeps {
  sidebar(): WorkspaceRows[]
}

export function workspaceVerb(d: WorkspaceVerbDeps): AgentVerb {
  return (args) => {
    if (args.length !== 1 || args[0] !== 'list')
      return refused('koloft workspace: use list, like: koloft workspace list', EXIT_USAGE)
    const lines = d
      .sidebar()
      .map(({ workspace, rows }) =>
        [
          scopeName(workspace.path),
          workspaceLabel(workspace.path),
          `${rows.filter((r) => r.running).length} open`,
          ...(workspace.missing ? ['folder missing'] : [])
        ].join(' · ')
      )
    return answered(lines.join('\n') || "Koloft's sidebar has no workspaces.")
  }
}
