// ADR-0054
import fs from 'node:fs'
import path from 'node:path'
import { createJiti } from 'jiti'
import * as prettier from 'prettier'

const ROOT = process.cwd()
const BASELINE = 'scripts/agent-words-baseline.json'
const CHECKED_FILE = /\.(tsx?|css)$/
const STYLE_FILE = /\.css$/
const AGENTS_DIR = 'src/agents/'
const AGENT_LIST = 'src/agents/list.ts'
const LISTS_THAT_MAY_NAME_AGENTS = new Set([
  AGENT_LIST,
  'src/agents/starts.ts',
  'src/agents/uis.ts'
])
const ALIASES = {
  '@shared': 'src/shared',
  '@core': 'src/core',
  '@plugins': 'src/plugins',
  '@agents': 'src/agents',
  '@renderer': 'src/renderer/src'
}
const MARKER = String.raw`(?:ADR-\d{4}|AGY§\d+|CC§\d+|CODEX§\d+|PLATFORM§\d+)`
const MARKER_COMMENT = new RegExp(
  String.raw`\{?\s*\/\*\s*${MARKER}(?:\s+${MARKER})*\s*\*\/\s*\}?|\/\/\s*${MARKER}(?:\s+${MARKER})*\s*$`,
  'g'
)
const ROUNDABOUT = [
  { label: 'Exclude<agent id type>', re: /\bExclude<\s*(?:AgentId|BackendId)\b/ },
  {
    label: 'agent list[N]',
    re: /\b(?:AGENTS|AGENT_IDS|SESSION_BACKENDS)\s*(?:\[\s*\d+\s*\]|\.at\(\s*-?\d+\s*\))/
  }
]
const PRUNE = process.argv.includes('--prune')
const ACCEPT_NEW = process.argv.includes('--accept-new')

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const lineKey = (text) => text.replace(MARKER_COMMENT, '').trim().replace(/\s+/g, ' ')

function sourceFiles() {
  const src = path.join(ROOT, 'src')
  if (!fs.existsSync(src)) return []
  return fs
    .readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && CHECKED_FILE.test(d.name))
    .map((d) => path.relative(ROOT, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
    .sort()
}

async function agentMatchers() {
  const alias = Object.fromEntries(
    Object.entries(ALIASES).map(([name, dir]) => [name, path.join(ROOT, dir)])
  )
  const { AGENTS } = await createJiti(import.meta.url, { alias }).import(
    path.join(ROOT, AGENT_LIST)
  )
  return AGENTS.map(({ id, wordsThatNameMe: w }) => ({
    id,
    words: [
      ...w.anyCase.map((word) => ({ word, re: new RegExp(escape(word), 'i') })),
      ...w.wholeWord.map((word) => ({
        word,
        re: new RegExp(String.raw`(?<![\w-])${escape(word)}(?![\w-])`)
      })),
      ...w.quoted.map((word) => ({
        word: `'${word}'`,
        re: new RegExp(String.raw`(['"\x60])${escape(word)}\1`)
      }))
    ]
  }))
}

function folderOf(file) {
  return file.startsWith(AGENTS_DIR) ? file.slice(AGENTS_DIR.length).split('/')[0] : undefined
}

function hitsIn(file, text, agents) {
  const owner = folderOf(file)
  const foreign = agents.filter((a) => a.id !== owner).flatMap((a) => a.words)
  const hits = []
  text.split('\n').forEach((raw, i) => {
    const stripped = raw.replace(MARKER_COMMENT, '')
    const words = [
      ...foreign.filter((w) => w.re.test(stripped)).map((w) => w.word),
      ...ROUNDABOUT.filter((r) => r.re.test(stripped)).map((r) => r.label)
    ]
    if (words.length > 0) hits.push({ file, line: i + 1, key: lineKey(raw), words })
  })
  return hits
}

function readBaseline() {
  const file = path.join(ROOT, BASELINE)
  const empty = { awaitingMove: {}, allowed: [], lines: {} }
  return fs.existsSync(file) ? { ...empty, ...JSON.parse(fs.readFileSync(file, 'utf8')) } : empty
}

async function writeBaseline(baseline) {
  const file = path.join(ROOT, BASELINE)
  const sorted = {
    awaitingMove: Object.fromEntries(Object.entries(baseline.awaitingMove).sort()),
    allowed: [...baseline.allowed].sort((a, b) =>
      `${a.file}\n${a.line}`.localeCompare(`${b.file}\n${b.line}`)
    ),
    lines: Object.fromEntries(
      Object.entries(baseline.lines)
        .filter(([, keys]) => keys.length > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([f, keys]) => [f, [...keys].sort()])
    )
  }
  const options = (await prettier.resolveConfig(file)) ?? {}
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    await prettier.format(JSON.stringify(sorted), { ...options, filepath: file })
  )
}

function countBy(keys) {
  const counts = new Map()
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1)
  return counts
}

