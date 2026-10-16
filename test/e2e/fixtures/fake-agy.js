#!/usr/bin/env node
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const http = require('http')
const net = require('net')
const { spawn, spawnSync } = require('child_process')
const { pathToFileURL } = require('url')

const emitWarningWithoutSqliteNotice = process.emitWarning
process.emitWarning = function (warning, ...rest) {
  const text = typeof warning === 'string' ? warning : (warning && warning.message) || ''
  if (/SQLite/i.test(text)) return
  return emitWarningWithoutSqliteNotice.call(process, warning, ...rest)
}
const { DatabaseSync } = require('node:sqlite')

const VERSION = '1.4.0'
const ESC = '\x1b'
const BEL = '\x07'
const ENTER = '\r'
const BACKSPACE = '\x7f'
const UP = '\u0000up'
const DOWN = '\u0000down'
const LEFT = '\u0000left'
const RIGHT = '\u0000right'
const SHIFT_TAB = '\u0000shift-tab'
const PASTE_START = `${ESC}[200~`
const PASTE_END = `${ESC}[201~`
const STATUS_QUERY = `${ESC}]7501;?${BEL}`
const STATUS_REPLY = `${ESC}]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth${ESC}\\`
const STATUS_REPLY_PATTERN = /\x1b\]7501;\?:[^\x07\x1b]*(?:\x07|\x1b\\)/g
const OTHER_OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CSI_PATTERN = /^\x1b(?:\[[0-9;?<>=]*[ -/]*[@-~]|O[A-Z])/
const CSI_KEYS = { A: UP, B: DOWN, C: RIGHT, D: LEFT, Z: SHIFT_TAB }
const SERVICE_PREFIX = '/exa.language_server_pb.LanguageServerService/'
const PLAN_MODEL = 'MODEL_PLACEHOLDER_M36'
const PROJECT_ID = 'default-cli-project'
const APP_DATA_DIR_NAME = 'antigravity-cli'
const CONTEXT_WINDOW_SIZE = 1048576
const TITLE_LENGTH = 60
const TITLE_DELAY_MS = 500
const RUN_COMMAND_MESSAGE_LENGTH = 100
const RUNNING = 'CASCADE_RUN_STATUS_RUNNING'
const IDLE = 'CASCADE_RUN_STATUS_IDLE'
const INTERRUPTED = 'Interrupted · What should Antigravity CLI do instead?'
const EXECUTOR_500 =
  'generating and executing: Error 500, Message: fake internal error, Status: INTERNAL, Details: []'
const NO_PLAN_MODEL = 'failed to construct executor: plan model not specified'
const MISSING_API_KEY =
  'modelProvider is set to "gemini" in settings.json, but the GEMINI_API_KEY environment variable is not set. Set GEMINI_API_KEY or remove modelProvider from settings.json.'
const AUTH_REQUIRED = "Error: authentication required. Run 'agy' to log in, then retry."
const SYSTEM_MESSAGE_PREFIX =
  'The following is a <SYSTEM_MESSAGE> not actually sent by the user. It was injected by a SessionStart hook:\n'
const WRITTEN_BY_FAKE = 'written by fake agy\n'
const EDITED_LINE = 'edited by fake agy'
const PLAN_ARTIFACT = 'implementation_plan.md'
const WRITTEN_LIST = 'Files the agent wrote this turn:\n'
const CANCELLED = Symbol('cancelled')
const FULL_CASCADE_CONFIG = {
  plannerConfig: { planModel: PLAN_MODEL, requestedModel: { model: PLAN_MODEL } },
  conversationHistoryConfig: { enabled: true },
  toolConfig: { code: { applyEdits: true }, runCommand: { autoCommandConfig: {} } }
}
const MODEL_FAMILIES = [
  {
    base: 'gemini-3.8-flash',
    label: 'Gemini 3.8 Flash',
    efforts: ['high', 'medium', 'low'],
    fallback: 'medium'
  },
  {
    base: 'gemini-3.7-flash',
    label: 'Gemini 3.7 Flash',
    efforts: ['high', 'medium', 'low'],
    fallback: 'medium'
  },
  {
    base: 'gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    efforts: ['high', 'medium', 'low'],
    fallback: 'medium'
  },
  { base: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', efforts: ['high', 'low'], fallback: 'low' }
]
const MODEL_TOOLS = [
  'view_file',
  'run_command',
  'manage_task',
  'send_message',
  'schedule',
  'invoke_subagent',
  'define_subagent',
  'manage_subagents',
  'write_to_file',
  'replace_file_content',
  'read_url_content',
  'search_web',
  'ask_question'
]
const STEP_TYPES = {
  USER_INPUT: 'CORTEX_STEP_TYPE_USER_INPUT',
  PLANNER_RESPONSE: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
  CHECKPOINT: 'CORTEX_STEP_TYPE_CHECKPOINT',
  ERROR_MESSAGE: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
  SYSTEM_MESSAGE: 'CORTEX_STEP_TYPE_SYSTEM_MESSAGE'
}
const TOOL_STEP_TYPES = {
  write_to_file: 'CORTEX_STEP_TYPE_CODE_ACTION',
  replace_file_content: 'CORTEX_STEP_TYPE_CODE_ACTION',
  run_command: 'CORTEX_STEP_TYPE_RUN_COMMAND',
  ask_question: 'CORTEX_STEP_TYPE_ASK_QUESTION',
  invoke_subagent: 'CORTEX_STEP_TYPE_INVOKE_SUBAGENT'
}
const STEP_STATUSES = {
  DONE: 'CORTEX_STEP_STATUS_DONE',
  ERROR: 'CORTEX_STEP_STATUS_ERROR',
  RUNNING: 'CORTEX_STEP_STATUS_RUNNING',
  INVALID: 'CORTEX_STEP_STATUS_INVALID'
}
const CONVERSATION_DB_STEP_TYPES = { USER_INPUT: 14, PLANNER_RESPONSE: 15 }
const CONVERSATION_DB_GENERIC_STEP_TYPE = 90
const BRIEF_MESSAGES = {
  done: 'Task complete',
  command: 'Approve RunCommand',
  question: 'Answer question',
  error: 'Agent stopped with an error'
}
const SUMMARIES_DDL =
  "CREATE TABLE IF NOT EXISTS `conversation_summaries` (`conversation_id` text,`title` text NOT NULL DEFAULT '',`preview` text NOT NULL DEFAULT '',`step_count` integer NOT NULL DEFAULT 0,`last_modified_time` datetime NOT NULL,`workspace_uris` text NOT NULL,`status` text NOT NULL DEFAULT '',`source` text NOT NULL DEFAULT '',`project_id` text NOT NULL DEFAULT '',`agent_name` text NOT NULL DEFAULT '',`parent_conversation_id` text NOT NULL DEFAULT '',`nesting_depth` integer NOT NULL DEFAULT 0,`battle_id` text NOT NULL DEFAULT '',`winning_conversation_id` text NOT NULL DEFAULT '',`not_fully_idle` numeric NOT NULL DEFAULT false,`killed` numeric NOT NULL DEFAULT false,`last_user_input_time` datetime NOT NULL,`last_user_input_step_index` integer NOT NULL DEFAULT -1,`app_data_dir` text NOT NULL DEFAULT '',`raw_summary` blob,`group_id` text NOT NULL DEFAULT '',PRIMARY KEY (`conversation_id`));" +
  'CREATE INDEX IF NOT EXISTS `idx_conversation_summaries_last_user_input_time` ON `conversation_summaries`(`last_user_input_time`);'
const CONVERSATION_DDL =
  'CREATE TABLE IF NOT EXISTS steps (idx integer PRIMARY KEY, step_type integer, status integer, step_payload blob);' +
  'CREATE TABLE IF NOT EXISTS trajectory_meta (id integer PRIMARY KEY, payload blob);' +
  'CREATE TABLE IF NOT EXISTS gen_metadata (idx integer PRIMARY KEY, payload blob);' +
  'CREATE TABLE IF NOT EXISTS executor_metadata (idx integer PRIMARY KEY, payload blob);' +
  'CREATE TABLE IF NOT EXISTS parent_references (id integer PRIMARY KEY, payload blob);' +
  'CREATE TABLE IF NOT EXISTS trajectory_metadata_blob (id integer PRIMARY KEY, payload blob);' +
  'CREATE TABLE IF NOT EXISTS battle_mode_infos (id integer PRIMARY KEY, payload blob);'

const VALUE_FLAGS = new Set([
  '--gemini_dir',
  '--csrf_token',
  '--conversation',
  '-i',
  '--prompt-interactive',
  '--model',
  '--effort',
  '--mode',
  '-p',
  '--print',
  '--output-format',
  '--input-format',
  '--print-timeout',
  '--json-schema',
  '--add-dir',
  '--agent',
  '--app_data_dir'
])
const argv = process.argv.slice(2)
const flags = {}
const positional = []
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  const equals = arg.startsWith('--') ? arg.indexOf('=') : -1
  if (equals > 0) flags[arg.slice(0, equals)] = arg.slice(equals + 1)
  else if (VALUE_FLAGS.has(arg)) flags[arg] = argv[++i] ?? ''
  else if (arg.startsWith('-')) flags[arg] = true
  else positional.push(arg)
}
const flag = (...names) => names.map((n) => flags[n]).find((v) => v !== undefined)

const home = process.env.HOME || os.homedir()
const geminiDir =
  typeof flags['--gemini_dir'] === 'string' ? flags['--gemini_dir'] : path.join(home, '.gemini')
const appDir = path.join(geminiDir, APP_DATA_DIR_NAME)
const configDir = path.join(geminiDir, 'config')
const paths = {
  settings: path.join(appDir, 'settings.json'),
  token: path.join(appDir, 'antigravity-oauth-token'),
  summaries: path.join(appDir, 'conversation_summaries.db'),
  conversations: path.join(appDir, 'conversations'),
  brain: path.join(appDir, 'brain'),
  annotations: path.join(appDir, 'annotations'),
  presence: path.join(appDir, 'presence'),
  cache: path.join(appDir, 'cache'),
  onboarding: path.join(appDir, 'cache', 'onboarding.json'),
  lastConversations: path.join(appDir, 'cache', 'last_conversations.json'),
  history: path.join(appDir, 'history.jsonl'),
  userHooks: path.join(configDir, 'hooks.json'),
  project: path.join(configDir, 'projects', `${PROJECT_ID}.json`)
}
const workspace = (() => {
  const given = process.env.PWD
  try {
    if (given && fs.realpathSync(given) === fs.realpathSync(process.cwd())) return given
  } catch {}
  return process.cwd()
})()
const printMode = flag('-p', '--print') !== undefined
const skipPermissions = flags['--dangerously-skip-permissions'] === true
const planMode = flag('--mode') === 'plan'
let acceptEdits = flag('--mode') === 'accept-edits'
const csrfToken = typeof flags['--csrf_token'] === 'string' ? flags['--csrf_token'] : undefined
const internalToken = crypto.randomUUID()

const sentinel = (name) => path.join(home, name)
const readSentinel = (name, fallback) => {
  try {
    return fs.readFileSync(sentinel(name), 'utf8').trim()
  } catch {
    return fallback
  }
}
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}
const appendJsonl = (file, value) => {
  try {
    fs.appendFileSync(file, JSON.stringify(value) + '\n')
  } catch {}
}
const sortKeys = (value) =>
  Array.isArray(value)
    ? value.map(sortKeys)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, sortKeys(value[k])])
        )
      : value
