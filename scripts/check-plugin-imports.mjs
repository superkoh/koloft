// ADR-0051
import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'

const ROOT = path.resolve(import.meta.dirname, '..')
const SOURCE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/
const PLUGINS = 'src/plugins/'
const PLUGIN_LIST = 'src/plugins/list'
const ALIASES = {
  '@shared/': 'src/shared/',
  '@core/': 'src/core/',
  '@plugins/': 'src/plugins/',
  '@renderer/': 'src/renderer/src/'
}
const RULE =
  'A plugin imports only src/core, its own folder and the api.ts of a plugin in its needs; ' +
  'outside src/plugins, only src/plugins/list.ts is imported (ADR-0051).'

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const withoutExtension = (p) => p.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')

function sourceFiles() {
  return fs
    .readdirSync(path.join(ROOT, 'src'), { recursive: true })
    .map((f) => path.posix.join('src', f.split(path.sep).join('/')))
    .filter((f) => SOURCE_FILE.test(f) && fs.statSync(path.join(ROOT, f)).isFile())
    .sort()
}

function parseSource(rel) {
  const plugins = rel.endsWith('.tsx')
    ? ['typescript', 'jsx']
    : rel.endsWith('.ts')
      ? ['typescript']
      : ['jsx']
  return parse(read(rel), { sourceType: 'unambiguous', plugins })
}

function walk(node, visit) {
  visit(node)
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key.endsWith('Comments') || !value || typeof value !== 'object') continue
    for (const child of Array.isArray(value) ? value : [value])
      if (child && typeof child.type === 'string') walk(child, visit)
  }
}

const literal = (node) =>
  node?.type === 'StringLiteral'
    ? node.value
    : node?.type === 'TSLiteralType'
      ? literal(node.literal)
      : undefined

function importedSpecifiers(ast) {
  const found = []
  const add = (node, at) => {
    const spec = literal(node)
    if (spec !== undefined) found.push({ spec, line: at.loc.start.line })
  }
  walk(ast.program, (node) => {
    if (
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      node.type === 'ExportNamedDeclaration'
    )
      add(node.source, node)
    else if (node.type === 'ImportExpression') add(node.source, node)
    else if (node.type === 'TSImportType') add(node.argument, node)
    else if (
      node.type === 'CallExpression' &&
      (node.callee.type === 'Import' ||
        (node.callee.type === 'Identifier' && node.callee.name === 'require'))
    )
      add(node.arguments[0], node)
  })
  return found
}

function target(fromRel, spec) {
  const bare = spec.split('?')[0]
  if (bare.startsWith('.'))
    return withoutExtension(
      path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), bare))
    )
  for (const [alias, dir] of Object.entries(ALIASES))
    if (bare.startsWith(alias)) return withoutExtension(dir + bare.slice(alias.length))
  return undefined
}

function pluginOf(rel) {
  if (!rel.startsWith(PLUGINS) || withoutExtension(rel) === PLUGIN_LIST) return undefined
  const [id, ...rest] = rel.slice(PLUGINS.length).split('/')
  return { id, inside: rest.join('/') }
}

function manifestNeeds(id, problems) {
  const rel = `${PLUGINS}${id}/plugin.ts`
  let needs
  try {
    walk(parseSource(rel).program, (node) => {
      if (node.type !== 'ObjectProperty' || node.key.name !== 'needs') return
      if (node.value.type === 'ArrayExpression')
        needs = node.value.elements.map(literal).filter((n) => n !== undefined)
    })
  } catch {}
  if (needs === undefined) problems.push(`${rel}: no needs list of plain strings to read`)
  return new Set(needs ?? [])
}

function breach(fromRel, to, needsOf) {
  const from = pluginOf(fromRel)
  const into = pluginOf(to)
  if (!from) {
    if (withoutExtension(fromRel) === PLUGIN_LIST || !into) return undefined
    return `names plugin ${into.id} outside the list of plugins`
  }
  if (into?.id === from.id || to.startsWith('src/core/')) return undefined
  if (to === PLUGIN_LIST) return 'imports the list of plugins'
  if (into && into.inside !== 'api') return `imports plugin ${into.id} past its api.ts`
  if (into && !needsOf(from.id).has(into.id))
    return `imports the api.ts of ${into.id}, which its manifest does not list in needs`
  if (into) return undefined
  if (to.startsWith('src/shared/'))
    return 'imports src/shared, which is not core (whether it becomes core is not decided)'
  return 'imports app code outside src/core'
}

function checkAll() {
  const problems = []
  const needs = new Map()
  const needsOf = (id) => {
    if (!needs.has(id)) needs.set(id, manifestNeeds(id, problems))
    return needs.get(id)
  }
  const files = sourceFiles()
  for (const rel of files) {
    let specs
    try {
      specs = importedSpecifiers(parseSource(rel))
    } catch (e) {
      problems.push(`${rel}: cannot parse (${e.message})`)
      continue
    }
    for (const { spec, line } of specs) {
      const to = target(rel, spec)
      const why = to && breach(rel, to, needsOf)
      if (why) problems.push(`${rel}:${line}  ${spec}  ${why}`)
    }
  }
  return { problems, scanned: files.length }
}

const { problems, scanned } = checkAll()
if (problems.length > 0) console.log([RULE, ...problems.map((p) => `  ${p}`)].join('\n'))
console.log(
  `check-plugin-imports: ${problems.length} found in ${scanned} files under src/ (report only, never fails).`
)
