#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const home = process.env.KOLOFT_FAKE_GCM_HOME || process.env.HOME
const plaintext =
  process.env.GCM_CREDENTIAL_STORE === 'plaintext' && process.env.GCM_PLAINTEXT_STORE_PATH
const storeFile = path.join(plaintext || home, 'fake-gcm-store.json')
const POLL_MS = 50
const op = process.argv[2]
if (op === '--version') {
  process.stdout.write('3.0.1+fake\n')
  process.exit(0)
}
const namespace = process.env.GCM_NAMESPACE || ''

function readStore() {
  if (plaintext) fs.mkdirSync(plaintext, { recursive: true, mode: 0o700 })
  try {
    return JSON.parse(fs.readFileSync(storeFile, 'utf8'))
  } catch {
    return {}
  }
}

function fields(text) {
  const out = {}
  for (const line of text.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 1)
  }
  return out
}

let input = ''
process.stdin.on('data', (c) => (input += c))
process.stdin.on('end', () => {
  const req = fields(input)
  const interactive = op === 'get' && process.env.GCM_INTERACTIVE !== 'never'
  fs.appendFileSync(
    path.join(home, 'fake-gcm-calls.txt'),
    JSON.stringify({
      op,
      namespace,
      interactive,
      protocol: req.protocol,
      host: req.host,
      wwwauth: req['wwwauth[]'] || null,
      env: {
        GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
        GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
        GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT || null,
        GCM_PROVIDER: process.env.GCM_PROVIDER
      }
    }) + '\n'
  )
  const store = readStore()
  const save = () => fs.writeFileSync(storeFile, JSON.stringify(store, null, 2))
  if (op === 'store') {
    store[namespace] = { username: req.username, password: req.password }
    save()
    return process.exit(0)
  }
  if (op === 'erase') {
    delete store[namespace]
    save()
    return process.exit(0)
  }
  if (!interactive) {
    const found = store[namespace]
    if (!found) {
      process.stderr.write('fatal: Cannot prompt because user interactivity has been disabled.\n')
      return process.exit(1)
    }
    process.stdout.write(`username=${found.username}\npassword=${found.password}\n`)
    return process.exit(0)
  }
  const authorize = `${req.protocol}://${req.host}/login/oauth/authorize?client_id=fake&state=s`
  process.stderr.write(
    `12:00:00.000000 OAuth2SystemWebBrowser.cs:90 trace: [OpenBrowser] Opening browser using framework shell-execute: ${authorize}\n`
  )
  const approved = path.join(home, 'approve-gcm-login')
  const wait = setInterval(() => {
    if (!fs.existsSync(approved)) return
    clearInterval(wait)
    const cred = JSON.parse(fs.readFileSync(approved, 'utf8'))
    fs.rmSync(approved)
    store[namespace] = cred
    save()
    process.stdout.write(
      `protocol=${req.protocol}\nhost=${req.host}\nusername=${cred.username}\npassword=${cred.password}\n`
    )
    process.exit(0)
  }, POLL_MS)
})