const dbTime = (date = new Date()) =>
  date.toISOString().replace('T', ' ').replace('Z', '000000+00:00')
const stepTime = (date = new Date()) => date.toISOString().replace(/\.\d{3}Z$/, 'Z')
const firstLine = (text) => (text.split('\n').find((l) => l.trim()) ?? '').trim()
const turnDelayMs = () => Number(readSentinel('fake-agy-delay', '300'))
const uuidFrom = (seed) => {
  const hex = crypto.createHash('sha1').update(seed).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}
const trajectoryIdOf = (id) => uuidFrom(`${id}:trajectory`)
const base64url = (text) => Buffer.from(text).toString('base64url')

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true })
  } catch (error) {
    let target
    try {
      target = path.resolve(path.dirname(dir), fs.readlinkSync(dir))
    } catch {
      throw error
    }
    fs.mkdirSync(target, { recursive: true })
  }
}
function writeReplacing(file, text, mode) {
  ensureDir(path.dirname(file))
  const temporary = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temporary, text, mode ? { mode } : undefined)
  fs.renameSync(temporary, file)
}
function ensureSharedDirs() {
  for (const dir of [
    paths.conversations,
    paths.brain,
    paths.annotations,
    paths.presence,
    paths.cache
  ])
    ensureDir(dir)
}

appendJsonl(sentinel('fake-agy-calls.jsonl'), {
  pid: process.pid,
  argv,
  cwd: process.cwd(),
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) =>
          k.startsWith('KOLOFT_') ||
          [
            'SSH_CONNECTION',
            'SSH_TTY',
            'SSH_CLIENT',
            'WSL_DISTRO_NAME',
            'WSL_INTEROP',
            'AGY_CLI_OSC7501',
            'AGY_CLI_OSC7501_MESSAGES',
            'AGY_CLI_DISABLE_AUTO_UPDATE',
            'GOOGLE_GEMINI_BASE_URL'
          ].includes(k)
      )
    ),
    GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY),
    pathHead: (process.env.PATH || '').split(':')[0]
  },
  geminiDir
})

const readSettings = () => readJson(paths.settings, {})
function writeSettings(patch) {
  const next = sortKeys({ ...readSettings(), ...patch })
  writeReplacing(paths.settings, JSON.stringify(next, null, 2), 0o600)
}
const apiKeyRoute = () => readSettings().modelProvider === 'gemini'
const signedIn = () => apiKeyRoute() || fs.existsSync(paths.token)
const onboardingDone = () => {
  const o = readJson(paths.onboarding, {})
  return o.onboardingComplete === true || o.consumerOnboardingComplete === true
}
const trusted = () => (readSettings().trustedWorkspaces ?? []).includes(workspace)
const signedInEmail = () => {
  try {
    const idToken = JSON.parse(fs.readFileSync(paths.token, 'utf8')).id_token
    return JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8')).email
  } catch {
    return readSentinel('fake-agy-email', 'fake-user@example.com')
  }
}

function resolveModel(name, effortFlag) {
  const wanted = name || 'gemini-3.1-pro-low'
  let family
  let effort
  for (const f of MODEL_FAMILIES) {
    if (wanted === f.base) family = f
    else if (
      wanted.startsWith(f.base + '-') &&
      f.efforts.includes(wanted.slice(f.base.length + 1))
    ) {
      family = f
      effort = wanted.slice(f.base.length + 1)
    }
  }
  if (!family)
    return {
      error: `error: unknown model "${wanted}". Available models:\n${modelRows().join('\n')}`
    }
  effort = effortFlag || effort || family.fallback
  if (!family.efforts.includes(effort))
    return { error: `error: effort "${effort}" is not supported by ${family.base}` }
  const label = `${family.label} (${effort[0].toUpperCase()}${effort.slice(1)})`
  return { id: `${family.base}-${effort}`, display_name: label, effort }
}
function modelRows() {
  return MODEL_FAMILIES.flatMap((f) =>
    f.efforts.map((e) => `${f.base}-${e}\t${f.label} (${e[0].toUpperCase()}${e.slice(1)})`)
  )
}
let model = resolveModel()

const brainDir = (id) => path.join(paths.brain, id)
const logsDir = (id) => path.join(brainDir(id), '.system_generated', 'logs')
const transcriptPath = (id) => path.join(logsDir(id), 'transcript.jsonl')
const transcriptFullPath = (id) => path.join(logsDir(id), 'transcript_full.jsonl')
const conversationDbPath = (id) => path.join(paths.conversations, `${id}.db`)

function withDb(file, work) {
  const db = new DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    return work(db)
  } finally {
    db.close()
  }
}
function withSummaries(work) {
  ensureDir(appDir)
  return withDb(paths.summaries, (db) => {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(SUMMARIES_DDL)
    return work(db)
  })
}
function readSummary(id) {
  if (!fs.existsSync(paths.summaries)) return undefined
  return withSummaries((db) =>
    db.prepare('SELECT * FROM conversation_summaries WHERE conversation_id = ?').get(id)
  )
}
function insertSummary(id, fields = {}) {
  const now = dbTime()
  const row = {
    conversation_id: id,
    title: '',
    preview: '',
    step_count: 0,
    last_modified_time: now,
    workspace_uris: JSON.stringify([pathToFileURL(workspace).href]),
    status: IDLE,
    source: '',
    project_id: PROJECT_ID,
    agent_name: '',
    parent_conversation_id: '',
    nesting_depth: 0,
    not_fully_idle: 0,
    killed: 0,
    last_user_input_time: now,
    app_data_dir: APP_DATA_DIR_NAME,
    group_id: '',
    ...fields
  }
  const keys = Object.keys(row)
  withSummaries((db) =>
    db
      .prepare(
        `INSERT OR REPLACE INTO conversation_summaries (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
      )
      .run(...keys.map((k) => row[k]))
  )
}
function updateSummary(id, fields) {
  const keys = Object.keys(fields)
  withSummaries((db) =>
    db
      .prepare(
        `UPDATE conversation_summaries SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE conversation_id = ?`
      )
      .run(...keys.map((k) => fields[k]), id)
  )
}
const conversationExists = (id) =>
  Boolean(id) && (Boolean(readSummary(id)) || fs.existsSync(conversationDbPath(id)))
function readTranscript(id, full = true) {
  try {
    return fs
      .readFileSync(full ? transcriptFullPath(id) : transcriptPath(id), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  } catch {
    return []
  }
}
function writeAnnotation(id, title) {
  ensureDir(paths.annotations)
  fs.writeFileSync(
    path.join(paths.annotations, `${id}.pbtxt`),
    `title:"${title.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`
  )
}
function storeTitle(id, title) {
  updateSummary(id, { title, preview: title })
  writeAnnotation(id, title)
}
function setLastConversation(id) {
  const map = readJson(paths.lastConversations, {})
  map[workspace] = id
  writeReplacing(paths.lastConversations, JSON.stringify(map))
}
function logHistory(display, type) {
  ensureDir(appDir)
  appendJsonl(paths.history, {
    display,
    timestamp: Date.now(),
    workspace,
    conversationId: conversation?.id ?? '',
    ...(type ? { type } : {})
  })
}

function presenceHeldElsewhere(file) {
  if (!fs.existsSync(file)) return false
  const probe = spawnSync('perl', [
    '-MFcntl=:flock',
    '-e',
    'open(my $f, "<", $ARGV[0]) or exit 0; exit(flock($f, LOCK_EX|LOCK_NB) ? 0 : 1)',
    file
  ])
  return probe.status === 1
}
function holdPresence(id) {
  ensureDir(paths.presence)
  const file = path.join(paths.presence, `${id}.lock`)
  if (presenceHeldElsewhere(file)) return null
  const fd = fs.openSync(file, 'a', 0o600)
  spawnSync('perl', ['-MFcntl=:flock', '-e', 'flock(STDIN, LOCK_EX|LOCK_NB) or exit 1'], {
    stdio: [fd, 'ignore', 'ignore']
  })
  return fd
}
function releasePresence(c) {
  if (c?.lockFd == null) return
  try {
    fs.closeSync(c.lockFd)
  } catch {}
  c.lockFd = null
}

function conversationRecord(id, fields = {}) {
  return {
    id,
    nextStep: 0,
    apiCount: 0,
    title: '',
    conversationTitle: null,
    needsSessionStart: true,
    settingsAnnounced: false,
    systemMessages: [],
    userConfigs: {},
    lockFd: null,
    executions: 0,
    tasks: 0,
    totals: { input: 0, output: 0, cacheRead: 0, lastInput: 0 },
    ...fields
  }
}
function createConversation(rowFields = {}) {
  ensureSharedDirs()
  const id = crypto.randomUUID()
  ensureDir(logsDir(id))
  ensureDir(path.join(brainDir(id), '.user_uploaded'))
  ensureDir(path.join(brainDir(id), 'scratch'))
  fs.appendFileSync(transcriptPath(id), '')
  fs.appendFileSync(transcriptFullPath(id), '')
  withDb(conversationDbPath(id), (db) => db.exec(CONVERSATION_DDL))
  insertSummary(id, rowFields)
  if (!fs.existsSync(paths.project)) {
    ensureDir(path.dirname(paths.project))
    fs.writeFileSync(
      paths.project,
      JSON.stringify({ id: PROJECT_ID, name: 'CLI Project', projectResources: {} })
    )
  }
  return id
}
function loadConversation(id) {
  const row = readSummary(id)
  const lines = readTranscript(id)
  const lastIndex = lines.reduce((m, l) => Math.max(m, l.step_index ?? -1), -1)
  return conversationRecord(id, {
    nextStep: Math.max(row?.step_count ?? 0, lastIndex + 1),
    apiCount: lines.length,
    title: row?.title ?? '',
    conversationTitle: row?.title || null,
    needsSessionStart: false,
    settingsAnnounced: true,
    systemMessages: lines
      .filter((l) => l.type === 'SYSTEM_MESSAGE')
      .map((l) => String(l.content ?? '').replace(SYSTEM_MESSAGE_PREFIX, ''))
  })
}

const stringArgs = (args) =>
  Object.fromEntries(
    Object.entries(args).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])
  )
