// ADR-0054
import fs from 'node:fs'
import path from 'node:path'
import { AGENTS_DIR, EVERY_NAME, nameOf, walk, withoutCasts } from './source-imports.mjs'

export const MANIFEST_TYPES = 'src/core/agent/manifest.ts'
const REGISTRY = 'src/core/agent/registry.ts'
const LIST_OF_MANIFESTS = `${AGENTS_DIR}list.ts`
const ONE_MANIFEST = 'agentManifest'
const EVERY_MANIFEST = 'AGENT_MANIFESTS'
const LISTED_MANIFESTS = 'AGENTS'
const MANIFEST_TYPE = 'AgentManifest'
const FLAGS = 'flags'
const HOSTS = ['local', 'ssh']
const HOST_LABEL = { local: 'on this Mac', ssh: 'remote' }
const CALLED_WITH_EACH_ELEMENT = new Set([
  'map',
  'filter',
  'find',
  'findLast',
  'some',
  'every',
  'flatMap',
  'forEach'
])
const COMPARISONS = new Set(['===', '!==', '==', '!='])
const ROUNDS_UNTIL_NAMES_SETTLE = 3

const keyOf = (file, name) => `${file}\n${name}`
const isFunction = (node) => /^(Arrow)?FunctionExpression$/.test(node?.type ?? '')
const isMember = (node) => /^(Optional)?MemberExpression$/.test(node?.type ?? '')
const isFixedText = (node) =>
  node?.type === 'StringLiteral' ||
  (node?.type === 'TemplateLiteral' && node.expressions.length === 0)

function objectTypesOf(program) {
  const types = new Map()
  walk(program, (node) => {
    if (node.type === 'TSInterfaceDeclaration') types.set(node.id.name, node.body.body)
    if (node.type === 'TSTypeAliasDeclaration' && node.typeAnnotation.type === 'TSTypeLiteral')
      types.set(node.id.name, node.typeAnnotation.members)
  })
  return types
}

function flagTypesThatAreNotYesOrNo(modules) {
  const mod = modules.get(MANIFEST_TYPES)
  if (!mod) return []
  const types = objectTypesOf(mod.program)
  const typeOf = (member) =>
    member.type === 'TSPropertySignature' ? member.typeAnnotation?.typeAnnotation : undefined
  const membersOf = (type) =>
    type?.type === 'TSTypeLiteral'
      ? type.members
      : type?.type === 'TSTypeReference' && type.typeName.type === 'Identifier'
        ? types.get(type.typeName.name)
        : undefined
  const isYesOrNo = (member) => !member.optional && typeOf(member)?.type === 'TSBooleanKeyword'
  const flags = types.get(MANIFEST_TYPE)?.find((m) => m.key && nameOf(m.key) === FLAGS)
  const members = (flags && membersOf(typeOf(flags))) ?? []
  return members
    .filter((m) => {
      const answers = membersOf(typeOf(m)) ?? []
      return !isYesOrNo(m) && !(!m.optional && answers.length > 0 && answers.every(isYesOrNo))
    })
    .map((m) => ({
      file: MANIFEST_TYPES,
      line: m.loc.start.line,
      name: m.key ? nameOf(m.key) : '(not a plain field)',
      why: 'its type is not `boolean`, nor one `boolean` for each kind of machine'
    }))
}

function declaredObject(mod, name) {
  let found
  walk(mod.program, (node) => {
    const init = node.type === 'VariableDeclarator' && withoutCasts(node.init)
    if (init && node.id.type === 'Identifier' && node.id.name === name)
      found = init.type === 'ObjectExpression' ? init : undefined
  })
  return found
}

const fieldOf = (object, name) =>
  object?.properties.find(
    (p) => p.type === 'ObjectProperty' && !p.computed && nameOf(p.key) === name
  )

function manifestsInListOrder(modules) {
  const list = modules.get(LIST_OF_MANIFESTS)
  if (!list) return []
  let agents = []
  walk(list.program, (node) => {
    const init = node.type === 'VariableDeclarator' && withoutCasts(node.init)
    if (init?.type === 'ArrayExpression' && node.id.name === LISTED_MANIFESTS)
      agents = init.elements.flatMap((e) => {
        const from = e?.type === 'Identifier' && list.namesBoundToImports.get(e.name)
        const object =
          from && modules.has(from.to) && declaredObject(modules.get(from.to), from.name)
        const id = withoutCasts(fieldOf(object, 'id')?.value)
        return object && id?.type === 'StringLiteral'
          ? [{ id: id.value, file: from.to, object }]
          : []
      })
  })
  return agents
}

