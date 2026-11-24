// ADR-0054
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { LEDGERS } from './ledgers.mjs'
import {
  AGENTS_DIR,
  AGENT_LIST,
  LISTS_OF_AGENTS,
  agentFolderOf,
  byCodeUnit,
  importAgentList,
  importedPath,
  parseSource,
  sourceFilesUnder,
  walk,
  withoutCasts
} from './source-imports.mjs'

const ROOT = process.cwd()
const MANIFEST_LIST = AGENT_LIST
const MANIFEST_ARRAY = 'AGENTS'
const CHECKS = [
  { label: 'main process', config: 'tsconfig.node.json' },
  { label: 'window', config: 'tsconfig.web.json' }
]
const MARKED_FILE = /\.([cm]?[jt]sx?|css)$/
const TYPECHECKS_AT_ONCE = 4
const NOTHING_DELETED = 'nothing deleted'
const CANNOT_RUN = 2
const SHOW_FILES = process.argv.includes('--files')

class CannotRun extends Error {}

function cannotRun(why) {
  throw new CannotRun(why)
}

const NAME_NOT_A_REFERENCE = {
  ImportSpecifier: ['imported'],
  ExportSpecifier: ['exported'],
  ObjectProperty: ['key'],
  ObjectMethod: ['key'],
  ClassProperty: ['key'],
  ClassMethod: ['key'],
  MemberExpression: ['property'],
  OptionalMemberExpression: ['property'],
  TSPropertySignature: ['key'],
  TSQualifiedName: ['right']
}

function referencesTo(node, names, found = new Set()) {
  if (node.type === 'Identifier' && names.has(node.name)) found.add(node.name)
  const skipped = node.computed ? [] : (NAME_NOT_A_REFERENCE[node.type] ?? [])
  for (const [key, value] of Object.entries(node)) {
    if (skipped.includes(key)) continue
    for (const child of Array.isArray(value) ? value : [value])
      if (child && typeof child.type === 'string') referencesTo(child, names, found)
  }
  return [...found]
}

function agentImports(root, file) {
  const program = parseSource(root, file)
  const reExport = program.body.find(
    (node) =>
      /^Export(Named|All)Declaration$/.test(node.type) &&
      node.source &&
      agentFolderOf(importedPath(file, node.source.value))
  )
  if (reExport)
    cannotRun(`${file}: re-exports from an agent's folder, which this script cannot take out yet`)
  const imports = program.body
    .filter((node) => node.type === 'ImportDeclaration')
    .map((node) => ({ node, folder: agentFolderOf(importedPath(file, node.source.value)) }))
    .filter((i) => i.folder)
  return { program, imports }
}

function foldersInListOrder() {
  const { program, imports } = agentImports(ROOT, MANIFEST_LIST)
  const folderOfName = new Map(
    imports.flatMap((i) => i.node.specifiers.map((s) => [s.local.name, i.folder]))
  )
  let elements
  walk(program, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.name === MANIFEST_ARRAY) {
      elements = withoutCasts(node.init)?.elements
    }
  })
  if (!elements) cannotRun(`${MANIFEST_LIST} has no array ${MANIFEST_ARRAY}`)
  return elements.map((el) => {
    const folder = el?.type === 'Identifier' ? folderOfName.get(el.name) : undefined
    if (!folder)
      cannotRun(`${MANIFEST_LIST}: an entry of ${MANIFEST_ARRAY} is not an imported agent`)
    return folder
  })
}

async function manifestsInListOrder() {
  return (await importAgentList(ROOT))[MANIFEST_ARRAY]
}

function lineEnd(text, at) {
  return text[at] === '\n' ? at + 1 : at
}

function withOverlapsMerged(cuts) {
  const merged = []
  for (const cut of [...cuts].sort((a, b) => a.start - b.start)) {
    const last = merged.at(-1)
    if (last && cut.start < last.end) {
      if (last.with || cut.with) cannotRun(`two changes overlap in a list file`)
      last.end = Math.max(last.end, cut.end)
    } else merged.push({ ...cut })
  }
  return merged
}