function writeStep(c, record) {
  const index = c.nextStep++
  const full = {
    step_index: index,
    source: record.source,
    type: record.type,
    status: record.status ?? 'DONE',
    created_at: stepTime()
  }
  if (record.error) full.error = record.error
  if (record.tokens) {
    full.input_tokens = record.tokens.input
    full.cache_read_tokens = record.tokens.cacheRead
    full.output_tokens = record.tokens.output
  }
  if (record.content !== undefined) full.content = record.content
  if (record.toolCalls) full.tool_calls = record.toolCalls
  const flat = { ...full }
  if (full.tool_calls)
    flat.tool_calls = full.tool_calls.map((t) => ({ name: t.name, args: stringArgs(t.args) }))
  ensureDir(logsDir(c.id))
  fs.appendFileSync(transcriptPath(c.id), JSON.stringify(flat) + '\n')
  fs.appendFileSync(transcriptFullPath(c.id), JSON.stringify(full) + '\n')
  withDb(conversationDbPath(c.id), (db) => {
    db.exec(CONVERSATION_DDL)
    db.prepare(
      'INSERT OR REPLACE INTO steps (idx, step_type, status, step_payload) VALUES (?, ?, ?, ?)'
    ).run(
      index,
      CONVERSATION_DB_STEP_TYPES[full.type] ?? CONVERSATION_DB_GENERIC_STEP_TYPE,
      full.status === 'DONE' ? 3 : 4,
      Buffer.from(JSON.stringify(full))
    )
  })
  if (record.userConfig) c.userConfigs[index] = record.userConfig
  updateSummary(c.id, { step_count: c.nextStep, last_modified_time: dbTime() })
  const position = c.apiCount++
  const previous = position > 0 ? readTranscript(c.id)[position - 1] : undefined
  streamPush(c, {
    mainTrajectoryUpdate: {
      stepsUpdate: { indices: [position], steps: [apiStepOf(c, full, previous)] }
    }
  })
  return index
}
const requestText = (content) => {
  const match = /<USER_REQUEST>\n([\s\S]*?)\n<\/USER_REQUEST>/.exec(content ?? '')
  return match ? match[1] : (content ?? '')
}
function apiStepOf(c, record, previous) {
  const toolName = previous?.tool_calls?.[0]?.name
  const step = {
    type: STEP_TYPES[record.type] ?? TOOL_STEP_TYPES[toolName] ?? 'CORTEX_STEP_TYPE_GENERIC',
    status: STEP_STATUSES[record.status] ?? STEP_STATUSES.DONE,
    metadata: { createdAt: record.created_at, stepIndex: record.step_index }
  }
  if (record.type === 'USER_INPUT')
    step.userInput = {
      items: [{ text: requestText(record.content) }],
      userConfig: c?.userConfigs?.[record.step_index] ?? FULL_CASCADE_CONFIG
    }
  else if (record.type === 'PLANNER_RESPONSE') {
    step.plannerResponse = {
      response: record.content ?? '',
      toolCalls: (record.tool_calls ?? []).map((t) => ({
        name: t.name,
        argumentsJson: JSON.stringify(t.args)
      }))
    }
    step.metadata.modelUsage = {
      model: PLAN_MODEL,
      inputTokens: String(record.input_tokens ?? 0),
      outputTokens: String(record.output_tokens ?? 0),
      thinkingOutputTokens: '3',
      responseOutputTokens: String(record.output_tokens ?? 0),
      cacheReadTokens: String(record.cache_read_tokens ?? 0)
    }
  } else step.output = { content: record.content ?? '' }
  if (record.error) step.error = { userErrorMessage: record.error }
  return step
}
function trajectorySteps(id) {
  const c = conversation?.id === id ? conversation : undefined
  const lines = readTranscript(id)
  const steps = lines.map((l, i) => apiStepOf(c, l, lines[i - 1]))
  if (pendingAsk && pendingAsk.conv.id === id) steps.push(pendingAsk.waitingStep)
  return steps
}

function hookCommands(event, toolName) {
  const sources = [
    [paths.userHooks, configDir],
    [path.join(workspace, '.agents', 'hooks.json'), path.join(workspace, '.agents')]
  ]
  const commands = []
  for (const [file, cwd] of sources) {
    const config = readJson(file, null)
    if (!config || typeof config !== 'object') continue
    for (const block of Object.values(config)) {
      if (!block || typeof block !== 'object' || block.enabled === false) continue
      for (const entry of Array.isArray(block[event]) ? block[event] : []) {
        if (event === 'PreToolUse' || event === 'PostToolUse') {
          if (!matcherFits(entry.matcher, toolName)) continue
          for (const hook of entry.hooks ?? []) commands.push({ ...hook, cwd })
        } else commands.push({ ...entry, cwd })
      }
    }
  }
  return commands.filter((h) => typeof h.command === 'string')
}
function matcherFits(matcher, toolName) {
  if (!matcher || matcher === '*') return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName)
  } catch {
    return matcher === toolName
  }
}
function fireHook(event, conversationId, extra = {}) {
  const input = JSON.stringify(
    sortKeys({
      artifactDirectoryPath: brainDir(conversationId),
      conversationId,
      modelName: model.id,
      transcriptPath: transcriptFullPath(conversationId),
      workspacePaths: [workspace],
      ...extra
    })
  )
  return hookCommands(event, extra.toolCall?.name).map((hook) => {
    const run = spawnSync('/bin/sh', ['-c', hook.command], {
      cwd: hook.cwd,
      input,
      encoding: 'utf8',
      env: { ...process.env, ANTIGRAVITY_CONVERSATION_ID: conversationId },
      timeout: (Number(hook.timeout) || 60) * 1000
    })
    return (run.stdout ?? '').trim()
  })
}
function injectedTexts(outputs, kind) {
  const texts = []
  for (const out of outputs) {
    let parsed
    try {
      parsed = JSON.parse(out)
    } catch {
      continue
    }
    for (const step of parsed?.injectSteps ?? []) {
      const text = kind === 'system' ? step?.systemMessage?.systemMessage : step?.ephemeralMessage
      if (typeof text === 'string') texts.push(text)
    }
  }
  return texts
}
function preToolVerdict(outputs) {
  for (const out of outputs) {
    if (!out) continue
    let parsed
    try {
      parsed = JSON.parse(out)
    } catch {
      return { denied: `pre-tool hook returned output that is not JSON: ${out}` }
    }
    const decision = parsed?.decision
    if (decision === 'deny')
      return { denied: `tool call denied by pre-tool hook: ${parsed.reason ?? ''}` }
    if (decision === 'force_ask') return { forceAsk: true, reason: parsed.reason ?? '' }
    if (decision === 'allow' || decision === 'ask') continue
    return { denied: 'tool call denied by pre-tool hook: ' }
  }
  return {}
}

let conversation = null
let turnRunning = false
let turnCancelled = false
let cancelPause = null
let pendingAsk = null
let panel = null
let review = null
let phase = 'start'
let typed = ''
let pasteBuffer = null
let trustCursor = 0
const queue = []
const term = {
  statusOn: process.env.AGY_CLI_OSC7501 === 'on',
  statusOff: process.env.AGY_CLI_OSC7501 === 'off',
  lastFrame: null,
  idleOnNextKey: false,
  agentState: 'authenticating',
  lastTitle: undefined,
  lastStatusLine: undefined
}
const api = { port: 0, subscribers: new Set() }

function write(text) {
  if (!printMode) process.stdout.write(text)
}
function say(text) {
  write(String(text).replace(/\r?\n/g, '\r\n') + '\r\n')
}
function sendFrame(state, kind, message) {
  if (term.statusOff || printMode) return
  let text = message
  if (process.env.AGY_CLI_OSC7501_MESSAGES === 'brief') {
    if (state === 'done') text = BRIEF_MESSAGES.done
    else if (state === 'error') text = BRIEF_MESSAGES.error
    else if (kind === 'question') text = BRIEF_MESSAGES.question
    else if (kind === 'permission' && String(message).startsWith('Approve RunCommand'))
      text = BRIEF_MESSAGES.command
  }
  let frame = `${ESC}]7501;state=${state}`
  if (kind) frame += `:kind=${kind}`
  frame += ':app=antigravity'
  if (text) frame += `:msg=${Buffer.from(String(text), 'utf8').toString('base64')}`
  frame += BEL
  term.lastFrame = frame
  if (term.statusOn) process.stdout.write(frame)
}
function statusInput() {
  const c = conversation
  const t = c?.totals ?? { input: 0, output: 0, cacheRead: 0, lastInput: 0 }
  const used = Math.round(((t.lastInput + t.cacheRead) / CONTEXT_WINDOW_SIZE) * 10000) / 100
  return {
    agent_state: term.agentState,
    context_window: {
      context_window_size: CONTEXT_WINDOW_SIZE,
      current_usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: t.cacheRead,
        input_tokens: t.lastInput,
        output_tokens: t.output
      },
      remaining_percentage: Math.round((100 - used) * 100) / 100,
      total_input_tokens: t.input,
      total_output_tokens: t.output,
      used_percentage: used
    },
    conversation_id: c?.id ?? '',
    conversation_title: c?.conversationTitle ?? null,
    cwd: process.cwd(),
    exceeds_200k_tokens: false,
    model: term.agentState === 'authenticating' ? null : { ...model },
    product: 'antigravity',
    sandbox: { enabled: flags['--sandbox'] === true },
    session_id: c?.id ?? '',
    terminal_width: process.stdout.columns || 80,
    tool_confirmation_pending: Boolean(pendingAsk),
    transcript_path: c
      ? path.join(
          geminiDir,
          'antigravity',
          'brain',
          c.id,
          '.system_generated',
          'logs',
          'transcript.jsonl'
        )
      : '',
    version: VERSION,
    workspace: { current_dir: workspace, project_dir: workspace }
  }
}
function runScripts() {
  if (printMode) return
  const settings = readSettings()
  const input = JSON.stringify(statusInput())
  const run = (command) =>
    spawnSync('/bin/sh', ['-c', command], {
      input,
      encoding: 'utf8',
      env: process.env,
      timeout: 10000
    })
  if (typeof settings.title?.command === 'string') {
    const title = (run(settings.title.command).stdout ?? '').split('\n')[0].replace(/\r$/, '')
    if (title !== term.lastTitle) {
      term.lastTitle = title
      write(`${ESC}]2;${title}${BEL}`)
    }
  }
  if (typeof settings.statusLine?.command === 'string') {
    const result = run(settings.statusLine.command)
    if (result.status !== 0)
      say(`⚠ Statusline Error\n⎿ command failed: exit status ${result.status}`)
    else {
      const lines = (result.stdout ?? '').replace(/\n$/, '')
      if (lines !== term.lastStatusLine) {
        term.lastStatusLine = lines
        if (lines) say(lines)
      }
    }
  }
}
function setAgentState(state) {
  if (state === term.agentState) return
  term.agentState = state
  runScripts()
}
function streamPush(c, extra = {}) {
  if (!c) return
  for (const sub of api.subscribers) {
    if (sub.id !== c.id) continue
    const status = extra.status ?? (turnRunning && conversation?.id === c.id ? RUNNING : IDLE)
    sub.res.write(
      envelope({
        update: {
          conversationId: c.id,
          trajectoryId: trajectoryIdOf(c.id),
          status,
          executableStatus: IDLE,
          executorLoopStatus: status,
          ...extra
        }
      })
    )
  }
}
function envelope(message, messageFlags = 0) {
  const json = Buffer.from(JSON.stringify(message))
  const head = Buffer.alloc(5)
  head.writeUInt8(messageFlags, 0)
  head.writeUInt32BE(json.length, 1)
  return Buffer.concat([head, json])
}

