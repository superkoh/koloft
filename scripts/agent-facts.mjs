// ADR-0054
import fs from 'node:fs'
import path from 'node:path'
import {
  AGENTS_DIR,
  EVERY_NAME,
  MANIFEST_TYPES,
  isMember,
  keyOf,
  nameOf,
  walk,
  withoutCasts
} from './source-imports.mjs'

const REGISTRY = 'src/core/agent/registry.ts'
const LIST_OF_MANIFESTS = `${AGENTS_DIR}list.ts`
const ONE_MANIFEST = 'agentManifest'
const EVERY_MANIFEST = 'AGENT_MANIFESTS'
const LISTED_MANIFESTS = 'AGENTS'
const MANIFEST_TYPE = 'AgentManifest'
const FLAGS = 'flags'
const HOSTS = ['local', 'ssh']
const HOST_LABEL = { local: 'on this Mac', ssh: 'remote' }
const GIVES_ONE_ELEMENT = new Set(['find', 'findLast'])
const CALLED_WITH_EACH_ELEMENT = new Set([
  ...GIVES_ONE_ELEMENT,
  'map',
  'filter',
  'some',
  'every',
  'flatMap',
  'forEach'
])
const COMPARISONS = new Set(['===', '!==', '==', '!='])
const DECLARES_PARAMETERS =
  /^((Arrow)?FunctionExpression|FunctionDeclaration|ObjectMethod|ClassMethod)$/
const OPENS_A_SCOPE = new RegExp(
  `^(Program|BlockStatement|For(Of|In)?Statement)$|${DECLARES_PARAMETERS.source}`
)

const isFunction = (node) => /^(Arrow)?FunctionExpression$/.test(node?.type ?? '')
const isFixedText = (node) =>
  node?.type === 'StringLiteral' ||
  (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
const initOf = (node) => node.type === 'VariableDeclarator' && withoutCasts(node.init)
const methodCalled = (node) =>
  node?.type === 'CallExpression' && isMember(node.callee) && !node.callee.computed
    ? nameOf(node.callee.property)
    : undefined

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
  if (!flags) return []
  const members = membersOf(typeOf(flags))
  if (!members)
    return [
      {
        file: MANIFEST_TYPES,
        line: flags.loc.start.line,
        what: FLAGS,
        why: 'its type is not an interface or an object type written in this file, so no flag can be checked'
      }
    ]
  const isOneAnswerPerHost = (m) => {
    const answers = membersOf(typeOf(m)) ?? []
    return (
      !m.optional &&
      answers.length === HOSTS.length &&
      answers.every(isYesOrNo) &&
      HOSTS.every((host) => answers.some((a) => nameOf(a.key) === host))
    )
  }
  return members
    .filter((m) => !isYesOrNo(m) && !isOneAnswerPerHost(m))
    .map((m) => ({
      file: MANIFEST_TYPES,
      line: m.loc.start.line,
      what: `${FLAGS}.${m.key ? nameOf(m.key) : '(not a plain field)'}`,
      why: `its type is not \`boolean\`, nor { ${HOSTS.map((h) => `${h}: boolean`).join('; ')} }`
    }))
}

