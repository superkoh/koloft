// ADR-0054
import fs from 'node:fs'
import path from 'node:path'
import * as prettier from 'prettier'
import {
  AGENTS_DIR,
  LISTS_OF_AGENTS,
  importedPath,
  importedSpecifierOf,
  parseSource,
  sourceFilesUnder,
  walk
} from './source-imports.mjs'

const ROOT = process.cwd()
const BASELINE = 'scripts/agent-imports-baseline.json'
const WORDS_BASELINE = 'scripts/agent-words-baseline.json'
const EMPTY_BASELINE = { imports: {}, optionalMethods: {}, messagingOf: {} }
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/
const ENDINGS_TRIED = ['', '.ts', '.tsx', '/index.ts', '/index.tsx']
const KIT = 'kit'
const LIST_NAMES = [...LISTS_OF_AGENTS].map((f) => path.basename(f)).join(', ')
const MANIFEST_TYPES = 'src/core/agent/manifest.ts'
const MESSAGING = { file: 'src/shared/sessionBackend.ts', name: 'messagingOf' }
const EVERY_NAME = '*'
const CANNOT_RUN = 2
const RULES = {
  'plugin-into-agent':
    'Nothing under src/plugins imports an agent’s folder. A plugin calls the interface in ' +
    'src/core/agent.',
  'common-into-agent':
    'Outside src/agents nothing imports an agent’s folder; only the lists in src/agents do ' +
    `(${LIST_NAMES}). Read agents through src/core/agent/registry.ts.`,
  'outside-into-kit':
    'src/agents/kit holds parts that agents share. Common code and plugins never import it.',
  'agent-into-plugin':
    'An agent’s folder (kit too) never imports a plugin. It uses what Koloft hands it.',
  'agent-into-list': `An agent’s folder (kit too) never imports a list of agents (${LIST_NAMES}).`,
  'agent-into-agent':
    'An agent’s folder never imports another agent’s folder, and kit imports no agent’s. ' +
    'What several agents share goes in src/agents/kit or src/core.',
  'agent-into-window': 'An agent’s folder (kit too) never imports src/renderer or src/preload.',
  'outside-main-into-main':
    'In an agent’s folder (and in kit) only main/ imports main-process code (src/main, or a ' +
    'main/ folder). Its agent.ts, shared/, renderer/ and anything else there never do: the ' +
    'window loads them too.',
  'manifest-loads-list':
    'A manifest (agent.ts) never loads, at run time, a file that loads the list of agents: ' +
    'the list imports the manifest, so the two would wait on each other. Use `import type`.',
  'agent-main-into-mixed-main':
    'An agent’s main/ (kit’s too) imports a src/main module only when that module names no ' +
    `agent (no line of its own in ${WORDS_BASELINE}) and no chain of src/main modules from ` +
    'it imports a plugin’s folder or another agent’s folder.'
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const flag = (name) => process.argv.includes(name)
const PRUNE = flag('--prune')
const ACCEPT_NEW = flag('--accept-new')
const STEP_FOR_NEW = ACCEPT_NEW ? process.argv[process.argv.indexOf('--accept-new') + 1] : undefined

const importKey = (c) => [c.rule, c.from, c.to].join('\n')
const methodKey = (m) => [m.file, m.name].join('\n')

function cannotRun(why) {
  console.error(`check-agent-imports: ${why}`)
  process.exit(CANNOT_RUN)
}

function zoneOf(file) {
  if (LISTS_OF_AGENTS.has(file)) return { kind: 'list' }
  if (file.startsWith(AGENTS_DIR)) {
    const [owner, part, ...deeper] = file.slice(AGENTS_DIR.length).split('/')
    return {
      kind: 'agent',
      owner,
      part: deeper.length === 0 && part === 'agent.ts' ? 'manifest' : part
    }
  }
  if (file.startsWith('src/plugins/'))
    return { kind: file.split('/').length > 3 ? 'plugin' : 'plugin-list' }
  if (file.startsWith('src/main/')) return { kind: 'main' }
  if (file.startsWith('src/renderer/') || file.startsWith('src/preload/')) return { kind: 'window' }
  if (file.startsWith('src/core/') || file.startsWith('src/shared/')) return { kind: 'open' }
  return undefined
}

const isPluginCode = (zone) => zone.kind === 'plugin' || zone.kind === 'plugin-list'
const isForeignAgent = (zone, owner) =>
  zone.kind === 'agent' && zone.owner !== KIT && zone.owner !== owner

function nameOf(node) {
  return node.type === 'Identifier' ? node.name : node.value
}

function withoutCasts(node) {
  let inner = node
  while (inner && /^TS(As|Satisfies|NonNull)Expression$/.test(inner.type)) inner = inner.expression
  return inner
}

function readModule(file, resolve) {
  const program = parseSource(ROOT, file)
  const edges = []
  const bound = new Map()
  const sameAs = new Map()
  const passedOn = new Map()
  const everythingFrom = []
  const exportedLocals = []
  const ownNames = new Set(['default'])
  const edge = (node, spec, names, typeOnly) => {
    const to = resolve(file, spec)
    if (to && to !== file) edges.push({ to, line: node.loc.start.line, names, typeOnly })
    return to
  }
  const everyOneIsAType = (specifiers, kind) =>
    specifiers.length > 0 && specifiers.every((s) => s[kind] === 'type')
  for (const statement of program.body) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement
    for (const d of declaration?.declarations ?? []) {
      const init = withoutCasts(d.init)
      if (d.id.type === 'Identifier' && init?.type === 'Identifier')
        sameAs.set(d.id.name, init.name)
    }
  }
  walk(program, (node) => {
    if (node.type === 'ExportDefaultDeclaration') {
      const exported = withoutCasts(node.declaration)
      if (exported.type === 'Identifier')
        exportedLocals.push({ local: exported.name, exported: 'default' })
    }
    const spec = importedSpecifierOf(node)
    if (node.type === 'ExportNamedDeclaration' && spec === undefined) {
      for (const s of node.specifiers)
        exportedLocals.push({ local: nameOf(s.local), exported: nameOf(s.exported) })
      const declared = node.declaration?.declarations?.map((d) => d.id) ?? [node.declaration?.id]
      for (const id of declared)
        if (id?.type === 'Identifier') exportedLocals.push({ local: id.name, exported: id.name })
      return
    }
    if (spec === undefined) return
    if (node.type === 'ImportDeclaration') {
      const names = node.specifiers.map((s) =>
        s.type === 'ImportSpecifier'
          ? nameOf(s.imported)
          : s.type === 'ImportDefaultSpecifier'
            ? 'default'
            : EVERY_NAME
      )
      const typeOnly = node.importKind === 'type' || everyOneIsAType(node.specifiers, 'importKind')
      const to = edge(node, spec, names, typeOnly)
      if (to) node.specifiers.forEach((s, i) => bound.set(s.local.name, { to, name: names[i] }))
    } else if (node.type === 'ExportNamedDeclaration') {
      const names = node.specifiers.map((s) =>
        s.type === 'ExportSpecifier' ? nameOf(s.local) : EVERY_NAME
      )
      const typeOnly = node.exportKind === 'type' || everyOneIsAType(node.specifiers, 'exportKind')
      const to = edge(node, spec, names, typeOnly)
      if (to)
        node.specifiers.forEach((s, i) => passedOn.set(nameOf(s.exported), { to, name: names[i] }))
    } else if (node.type === 'ExportAllDeclaration') {
      const to = edge(node, spec, [EVERY_NAME], node.exportKind === 'type')
      if (to) everythingFrom.push(to)
    } else if (node.type === 'TSImportType') {
      edge(
        node,
        spec,
        [node.qualifier?.type === 'Identifier' ? node.qualifier.name : EVERY_NAME],
        true
      )
    } else {
      edge(node, spec, [EVERY_NAME], false)
    }
  })
  const importBehind = (local, seen = new Set()) => {
    if (bound.has(local)) return bound.get(local)
    if (seen.has(local) || !sameAs.has(local)) return undefined
    return importBehind(sameAs.get(local), seen.add(local))
  }
  for (const { local, exported } of exportedLocals) {
    const from = importBehind(local)
    if (from) passedOn.set(exported, from)
    else ownNames.add(exported)
  }
  const namesBoundToImports = new Map(
    [...bound.keys(), ...sameAs.keys()]
      .map((local) => [local, importBehind(local)])
      .filter(([, from]) => from)
  )
  return { program, edges, namesBoundToImports, passedOn, everythingFrom, ownNames }
}