function ensureConversation() {
  if (conversation) return conversation
  const id = createConversation()
  conversation = conversationRecord(id)
  conversation.lockFd = holdPresence(id)
  runScripts()
  return conversation
}
function openStored(id) {
  if (!conversationExists(id)) return false
  if (conversation?.id === id) return true
  releasePresence(conversation)
  conversation = loadConversation(id)
  conversation.lockFd = holdPresence(id)
  if (conversation.lockFd === null)
    say(
      '⚠ Conversation already open\n⎿ When you opened this conversation it was already open in another CLI instance on this machine. Sending messages from both may cause conflicts. Use /fork to continue here separately.'
    )
  setLastConversation(id)
  return true
}
function scheduleTitle(c, text) {
  if (c.title || c.titleScheduled) return
  c.titleScheduled = true
  const title = firstLine(text).slice(0, TITLE_LENGTH)
  const store = () => {
    if (c.title) return
    c.title = title
    storeTitle(c.id, title)
  }
  if (printMode) store()
  else setTimeout(store, TITLE_DELAY_MS)
}
function spend(c) {
  const tokens = { input: 1200 + 100 * c.nextStep, cacheRead: 300, output: 40 }
  c.totals.input += tokens.input
  c.totals.output += tokens.output
  c.totals.cacheRead = tokens.cacheRead
  c.totals.lastInput = tokens.input
  return tokens
}
function pause(ms) {
  if (turnCancelled) return Promise.reject(CANCELLED)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cancelPause = null
      resolve()
    }, ms)
    cancelPause = () => {
      clearTimeout(timer)
      cancelPause = null
      reject(CANCELLED)
    }
  })
}
function cancelTurn() {
  if (!turnRunning) return false
  if (pendingAsk) pendingAsk.resolve({ cancelled: true })
  else if (cancelPause) cancelPause()
  else turnCancelled = true
  return true
}

function writeUserInput(c, text, userConfig) {
  let content = `<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe current local time is: ${stepTime()}.\n</ADDITIONAL_METADATA>`
  if (!c.settingsAnnounced) {
    c.settingsAnnounced = true
    content += `\n<USER_SETTINGS_CHANGE>\nThe user changed setting \`Model Selection\` from None to ${model.display_name}. No need to comment on this change if the user doesn't ask about it.\n</USER_SETTINGS_CHANGE>`
  }
  const index = writeStep(c, {
    source: 'USER_EXPLICIT',
    type: 'USER_INPUT',
    content,
    userConfig
  })
  updateSummary(c.id, { last_user_input_time: dbTime(), last_user_input_step_index: index })
  return index
}
function startSession(c) {
  if (!c.needsSessionStart) return
  c.needsSessionStart = false
  for (const text of injectedTexts(fireHook('SessionStart', c.id), 'system')) {
    c.systemMessages.push(text)
    writeStep(c, {
      source: 'SYSTEM',
      type: 'SYSTEM_MESSAGE',
      content: SYSTEM_MESSAGE_PREFIX + text
    })
    appendJsonl(sentinel('fake-agy-injected.jsonl'), {
      event: 'SessionStart',
      conversationId: c.id,
      systemMessage: text
    })
  }
}
function beginUserTurn(turn, text) {
  const c = turn.conv
  writeUserInput(c, planMode ? `/plan ${text}` : text, turn.origin.cascadeConfig)
  startSession(c)
  scheduleTitle(c, text)
  setLastConversation(c.id)
}
async function modelCall(turn, response = {}) {
  const c = turn.conv
  const meta = { initialNumSteps: c.nextStep, invocationNum: turn.invocation }
  const ephemeral = injectedTexts(fireHook('PreInvocation', c.id, meta), 'ephemeral')
  appendJsonl(sentinel('fake-agy-injected.jsonl'), {
    event: 'request',
    conversationId: c.id,
    invocationNum: turn.invocation,
    systemMessages: c.systemMessages,
    ephemeralMessages: ephemeral
  })
  if (!printMode) await pause(turnDelayMs())
  fireHook('PostInvocation', c.id, meta)
  turn.invocation++
  return writeStep(c, {
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    content: response.content ?? '',
    toolCalls: response.toolCalls,
    tokens: spend(c)
  })
}
const stamped = (body) => {
  const now = stepTime()
  return `Created At: ${now}\nCompleted At: ${now}\n${body}`
}
function markIdle(c, fullyIdle = true) {
  updateSummary(c.id, { status: IDLE, not_fully_idle: fullyIdle ? 0 : 1 })
  streamPush(c, { status: IDLE, executorLoopStatus: IDLE, fullyIdle })
}
function fireStop(c, fields) {
  fireHook('Stop', c.id, { error: '', executionNum: c.executions++, fullyIdle: true, ...fields })
}
async function finishTurn(turn, reply, options = {}) {
  const {
    fullyIdle = true,
    terminationReason = 'NO_TOOL_CALL',
    ending = 'done',
    agentState = 'idle'
  } = options
  const c = turn.conv
  await modelCall(turn, { content: reply })
  say(reply)
  fireStop(c, { fullyIdle, terminationReason })
  markIdle(c, fullyIdle)
  setAgentState(agentState)
  if (ending === 'done') {
    sendFrame('done', null, reply)
    term.idleOnNextKey = true
  } else if (ending === 'plan') sendFrame('blocked', 'permission', 'Approve plan')
}
async function failTurn(turn, error) {
  const c = turn.conv
  fireHook('PreInvocation', c.id, { initialNumSteps: c.nextStep, invocationNum: turn.invocation })
  await pause(turnDelayMs())
  c.nextStep++
  say(`⚠ agent executor error: ${error}\nError ID: ${crypto.randomBytes(8).toString('hex')}`)
  fireStop(c, { error, terminationReason: 'ERROR' })
  markIdle(c)
  setAgentState('idle')
  sendFrame('error', null, `agent executor error: ${error}`)
  term.idleOnNextKey = true
}
function declineTurn(turn, words) {
  if (words) say(words)
  say(`⎿ ${INTERRUPTED}`)
  markIdle(turn.conv)
  setAgentState('idle')
  sendFrame('idle')
}

function askUser(turn, ask) {
  const c = turn.conv
  return new Promise((resolve) => {
    const position = c.apiCount
    const waitingStep = {
      type: ask.stepType,
      status: 'CORTEX_STEP_STATUS_WAITING',
      requestedInteraction: ask.requestedInteraction,
      metadata: { createdAt: stepTime(), stepIndex: c.nextStep }
    }
    pendingAsk = {
      conv: c,
      position,
      waitingStep,
      fromApi: ask.fromApi,
      onKey: (key) => {
        const answer = ask.onKey(key)
        if (answer) pendingAsk.resolve(answer)
      },
      resolve: (answer) => {
        pendingAsk = null
        resolve(answer)
      }
    }
    say(ask.screen)
    updateSummary(c.id, { status: RUNNING, not_fully_idle: 1 })
    streamPush(c, {
      mainTrajectoryUpdate: { stepsUpdate: { indices: [position], steps: [waitingStep] } }
    })
    setAgentState('tool_use')
    sendFrame('blocked', ask.frame[0], ask.frame[1])
  })
}
async function useTool(turn, tool) {
  const c = turn.conv
  await modelCall(turn, { toolCalls: [{ name: tool.name, args: tool.args }] })
  const stepIdx = c.nextStep
  const toolCall = { args: tool.args, name: tool.name }
  const verdict = preToolVerdict(fireHook('PreToolUse', c.id, { stepIdx, toolCall }))
  if (verdict.denied) {
    writeStep(c, {
      source: 'MODEL',
      type: 'GENERIC',
      status: 'ERROR',
      error: verdict.denied,
      content: stamped('')
    })
    if (tool.name === 'write_to_file' || tool.name === 'replace_file_content') say('Edited 1 file')
    return { denied: verdict.denied }
  }
  if (tool.ask && (tool.ask.needed || verdict.forceAsk)) {
    if (verdict.forceAsk) tool.ask.screen += `\nReason: ${verdict.reason}`
    const answer = await askUser(turn, tool.ask)
    if (answer.cancelled) throw CANCELLED
    if (!answer.allow) {
      if (answer.via === 'api' && tool.ask.deniedError) {
        writeStep(c, {
          source: 'MODEL',
          type: 'GENERIC',
          status: 'ERROR',
          error: tool.ask.deniedError,
          content: stamped('')
        })
        return { apiDenied: true }
      }
      if (answer.via === 'confirm-only') return { notRun: true }
      if (answer.via === 'key' && tool.ask.deniedError)
        writeStep(c, {
          source: 'MODEL',
          type: 'GENERIC',
          status: 'ERROR',
          error: tool.ask.deniedError,
          content: stamped('')
        })
      return { declined: answer.via }
    }
    if (answer.fromApi) say('Answered from another device.')
    sendFrame('working', null, c.conversationTitle || undefined)
    setAgentState('working')
    updateSummary(c.id, { status: RUNNING, not_fully_idle: 0 })
    tool.answer = answer
  }
  const result = await tool.run(stepIdx, toolCall)
  writeStep(c, {
    source: 'MODEL',
    type: 'GENERIC',
    status: result.error ? 'ERROR' : 'DONE',
    error: result.error,
    content: stamped(result.content)
  })
  if (!result.error && !result.background)
    fireHook('PostToolUse', c.id, { error: '', stepIdx, toolCall })
  return result
}
async function endToolTurn(turn, result, success, failure) {
  if (result.denied) return finishTurn(turn, `Denied: ${result.denied}`)
  if (result.apiDenied) return finishTurn(turn, `Denied: ${failure}`)
  if (result.notRun) return finishTurn(turn, `Not run: ${failure}`)
  if (result.declined)
    return declineTurn(turn, result.declined === 'key' ? 'User declined the tool call' : '')
  return finishTurn(turn, success)
}

function fileAsk(turn, file, kind) {
  const create = kind === 'create'
  const apiMinimal = turn.origin.api && !turn.origin.fullConfig
  return {
    needed: !(acceptEdits || skipPermissions || apiMinimal),
    stepType: 'CORTEX_STEP_TYPE_CODE_ACTION',
    requestedInteraction: {
      permission: {
        resource: { action: 'write_file', target: file },
        actionDescription: `Write: ${file}`,
        triggerSource: { type: 'TYPE_DEFAULT_GRANT', detail: 'write_file(/)' }
      }
    },
    frame: [
      'permission',
      `Approve ${create ? 'WriteToFile' : 'ReplaceFileContent'}: Write: ${file}`
    ],
    screen: create
      ? `${file}\n+ ${WRITTEN_BY_FAKE.trim()}\nAllow creation of this file?\n> 1. Yes, allow creation\n  2. No, deny creation`
      : `${file}\nAccept this file edit?\n> 1. Yes, accept this change\n  2. No, reject this change\nshift+tab to auto-approve file edits`,
    deniedError: `user denied permission for write_file(${file})`,
    onKey: (key) => {
      if (key === '1' || key === ENTER) return { allow: true }
      if (key === '2') return { allow: false, via: 'key' }
      if (key === ESC) return { allow: false, via: 'key' }
      if (key === SHIFT_TAB && !create) {
        acceptEdits = true
        say('Accept-edits mode: file edits auto-approved')
        return { allow: true }
      }
      return undefined
    },
    fromApi: (interaction) =>
      interaction.permission
        ? interaction.permission.allow
          ? { allow: true, fromApi: true }
          : { allow: false, via: 'api' }
        : undefined
  }
}
function commandAsk(cmd) {
  const prefix = cmd.split(/\s+/)[0]
  const shellName = path.basename(modelShell())
  return {
    needed: !skipPermissions,
    stepType: 'CORTEX_STEP_TYPE_RUN_COMMAND',
    requestedInteraction: {
      permission: {
        resource: { action: 'command', target: cmd },
        persistSuggestionType: 'PERSIST_SUGGESTION_TYPE_PREFIX',
        suggestedPersistPattern: `${prefix} *`,
        triggerSource: { type: 'TYPE_DEFAULT_GRANT', detail: 'command(*)' },
        shellName
      }
    },
    frame: ['permission', `Approve RunCommand: ${cmd}`.slice(0, RUN_COMMAND_MESSAGE_LENGTH)],
    screen: `Run this command?\n  ${cmd}\n> 1. Yes, run command\n  2. Yes, and always allow in this conversation (${prefix})\n  3. Yes, and always allow (Persist to settings.json)\n  4. No, cancel`,
    deniedError: `permission check failed for command ${cmd}: user denied permission`,
    onKey: (key) => {
      if (key === '1' || key === '2' || key === '3' || key === ENTER) return { allow: true }
      if (key === '4') return { allow: false, via: 'key' }
      if (key === ESC) return { allow: false, via: 'esc' }
      return undefined
    },
    fromApi: (interaction) => {
      if (interaction.permission)
        return interaction.permission.allow
          ? { allow: true, fromApi: true }
          : { allow: false, via: 'api' }
      if (interaction.runCommand) return { allow: false, via: 'confirm-only' }
      return undefined
    }
  }
}
const modelShell = () =>
  process.platform === 'darwin' ? process.env.SHELL || '/bin/zsh' : '/bin/bash'
