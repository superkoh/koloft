import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { parse } from '@babel/parser'
import postcss from 'postcss'

const ROOT = path.resolve(import.meta.dirname, '..')
const ADR_DIR = 'docs/adr'
const CODE_FILE = /\.(ts|tsx|js|mjs|cjs|css)$/
const MARKERS = /^(?:(?:ADR-\d{4}|CC§\d+|CODEX§\d+|PLATFORM§\d+)(?: |$))+$/
const LEDGERS = {
  CC: { file: 'docs/claude-code-contract.md', heading: /^## §(\d+) /gm },
  CODEX: { file: 'docs/codex-cli-contract.md', heading: /^## (\d+)\. /gm },
  PLATFORM: { file: 'docs/platform-contract.md', heading: /^## §(\d+) /gm }
}
const DIRECTIVES = [
  /^@ts-expect-error$/,
  /^prettier-ignore$/,
  /^@vite-ignore$/,
  /^[#@]__PURE__$/,
  /^@vitest-environment \S+$/,
  /^\/ <reference [^>]+\/>$/
]
const RULE = 'Code comments are not allowed — see "Comments" in CLAUDE.md.'

const show = (rel, c) => `  ${rel}:${c.line}  ${c.text.split('\n')[0].slice(0, 100)}`
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function scan(rel, src) {
  const found = { comments: [], markers: [] }
  const classify = (text, line, allowDirective) => {
    if (MARKERS.test(text)) for (const m of text.split(' ')) found.markers.push({ m, line })
    else if (!(allowDirective && DIRECTIVES.some((d) => d.test(text))))
      found.comments.push({ text, line })
  }
  if (rel.endsWith('.css')) {
    const root = postcss.parse(src)
    root.walkComments((c) => classify(c.text, c.source.start.line, false))
    root.walk((node) => {
      for (const raw of [node.raws.selector?.raw, node.raws.value?.raw, node.raws.params?.raw])
        for (const m of (raw ?? '').matchAll(/\/\*([\s\S]*?)\*\//g))
          classify(m[1].trim(), node.source.start.line, false)
    })
    return found
  }
  const plugins = rel.endsWith('.tsx')
    ? ['typescript', 'jsx']
    : rel.endsWith('.ts')
      ? ['typescript']
      : []
  const ast = parse(src, {
    sourceType: 'unambiguous',
    plugins,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true
  })
  for (const c of ast.comments) classify(c.value.trim(), c.loc.start.line, true)
  walk(ast.program, (node) => {
    if (node.type !== 'TemplateLiteral' || !node.quasis[0].value.raw.startsWith('#!/')) return
    const lines = node.quasis
      .map((q) => q.value.raw)
      .join('${}')
      .split('\n')
    lines.forEach((l, i) => {
      const hash = i > 0 && /^\s*#(.*)$/.exec(l)
      if (hash) classify(hash[1].trim(), node.loc.start.line + i, false)
    })
  })
  found.comments.sort((a, b) => a.line - b.line)
  return found
}

function walk(node, visit) {
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key.endsWith('Comments') || !value || typeof value !== 'object') continue
    for (const child of Array.isArray(value) ? value : [value])
      if (child && typeof child.type === 'string') walk(child, visit)
  }
}

function repoFiles(...pathspec) {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '--', ...pathspec], {
    cwd: ROOT,
    encoding: 'utf8'
  })
    .split('\n')
    .filter((f) => f && fs.existsSync(path.join(ROOT, f)))
}

function uncommented(rel, found) {
  if (found.comments.length === 0) return []
  return [`${rel}: ${RULE}`, ...found.comments.map((c) => show(rel, c))]
}

function knownTargets() {
  const errors = []
  const adrs = new Map()
  for (const name of repoFiles(ADR_DIR).map((f) => path.basename(f))) {
    if (name === 'README.md') continue
    const m = /^(\d{4})-[a-z0-9-]+\.md$/.exec(name)
    if (!m) errors.push(`${ADR_DIR}/${name}: ADR files are named NNNN-short-slug.md`)
    else if (adrs.has(`ADR-${m[1]}`))
      errors.push(`${ADR_DIR}: ADR number ${m[1]} is used twice — renumber the newer one`)
    else adrs.set(`ADR-${m[1]}`, `${ADR_DIR}/${name}`)
  }
  const targets = new Set(adrs.keys())
  for (const [prefix, { file, heading }] of Object.entries(LEDGERS))
    for (const m of read(file).matchAll(heading)) targets.add(`${prefix}§${m[1]}`)
  return { errors, adrs, targets }
}

function unresolved(rel, found, targets) {
  return found.markers
    .filter(({ m }) => !targets.has(m))
    .map(({ m, line }) => `${rel}:${line}: ${m} points at no ADR file or ledger section`)
}

function checkAll() {
  const { errors, adrs, targets } = knownTargets()
  const cited = new Set()
  for (const rel of repoFiles().filter((f) => CODE_FILE.test(f))) {
    let found
    try {
      found = scan(rel, read(rel))
    } catch (e) {
      errors.push(`${rel}: cannot parse (${e.message})`)
      continue
    }
    for (const { m } of found.markers) cited.add(m)
    errors.push(...uncommented(rel, found), ...unresolved(rel, found, targets))
  }
  for (const [id, file] of adrs)
    if (!cited.has(id)) errors.push(`${file}: no code cites ${id} — delete it or add the marker`)
  return errors
}

function checkHookedFile() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'))
  const file = path.resolve(input.tool_input?.file_path ?? '')
  const rel = path.relative(ROOT, file)
  if (rel.startsWith('..') || !CODE_FILE.test(file) || !fs.existsSync(file)) return []
  const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: path.dirname(file),
    encoding: 'utf8'
  }).trim()
  if (fs.realpathSync(top) !== fs.realpathSync(ROOT)) return []
  let found
  try {
    found = scan(rel, read(rel))
  } catch {
    return []
  }
  return [...uncommented(rel, found), ...unresolved(rel, found, knownTargets().targets)]
}

const hook = process.argv.includes('--hook')
const errors = hook ? checkHookedFile() : checkAll()
if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exit(hook ? 2 : 1)
}