function compare(baseline, files, agents) {
  const ids = new Set(agents.map((a) => a.id))
  const present = new Set(files)
  const fresh = []
  const gone = []
  const current = {}
  const allowedLeft = new Map(baseline.allowed.map((a) => [a, false]))
  for (const file of files) {
    if (LISTS_THAT_MAY_NAME_AGENTS.has(file) || Object.hasOwn(baseline.awaitingMove, file)) continue
    const hits = hitsIn(file, fs.readFileSync(path.join(ROOT, file), 'utf8'), agents).filter(
      (h) => {
        const allow = baseline.allowed.find((a) => a.file === file && a.line === h.key)
        if (allow) allowedLeft.set(allow, true)
        return !allow
      }
    )
    if (hits.length === 0) continue
    current[file] = hits.map((h) => h.key)
    const room = countBy(baseline.lines[file] ?? [])
    for (const h of hits) {
      const left = room.get(h.key) ?? 0
      if (left > 0) room.set(h.key, left - 1)
      else fresh.push(h)
    }
  }
  for (const [file, keys] of Object.entries(baseline.lines)) {
    const now = countBy(current[file] ?? [])
    for (const [key, n] of countBy(keys)) {
      const extra = n - (now.get(key) ?? 0)
      for (let i = 0; i < extra; i++) gone.push(`${file}  ${key}`)
    }
  }
  for (const [file, owner] of Object.entries(baseline.awaitingMove)) {
    if (!present.has(file)) gone.push(`awaitingMove ${file} (no such file any more)`)
    else if (!ids.has(owner)) gone.push(`awaitingMove ${file} (no agent "${owner}" in the list)`)
  }
  for (const [allow, used] of allowedLeft)
    if (!used) gone.push(`allowed ${allow.file}  ${allow.line} (no such line any more)`)
  return { fresh, gone, current, allowedLeft }
}

function pruned(baseline, { current, allowedLeft }, files, agents) {
  const ids = new Set(agents.map((a) => a.id))
  const present = new Set(files)
  const lines = {}
  for (const [file, keys] of Object.entries(baseline.lines)) {
    const now = countBy(current[file] ?? [])
    lines[file] = keys.filter((k) => {
      const left = now.get(k) ?? 0
      if (left === 0) return false
      now.set(k, left - 1)
      return true
    })
  }
  return {
    awaitingMove: Object.fromEntries(
      Object.entries(baseline.awaitingMove).filter(([f, o]) => present.has(f) && ids.has(o))
    ),
    allowed: baseline.allowed.filter((a) => allowedLeft.get(a)),
    lines
  }
}

function summary(baseline) {
  const entries = Object.entries(baseline.lines)
  const part = (style) => {
    const mine = entries.filter(([f]) => STYLE_FILE.test(f) === style)
    return `${mine.reduce((n, [, k]) => n + k.length, 0)} lines in ${mine.length} files`
  }
  return (
    `baseline ${part(false)} (.ts/.tsx) and ${part(true)} (.css); ` +
    `${Object.keys(baseline.awaitingMove).length} files await the move into src/agents; ` +
    `${baseline.allowed.length} lines allowed by name`
  )
}

const NEW_HELP = [
  'Code outside an agent’s own folder must not name an agent (ADR-0054, issue #2410).',
  'How to fix:',
  '- Put code that is about one agent in that agent’s folder, src/agents/<id>/. Until an',
  `  agent’s old files move there, the files listed under "awaitingMove" in ${BASELINE}`,
  '  are that agent’s own too, and are not checked.',
  '- Elsewhere, ask the agent list (src/core/agent/registry.ts) instead of naming one.',
  '- A changed line that already named an agent counts as new.',
  '- If it truly must stay where it is, say why in the PR body, then run',
  '  `npm run check:agent-words -- --accept-new` and commit the baseline.',
  '- A false hit (a word that means something else here) goes under "allowed" in the',
  '  baseline as { file, line, reason }.'
]
const GONE_HELP = [
  `These baseline entries are gone. Run \`npm run check:agent-words -- --prune\` and commit`,
  `${BASELINE}, so they cannot come back.`
]

let agents
try {
  agents = await agentMatchers()
} catch (e) {
  console.error(`check-agent-words: cannot load ${AGENT_LIST} (${e.message})`)
  process.exit(2)
}
const files = sourceFiles()
let baseline = readBaseline()
let result = compare(baseline, files, agents)

if (PRUNE || ACCEPT_NEW) {
  baseline = pruned(baseline, result, files, agents)
  if (ACCEPT_NEW) for (const h of result.fresh) (baseline.lines[h.file] ??= []).push(h.key)
  await writeBaseline(baseline)
  baseline = readBaseline()
  result = compare(baseline, files, agents)
}

const out = []
if (result.fresh.length > 0)
  out.push(
    `check-agent-words: ${result.fresh.length} new lines name an agent.`,
    ...result.fresh.map((h) => `  ${h.file}:${h.line}  [${h.words.join(', ')}]  ${h.key}`),
    ...NEW_HELP
  )
if (result.gone.length > 0)
  out.push(
    `check-agent-words: ${result.gone.length} baseline entries no longer match the code.`,
    ...result.gone.map((g) => `  ${g}`),
    ...GONE_HELP
  )
if (out.length > 0) {
  console.error(out.join('\n'))
  process.exit(1)
}
console.log(`check-agent-words: nothing new; ${summary(baseline)}.`)