function declaredObject(mod, name) {
  let found
  walk(mod.program, (node) => {
    const init = initOf(node)
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
  const agents = []
  const unread = []
  walk(list?.program ?? {}, (node) => {
    const init = initOf(node)
    if (init?.type !== 'ArrayExpression' || node.id.name !== LISTED_MANIFESTS) return
    for (const e of init.elements) {
      const from = e?.type === 'Identifier' && list.namesBoundToImports.get(e.name)
      const object = from && modules.has(from.to) && declaredObject(modules.get(from.to), from.name)
      const id = fieldOf(object, 'id')?.value
      if (object && id?.type === 'StringLiteral')
        agents.push({ id: id.value, file: from.to, object })
      else
        unread.push({
          file: LIST_OF_MANIFESTS,
          line: (e ?? init).loc.start.line,
          what: `an entry of ${LISTED_MANIFESTS}`,
          why: "it is not an imported `agent` written in its agent.ts as { id: '…', … }, so its flags cannot be checked"
        })
    }
  })
  return { agents, unread }
}

function answerOf(node) {
  if (node.type === 'BooleanLiteral') return Object.fromEntries(HOSTS.map((h) => [h, node.value]))
  if (node.type !== 'ObjectExpression') return undefined
  const perHost = HOSTS.map((h) => fieldOf(node, h)?.value)
  const complete =
    node.properties.length === HOSTS.length && perHost.every((v) => v?.type === 'BooleanLiteral')
  return complete ? Object.fromEntries(HOSTS.map((h, i) => [h, perHost[i].value])) : undefined
}

function flagAnswers(modules) {
  const listed = manifestsInListOrder(modules)
  const problems = [...listed.unread]
  const agents = listed.agents.map(({ id, file, object }) => {
    const answers = new Map()
    const flags = fieldOf(object, FLAGS)
    if (flags && flags.value.type !== 'ObjectExpression')
      problems.push({
        file,
        line: flags.loc.start.line,
        what: FLAGS,
        why: 'it is not written out here as { … }, so no answer can be checked'
      })
    for (const p of flags?.value.type === 'ObjectExpression' ? flags.value.properties : []) {
      const name = p.type === 'ObjectProperty' && !p.computed ? nameOf(p.key) : undefined
      const answer = name && answerOf(p.value)
      if (answer) answers.set(name, answer)
      else
        problems.push({
          file,
          line: p.loc.start.line,
          what: `${FLAGS}.${name ?? '(not a plain field)'}`,
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

function readersOf(modules, file, declaredIn, tables) {
  const one = new Set()
  const every = new Set()
  const table = new Set()
  for (const [local, from] of modules.get(file).namesBoundToImports) {
    if (from.name === EVERY_NAME) continue
    const origins = declaredIn(modules, from.to, from.name)
    if (origins.some((d) => d.file === REGISTRY && d.name === ONE_MANIFEST)) one.add(local)
    if (origins.some((d) => d.file === LIST_OF_MANIFESTS && d.name === LISTED_MANIFESTS))
      every.add(local)
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

function namesDeclaredBy(pattern) {
  const target =
    pattern?.type === 'AssignmentPattern'
      ? pattern.left
      : pattern?.type === 'RestElement'
        ? pattern.argument
        : pattern
  if (target?.type === 'Identifier') return [target.name]
  if (target?.type === 'ObjectPattern')
    return target.properties.flatMap((p) =>
      namesDeclaredBy(p.type === 'ObjectProperty' ? p.value : p)
    )
  return target?.type === 'ArrayPattern' ? target.elements.flatMap(namesDeclaredBy) : []
}

function walkInScopes(node, visit, scope = node) {
  const inner = OPENS_A_SCOPE.test(node.type) ? node : scope
  visit(node, inner)
  for (const value of Object.values(node))
    for (const child of Array.isArray(value) ? value : [value])
      if (child && typeof child.type === 'string') walkInScopes(child, visit, inner)
}

function factsIn(program, { one, every, table }) {
  const bound = []
  const named = (node, names) => node?.type === 'Identifier' && names.has(node.name)
  const boundAt = (id) =>
    bound
      .filter((b) => b.name === id.name && b.scope.start <= id.start && id.end <= b.scope.end)
      .reduce((best, b) => (!best || b.scope.start >= best.scope.start ? b : best), undefined)
  const isEveryManifest = (node) =>
    named(node, every) || (methodCalled(node) === 'filter' && isEveryManifest(node.callee.object))
  const isManifest = (raw) => {
    const node = withoutCasts(raw)
    if (node?.type === 'Identifier') return boundAt(node)?.isAManifest === true
    if (node?.type !== 'CallExpression') return false
    return (
      named(node.callee, one) ||
      (GIVES_ONE_ELEMENT.has(methodCalled(node)) && isEveryManifest(node.callee.object))
    )
  }
  const isFact = (raw) => {
    const node = withoutCasts(raw)
    if (node?.type === 'Identifier') return boundAt(node)?.isAManifest === false
    if (!isMember(node)) return false
    if (named(node.object, table)) return true
    return isManifest(node.object) ? nameOf(node.property) !== FLAGS : isFact(node.object)
  }
  const bind = (pattern, isAManifest, scope) => {
    const target = pattern?.type === 'AssignmentPattern' ? pattern.left : pattern
    if (target?.type === 'Identifier') bound.push({ name: target.name, isAManifest, scope })
    if (target?.type !== 'ObjectPattern' || !isAManifest) return
    for (const p of target.properties)
      if (p.type === 'ObjectProperty' && !p.computed && nameOf(p.key) !== FLAGS)
        bind(p.value, false, scope)
  }
  const hideOuterNames = (pattern, scope) => {
    for (const name of namesDeclaredBy(pattern))
      if (!bound.some((b) => b.name === name && b.scope === scope))
        bound.push({ name, isAManifest: undefined, scope })
  }
  walkInScopes(program, (node, scope) => {
    if (node.type === 'VariableDeclarator') {
      if (isManifest(node.init)) bind(node.id, true, scope)
      else if (isFact(node.init)) bind(node.id, false, scope)
      hideOuterNames(node.id, scope)
    }
    if (DECLARES_PARAMETERS.test(node.type))
      for (const param of node.params) hideOuterNames(param, node)
    if (node.type === 'ForOfStatement' && isEveryManifest(node.right))
      bind(
        node.left.type === 'VariableDeclaration' ? node.left.declarations[0].id : node.left,
        true,
        node
      )
    if (
      CALLED_WITH_EACH_ELEMENT.has(methodCalled(node)) &&
      isEveryManifest(node.callee.object) &&
      isFunction(node.arguments[0])
    )
      bind(node.arguments[0].params[0], true, node.arguments[0])
  })
  return isFact
}

function tablesBuiltFromFacts(modules, declaredIn) {
  const tables = new Set()
  const none = new Set()
  for (const [file, mod] of modules) {
    const readers = readersOf(modules, file, declaredIn, none)
    if (readers.one.size + readers.every.size === 0) continue
    const isFact = factsIn(mod.program, readers)
    walk(mod.program, (node) => {
      const init = initOf(node)
      if (
        init?.type === 'CallExpression' &&
        node.id.type === 'Identifier' &&
        init.arguments.some((a) => isFunction(a) && isFact(a.body))
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
    const readers = readersOf(modules, file, declaredIn, tables)
    if (readers.one.size + readers.every.size + readers.table.size === 0) continue
    const isFact = factsIn(mod.program, readers)
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
        (methodCalled(node) === 'includes' &&
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
