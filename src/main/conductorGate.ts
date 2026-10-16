import { shq } from '@shared/shellQuote'
import { CODEX_WAITING_QUESTION_TOOL } from '@shared/agentGuide'

const CONDUCTOR_DENIED =
  'Koloft: Assist only passes work on. It may read files, write its own memory folder, ask the owner a question and run one plain koloft command per Bash call (no ;, &&, |, >, $ or backticks outside quotes). To get anything else done, start a session with koloft session new or message one with koloft session send.'

const CODEX_CONDUCTOR_DENIED = `Koloft: Assist only passes work on. It may run shell commands, change files inside its own folder and ask the owner a question with ${CODEX_WAITING_QUESTION_TOOL} (it waits for the answer; ${CODEX_WAITING_QUESTION_TOOL}_async does not). It may not start sub-agents or use other tools. To get anything else done, start a session with koloft session new or message one with koloft session send.`

const READ_OR_ASK_TOOLS = ['Read', 'Glob', 'Grep', 'Skill', 'ToolSearch', 'AskUserQuestion']
const WRITE_TOOLS = ['Write', 'Edit']

const TOOLS_THE_ALLOW_FILE_NAMES = `function toolsTheAllowFileNames() {
  try {
    const named = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'))
    return new Set(Array.isArray(named) ? named : [])
  } catch {
    return new Set()
  }
}`

const DENY_AND_SAY = (denied: string): string => `const GRANTED = 'granted'
let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (raw += chunk))
process.stdin.on('end', () => {
  let event = {}
  try {
    event = JSON.parse(raw)
  } catch {}
  const named = toolsTheAllowFileNames()
  const verdict = named.has(event.tool_name) || allowed(event, named)
  if (verdict === true) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput:
        verdict === GRANTED
          ? { hookEventName: 'PreToolUse', permissionDecision: 'allow' }
          : {
              hookEventName: 'PreToolUse',
              permissionDecision: 'deny',
              permissionDecisionReason: ${JSON.stringify(denied)}
            }
    })
  )
})
`

const ONE_PLAIN_CALL = `function onePlainCall(command, program) {
  const cmd = String(command).trim()
  if (cmd !== program && !cmd.startsWith(program + ' ')) return false
  let quote = ''
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (quote === "'") {
      if (c === "'") quote = ''
    } else if (quote === '"') {
      if (c === '\\\\') i++
      else if (c === '"') quote = ''
      else if (c === '$' || c === '\`') return false
    } else if (c === '\\\\') i++
    else if (c === "'" || c === '"') quote = c
    else if (';&|<>\`$(){}\\n'.includes(c)) return false
  }
  return quote === ''
}

function allowedCommands(named) {
  return [...named].flatMap((tool) => {
    const bash = /^Bash\\((.+)\\)$/.exec(tool)
    return bash ? [bash[1]] : []
  })
}

function koloftOrNamed(command, named) {
  if (allowedCommands(named).some((program) => onePlainCall(command, program))) return GRANTED
  return onePlainCall(command, 'koloft')
}`

// ADR-0029 CC§15
export const CONDUCTOR_GATE_SCRIPT = `const path = require('path')
const READ_OR_ASK_TOOLS = new Set(${JSON.stringify(READ_OR_ASK_TOOLS)})
const WRITE_TOOLS = new Set(${JSON.stringify(WRITE_TOOLS)})

function inOwnMemory(event) {
  const transcript = event.transcript_path
  const file = event.tool_input && event.tool_input.file_path
  if (typeof transcript !== 'string' || typeof file !== 'string') return false
  const memory = path.join(path.dirname(transcript), 'memory')
  return path.resolve(file).startsWith(memory + path.sep)
}

${ONE_PLAIN_CALL}

function allowed(event, named) {
  if (READ_OR_ASK_TOOLS.has(event.tool_name)) return true
  if (WRITE_TOOLS.has(event.tool_name)) return inOwnMemory(event)
  if (event.tool_name !== 'Bash') return false
  return koloftOrNamed(event.tool_input && event.tool_input.command, named)
}

${TOOLS_THE_ALLOW_FILE_NAMES}

${DENY_AND_SAY(CONDUCTOR_DENIED)}`

