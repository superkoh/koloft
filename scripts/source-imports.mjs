import fs from 'node:fs'
import path from 'node:path'
import { parse } from '@babel/parser'

export const ALIASES = {
  '@shared': 'src/shared',
  '@core': 'src/core',
  '@plugins': 'src/plugins',
  '@agents': 'src/agents',
  '@renderer': 'src/renderer/src'
}
export const AGENTS_DIR = 'src/agents/'
export const LISTS_OF_AGENTS = new Set([
  'src/agents/list.ts',
  'src/agents/starts.ts',
  'src/agents/uis.ts'
])

export function sourceFilesUnder(root, sourceFile) {
  const src = path.join(root, 'src')
  if (!fs.existsSync(src)) return []
  return fs
    .readdirSync(src, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile() && sourceFile.test(d.name))
    .map((d) => path.relative(root, path.join(d.parentPath, d.name)).split(path.sep).join('/'))
    .sort()
}

export function parseSource(root, rel) {
  return parse(fs.readFileSync(path.join(root, rel), 'utf8'), {
    sourceType: 'module',
    plugins: rel.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript']
  }).program
}

export function walk(node, visit) {
  visit(node)
  for (const value of Object.values(node))
    for (const child of Array.isArray(value) ? value : [value])
      if (child && typeof child.type === 'string') walk(child, visit)
}

export function importedSpecifierOf(node) {
  const source =
    node.type === 'CallExpression' && node.callee.type === 'Import'
      ? node.arguments[0]
      : node.type === 'TSImportType'
        ? node.argument
        : /^(Import|ExportAll|ExportNamed)Declaration$/.test(node.type)
          ? node.source
          : undefined
  return source?.type === 'StringLiteral' ? source.value : undefined
}

export function importedPath(fromRel, spec) {
  const bare = spec.split('?')[0]
  const [first, ...rest] = bare.split('/')
  if (bare.startsWith('.')) return path.posix.join(path.posix.dirname(fromRel), bare)
  return Object.hasOwn(ALIASES, first) ? path.posix.join(ALIASES[first], ...rest) : undefined
}