function runCommandEnv(c, stepIdx, toolCall) {
  return {
    ...process.env,
    PATH: `${path.join(appDir, 'bin')}:${process.env.PATH || ''}`,
    TERM: 'dumb',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GIT_EDITOR: 'false',
    HGEDITOR: 'false',
    JJ_EDITOR: 'false',
    JJ_PAGER: 'cat',
    ANTIGRAVITY_AGENT: '1',
    ANTIGRAVITY_CONVERSATION_ID: c.id,
    ANTIGRAVITY_TRAJECTORY_ID: trajectoryIdOf(c.id),
    ANTIGRAVITY_PROJECT_ID: PROJECT_ID,
    ANTIGRAVITY_SOURCE_METADATA: JSON.stringify({
      conversationId: c.id,
      stepIndex: stepIdx,
      toolCall
    }),
    ANTIGRAVITY_LS_ADDRESS: `localhost:${api.port}`,
    ANTIGRAVITY_CSRF_TOKEN: internalToken,
    ANTIGRAVITY_APP_DATA_DIR: appDir,
    ANTIGRAVITY_AGENTAPI_EXE: process.argv[1]
  }
}
function runShell(shell, cmd, env, logFile) {
  return new Promise((resolve) => {
    const child = spawn(shell, ['-c', cmd], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let output = ''
    const collect = (chunk) => {
      output += chunk
      if (logFile) fs.appendFileSync(logFile, chunk)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (error) => resolve({ code: 127, output: String(error.message) }))
    child.on('close', (code) => resolve({ code: code ?? 1, output }))
  })
}

async function writeScenario(turn, target) {
  const shown = target || 'fake-agy.txt'
  const file = path.resolve(process.cwd(), shown)
  const args = {
    TargetFile: file,
    CodeContent: WRITTEN_BY_FAKE,
    Overwrite: fs.existsSync(file),
    Description: `Write ${path.basename(file)}`,
    toolAction: 'Writing file',
    toolSummary: path.basename(file)
  }
  const result = await useTool(turn, {
    name: 'write_to_file',
    args,
    ask: fileAsk(turn, file, 'create'),
    run: () => {
      ensureDir(path.dirname(file))
      fs.writeFileSync(file, WRITTEN_BY_FAKE)
      return { content: `Created file ${pathToFileURL(file).href} with requested content.` }
    }
  })
  return endToolTurn(turn, result, `Wrote ${shown}`, shown)
}
async function editScenario(turn, target) {
  const shown = target || 'fake-agy.txt'
  const file = path.resolve(process.cwd(), shown)
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const lines = before === '' ? [] : before.replace(/\n$/, '').split('\n')
  const after = [EDITED_LINE, ...lines.slice(1)]
  const context = lines.slice(1, 4)
  const oldRange = lines.length ? `1,${1 + context.length}` : '0,0'
  const diff = [
    `@@ -${oldRange} +1,${1 + context.length} @@`,
    ...(lines.length ? [`-${lines[0]}`] : []),
    `+${EDITED_LINE}`,
    ...context.map((l) => ` ${l}`)
  ].join('\n')
  const args = {
    TargetFile: file,
    TargetContent: lines[0] ?? '',
    ReplacementContent: EDITED_LINE,
    StartLine: 1,
    EndLine: 1,
    AllowMultiple: false,
    Instruction: 'Replace the first line',
    Description: `Edit ${path.basename(file)}`,
    toolAction: 'Editing file',
    toolSummary: path.basename(file)
  }
  const result = await useTool(turn, {
    name: 'replace_file_content',
    args,
    ask: fileAsk(turn, file, 'edit'),
    run: () => {
      fs.writeFileSync(file, after.join('\n') + '\n')
      return {
        content: `The following changes were made by the replace_file_content tool to: ${file}. If relevant, proactively run terminal commands to execute this code for the USER. Don't ask for permission.\n[diff_block_start]\n${diff}\n[diff_block_end]`
      }
    }
  })
  return endToolTurn(turn, result, `Edited ${shown}`, shown)
}
async function bashScenario(turn, command) {
  const c = turn.conv
  const cmd = command || 'echo hello'
  const args = {
    CommandLine: cmd,
    Cwd: process.cwd(),
    WaitMsBeforeAsync: 5000,
    toolAction: 'Running command',
    toolSummary: cmd
  }
  const result = await useTool(turn, {
    name: 'run_command',
    args,
    ask: commandAsk(cmd),
    run: async (stepIdx, toolCall) => {
      const outDir = path.join(brainDir(c.id), '.system_generated', 'steps', String(stepIdx))
      ensureDir(outDir)
      const ran = await runShell(modelShell(), cmd, runCommandEnv(c, stepIdx, toolCall))
      fs.writeFileSync(path.join(outDir, 'output.txt'), ran.output)
      if (ran.output) say(ran.output.replace(/\n$/, ''))
      return { content: `\nThe command exited with code ${ran.code}.\nOutput:\n${ran.output}` }
    }
  })
  return endToolTurn(turn, result, `Ran: ${cmd}`, cmd)
}
async function askScenario(turn, spec) {
  const parts = (spec || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
  const question = parts[0] || 'Which one?'
  const options = parts.length > 1 ? parts.slice(1) : ['Apple', 'Banana']
  const pick = (index) =>
    index >= 0 && index < options.length ? { allow: true, option: options[index] } : undefined
  const args = {
    questions: [{ question, options, is_multi_select: false }],
    toolAction: 'Asking a question',
    toolSummary: question
  }
  const tool = {
    name: 'ask_question',
    args,
    ask: {
      needed: true,
      stepType: 'CORTEX_STEP_TYPE_ASK_QUESTION',
      requestedInteraction: {
        askQuestion: {
          questions: [
            { question, options: options.map((text, i) => ({ id: String(i + 1), text })) }
          ]
        }
      },
      frame: ['question', question],
      screen: [
        `Question 1/1: ${question}`,
        ...options.map((o, i) => `${i === 0 ? '> ' : '  '}${i + 1}. ${o}`),
        `  ${options.length + 1}. Write-in…`
      ].join('\n'),
      onKey: (key) => {
        if (/^[1-9]$/.test(key)) return pick(Number(key) - 1)
        if (key === ENTER) return pick(0)
        if (key === ESC) return { allow: false, via: 'esc' }
        return undefined
      },
      fromApi: (interaction) => {
        const reply = interaction.askQuestion
        if (!reply) return undefined
        if (reply.cancelled) return { allow: true, option: '', fromApi: true }
        const id = reply.responses?.[0]?.selectedOptionIds?.[0]
        const picked = pick(Number(id) - 1)
        return picked ? { ...picked, fromApi: true } : undefined
      }
    },
    run: () => ({ content: `A1: ${tool.answer.option}` })
  }
  const result = await useTool(turn, tool)
  return endToolTurn(turn, result, `Picked: ${tool.answer?.option || 'nothing'}`, question)
}
async function backgroundScenario(turn, command) {
  const c = turn.conv
  const cmd = command || 'sleep 2'
  const args = {
    CommandLine: cmd,
    Cwd: process.cwd(),
    WaitMsBeforeAsync: 0,
    toolAction: 'Running command',
    toolSummary: cmd
  }
  const result = await useTool(turn, {
    name: 'run_command',
    args,
    run: (stepIdx, toolCall) => {
      const task = ++c.tasks
      const tasksDir = path.join(brainDir(c.id), '.system_generated', 'tasks')
      ensureDir(tasksDir)
      const logFile = path.join(tasksDir, `task-${task}.log`)
      fs.writeFileSync(logFile, '')
      runShell(modelShell(), cmd, runCommandEnv(c, stepIdx, toolCall), logFile).then(() => {
        fireHook('PostToolUse', c.id, { error: '', stepIdx, toolCall })
        enqueueSelfTurn(c, `Background work finished: ${cmd}`)
      })
      return {
        background: true,
        content: `Command is running as a background task with task id: ${c.id}/task-${task}. Use manage_task to check on it. Logs at ${pathToFileURL(logFile).href}`
      }
    }
  })
  if (result.denied) return finishTurn(turn, `Denied: ${result.denied}`)
  return finishTurn(turn, 'Started in the background', { fullyIdle: false })
}
async function subagentScenario(turn, prompt) {
  const parent = turn.conv
  const task = prompt || 'Help with the task'
  let child
  const args = {
    Subagents: [{ TypeName: 'self', Role: 'helper', Prompt: task }],
    toolAction: 'Starting a subagent',
    toolSummary: task
  }
  const result = await useTool(turn, {
    name: 'invoke_subagent',
    args,
    run: () => {
      const childId = createConversation({
        parent_conversation_id: parent.id,
        nesting_depth: 1,
        agent_name: 'self'
      })
      child = conversationRecord(childId)
      writeUserInput(child, task)
      startSession(child)
      return { content: `Started subagent ${childId}` }
    }
  })
  if (result.denied) return finishTurn(turn, `Denied: ${result.denied}`)
  await finishTurn(turn, 'A subagent is on it', { fullyIdle: false })
  setTimeout(
    () => {
      writeStep(child, {
        source: 'MODEL',
        type: 'PLANNER_RESPONSE',
        content: 'Subagent result',
        tokens: spend(child)
      })
      storeTitle(child.id, `Subagent: ${firstLine(task)}`.slice(0, TITLE_LENGTH))
      fireStop(child, { terminationReason: 'NO_TOOL_CALL' })
      enqueueSelfTurn(parent, 'Subagent done')
    },
    Number(readSentinel('fake-agy-subagent-ms', '1500'))
  )
}
async function planScenario(turn) {
  const c = turn.conv
  const file = path.join(brainDir(c.id), PLAN_ARTIFACT)
  const plan = '# Implementation plan\n\n1. Do the thing.\n'
  const args = {
    TargetFile: file,
    CodeContent: plan,
    Overwrite: fs.existsSync(file),
    Description: 'Write the plan',
    ArtifactMetadata: {
      ArtifactType: 'implementation_plan',
      RequestFeedback: true,
      Summary: 'A plan to review'
    },
    toolAction: 'Writing plan',
    toolSummary: PLAN_ARTIFACT
  }
  const result = await useTool(turn, {
    name: 'write_to_file',
    args,
    run: () => {
      fs.writeFileSync(file, plan)
      fs.writeFileSync(
        `${file}.metadata.json`,
        JSON.stringify({
          summary: 'A plan to review',
          updatedAt: new Date().toISOString(),
          userFacing: true,
          requestFeedback: true
        })
      )
      return { content: `Created file ${pathToFileURL(file).href} with requested content.` }
    }
  })
  if (result.denied) return finishTurn(turn, `Denied: ${result.denied}`)
  review = { conv: c, name: PLAN_ARTIFACT }
  await finishTurn(turn, 'The plan is ready for review.', {
    ending: 'plan',
    agentState: 'reviewing'
  })
  say('1 artifact · /artifact to review')
}
async function busyScenario(turn) {
  await pause(Number(readSentinel('fake-agy-busy-ms', '30000')))
  return finishTurn(turn, 'Done being busy')
}
async function compactScenario(turn) {
  const c = turn.conv
  writeStep(c, { source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '/compact' })
  say('Compacting conversation… (1s · esc to cancel)')
  streamPush(c, {
    activeHook: {
      hookType: 'HOOK_TYPE_PRE_INVOCATION',
      hookName: 'context_summary',
      startedAt: new Date().toISOString()
    }
  })
  fireHook('PreInvocation', c.id, { initialNumSteps: c.nextStep, invocationNum: 0 })
  await pause(Number(readSentinel('fake-agy-compact-ms', '1500')))
  streamPush(c, {})
  const summarized = c.nextStep
  writeStep(c, {
    source: 'SYSTEM',
    type: 'CHECKPOINT',
    content: `# Resuming from a compaction\n${summarized} earlier steps were summarized.`
  })
  say(`${summarized} steps summarized · context 100 → ~17.0k (10 summary) · took 2s`)
  fireStop(c, { terminationReason: 'TERMINAL_CUSTOM_HOOK' })
  markIdle(c)
  sendFrame('done', null, 'Task complete')
  term.idleOnNextKey = true
}
async function promptScenario(turn, text) {
  return finishTurn(turn, `Answer to: ${text}`)
}
const SCENARIOS = {
  '/write': writeScenario,
  '/edit': editScenario,
  '/bash': bashScenario,
  '/ask': askScenario,
  '/bg': backgroundScenario,
  '/subagent': subagentScenario,
  '/plan': planScenario,
  '/busy': busyScenario,
  '/fail': (turn) => failTurn(turn, EXECUTOR_500),
  '/compact': compactScenario
}

async function runTurn(text, origin = {}) {
  turnRunning = true
  turnCancelled = false
  review = null
  const c = ensureConversation()
  const turn = { conv: c, invocation: 0, origin }
  const command = text.split(/\s/)[0]
  const argument = text.slice(command.length).trim()
  const scenario = SCENARIOS[command]
  try {
    sendFrame('working', null, c.conversationTitle || undefined)
    setAgentState('working')
    updateSummary(c.id, { status: RUNNING, not_fully_idle: 0 })
    streamPush(c, { status: RUNNING, executorLoopStatus: RUNNING })
    if (command !== '/compact') beginUserTurn(turn, text)
    if (origin.api && !origin.planModel) await failTurn(turn, NO_PLAN_MODEL)
    else if (scenario) await scenario(turn, argument)
    else await promptScenario(turn, text)
  } catch (error) {
    if (error !== CANCELLED) throw error
    say(`⎿ ${INTERRUPTED}`)
    markIdle(c)
    sendFrame('done', null, 'Task complete')
    setAgentState('idle')
    sendFrame('idle')
  } finally {
    turnRunning = false
    turnCancelled = false
    setImmediate(drainQueue)
  }
}
function enqueueSelfTurn(c, reply) {
  queue.push({ self: reply, conv: c })
  drainQueue()
}
async function runSelfTurn(item) {
  if (conversation !== item.conv) return drainQueue()
  turnRunning = true
  const c = item.conv
  try {
    sendFrame('working', null, c.conversationTitle || undefined)
    setAgentState('working')
    updateSummary(c.id, { status: RUNNING })
    await finishTurn({ conv: c, invocation: 0, origin: { self: true } }, item.self)
  } catch (error) {
    if (error !== CANCELLED) throw error
  } finally {
    turnRunning = false
    setImmediate(drainQueue)
  }
}
function drainQueue() {
  if (turnRunning || pendingAsk || phase !== 'prompt') return
  const next = queue.shift()
  if (!next) return
  if (next.self) runSelfTurn(next).catch(crash)
  else handleLine(next.text, next.origin)
}

function openPanel(name, text, onKey) {
  say(text)
  panel = {
    onKey: (key) => {
      if (onKey && onKey(key)) return
      if (key !== ESC) return
      panel = null
      if (name !== 'usage') say(`⎿ Exited /${name} command`)
    }
  }
}
function usageData() {
  const custom = readJson(sentinel('fake-agy-usage.json'), null)
  if (custom) return custom
  if (apiKeyRoute()) return { groups: [] }
  return {
    description: 'Models & Quota',
    groups: [
      {
        name: 'Gemini Pro',
        description: 'Gemini 3.1 Pro models',
        buckets: [
          {
            id: 'gemini-pro-daily',
            name: 'Daily requests',
            description: 'Requests per day',
            remaining_fraction: 0.42,
            reset_time: new Date(Date.now() + 6 * 3600 * 1000).toISOString()
          }
        ]
      }
    ]
  }
}
const usageRows = (data) =>
  (data.groups ?? []).flatMap((g) =>
    (g.buckets ?? []).map(
      (b) =>
        `${g.name}\t${b.name}\t${Math.round((b.remaining_fraction ?? 0) * 100)}%\t${b.reset_time ?? ''}`
    )
  )
function helpText() {
  return [
    `Antigravity CLI ${VERSION}`,
    `Signed in with: ${apiKeyRoute() ? 'Gemini API key' : `Google account ${signedInEmail()}`}`,
    `Workspace: ${workspace}`,
    `Project config: ${paths.project}`,
    `Log: ${path.join(appDir, 'log', 'cli.log')}`,
    `Conversation: ${conversation?.id ?? ''}`
  ].join('\n')
}
function slashCommand(command, argument) {
  if (command === '/exit' || command === '/quit') return quit(0, true)
  if (command === '/clear' || command === '/new') {
    releasePresence(conversation)
    conversation = null
    ensureConversation()
    return
  }
  if (command === '/fork') {
    const old = ensureConversation()
    releasePresence(old)
    const id = createConversation({ step_count: old.nextStep })
    conversation = conversationRecord(id, {
      nextStep: old.nextStep,
      needsSessionStart: false,
      settingsAnnounced: true,
      systemMessages: [...old.systemMessages],
      totals: { ...old.totals }
    })
    conversation.lockFd = holdPresence(id)
    say(`Forked conversation. To go back, use: /resume ${old.id}`)
    runScripts()
    return
  }
  if (command === '/resume') {
    if (!argument) {
      ensureConversation()
      const rows = fs.existsSync(paths.summaries)
        ? withSummaries((db) =>
            db
              .prepare(
                "SELECT conversation_id, title FROM conversation_summaries WHERE parent_conversation_id = '' ORDER BY last_modified_time DESC LIMIT 20"
              )
              .all()
          )
        : []
      return say(
        rows.map((r) => `${r.conversation_id}  ${r.title}`).join('\n') || 'No conversations'
      )
    }
    if (!conversationExists(argument)) return say(`Conversation not found: ${argument}`)
    const previous = conversation
    conversation = null
    runScripts()
    conversation = previous
    openStored(argument)
    runScripts()
    return
  }
  if (command === '/rename') {
    const c = ensureConversation()
    if (!argument) return say('Usage: /rename <title>')
    c.title = argument
    c.conversationTitle = argument
    storeTitle(c.id, argument)
    say(`Conversation renamed to "${argument}"`)
    runScripts()
    return
  }
  ensureConversation()
  if (command === '/usage' || command === '/quota') {
    const rows = apiKeyRoute() ? ['Loading quota summary...'] : usageRows(usageData())
    return openPanel('usage', ['Models & Quota', ...rows].join('\n'))
  }
  if (command === '/model')
    return openPanel(
      'model',
      [
        'Select model',
        ...modelRows().map(
          (r) => `${r.startsWith(model.id + '\t') ? '> ' : '  '}${r.split('\t')[1]}`
        )
      ].join('\n')
    )
  if (command === '/help') return openPanel('help', helpText())
  if (command === '/config') return openPanel('config', JSON.stringify(readSettings(), null, 2))
  if (command === '/artifact') {
    if (!review) return say('No artifacts to review')
    const pending = review
    return openPanel(
      'artifact',
      `Action required (1 left)\n${pending.name}\ny approve · n reject · shift+a approve all · p preview · esc`,
      (key) => {
        if (key !== 'y' && key !== 'n' && key !== 'A') return false
        panel = null
        handleLine(`${key === 'n' ? '[Rejected]' : '[Approved]'} ${pending.name}`, {})
        return true
      }
    )
  }
}
const INSTANT_COMMANDS = new Set([
  '/exit',
  '/quit',
  '/clear',
  '/new',
  '/fork',
  '/resume',
  '/rename',
  '/usage',
  '/quota',
  '/model',
  '/help',
  '/config',
  '/artifact'
])
function handleLine(text, origin = {}) {
  if (text.startsWith('!')) return shellEscape(text.slice(1))
  const command = text.split(/\s/)[0]
  const argument = text.slice(command.length).trim()
  const instant = INSTANT_COMMANDS.has(command)
  if (command === '/exit' || command === '/quit') return quit(0, true)
  if (text.startsWith('/')) ensureConversation()
  if (origin.typed) logHistory(text, instant ? 'slash_command' : undefined)
  if (instant) return slashCommand(command, argument)
  runTurn(text, origin).catch(crash)
}
function shellEscape(cmd) {
  runShell('/bin/bash', cmd, process.env).then((ran) => {
    if (ran.output) say(ran.output.replace(/\n$/, ''))
  })
}
function submit(raw) {
  const text = raw.replace(/\r\n?/g, '\n').trim()
  if (!text) return
  say(`> ${text}`)
  if (turnRunning || pendingAsk) {
    queue.push({ text, origin: { typed: true } })
    say('▸ queued msg')
    return
  }
  handleLine(text, { typed: true })
}

function quit(code, showResume) {
  if (typeof readSettings().title?.command === 'string') write(`${ESC}]2;${BEL}`)
  if (showResume && conversation)
    say(`Resume with -c (or command below):\nagy --conversation=${conversation.id}`)
  write(`${ESC}[?2004l`)
  process.exit(code)
}
function crash(error) {
  process.stderr.write(`${error?.stack || error}\n`)
  process.exit(70)
}

function nextPhase() {
  if (!signedIn()) return showSignIn()
  if (!onboardingDone()) return showColorScheme()
  if (!trusted()) return showTrust()
  enterPrompt()
}
function showSignIn() {
  phase = 'signin'
  say(
    'Welcome to the Antigravity CLI. You are currently not signed in.\n> 1. Google OAuth\n  2. Use a Google Cloud project'
  )
  sendFrame('blocked', 'auth', 'Sign in required')
}
function showSignInUrl() {
  phase = 'signin-code'
  typed = ''
  const query = new URLSearchParams({
    access_type: 'offline',
    client_id: 'fake-antigravity-cli.apps.googleusercontent.com',
    code_challenge: crypto.randomBytes(32).toString('base64url'),
    code_challenge_method: 'S256',
    prompt: 'consent',
    redirect_uri: 'https://antigravity.google/oauth-callback',
    response_type: 'code',
    scope: 'openid email profile https://www.googleapis.com/auth/cloud-platform',
    state: crypto.randomBytes(16).toString('hex')
  })
  const url = `https://accounts.google.com/o/oauth2/auth?${query}`
  const overSsh = ['SSH_CONNECTION', 'SSH_TTY', 'SSH_CLIENT'].some((k) => process.env[k])
  if (!overSsh) fs.appendFileSync(sentinel('fake-agy-browser-opens.txt'), url + '\n')
  say(
    `Sign in with Google\nOpen this URL in your browser:\n${url}\n\nPaste the authorization code here:`
  )
}
function finishSignIn(code) {
  if (!code.startsWith('code-')) return say('Invalid authorization code. Try again.')
  const email = readSentinel('fake-agy-email', 'fake-user@example.com')
  const idToken = [
    base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    base64url(
      JSON.stringify({ email, sub: crypto.createHash('sha1').update(email).digest('hex') })
    ),
    base64url('fake-signature')
  ].join('.')
  const token = {
    token: {
      access_token: `fake-access-${crypto.randomBytes(12).toString('hex')}`,
      token_type: 'Bearer',
      refresh_token: `fake-refresh-${crypto.randomBytes(12).toString('hex')}`,
      expiry: new Date(Date.now() + 3600 * 1000).toISOString()
    },
    auth_method: 'consumer',
    id_token: idToken
  }
  writeReplacing(paths.token, JSON.stringify(token), 0o600)
  say(`Signed in as ${email}`)
  nextPhase()
}
function showColorScheme() {
  phase = 'color'
  say(
    'Welcome to Antigravity CLI! Choose your color scheme\n> Dark\n  Light\n  Dark (high contrast)'
  )
  sendFrame('blocked', 'question', 'Finish setup')
}
function showTerms() {
  phase = 'terms'
  say('Terms of Service & Data Use\n[x] Interactions data\n[Done]')
  sendFrame('blocked', 'question', 'Finish setup')
}
function showTrust() {
  phase = 'trust'
  trustCursor = 0
  say(
    `Do you trust the contents of this project?\n${workspace}\n> Yes, I trust this folder\n  No, exit`
  )
  sendFrame('blocked', 'permission', 'Trust this folder?')
}
function trustWorkspace() {
  const current = readSettings().trustedWorkspaces ?? []
  if (!current.includes(workspace)) writeSettings({ trustedWorkspaces: [...current, workspace] })
}
function setupKey(key) {
  if (phase === 'signin') {
    if (key === '1' || key === ENTER) showSignInUrl()
    else if (key === '2') say('Google Cloud project sign-in is not available.')
    return
  }
  if (phase === 'signin-code') {
    if (key === ENTER) {
      const code = typed.trim()
      typed = ''
      finishSignIn(code)
    } else if (key === BACKSPACE) typed = typed.slice(0, -1)
    else if (key.length === 1 && key >= ' ') typed += key
    return
  }
  if (phase === 'color') {
    if (key === ENTER) showTerms()
    return
  }
  if (phase === 'terms') {
    if (key !== ENTER) return
    writeReplacing(
      paths.onboarding,
      JSON.stringify({
        consumerOnboardingComplete: true,
        enterpriseOnboardingComplete: false,
        onboardingComplete: true
      })
    )
    return nextPhase()
  }
  if (phase === 'trust') {
    if (key === DOWN) trustCursor = 1
    else if (key === UP) trustCursor = 0
    const yes = key === '1' || (key === ENTER && trustCursor === 0)
    const no = key === '2' || (key === ENTER && trustCursor === 1)
    if (yes) {
      trustWorkspace()
      nextPhase()
    } else if (no) quit(0, false)
  }
}
function enterPrompt() {
  phase = 'prompt'
  say(
    `Antigravity CLI ${VERSION}\n${apiKeyRoute() ? 'Gemini API key' : `${signedInEmail()} (Free)`} · ${model.display_name}`
  )
  if (acceptEdits) say('Accept-edits mode: file edits auto-approved')
  if (planMode) say('Plan mode: research & plan only')
  const wanted = flag('--conversation')
  if (typeof wanted === 'string' && wanted) {
    if (!openStored(wanted)) say(`warning: conversation "${wanted}" not found`)
  } else if (flag('-c', '--continue') === true) {
    const last = readJson(paths.lastConversations, {})[workspace]
    if (last) openStored(last)
  }
  sendFrame('idle')
  term.agentState = 'idle'
  runScripts()
  const first = flag('-i', '--prompt-interactive')
  if (typeof first === 'string' && first) submit(first)
  drainQueue()
}

function onKey(key) {
  if (term.idleOnNextKey) {
    term.idleOnNextKey = false
    sendFrame('idle')
  }
  if (phase !== 'prompt') return setupKey(key)
  if (pendingAsk) return pendingAsk.onKey(key)
  if (panel) return panel.onKey(key)
  if (key === ESC) {
    typed = ''
    if (turnRunning) cancelTurn()
    return
  }
  if (key === ENTER) {
    const line = typed
    typed = ''
    return submit(line)
  }
  if (key === BACKSPACE) typed = typed.slice(0, -1)
  else if (key.length === 1 && key >= ' ') typed += key
}
function feed(chunk) {
  let text = chunk
  if (text.includes(STATUS_REPLY) && !term.statusOff) {
    term.statusOn = true
    if (term.lastFrame) process.stdout.write(term.lastFrame)
  }
  text = text.replace(STATUS_REPLY_PATTERN, '').replace(OTHER_OSC_PATTERN, '')
  let i = 0
  while (i < text.length) {
    if (pasteBuffer !== null) {
      const end = text.indexOf(PASTE_END, i)
      if (end < 0) {
        pasteBuffer += text.slice(i)
        return
      }
      typed += (pasteBuffer + text.slice(i, end)).replace(/\r\n?/g, '\n')
      pasteBuffer = null
      i = end + PASTE_END.length
      continue
    }
    if (text.startsWith(PASTE_START, i)) {
      pasteBuffer = ''
      i += PASTE_START.length
      continue
    }
    if (text[i] === ESC && (text[i + 1] === '[' || text[i + 1] === 'O')) {
      const match = CSI_PATTERN.exec(text.slice(i))
      if (match) {
        const key = CSI_KEYS[match[0].slice(-1)]
        if (key && match[0].length <= 4) onKey(key)
        i += match[0].length
        continue
      }
    }
    const ch = text[i++]
    onKey(ch === '\n' ? ENTER : ch === '\b' ? BACKSPACE : ch === '\x03' ? ESC : ch)
  }
}

function parseApiBody(raw) {
  if (raw.length >= 5 && raw[0] <= 3 && raw.readUInt32BE(1) === raw.length - 5)
    return JSON.parse(raw.subarray(5).toString('utf8') || '{}')
  return JSON.parse(raw.toString('utf8') || '{}')
}
function reply(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
const notFound = (res, id) =>
  reply(res, 404, { code: 'not_found', message: `cascade ${id} not found` })
const API_METHODS = {
  GetStatus: (body, res) => reply(res, 200, {}),
  RetrieveUserQuotaSummary: (body, res) => reply(res, 200, { response: {} }),
  GetUserStatus: (body, res) => reply(res, 200, { userStatus: {} }),
  GetModelStatuses: (body, res) => reply(res, 200, {}),
  GetCascadeTrajectory: (body, res) => {
    if (!conversationExists(body.cascadeId)) return notFound(res, body.cascadeId)
    reply(res, 200, {
      trajectory: {
        trajectoryId: trajectoryIdOf(body.cascadeId),
        cascadeId: body.cascadeId,
        steps: trajectorySteps(body.cascadeId)
      }
    })
  },
  SendUserCascadeMessage: (body, res) => {
    if (!conversation || conversation.id !== body.cascadeId) return notFound(res, body.cascadeId)
    const text = (body.items ?? []).map((item) => item.text ?? '').join('')
    const config = body.cascadeConfig
    const origin = {
      api: true,
      cascadeConfig: config,
      planModel: config?.plannerConfig?.planModel,
      fullConfig: Boolean(config?.toolConfig)
    }
    reply(res, 200, {})
    say(`> ${text}`)
    if (turnRunning || pendingAsk || phase !== 'prompt') {
      queue.push({ text, origin })
      say('▸ queued msg')
    } else runTurn(text, origin).catch(crash)
  },
  HandleCascadeUserInteraction: (body, res) => {
    const interaction = body.interaction ?? {}
    const waiting =
      pendingAsk &&
      pendingAsk.conv.id === body.cascadeId &&
      interaction.stepIndex === pendingAsk.position
    if (!waiting)
      return reply(res, 500, {
        code: 'internal',
        message: `input not registered for step ${interaction.stepIndex}`
      })
    const answer = pendingAsk.fromApi(interaction)
    if (!answer)
      return reply(res, 400, {
        code: 'invalid_argument',
        message: 'interaction does not fit the waiting step'
      })
    reply(res, 200, {})
    pendingAsk.resolve(answer)
  },
  UpdateConversationAnnotations: (body, res) => {
    if (!conversationExists(body.cascadeId)) return notFound(res, body.cascadeId)
    const title = body.annotations?.title
    if (typeof title === 'string') {
      storeTitle(body.cascadeId, title)
      if (conversation?.id === body.cascadeId) conversation.title = title
    }
    reply(res, 200, {})
  },
  CancelCascadeInvocation: (body, res) => {
    if (conversation?.id === body.cascadeId) cancelTurn()
    reply(res, 200, {})
  },
  WaitForConversationFullyIdle: (body, res) => {
    if (!body.conversationId)
      return reply(res, 400, { code: 'invalid_argument', message: 'conversationId is required' })
    const check = () => {
      if (conversation?.id === body.conversationId && (turnRunning || pendingAsk))
        return setTimeout(check, 100)
      reply(res, 200, {})
    }
    check()
  },
  GetArtifactSnapshots: (body, res) => {
    if (!conversationExists(body.cascadeId)) return notFound(res, body.cascadeId)
    const dir = brainDir(body.cascadeId)
    const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.endsWith('.md')) : []
    reply(res, 200, {
      artifactSnapshots: names.map((name) => ({
        name,
        uri: pathToFileURL(path.join(dir, name)).href,
        metadata: readJson(path.join(dir, `${name}.metadata.json`), {}),
        content: fs.readFileSync(path.join(dir, name), 'utf8')
      }))
    })
  },
  StreamAgentStateUpdates: (body, res) => {
    const id = body.conversationId
    if (!id)
      return reply(res, 400, { code: 'invalid_argument', message: 'conversationId is required' })
    const live = conversation?.id === id
    const status = live && turnRunning ? RUNNING : IDLE
    const steps = conversationExists(id) ? trajectorySteps(id) : []
    res.writeHead(200, { 'content-type': 'application/connect+json' })
    res.write(
      envelope({
        update: {
          conversationId: id,
          trajectoryId: trajectoryIdOf(id),
          status,
          executableStatus: IDLE,
          executorLoopStatus: status,
          mainTrajectoryUpdate: { stepsUpdate: { indices: steps.map((_, i) => i), steps } },
          fullyIdle: !(live && turnRunning)
        }
      })
    )
    const sub = { id, res }
    api.subscribers.add(sub)
    res.on('close', () => api.subscribers.delete(sub))
  }
}
function handleApi(req, res) {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const method = req.url.startsWith(SERVICE_PREFIX)
      ? req.url.slice(SERVICE_PREFIX.length)
      : req.url
    const token = req.headers['x-codeium-csrf-token']
    let body = {}
    try {
      body = parseApiBody(Buffer.concat(chunks))
    } catch {
      body = { unparsed: Buffer.concat(chunks).toString('utf8') }
    }
    const authorized = Boolean(token) && (token === csrfToken || token === internalToken)
    appendJsonl(sentinel('fake-agy-api.jsonl'), { pid: process.pid, method, body, authorized })
    if (!token) return reply(res, 401, { code: 'unauthenticated', message: 'missing CSRF token' })
    if (!authorized)
      return reply(res, 401, { code: 'unauthenticated', message: 'invalid CSRF token' })
    const handler = API_METHODS[method]
    if (!handler)
      return reply(res, 404, { code: 'unimplemented', message: `${method} is not implemented` })
    try {
      handler(body, res)
    } catch (error) {
      reply(res, 500, { code: 'internal', message: String(error?.message ?? error) })
    }
  })
}
function startApi() {
  return new Promise((resolve) => {
    const server = http.createServer(handleApi)
    const tlsLookalike = net.createServer((socket) => {
      socket.on('error', () => {})
      socket.once('data', () =>
        socket.end(
          'HTTP/1.0 400 Bad Request\r\n\r\nClient sent an HTTP request to an HTTPS server.\n'
        )
      )
    })
    let waiting = 2
    const ready = () => --waiting === 0 && resolve()
    server.listen(0, '127.0.0.1', () => {
      api.port = server.address().port
      ready()
    })
    tlsLookalike.listen(0, '127.0.0.1', ready)
  })
}

