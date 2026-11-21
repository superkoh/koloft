import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { depsState, worktreeOf } from './worktree-deps-state.mjs'

// ADR-0052 CODEX§27 AGY§12

const ROOT = path.resolve(import.meta.dirname, '..')
const AGY_FILE_EDITS = new Set(['write_file', 'edit_file', 'write_to_file', 'replace_file_content'])
const COULD_PUSH = /\b(push|pr)\b/
const PATCHED_FILE = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gm
const AGY_NOTES_FILE = 'koloft-dev-notes.txt'

const [agent, check] = process.argv.slice(2)
let input = {}
let cwd = ROOT

const runScript = (name, args, stdin) =>
  spawnSync(process.execPath, [path.join(ROOT, 'scripts', name), ...args], {
    cwd: ROOT,
    input: JSON.stringify(stdin),
    encoding: 'utf8'
  })

const tellCodex = (hookEventName, additionalContext) =>
  console.log(JSON.stringify({ hookSpecificOutput: { hookEventName, additionalContext } }))

function systemMessageIn(stdout) {
  try {
    return JSON.parse(stdout).systemMessage
  } catch {
    return undefined
  }
}

function sessionStart() {
  const worktree = worktreeOf(cwd)
  if (!worktree.linked) return
  if (depsState(worktree) === 'ready' && fs.existsSync(worktree.nodeModules)) return
  spawn(process.execPath, [path.join(ROOT, 'scripts', 'worktree-deps.mjs'), '--here'], {
    cwd: worktree.root,
    detached: true,
    stdio: 'ignore'
  }).unref()
  const said = `This worktree's node_modules started installing in the background as this session began (log: ${worktree.log}). Until it finishes, Node resolves packages from the parent checkout: before building or testing here, check that the log has ended. A push waits for it on its own.`
  if (agent === 'codex') tellCodex('SessionStart', said)
  else console.log(JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: said } }] }))
}

function shellCommand() {
  if (agent === 'codex') return input.tool_input?.command
  if (input.toolCall?.name === 'run_command') return input.toolCall.args?.CommandLine
  return undefined
}

function beforeShellCommand() {
  const command = shellCommand()
  if (typeof command !== 'string' || !COULD_PUSH.test(command)) return
  const where = agent === 'agy' ? (input.toolCall.args?.Cwd ?? cwd) : cwd
  const r = runScript('push-checks.mjs', [], { cwd: where, tool_input: { command } })
  if (r.status === 2) {
    const reason = r.stderr.trim()
    if (agent === 'agy') return console.log(JSON.stringify({ decision: 'deny', reason }))
    console.error(reason)
    process.exit(2)
  }
  const said = systemMessageIn(r.stdout)
  if (said && agent === 'codex') tellCodex('PreToolUse', said)
}

function editedFiles() {
  if (agent === 'codex') {
    if (input.tool_name !== 'apply_patch') return []
    const patch = String(input.tool_input?.command ?? '')
    return [...patch.matchAll(PATCHED_FILE)].map((m) => path.resolve(cwd, m[1].trim()))
  }
  const call = input.toolCall
  if (!AGY_FILE_EDITS.has(call?.name)) return []
  const file = call.args?.Path ?? call.args?.TargetFile
  return typeof file === 'string' ? [path.resolve(cwd, file)] : []
}

function afterFileEdit() {
  const problems = editedFiles()
    .map((file) => runScript('check-comments.mjs', ['--hook'], { tool_input: { file_path: file } }))
    .filter((r) => r.status === 2)
    .map((r) => r.stderr.trim())
  if (problems.length === 0) return
  const said = problems.join('\n')
  if (agent === 'codex') return tellCodex('PostToolUse', said)
  if (input.artifactDirectoryPath)
    fs.appendFileSync(path.join(input.artifactDirectoryPath, AGY_NOTES_FILE), `${said}\n`)
}

function beforeModelCall() {
  if (!input.artifactDirectoryPath) return
  const notes = path.join(input.artifactDirectoryPath, AGY_NOTES_FILE)
  if (!fs.existsSync(notes)) return
  const said = fs.readFileSync(notes, 'utf8').trim()
  fs.rmSync(notes)
  if (said) console.log(JSON.stringify({ injectSteps: [{ ephemeralMessage: said }] }))
}

const CHECKS = {
  'session-start': sessionStart,
  'before-shell-command': beforeShellCommand,
  'after-file-edit': afterFileEdit,
  'before-model-call': beforeModelCall
}
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
  cwd = input.cwd || ROOT
  CHECKS[check]?.()
} catch (e) {
  console.error(`agent-hook: ${e.message}`)
  process.exit(0)
}