function loadModules(files) {
  const known = new Set(files)
  const resolve = (from, spec) => {
    const joined = importedPath(from, spec)
    if (!joined) return undefined
    for (const ending of ENDINGS_TRIED) if (known.has(joined + ending)) return joined + ending
    return joined
  }
  const modules = new Map()
  for (const file of files) {
    try {
      modules.set(file, readModule(file, resolve))
    } catch (e) {
      cannotRun(`cannot parse ${file} (${e.message}); fix the file, then run again.`)
    }
  }
  return modules
}

function declaredIn(modules, file, name, seen = new Set()) {
  const key = `${file}\n${name}`
  if (seen.has(key)) return []
  seen.add(key)
  const mod = modules.get(file)
  if (!mod || LISTS_OF_AGENTS.has(file)) return [{ file, name }]
  const throughStars = () => mod.everythingFrom.flatMap((f) => declaredIn(modules, f, name, seen))
  if (name === EVERY_NAME)
    return [
      { file, name },
      ...[...mod.passedOn.values()].flatMap((p) => declaredIn(modules, p.to, p.name, seen)),
      ...throughStars()
    ]
  const passed = mod.passedOn.get(name)
  if (passed) return declaredIn(modules, passed.to, passed.name, seen)
  return mod.ownNames.has(name) ? [{ file, name }] : [{ file, name }, ...throughStars()]
}