async function startTui() {
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.on('data', (chunk) => {
    try {
      feed(chunk.toString('utf8'))
    } catch (error) {
      crash(error)
    }
  })
  process.on('SIGHUP', () => quit(0, false))
  process.on('SIGTERM', () => quit(0, false))
  await startApi()
  if (!term.statusOn && !term.statusOff) write(STATUS_QUERY)
  write(`${ESC}[?2004h`)
  runScripts()
  runScripts()
  if (process.env.AGY_CLI_OSC7501 === 'on') sendFrame('blocked', 'auth', 'Sign in required')
  if (!fs.existsSync(paths.onboarding))
    writeReplacing(
      paths.onboarding,
      JSON.stringify({
        consumerOnboardingComplete: false,
        enterpriseOnboardingComplete: false,
        onboardingComplete: false
      })
    )
  nextPhase()
}

function oneShotResponse(input) {
  const assistReply = sentinel('fake-agy-assist-reply')
  if (fs.existsSync(assistReply)) {
    fs.appendFileSync(sentinel('fake-agy-assist-asked.txt'), input + '\n')
    const waitMs = Number(readSentinel('fake-agy-assist-ms', '0'))
    if (waitMs) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
    return fs.readFileSync(assistReply, 'utf8')
  }
  if (input.includes(WRITTEN_LIST)) {
    const [asked, written] = input.split(WRITTEN_LIST)
    const answer = asked.split('Agent replied:\n').pop()
    const picks = [
      ...written
        .split('\n')
        .filter((l) => l.startsWith('/') && !path.basename(l).startsWith('draft-')),
      ...(answer.match(/(?<![\w.~-])\/[^\s`'"]+\.(?:md|html)\b/g) ?? [])
    ]
    return [...new Set(picks)].join('\n') || 'NONE'
  }
  return `${firstLine(input.split('Task:\n').pop())} (titled)`
}
const zeroUsage = () => ({
  input_tokens: 0,
  output_tokens: 0,
  thinking_tokens: 0,
  cache_read_tokens: 0,
  total_tokens: 0
})
function printResult(format, result, extraEvents = []) {
  if (format === 'json') process.stdout.write(JSON.stringify(result) + '\n')
  else if (format === 'stream-json') {
    for (const event of extraEvents) process.stdout.write(JSON.stringify(event) + '\n')
    process.stdout.write(JSON.stringify({ event: 'result', result }) + '\n')
  }
}
function printCommand(name, data, format) {
  const result = {
    conversation_id: '',
    status: 'SUCCESS',
    response: '',
    duration_seconds: 0,
    num_turns: 0,
    usage: zeroUsage(),
    command: { name, data }
  }
  if (format === 'text')
    process.stdout.write(
      (name === 'usage' ? usageRows(data).join('\n') : JSON.stringify(data, null, 2)) + '\n'
    )
  else printResult(format, result, [{ event: 'command_result', command: { name, data } }])
  process.exit(0)
}
async function headless() {
  if (flag('-i', '--prompt-interactive') !== undefined) {
    process.stderr.write('error: --print and --prompt-interactive are mutually exclusive\n')
    process.exit(2)
  }
  if (!signedIn()) {
    process.stderr.write(AUTH_REQUIRED + '\n')
    process.exit(1)
  }
  const given = flag('-p', '--print')
  let prompt = typeof given === 'string' ? given : ''
  if (!prompt && !process.stdin.isTTY) prompt = fs.readFileSync(0, 'utf8')
  const format = flag('--output-format') || 'text'
  const started = Date.now()
  const trimmed = prompt.trim()
  if (/^\/(rename|logout)\b/.test(trimmed)) {
    process.stderr.write('error: print mode has no conversation manager\n')
    process.exit(2)
  }
  if (/^\/(usage|quota)\b/.test(trimmed)) return printCommand('usage', usageData(), format)
  if (/^\/model\b/.test(trimmed))
    return printCommand(
      'model',
      {
        id: model.id,
        label: model.display_name,
        effort: model.effort,
        is_default: !flag('--model')
      },
      format
    )
  if (/^\/help\b/.test(trimmed))
    return printCommand(
      'help',
      {
        commands: [
          '/help',
          '/usage',
          '/model',
          '/config',
          '/effort',
          '/hooks',
          '/permissions',
          '/skills'
        ]
      },
      format
    )
  if (/^\/config\b/.test(trimmed)) return printCommand('config', { config: readSettings() }, format)
  const wanted = flag('--conversation')
  if (typeof wanted === 'string' && wanted) {
    if (conversationExists(wanted)) conversation = loadConversation(wanted)
    else process.stderr.write(`warning: conversation "${wanted}" not found\n`)
  } else if (flag('-c', '--continue') === true) {
    const last = readJson(paths.lastConversations, {})[workspace]
    if (conversationExists(last)) conversation = loadConversation(last)
  }
  if (!conversation) conversation = conversationRecord(createConversation())
  const c = conversation
  c.lockFd = holdPresence(c.id)
  const turn = { conv: c, invocation: 0, origin: { print: true } }
  updateSummary(c.id, { status: RUNNING })
  beginUserTurn(turn, prompt)
  const elapsed = () => (Date.now() - started) / 1000
  if (trimmed === '/fail') {
    fireStop(c, { error: EXECUTOR_500, terminationReason: 'ERROR' })
    markIdle(c)
    printResult(format, {
      conversation_id: c.id,
      status: 'ERROR',
      response: '',
      error: `agent executor error: ${EXECUTOR_500}`,
      duration_seconds: 0,
      num_turns: 1,
      usage: zeroUsage()
    })
    process.stderr.write(
      `AGY_ERROR: ${JSON.stringify({ short_error: 'Error 500', status: 'INTERNAL', error_code: 500, code_kind: 'server', retryable: false, error_id: crypto.randomBytes(8).toString('hex') })}\n`
    )
    process.exit(3)
  }
  const response = oneShotResponse(prompt)
  await modelCall(turn, { content: response })
  fireStop(c, { terminationReason: 'NO_TOOL_CALL' })
  markIdle(c)
  const t = c.totals
  const usage = {
    input_tokens: t.input,
    output_tokens: t.output,
    thinking_tokens: 3,
    cache_read_tokens: t.cacheRead,
    total_tokens: t.input + t.output + 3
  }
  const result = {
    conversation_id: c.id,
    status: 'SUCCESS',
    response,
    duration_seconds: elapsed(),
    num_turns: 1,
    usage
  }
  if (format === 'text') process.stdout.write(response.endsWith('\n') ? response : response + '\n')
  else
    printResult(format, result, [
      {
        event: 'init',
        conversation_id: c.id,
        init: {
          cwd: process.cwd(),
          tools: MODEL_TOOLS,
          permission_mode: skipPermissions ? 'bypass-permissions' : 'request-review'
        }
      },
      {
        event: 'step_update',
        step_update: {
          conversation_id: c.id,
          step_index: 0,
          state: 'DONE',
          step_type: 'user_input'
        }
      },
      {
        event: 'step_update',
        step_update: {
          conversation_id: c.id,
          step_index: 1,
          state: 'DONE',
          step_type: 'agent_response',
          text_delta: response,
          duration_seconds: elapsed(),
          usage
        }
      }
    ])
  releasePresence(c)
  process.exit(0)
}

function main() {
  if (readSettings().modelProvider === 'gemini' && !process.env.GEMINI_API_KEY) {
    process.stderr.write(MISSING_API_KEY + '\n')
    process.exit(1)
  }
  const wantedEffort = flag('--effort')
  model = resolveModel(
    typeof flag('--model') === 'string' ? flag('--model') : undefined,
    typeof wantedEffort === 'string' ? wantedEffort : undefined
  )
  if (model.error) {
    process.stderr.write(model.error + '\n')
    process.exit(1)
  }
  if (printMode) headless().catch(crash)
  else startTui().catch(crash)
}

if (argv[0] === '--version') {
  process.stdout.write(`${VERSION}\n`)
  process.exit(0)
} else if (positional[0] === 'version') process.exit(2)
else if (positional[0] === 'update') {
  process.stdout.write(
    'Checking for updates…\nFound new version…\nUpdate successful! Please restart agy.\n'
  )
  process.exit(0)
} else if (positional[0] === 'install') {
  process.stdout.write(
    `Add agy to your PATH:\n  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc\n`
  )
  process.exit(0)
} else if (positional[0] === 'models') {
  process.stdout.write(modelRows().join('\n') + '\n')
  process.exit(0)
} else main()
