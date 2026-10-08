import { shq } from '@shared/shellQuote'

export const CONDUCTOR_DENIED =
  'Koloft: a conductor only passes work on. It may read files, ask the owner a question and run one plain koloft command per Bash call (no ;, &&, |, >, $ or backticks outside quotes). To get anything else done, start a session with koloft session new or message one with koloft session send.'

const READ_OR_ASK_TOOLS = ['Read', 'Glob', 'Grep', 'Skill', 'ToolSearch', 'AskUserQuestion']

// ADR-0029 CC§15
export const CONDUCTOR_GATE_SCRIPT = `const READ_OR_ASK_TOOLS = new Set(${JSON.stringify(READ_OR_ASK_TOOLS)})
const DENIED = ${JSON.stringify(CONDUCTOR_DENIED)}

function oneKoloftCall(command) {
  const cmd = String(command).trim()
  if (!/^koloft(\\s|$)/.test(cmd)) return false
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

function allowed(event) {
  if (READ_OR_ASK_TOOLS.has(event.tool_name)) return true
  return event.tool_name === 'Bash' && oneKoloftCall(event.tool_input && event.tool_input.command)
}

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => (raw += chunk))
process.stdin.on('end', () => {
  let event = {}
  try {
    event = JSON.parse(raw)
  } catch {}
  if (allowed(event)) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: DENIED
      }
    })
  )
})
`

export function conductorGateCommand(gateScript: string): string {
  return `ELECTRON_RUN_AS_NODE=1 ${shq(process.execPath)} ${shq(gateScript)}`
}