function chainTo(modules, start, isGoal, follows) {
  const cameFrom = new Map([[start, undefined]])
  const queue = [start]
  while (queue.length > 0) {
    const file = queue.shift()
    for (const e of modules.get(file)?.edges ?? []) {
      if (cameFrom.has(e.to) || !follows(e)) continue
      cameFrom.set(e.to, file)
      if (isGoal(e.to)) {
        const chain = []
        for (let at = e.to; at !== undefined; at = cameFrom.get(at)) chain.unshift(at)
        return chain
      }
      queue.push(e.to)
    }
  }
  return undefined
}

function wordsBaseline() {
  const file = path.join(ROOT, WORDS_BASELINE)
  const empty = { lines: {}, awaitingMove: {} }
  if (!fs.existsSync(file)) return empty
  try {
    return { ...empty, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (e) {
    return cannotRun(`cannot read ${WORDS_BASELINE} (${e.message}); fix the file, then run again.`)
  }
}

function boundaryChecker(modules) {
  const words = wordsBaseline()
  const reasonMixed = (file, owner) => {
    if (Object.hasOwn(words.awaitingMove, file)) return 'it is an agent’s own file, not moved yet'
    const named = words.lines[file]?.length ?? 0
    if (named > 0) return `it names an agent on ${named} lines`
    const isAPluginOrAnotherAgent = (to) => {
      const zone = zoneOf(to)
      return !!zone && (zone.kind === 'plugin' || isForeignAgent(zone, owner))
    }
    const chain = chainTo(
      modules,
      file,
      isAPluginOrAnotherAgent,
      (e) => zoneOf(e.to)?.kind === 'main' || isAPluginOrAnotherAgent(e.to)
    )
    return chain && `it leads to ${chain.join(' → ')}`
  }
  const mixed = new Map()
  const whyMixed = (file, owner) => {
    const key = `${file}\n${owner}`
    if (!mixed.has(key)) mixed.set(key, reasonMixed(file, owner))
    return mixed.get(key)
  }
  return (fromFile, toFile) => {
    const from = zoneOf(fromFile)
    const to = zoneOf(toFile)
    if (!from || !to || from.kind === 'list') return undefined
    if (from.kind !== 'agent') {
      if (to.kind !== 'agent') return undefined
      if (to.owner === KIT) return { rule: 'outside-into-kit' }
      return { rule: isPluginCode(from) ? 'plugin-into-agent' : 'common-into-agent' }
    }
    if (isPluginCode(to)) return { rule: 'agent-into-plugin' }
    if (to.kind === 'list') return { rule: 'agent-into-list' }
    if (isForeignAgent(to, from.owner)) return { rule: 'agent-into-agent' }
    if (to.kind === 'window') return { rule: 'agent-into-window' }
    const intoMain = to.kind === 'main' || (to.kind === 'agent' && to.part === 'main')
    if (intoMain && from.part !== 'main') return { rule: 'outside-main-into-main' }
    if (to.kind !== 'main') return undefined
    const why = whyMixed(toFile, from.owner)
    return why && { rule: 'agent-main-into-mixed-main', why }
  }
}

function crossings(modules) {
  const breach = boundaryChecker(modules)
  const found = new Map()
  const add = (rule, from, to, line, note) => {
    const crossing = { rule, from, to, line, note }
    if (!found.has(importKey(crossing))) found.set(importKey(crossing), crossing)
  }
  for (const [file, mod] of modules) {
    for (const e of mod.edges) {
      const direct = breach(file, e.to)
      if (direct) add(direct.rule, file, e.to, e.line, direct.why)
      const declaredAt = new Set(
        e.names.flatMap((n) => declaredIn(modules, e.to, n)).map((d) => d.file)
      )
      for (const origin of declaredAt) {
        const passed = origin !== e.to && origin !== file && breach(file, origin)
        if (passed)
          add(
            passed.rule,
            file,
            origin,
            e.line,
            [`passed on by ${e.to}`, passed.why].filter(Boolean).join('; ')
          )
      }
    }
    if (zoneOf(file)?.part !== 'manifest') continue
    for (const e of mod.edges) {
      if (e.typeOnly || LISTS_OF_AGENTS.has(e.to)) continue
      const chain = chainTo(
        modules,
        e.to,
        (to) => LISTS_OF_AGENTS.has(to),
        (next) => !next.typeOnly
      )
      if (chain) add('manifest-loads-list', file, e.to, e.line, `it loads ${chain.join(' → ')}`)
    }
  }
  return found
}

const holdsRuntimeInterfaces = (file) =>
  (file.startsWith('src/core/agent/') && file !== MANIFEST_TYPES) ||
  file.startsWith(`${AGENTS_DIR}${KIT}/main/`)

function objectTypesIn(type) {
  if (type.type === 'TSTypeLiteral') return [type]
  if (type.type === 'TSParenthesizedType') return objectTypesIn(type.typeAnnotation)
  return /^TS(Union|Intersection)Type$/.test(type.type) ? type.types.flatMap(objectTypesIn) : []
}

function isAFunctionType(type) {
  if (type.type === 'TSParenthesizedType') return isAFunctionType(type.typeAnnotation)
  if (type.type === 'TSUnionType') return type.types.some(isAFunctionType)
  return type.type === 'TSFunctionType'
}

function optionalMethods(modules) {
  const found = new Map()
  for (const [file, mod] of modules) {
    if (!holdsRuntimeInterfaces(file)) continue
    walk(mod.program, (node) => {
      const members =
        node.type === 'TSInterfaceDeclaration'
          ? node.body.body
          : node.type === 'TSTypeAliasDeclaration'
            ? objectTypesIn(node.typeAnnotation).flatMap((o) => o.members)
            : []
      for (const m of members) {
        const isMethod =
          m.type === 'TSMethodSignature' ||
          (m.type === 'TSPropertySignature' &&
            !!m.typeAnnotation &&
            isAFunctionType(m.typeAnnotation.typeAnnotation))
        if (!m.optional || !isMethod || m.computed) continue
        const method = { file, name: `${node.id.name}.${nameOf(m.key)}`, line: m.loc.start.line }
        found.set(methodKey(method), method)
      }
    })
  }
  return found
}

const isMessaging = (modules, file, name) =>
  declaredIn(modules, file, name).some(
    (d) => d.file === MESSAGING.file && d.name === MESSAGING.name
  )

function messagingReferences(modules) {
  const found = new Map()
  for (const [file, mod] of modules) {
    const zone = zoneOf(file)
    if ((zone?.kind === 'agent' && zone.owner !== KIT) || file === MESSAGING.file) continue
    const names = new Set()
    const namespaces = new Map()
    for (const [local, from] of mod.namesBoundToImports) {
      if (from.name === EVERY_NAME) namespaces.set(local, from.to)
      else if (isMessaging(modules, from.to, from.name)) names.add(local)
    }
    if (names.size === 0 && namespaces.size === 0 && mod.passedOn.size === 0) continue
    const notAUse = new Set()
    const lines = []
    walk(mod.program, (node) => {
      if (node.type === 'VariableDeclarator') notAUse.add(node.id)
      if (node.type === 'ImportDeclaration')
        for (const s of node.specifiers) notAUse.add(s.local).add(s.imported)
      if (node.type === 'ExportSpecifier') notAUse.add(node.exported)
      if (node.type === 'ExportNamedDeclaration' && node.source)
        for (const s of node.specifiers) {
          notAUse.add(s.local)
          const to = mod.passedOn.get(nameOf(s.exported))
          if (to && isMessaging(modules, to.to, to.name)) lines.push(s.loc.start.line)
        }
      if (/^(Optional)?MemberExpression$/.test(node.type) && !node.computed) {
        notAUse.add(node.property)
        const from = node.object.type === 'Identifier' && namespaces.get(node.object.name)
        if (from && isMessaging(modules, from, nameOf(node.property)))
          lines.push(node.loc.start.line)
      }
      if (node.key && !node.computed) notAUse.add(node.key)
      if (node.type === 'Identifier' && names.has(node.name) && !notAUse.has(node))
        lines.push(node.loc.start.line)
    })
    if (lines.length > 0) found.set(file, lines)
  }
  return found
}

function readBaseline() {
  const file = path.join(ROOT, BASELINE)
  if (!fs.existsSync(file)) return EMPTY_BASELINE
  try {
    return { ...EMPTY_BASELINE, ...JSON.parse(fs.readFileSync(file, 'utf8')) }
  } catch (e) {
    return cannotRun(`cannot read ${BASELINE} (${e.message}); fix the file, then run again.`)
  }
}

function sortedDeep(value) {
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .map(([k, v]) => [k, sortedDeep(v)])
      .sort(([a], [b]) => byCodeUnit(a, b))
  )
}

async function writeBaseline(baseline) {
  const file = path.join(ROOT, BASELINE)
  const options = (await prettier.resolveConfig(file)) ?? {}
  const whole = { ...EMPTY_BASELINE, ...sortedDeep(baseline) }
  fs.writeFileSync(
    file,
    await prettier.format(JSON.stringify(whole), { ...options, filepath: file })
  )
}

function baselineImports(baseline) {
  return Object.entries(baseline.imports).flatMap(([rule, byFrom]) =>
    Object.entries(byFrom).flatMap(([from, byTo]) =>
      Object.entries(byTo).map(([to, step]) => ({ rule, from, to, step }))
    )
  )
}

function baselineMethods(baseline) {
  return Object.entries(baseline.optionalMethods).flatMap(([file, byName]) =>
    Object.entries(byName).map(([name, step]) => ({ file, name, step }))
  )
}

const importEntry = (b) => `imports  ${b.rule}  ${b.from} → ${b.to}`
const methodEntry = (b) => `optionalMethods  ${b.file}  ${b.name}`
const hasNoStep = (b) => typeof b.step !== 'string' || b.step.trim() === ''

function compare(baseline, now) {
  const recordedImports = baselineImports(baseline)
  const recordedMethods = baselineMethods(baseline)
  const importKeys = new Set(recordedImports.map(importKey))
  const methodKeys = new Set(recordedMethods.map(methodKey))
  const moreReferences = [...now.references]
    .map(([file, lines]) => ({ file, lines, allowed: baseline.messagingOf[file] ?? 0 }))
    .filter((r) => r.lines.length > r.allowed)
  const fewerReferences = Object.entries(baseline.messagingOf)
    .map(([file, allowed]) => ({ file, allowed, left: now.references.get(file)?.length ?? 0 }))
    .filter((r) => r.left < r.allowed)
  return {
    newImports: [...now.imports].filter(([key]) => !importKeys.has(key)).map(([, c]) => c),
    newMethods: [...now.methods].filter(([key]) => !methodKeys.has(key)).map(([, m]) => m),
    moreReferences,
    gone: [
      ...recordedImports.filter((b) => !now.imports.has(importKey(b))).map(importEntry),
      ...recordedMethods.filter((b) => !now.methods.has(methodKey(b))).map(methodEntry),
      ...fewerReferences.map(
        (r) => `messagingOf  ${r.file}  (${r.left} left, the baseline says ${r.allowed})`
      )
    ],
    stepless: [
      ...recordedImports.filter(hasNoStep).map(importEntry),
      ...recordedMethods.filter(hasNoStep).map(methodEntry)
    ]
  }
}

function rewritten(baseline, now, takeNewWithStep) {
  const imports = {}
  const stepOfImport = new Map(baselineImports(baseline).map((b) => [importKey(b), b.step]))
  for (const [key, c] of now.imports) {
    const step = stepOfImport.get(key) ?? takeNewWithStep
    if (step !== undefined) ((imports[c.rule] ??= {})[c.from] ??= {})[c.to] = step
  }
  const optionalMethods = {}
  const stepOfMethod = new Map(baselineMethods(baseline).map((b) => [methodKey(b), b.step]))
  for (const [key, m] of now.methods) {
    const step = stepOfMethod.get(key) ?? takeNewWithStep
    if (step !== undefined) (optionalMethods[m.file] ??= {})[m.name] = step
  }
  const messagingOf = {}
  for (const [file, lines] of now.references) {
    const allowed = baseline.messagingOf[file] ?? 0
    const count = takeNewWithStep !== undefined ? lines.length : Math.min(allowed, lines.length)
    if (count > 0) messagingOf[file] = count
  }
  return { imports, optionalMethods, messagingOf }
}

function tally(values) {
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  return [...counts]
    .sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([k, n]) => `${k} ${n}`)
    .join(', ')
}

