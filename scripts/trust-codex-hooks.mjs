import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import {
  folderTrustLevel,
  withTrustedFolder,
  withTrustedHash
} from '../src/agents/codex/main/codexConfigTables.mjs'

// CODEX§11 CODEX§27 ADR-0053

const KOLOFT_SHIM_MARK = 'KOLOFT_UTIL'
const APP_SERVER_TIMEOUT_MS = 60_000

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function fail(message) {
  console.error(`trust-codex-hooks: ${message}`)
  process.exit(1)
}

function mainCheckout() {
  const common = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: import.meta.dirname,
    encoding: 'utf8'
  }).stdout?.trim()
  if (!common) fail('this script is not inside a git checkout')
  return fs.realpathSync(path.dirname(common))
}

function isRealCodex(file) {
  try {
    if (!fs.statSync(file).isFile()) return false
    const fd = fs.openSync(file, 'r')
    const head = Buffer.alloc(4096)
    const n = fs.readSync(fd, head, 0, head.length, 0)
    fs.closeSync(fd)
    return !head.subarray(0, n).toString('latin1').includes(KOLOFT_SHIM_MARK)
  } catch {
    return false
  }
}

function findCodex() {
  const given = argValue('--codex')
  if (given) return given
  const home = os.homedir()
  const onPath = (process.env.PATH ?? '').split(':').map((dir) => path.join(dir, 'codex'))
  const koloftInstalls = fs
    .readdirSync(home)
    .filter((name) => name.startsWith('.koloft'))
    .map((name) => path.join(home, name, 'codex-cli', 'bin', 'codex'))
  return (
    [...onPath, ...koloftInstalls].find(isRealCodex) ?? fail('no codex found; pass --codex <path>')
  )
}

function configFile() {
  const given = argValue('--config')
  if (given) return path.resolve(given)
  if (process.env.CODEX_HOME) return path.join(process.env.CODEX_HOME, 'config.toml')
  const localHome = path.join(os.homedir(), '.codex')
  const remoteHome = path.join(os.homedir(), '.koloft', 'codex-home')
  const homes = [localHome, remoteHome].filter((home) => fs.existsSync(home))
  if (homes.length > 1)
    fail(`both ${localHome} and ${remoteHome} exist; pass --config <home>/config.toml`)
  return path.join(homes[0] ?? localHome, 'config.toml')
}

function writeAtomically(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, text, { mode: 0o600 })
  fs.renameSync(temp, file)
}

function listProjectHooks(codex, codexHome, repo) {
  return new Promise((resolve) => {
    const child = spawn(codex, ['app-server'], {
      cwd: repo,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ['pipe', 'pipe', 'ignore']
    })
    child.on('error', (e) => fail(`could not start ${codex} app-server (${e.message})`))
    child.on('exit', (code) => fail(`codex app-server exited (${code}) before it listed the hooks`))
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      fail(`codex app-server gave no hook list in ${APP_SERVER_TIMEOUT_MS / 1000} s`)
    }, APP_SERVER_TIMEOUT_MS)
    let buffered = ''
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      let newline
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline)
        buffered = buffered.slice(newline + 1)
        let message
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message.error && (message.id === 1 || message.id === 2))
          fail(
            `codex app-server answered: ${message.error.message ?? JSON.stringify(message.error)}`
          )
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n`)
          child.stdin.write(
            `${JSON.stringify({ id: 2, method: 'hooks/list', params: { cwds: [repo] } })}\n`
          )
        } else if (message.id === 2) {
          clearTimeout(timer)
          child.removeAllListeners('exit')
          child.kill()
          const hooks = (message.result?.data ?? []).flatMap((entry) => entry.hooks ?? [])
          resolve(hooks.filter((hook) => hook.source === 'project'))
        }
      }
    })
    child.stdin.write(
      `${JSON.stringify({
        id: 1,
        method: 'initialize',
        params: {
          clientInfo: { name: 'trust-codex-hooks', title: 'trust-codex-hooks', version: '1' },
          capabilities: { experimentalApi: true }
        }
      })}\n`
    )
  })
}

const repo = mainCheckout()
const codex = findCodex()
const homeConfig = configFile()
const codexHome = path.dirname(homeConfig)
const config = fs.existsSync(homeConfig) ? fs.realpathSync(homeConfig) : homeConfig
const before = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : ''
const level = folderTrustLevel(before, repo)
if (level !== undefined && level !== 'trusted')
  fail(`${config} sets ${repo} to trust_level "${level}"; change it to "trusted" first`)

let saved = before
function save(text) {
  if (text === saved) return
  const backup = `${config}.before-trust-codex-hooks`
  if (saved === before && before !== '' && !fs.existsSync(backup)) fs.copyFileSync(config, backup)
  writeAtomically(config, text)
  saved = text
}

if (level !== 'trusted') save(withTrustedFolder(before, repo))

const hooks = await listProjectHooks(codex, codexHome, repo)
if (hooks.length === 0) fail(`codex lists no hooks from ${repo}/.codex`)
save(hooks.reduce((text, hook) => withTrustedHash(text, hook.key, hook.currentHash), saved))

const after = await listProjectHooks(codex, codexHome, repo)
const untrusted = after.filter((hook) => hook.trustStatus !== 'trusted')
if (untrusted.length > 0)
  fail(`still untrusted after writing ${config}: ${untrusted.map((h) => h.key).join(', ')}`)
console.log(`Trusted ${after.length} hooks from ${repo}/.codex in ${config}.`)