function takeOutEntriesOf(root, file, folder, agentFolders) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  const { program, imports } = agentImports(root, file)
  const mine = imports.filter((i) => i.folder === folder)
  if (mine.length === 0) return
  const names = new Set(mine.flatMap((i) => i.node.specifiers.map((s) => s.local.name)))
  const stayingNames = imports
    .filter((i) => i.folder !== folder && agentFolders.includes(i.folder))
    .filter((i) => i.node.importKind !== 'type')
    .flatMap((i) =>
      i.node.specifiers.filter((s) => s.importKind !== 'type').map((s) => s.local.name)
    )
  const cuts = mine.map(({ node }) => ({
    start: node.start,
    end: lineEnd(text, node.end),
    with: ''
  }))
  walk(program, (node) => {
    if (node.type === 'ArrayExpression')
      node.elements.forEach((el, i, all) => {
        if (el?.type !== 'Identifier' || !names.has(el.name)) return
        const next = all[i + 1]
        const before = all[i - 1]
        cuts.push(
          next
            ? { start: el.start, end: next.start, with: '' }
            : { start: before ? before.end : el.start, end: el.end, with: '' }
        )
      })
    if (node.type === 'VariableDeclarator' && names.has(node.init?.name)) {
      if (stayingNames.length === 0)
        cannotRun(`${file}: no other agent to point ${node.id.name} at`)
      cuts.push({ start: node.init.start, end: node.init.end, with: stayingNames[0] })
    }
  })
  let out = text
  for (const cut of withOverlapsMerged(cuts).reverse())
    out = out.slice(0, cut.start) + cut.with + out.slice(cut.end)
  fs.writeFileSync(path.join(root, file), out)
  let after
  try {
    after = parseSource(root, file)
  } catch (e) {
    cannotRun(`${file}: no longer parses once ${folder} is taken out (${e.message})`)
  }
  const left = referencesTo(after, names)
  if (left.length > 0)
    cannotRun(
      `${file}: cannot take out ${left.join(', ')} (used in a way this script does not know; teach takeOutEntriesOf)`
    )
}

function repoFiles() {
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8'
  })
    .split('\0')
    .filter((f) => f && fs.statSync(path.join(ROOT, f), { throwIfNoEntry: false })?.isFile())
}

function copyOfRepo(into, files) {
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(into, rel)), { recursive: true })
    fs.copyFileSync(path.join(ROOT, rel), path.join(into, rel))
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(into, 'node_modules'))
}

function deleteAgent(dir, folder, agentFolders) {
  fs.rmSync(path.join(dir, AGENTS_DIR, folder), { recursive: true, force: true })
  for (const list of LISTS_OF_AGENTS)
    if (fs.existsSync(path.join(dir, list))) takeOutEntriesOf(dir, list, folder, agentFolders)
}

function typecheck(dir, config) {
  return new Promise((resolve, reject) => {
    const tsc = spawn(
      path.join(dir, 'node_modules/.bin/tsc'),
      ['--noEmit', '--pretty', 'false', '-p', config],
      { cwd: dir }
    )
    let output = ''
    tsc.stdout.on('data', (d) => (output += d))
    tsc.stderr.on('data', (d) => (output += d))
    tsc.on('error', (e) => reject(new CannotRun(`cannot start tsc (${e.message})`)))
    tsc.on('close', (code) => {
      const errors = output
        .split('\n')
        .map((line) => /^(?:(.+?)\(\d+,\d+\): )?error TS\d+/.exec(line))
        .filter(Boolean)
        .map((m) => (m[1] ? path.relative(dir, path.resolve(dir, m[1])) : `(${config} itself)`))
      if (code !== 0 && errors.length === 0)
        return reject(new CannotRun(`tsc -p ${config} failed with no error line:\n${output}`))
      resolve({ errors: errors.length, files: [...new Set(errors)].sort(byCodeUnit), output })
    })
  })
}

async function inTurn(jobs, atOnce) {
  const results = new Array(jobs.length)
  const failures = []
  let next = 0
  const worker = async () => {
    while (next < jobs.length && failures.length === 0) {
      const i = next++
      results[i] = await jobs[i]().catch((e) => failures.push(e))
    }
  }
  await Promise.all(Array.from({ length: Math.min(atOnce, jobs.length) }, worker))
  if (failures.length > 0) throw failures[0]
  return results
}

function areaOf(file) {
  const parts = file.split('/')
  if (parts[0] !== 'src') return parts.length > 1 ? parts[0] : file
  if (parts[1] === 'plugins' || parts[1] === 'agents') return parts.slice(0, 3).join('/')
  return parts.slice(0, 2).join('/')
}

function ledgerOwners(manifests) {
  const owners = new Map()
  for (const [prefix, { file }] of Object.entries(LEDGERS)) {
    const name = path.basename(file).toLowerCase()
    const named = manifests.filter((m) =>
      m.wordsThatNameMe.anyCase.some((w) => name.includes(w.toLowerCase()))
    )
    if (named.length > 1)
      cannotRun(`${file} is named by more than one agent: ${named.map((m) => m.id).join(', ')}`)
    if (named.length === 1) owners.set(prefix, named[0].id)
  }
  return owners
}