function summary(baseline) {
  const imports = baselineImports(baseline)
  const methods = baselineMethods(baseline)
  const references = Object.values(baseline.messagingOf).reduce((n, c) => n + c, 0)
  return [
    `check-agent-imports: nothing new. What the baseline still holds (${BASELINE}):`,
    `  imports that cross a boundary: ${imports.length}`,
    ...(imports.length > 0
      ? [
          `    by rule: ${tally(imports.map((b) => b.rule))}`,
          `    by the step that removes them: ${tally(imports.map((b) => b.step))}`
        ]
      : []),
    `  optional methods on the run-time interfaces: ${methods.length}` +
      (methods.length > 0 ? ` (${tally(methods.map((b) => b.step))})` : ''),
    `  references to ${MESSAGING.name}: ${references} in ${Object.keys(baseline.messagingOf).length} files`
  ].join('\n')
}

const IF_IT_MUST_STAY = [
  '- If it truly must stay for now, say why in the PR body, then run',
  '  `npm run check:agent-imports -- --accept-new <step>` and commit the baseline. <step> is',
  '  the step of issue #2410 that removes it, such as C4. It also drops what --prune drops.'
]
const IMPORT_HELP = [
  'How to fix:',
  '- Do not add the import. Code about one agent goes in src/agents/<id>/; what every agent',
  '  fills or uses goes in src/core; parts only agents share go in src/agents/kit.',
  '- An import counts where the name is really declared, so passing it on through another',
  '  file, another name, `import type` or `import()` changes nothing.',
  ...IF_IT_MUST_STAY
]
const METHOD_HELP = [
  'A method of the run-time interfaces (src/core/agent but not manifest.ts, and',
  'src/agents/kit/main) is never optional: a caller must not pick one agent’s way by whether a',
  'method is there (issue #2410, Section 3).',
  'How to fix:',
  '- Make it required and let every agent answer it; an agent that cannot do it answers with a',
  '  reason code. Delete a method nobody fills. A field that is not a function may be optional.',
  ...IF_IT_MUST_STAY
]
const MESSAGING_HELP = [
  `Common code and plugins add no new use of ${MESSAGING.name} (${MESSAGING.file}): picking what`,
  'to do by how an agent takes a message belongs in that agent’s folder (issue #2410, Section 3).',
  'How to fix:',
  '- Do the work in the agent’s own code, or ask a yes-or-no question that would hold for any',
  '  agent. Step C2 of issue #2410 removes the uses that are left.',
  ...IF_IT_MUST_STAY
]
const GONE_HELP = [
  'These baseline entries are gone. Run `npm run check:agent-imports -- --prune` and commit',
  `${BASELINE}, so they cannot come back.`
]
const STEPLESS_HELP = [
  `Give each of these a step in ${BASELINE}: the step of issue #2410 that removes it, such as "C4".`
]