// ADR-0029 CODEX§27
export const CODEX_CONDUCTOR_GATE_SCRIPT = `const path = require('path')
const PATCHED_FILE = /^\\*\\*\\* (?:Add File|Update File|Delete File|Move to): (.+)$/

function patchedFiles(patch) {
  return String(patch)
    .split('\\n')
    .flatMap((line) => {
      const found = PATCHED_FILE.exec(line.trim())
      return found ? [found[1].trim()] : []
    })
}

function patchStaysInOwnFolder(event) {
  if (typeof event.cwd !== 'string') return false
  const own = path.resolve(event.cwd)
  const files = patchedFiles(event.tool_input && event.tool_input.command)
  return files.length > 0 && files.every((f) => path.resolve(own, f).startsWith(own + path.sep))
}

function allowed(event) {
  const tool = event.tool_name
  if (typeof tool !== 'string') return false
  if (tool === 'Bash' || tool === ${JSON.stringify(CODEX_WAITING_QUESTION_TOOL)}) return true
  if (tool === 'apply_patch') return patchStaysInOwnFolder(event)
  return false
}

${TOOLS_THE_ALLOW_FILE_NAMES}

${DENY_AND_SAY(CODEX_CONDUCTOR_DENIED)}`

const MUSE_CONDUCTOR_DENIED =
  'Koloft: Assist only passes work on. It may read files, change files inside its own folder, ask the owner a question with request_user_input and run one plain koloft command per bash call (no ;, &&, |, >, $ or backticks outside quotes). It may not start sub-agents or use other tools. To get anything else done, start a session with koloft session new or message one with koloft session send.'

// MUSE§9
const MUSE_READ_TOOLS = ['read_file', 'search', 'work_status', 'submit_reminder_decision']
const MUSE_WRITE_TOOLS = ['write_file', 'edit_file']

// ADR-0029 MUSE§9
export const MUSE_CONDUCTOR_GATE_SCRIPT = `const path = require('path')
const READ_TOOLS = new Set(${JSON.stringify(MUSE_READ_TOOLS)})
const WRITE_TOOLS = new Set(${JSON.stringify(MUSE_WRITE_TOOLS)})

function inOwnFolder(event) {
  const file = event.tool_input && event.tool_input.path
  if (typeof event.cwd !== 'string' || typeof file !== 'string') return false
  const own = path.resolve(event.cwd)
  return path.resolve(own, file).startsWith(own + path.sep)
}

${ONE_PLAIN_CALL}

function allowed(event, named) {
  if (READ_TOOLS.has(event.tool_name)) return true
  if (WRITE_TOOLS.has(event.tool_name)) return inOwnFolder(event)
  if (event.tool_name !== 'bash') return false
  return koloftOrNamed(event.tool_input && event.tool_input.command, named)
}

${TOOLS_THE_ALLOW_FILE_NAMES}

${DENY_AND_SAY(MUSE_CONDUCTOR_DENIED)}`

export function conductorGateCommand(gateScript: string, allowFile: string): string {
  return `ELECTRON_RUN_AS_NODE=1 ${shq(process.execPath)} ${shq(gateScript)} ${shq(allowFile)}`
}

export const CODEX_GATE_ENV = 'KOLOFT_CODEX_GATE'
export const ASSIST_ALLOW_ENV = 'KOLOFT_ASSIST_ALLOW'

// CODEX§27
export const CODEX_GATE_HOOK_COMMAND = `sh "$${CODEX_GATE_ENV}"`
export const codexHookOverride = (event: string, command: string): string =>
  `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)}}]}]`
export const CODEX_GATE_OVERRIDE = codexHookOverride('PreToolUse', CODEX_GATE_HOOK_COMMAND)

// CODEX§20
export const CODEX_ASKS_AND_WAITS = 'features.default_mode_request_user_input=true'

export function codexGateShell(gateScript: string): string {
  return `ELECTRON_RUN_AS_NODE=1 exec ${shq(process.execPath)} ${shq(gateScript)} "$${ASSIST_ALLOW_ENV}"\n`
}

export const CODEX_GATE_NOT_TRUSTED =
  "Codex would not run Koloft's safety check for Assist, so Koloft did not start Assist on Codex."

export const PLAYWRIGHT_CLI_RULE = 'Bash(playwright-cli '

const BROWSER_TOOLS = ['mcp__playwright__', PLAYWRIGHT_CLI_RULE]

export function allowsTheBrowser(allow: readonly string[]): boolean {
  return allow.some((tool) => BROWSER_TOOLS.some((prefix) => tool.startsWith(prefix)))
}