function markersLeft(dir, prefixes) {
  if (prefixes.length === 0) return undefined
  const marker = new RegExp(String.raw`(?<![A-Za-z])(?:${prefixes.join('|')})§\d+`, 'g')
  let places = 0
  let files = 0
  for (const rel of sourceFilesUnder(dir, MARKED_FILE)) {
    const n = fs.readFileSync(path.join(dir, rel), 'utf8').match(marker)?.length ?? 0
    places += n
    if (n > 0) files += 1
  }
  return { prefixes, places, files }
}

function countBy(items) {
  const counts = new Map()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return [...counts].sort(([a], [b]) => byCodeUnit(a, b))
}

const said = (c) => `${c.files.length} files, ${c.errors} errors`

function report(runs) {
  const rows = [
    ['', 'files with an error', ...CHECKS.map((c) => c.label), 'ledger markers left in src'],
    ...runs.map((r) => [
      r.label,
      String(r.either.length),
      ...r.checks.map(said),
      r.markers === null
        ? '—'
        : r.markers
          ? `${r.markers.prefixes.join(', ')}: ${r.markers.places} in ${r.markers.files} files`
          : 'no ledger is named after it'
    ])
  ]
  const widths = rows[0].map((_, i) => Math.max(...rows.map((row) => row[i].length)))
  const out = [
    'check-agent-removal: each agent deleted in turn from a copy of the repo, both typechecks run (only reports: it fails only when the copy with nothing deleted does not typecheck)',
    ...rows.map(
      (row) =>
        '  ' +
        row
          .map((cell, i) => cell.padEnd(widths[i]))
          .join('  ')
          .trimEnd()
    ),
    '  files with an error, by where they are:'
  ]
  for (const r of runs.filter((r) => r.folder))
    out.push(
      `    ${r.label}: ${
        countBy(r.either.map(areaOf))
          .map(([area, n]) => `${area} ${n}`)
          .join(', ') || 'none'
      }`
    )
  if (SHOW_FILES)
    for (const r of runs.filter((r) => r.folder)) {
      out.push(`  files with an error when ${r.label} is deleted:`)
      for (const [area] of countBy(r.either.map(areaOf))) {
        out.push(`    ${area}`)
        for (const f of r.either.filter((f) => areaOf(f) === area)) out.push(`      ${f}`)
      }
    }
  return out.join('\n')
}

async function main() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules/.bin/tsc')))
    cannotRun('no node_modules/.bin/tsc here; run npm ci first')
  let folders, manifests
  try {
    folders = foldersInListOrder()
    manifests = await manifestsInListOrder()
  } catch (e) {
    cannotRun(`cannot load ${MANIFEST_LIST} (${e.message})`)
  }
  const owners = ledgerOwners(manifests)
  const files = repoFiles()
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-agent-removal-'))
  try {
    const plans = [
      { label: NOTHING_DELETED },
      ...folders.map((folder, i) => ({ label: manifests[i].id, folder, id: manifests[i].id }))
    ].map((plan, i) => ({ ...plan, dir: path.join(scratch, String(i)) }))
    for (const plan of plans) {
      copyOfRepo(plan.dir, files)
      if (plan.folder) deleteAgent(plan.dir, plan.folder, folders)
    }
    const jobs = plans.flatMap((plan) => CHECKS.map((c) => () => typecheck(plan.dir, c.config)))
    const results = await inTurn(jobs, TYPECHECKS_AT_ONCE)
    const runs = plans.map((plan, i) => {
      const checks = results.slice(i * CHECKS.length, (i + 1) * CHECKS.length)
      const owned = [...owners].filter(([, id]) => id === plan.id).map(([prefix]) => prefix)
      return {
        ...plan,
        checks,
        either: [...new Set(checks.flatMap((c) => c.files))].sort(byCodeUnit),
        markers: plan.folder ? markersLeft(plan.dir, owned) : null
      }
    })
    console.log(report(runs))
    const control = runs[0]
    if (control.either.length > 0) {
      console.error(
        `check-agent-removal: with ${NOTHING_DELETED} the copy should typecheck clean, but it does not:\n` +
          control.checks.map((c) => c.output).join('\n')
      )
      process.exitCode = 1
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true })
  }
}

try {
  await main()
} catch (e) {
  if (!(e instanceof CannotRun)) throw e
  console.error(`check-agent-removal: ${e.message}`)
  process.exitCode = CANNOT_RUN
}