if (ACCEPT_NEW && (!STEP_FOR_NEW || STEP_FOR_NEW.startsWith('--')))
  cannotRun(
    '--accept-new needs the step of issue #2410 that removes the new entries, such as `--accept-new C4`.'
  )

const modules = loadModules(sourceFilesUnder(ROOT, SOURCE_FILE))
const now = {
  imports: crossings(modules),
  methods: optionalMethods(modules),
  references: messagingReferences(modules)
}
let baseline = readBaseline()
if (PRUNE || ACCEPT_NEW) {
  await writeBaseline(rewritten(baseline, now, STEP_FOR_NEW))
  baseline = readBaseline()
}
const result = compare(baseline, now)

const out = []
if (result.gone.length > 0)
  out.push(
    `check-agent-imports: ${result.gone.length} baseline entries no longer match the code.`,
    ...result.gone.map((g) => `  ${g}`),
    ...GONE_HELP
  )
if (result.stepless.length > 0)
  out.push(
    `check-agent-imports: ${result.stepless.length} baseline entries do not say which step removes them.`,
    ...result.stepless.map((s) => `  ${s}`),
    ...STEPLESS_HELP
  )
if (result.newImports.length > 0) {
  const rules = [...new Set(result.newImports.map((c) => c.rule))].sort()
  out.push(
    `check-agent-imports: ${result.newImports.length} new imports cross a boundary around src/agents (ADR-0054, issue #2410).`,
    ...result.newImports.map(
      (c) => `  ${c.from}:${c.line}  [${c.rule}]  → ${c.to}${c.note ? `  (${c.note})` : ''}`
    ),
    ...rules.map((r) => `[${r}] ${RULES[r]}`),
    ...IMPORT_HELP
  )
}
if (result.newMethods.length > 0)
  out.push(
    `check-agent-imports: ${result.newMethods.length} new optional methods on the run-time interfaces.`,
    ...result.newMethods.map((m) => `  ${m.file}:${m.line}  ${m.name}`),
    ...METHOD_HELP
  )
if (result.moreReferences.length > 0)
  out.push(
    `check-agent-imports: new references to ${MESSAGING.name}.`,
    ...result.moreReferences.map(
      (r) =>
        `  ${r.file}  ${r.lines.length} now, the baseline allows ${r.allowed} (lines ${r.lines.join(', ')})`
    ),
    ...MESSAGING_HELP
  )
if (out.length > 0) {
  console.error(out.join('\n'))
  process.exit(1)
}
console.log(summary(baseline))