function answerOf(value) {
  const node = withoutCasts(value)
  if (node?.type === 'BooleanLiteral') return Object.fromEntries(HOSTS.map((h) => [h, node.value]))
  if (node?.type !== 'ObjectExpression') return undefined
  const perHost = HOSTS.map((h) => withoutCasts(fieldOf(node, h)?.value))
  const complete =
    node.properties.length === HOSTS.length && perHost.every((v) => v?.type === 'BooleanLiteral')
  return complete ? Object.fromEntries(HOSTS.map((h, i) => [h, perHost[i].value])) : undefined
}

function flagAnswers(modules) {
  const problems = []
  const agents = manifestsInListOrder(modules).map(({ id, file, object }) => {
    const flags = withoutCasts(fieldOf(object, FLAGS)?.value)
    const answers = new Map()
    for (const p of flags?.type === 'ObjectExpression' ? flags.properties : []) {
      const name = p.type === 'ObjectProperty' && !p.computed ? nameOf(p.key) : undefined
      const answer = name && answerOf(p.value)
      if (answer) answers.set(name, answer)
      else
        problems.push({
          file,
          line: p.loc.start.line,
          name: name ?? '(not a plain field)',
          why: `it is not written as \`true\` or \`false\`, nor as { ${HOSTS.map((h) => `${h}: true or false`).join(', ')} }`
        })
    }
    return { id, answers }
  })
  return { agents, problems }
}

export function flagsThatAreNotYesOrNo(modules) {
  return [...flagTypesThatAreNotYesOrNo(modules), ...flagAnswers(modules).problems]
}

export function flagsByKindOfTab(modules) {
  const { agents } = flagAnswers(modules)
  const names = [...new Set(agents.flatMap((a) => [...a.answers.keys()]))]
  if (names.length === 0) return []
  const columns = agents.flatMap((a) => HOSTS.map((host) => ({ a, host })))
  const heads = columns.map((c) => `${c.a.id} ${HOST_LABEL[c.host]}`)
  const said = (c, name) => {
    const answer = c.a.answers.get(name)
    return answer === undefined ? '-' : answer[c.host] ? 'yes' : 'no'
  }
  const yesForOneAgentOnly = (name) =>
    agents.filter((a) => HOSTS.some((host) => a.answers.get(name)?.[host])).length === 1
  const wide = Math.max(...names.map((n) => n.length))
  const row = (first, cells) =>
    `    ${first.padEnd(wide)}  ${cells.map((cell, i) => cell.padEnd(heads[i].length)).join('  ')}`
  return [
    '  flags in the manifests, by kind of tab (a report, never a failure):',
    row('', heads),
    ...names.map(
      (name) =>
        row(
          name,
          columns.map((c) => said(c, name))
        ).trimEnd() + (yesForOneAgentOnly(name) ? '  <- yes for one agent only' : '')
    ),
    '    A PR that adds a flag with "yes" for one agent only says in one sentence why any other',
    '    agent that truthfully answered "yes" would be handled rightly too.'
  ]
}

const isEveryManifestAt = (d) =>
  (d.file === REGISTRY && d.name === EVERY_MANIFEST) ||
  (d.file === LIST_OF_MANIFESTS && d.name === LISTED_MANIFESTS)

function readersOf(modules, file, mod, declaredIn, tables) {
  const one = new Set()
  const every = new Set()
  const table = new Set()
  for (const [local, from] of mod.namesBoundToImports) {
    if (from.name === EVERY_NAME) continue
    const origins = declaredIn(modules, from.to, from.name)
    if (origins.some((d) => d.file === REGISTRY && d.name === ONE_MANIFEST)) one.add(local)
    if (origins.some(isEveryManifestAt)) every.add(local)
    if (origins.some((d) => tables.has(keyOf(d.file, d.name)))) table.add(local)
  }
  if (file === REGISTRY) {
    one.add(ONE_MANIFEST)
    every.add(EVERY_MANIFEST)
  }
  for (const key of tables) {
    const [declaredAt, name] = key.split('\n')
    if (declaredAt === file) table.add(name)
  }
  return { one, every, table }
}

