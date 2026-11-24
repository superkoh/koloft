// ADR-0051
import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'
import { createJiti } from 'jiti'

const ROOT = process.cwd()
const SOURCE_FILE = /\.tsx?$/
const PLUGINS = 'src/plugins/'
const PLUGIN_LIST = 'src/plugins/list'
const LIST_ENTRY = {
  [PLUGIN_LIST]: 'plugin',
  'src/plugins/bridges': 'preload/bridge',
  'src/plugins/uis': 'renderer/ui',
  'src/plugins/settings': 'shared/settings',
  'src/plugins/starts': 'main/start'
}
const ALIASES = {
  '@shared': 'src/shared',
  '@core': 'src/core',
  '@plugins': 'src/plugins',
  '@agents': 'src/agents',
  '@renderer': 'src/renderer/src'
}
const PUBLIC_SURFACES = new Set(['api', 'windowApi'])
const WINDOW_UNSAFE = /^(main|prompts)\//
const RULE =
  'A plugin imports only src/core, its own folder and the api.ts or windowApi.ts of a plugin in its needs; ' +
  'outside src/plugins, only the lists import a plugin: src/plugins/list.ts its plugin.ts, ' +
  'src/plugins/bridges.ts its preload/bridge.ts, src/plugins/uis.ts its renderer/ui.tsx, ' +
  'src/plugins/settings.ts its shared/settings.ts, src/plugins/starts.ts its main/start.ts (ADR-0051).'

const withoutExtension = (p) => p.replace(SOURCE_FILE, '')

function sourceFiles() {
  return fs
    .readdirSync(path.join(ROOT, 'src'), { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && SOURCE_FILE.test(d.name))
    .map((d) => path.relative(ROOT, path.join(d.parentPath, d.name)))
    .sort()
}

async function needsById(problems) {
  const alias = Object.fromEntries(
    Object.entries(ALIASES).map(([name, dir]) => [name, path.join(ROOT, dir)])
  )
  try {
    const { PLUGINS: manifests } = await createJiti(import.meta.url, { alias }).import(
      path.join(ROOT, `${PLUGIN_LIST}.ts`)
    )
    return new Map(manifests.map((m) => [m.id, new Set(m.needs)]))
  } catch (e) {
    problems.push(`${PLUGIN_LIST}.ts: cannot load the manifests (${e.message})`)
    return new Map()
  }
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
        : node.type === 'TSImportType'
          ? node.argument
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
    : Object.hasOwn(ALIASES, first) && path.posix.join(ALIASES[first], ...rest)
  return joined && withoutExtension(joined)
}

function pluginOf(file) {
  const rel = withoutExtension(file)
  if (!rel.startsWith(PLUGINS) || Object.hasOwn(LIST_ENTRY, rel)) return undefined
  const [id, ...rest] = rel.slice(PLUGINS.length).split('/')
  return { id, inside: rest.join('/') }
}

const inCore = (rel) => rel === 'src/core' || rel.startsWith('src/core/')

function breach(fromRel, to, needs) {
  const from = pluginOf(fromRel)
  const into = pluginOf(to)
  const list = withoutExtension(fromRel)
  const entry = Object.hasOwn(LIST_ENTRY, list) && LIST_ENTRY[list]
  if (entry)
    return into && into.inside !== entry
      ? `imports plugin ${into.id} past its ${entry}.ts`
      : undefined
  if (!from) return into && `names plugin ${into.id} outside the lists of plugins`
  if (from.inside === 'windowApi' && into?.id === from.id && WINDOW_UNSAFE.test(into.inside))
    return `loads ${into.inside}.ts into the window from its windowApi.ts`
  if (into?.id === from.id || inCore(to)) return undefined
  if (into)
    return !PUBLIC_SURFACES.has(into.inside)
      ? `imports plugin ${into.id} past its api.ts and windowApi.ts`
      : needs.get(from.id)?.has(into.id)
        ? undefined
        : `imports the ${into.inside}.ts of ${into.id}, which its manifest does not list in needs`
  if (Object.hasOwn(LIST_ENTRY, to)) return 'imports a list of plugins'
  if (to.startsWith('src/shared/'))
    return 'imports src/shared, which is not core (whether it becomes core is not decided)'
  return 'imports app code outside src/core'
}

const problems = []
const needs = await needsById(problems)
const files = sourceFiles()
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
