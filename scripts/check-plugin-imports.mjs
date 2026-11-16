// ADR-0051
import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import { createJiti } from 'jiti'

const ROOT = process.cwd()
const SOURCE_FILE = /\.tsx?$/
const PLUGINS = 'src/plugins/'
const PLUGIN_LIST = 'src/plugins/list'
const ALIASES = {
  '@shared': 'src/shared',
  '@core': 'src/core',
  '@plugins': 'src/plugins',
  '@renderer': 'src/renderer/src'
}
const RULE =
  'A plugin imports only src/core, its own folder and the api.ts of a plugin in its needs; ' +
  'outside src/plugins, only src/plugins/list.ts imports a plugin, and only its plugin.ts (ADR-0051).'

const withoutExtension = (p) => p.replace(SOURCE_FILE, '')

function sourceFiles() {
  return fs
    .readdirSync(path.join(ROOT, 'src'), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && SOURCE_FILE.test(d.name))
    .map((d) => path.relative(ROOT, path.join(d.parentPath, d.name)))
    .sort()
}

async function needsById() {
  const alias = Object.fromEntries(
    Object.entries(ALIASES).map(([name, dir]) => [name, path.join(ROOT, dir)])
  )
  const { PLUGINS: manifests } = await createJiti(import.meta.url, { alias }).import(
    path.join(ROOT, `${PLUGIN_LIST}.ts`)
  )
  return new Map(manifests.map((m) => [m.id, new Set(m.needs)]))
}

function walk(node, visit) {
  visit(node)
  for (const value of Object.values(node))
    for (const child of Array.isArray(value) ? value : [value])
      if (child && typeof child.type === 'string') walk(child, visit)
}

function importedSpecifiers(rel) {
  const ast = parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    sourceType: 'module',
    plugins: rel.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript']
  })
  const found = []
  walk(ast.program, (node) => {
    const source =
      node.type === 'CallExpression' && node.callee.type === 'Import'
        ? node.arguments[0]
        : /^(Import|ExportAll|ExportNamed)Declaration$/.test(node.type)
          ? node.source
          : undefined
    if (source?.type === 'StringLiteral')
      found.push({ spec: source.value, line: node.loc.start.line })
  })
  return found
}

function target(fromRel, spec) {
  const bare = spec.split('?')[0]
  const [first, ...rest] = bare.split('/')
  const joined = bare.startsWith('.')
    ? path.posix.join(path.posix.dirname(fromRel), bare)
    : ALIASES[first] && path.posix.join(ALIASES[first], ...rest)
  return joined && withoutExtension(joined)
}

function pluginOf(rel) {
  if (!rel.startsWith(PLUGINS) || rel === PLUGIN_LIST) return undefined
  const [id, ...rest] = rel.slice(PLUGINS.length).split('/')
  return { id, inside: rest.join('/') }
}

const inCore = (rel) => rel === 'src/core' || rel.startsWith('src/core/')

function breach(fromRel, to, needs) {
  const from = pluginOf(fromRel)
  const into = pluginOf(to)
  if (withoutExtension(fromRel) === PLUGIN_LIST)
    return into && into.inside !== 'plugin'
      ? `imports plugin ${into.id} past its plugin.ts`
      : undefined
  if (!from) return into && `names plugin ${into.id} outside the list of plugins`
  if (into?.id === from.id || inCore(to)) return undefined
  if (into)
    return into.inside !== 'api'
      ? `imports plugin ${into.id} past its api.ts`
      : needs.get(from.id)?.has(into.id)
        ? undefined
        : `imports the api.ts of ${into.id}, which its manifest does not list in needs`
  if (to === PLUGIN_LIST) return 'imports the list of plugins'
  if (to.startsWith('src/shared/'))
    return 'imports src/shared, which is not core (whether it becomes core is not decided)'
  return 'imports app code outside src/core'
}

const needs = await needsById()
const files = sourceFiles()
const problems = []
for (const rel of files) {
  let specs
  try {
    specs = importedSpecifiers(rel)
  } catch (e) {
    problems.push(`${rel}: cannot parse (${e.message})`)
    continue
  }
  for (const { spec, line } of specs) {
    const to = target(rel, spec)
    const why = to && breach(rel, to, needs)
    if (why) problems.push(`${rel}:${line}  ${spec}  ${why}`)
  }
}
if (problems.length > 0) console.log([RULE, ...problems.map((p) => `  ${p}`)].join('\n'))
console.log(
  `check-plugin-imports: ${problems.length} found in ${files.length} files under src/ (report only, never fails).`
)