function factsIn(mod, { one, every, table }) {
  const manifests = new Set()
  const facts = new Set()
  const named = (node, names) => node?.type === 'Identifier' && names.has(node.name)
  const isEveryManifest = (node) =>
    named(node, every) ||
    (node?.type === 'CallExpression' &&
      isMember(node.callee) &&
      !node.callee.computed &&
      nameOf(node.callee.property) === 'filter' &&
      isEveryManifest(node.callee.object))
  const isManifest = (raw) => {
    const node = withoutCasts(raw)
    if (node?.type === 'Identifier') return manifests.has(node.name)
    if (node?.type === 'CallExpression') return named(node.callee, one)
    return isMember(node) && node.computed && isEveryManifest(node.object)
  }
  const isFact = (raw) => {
    const node = withoutCasts(raw)
    if (node?.type === 'Identifier') return facts.has(node.name)
    if (!isMember(node)) return false
    if (named(node.object, table)) return true
    if (isManifest(node.object)) return node.computed || nameOf(node.property) !== FLAGS
    return isFact(node.object)
  }
  const bind = (pattern, isAManifest) => {
    const target = pattern?.type === 'AssignmentPattern' ? pattern.left : pattern
    if (target?.type === 'Identifier') (isAManifest ? manifests : facts).add(target.name)
    if (target?.type !== 'ObjectPattern' || !isAManifest) return
    for (const p of target.properties)
      if (p.type === 'ObjectProperty' && !p.computed && nameOf(p.key) !== FLAGS)
        bind(p.value, false)
  }
  for (let round = 0; round < ROUNDS_UNTIL_NAMES_SETTLE; round++)
    walk(mod.program, (node) => {
      if (node.type === 'VariableDeclarator') {
        if (isManifest(node.init)) bind(node.id, true)
        else if (isFact(node.init)) bind(node.id, false)
      }
      if (node.type === 'ForOfStatement' && isEveryManifest(node.right))
        bind(
          node.left.type === 'VariableDeclaration' ? node.left.declarations[0].id : node.left,
          true
        )
      if (
        node.type === 'CallExpression' &&
        isMember(node.callee) &&
        !node.callee.computed &&
        CALLED_WITH_EACH_ELEMENT.has(nameOf(node.callee.property)) &&
        isEveryManifest(node.callee.object) &&
        isFunction(node.arguments[0])
      )
        bind(node.arguments[0].params[0], true)
    })
  return isFact
}

function returnsAFact(fn, isFact) {
  if (fn.body.type !== 'BlockStatement') return isFact(fn.body)
  let does = false
  walk(fn.body, (node) => {
    if (node.type === 'ReturnStatement' && isFact(node.argument)) does = true
  })
  return does
}

function tablesBuiltFromFacts(modules, declaredIn) {
  const tables = new Set()
  const none = new Set()
  for (const [file, mod] of modules) {
    const readers = readersOf(modules, file, mod, declaredIn, none)
    if (readers.one.size + readers.every.size === 0) continue
    const isFact = factsIn(mod, readers)
    walk(mod.program, (node) => {
      const init = node.type === 'VariableDeclarator' && withoutCasts(node.init)
      if (
        init?.type === 'CallExpression' &&
        node.id.type === 'Identifier' &&
        init.arguments.some((a) => isFunction(a) && returnsAFact(a, isFact))
      )
        tables.add(keyOf(file, node.id.name))
    })
  }
  return tables
}

export function factsComparedWithFixedText(root, modules, declaredIn, isCommonCodeOrPlugin) {
  const tables = tablesBuiltFromFacts(modules, declaredIn)
  const found = []
  for (const [file, mod] of modules) {
    if (!isCommonCodeOrPlugin(file)) continue
    const readers = readersOf(modules, file, mod, declaredIn, tables)
    if (readers.one.size + readers.every.size + readers.table.size === 0) continue
    const isFact = factsIn(mod, readers)
    const hits = []
    walk(mod.program, (node) => {
      const compares =
        (node.type === 'BinaryExpression' &&
          COMPARISONS.has(node.operator) &&
          ((isFact(node.left) && isFixedText(node.right)) ||
            (isFixedText(node.left) && isFact(node.right)))) ||
        (node.type === 'SwitchStatement' &&
          isFact(node.discriminant) &&
          node.cases.some((c) => isFixedText(c.test))) ||
        (node.type === 'CallExpression' &&
          isMember(node.callee) &&
          !node.callee.computed &&
          nameOf(node.callee.property) === 'includes' &&
          node.callee.object.type === 'ArrayExpression' &&
          node.callee.object.elements.some(isFixedText) &&
          isFact(node.arguments[0]))
      if (compares) hits.push(node)
    })
    if (hits.length === 0) continue
    const text = fs.readFileSync(path.join(root, file), 'utf8')
    for (const node of hits) {
      const whole = node.type === 'SwitchStatement' ? node.discriminant : node
      const shown = text.slice(whole.start, whole.end).replace(/\s+/g, ' ')
      found.push({
        file,
        line: node.loc.start.line,
        text:
          node.type === 'SwitchStatement' ? `switch (${shown}) with a case of fixed text` : shown
      })
    }
  }
  return found
}
