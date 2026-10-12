#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const home = process.env.KOLOFT_FAKE_GH_LOGIN_HOME || process.env.HOME
const POLL_MS = 50
const CODE = 'ABCD-1234'
const DEVICE_URL = 'https://github.com/login/device'

fs.appendFileSync(
  path.join(home, 'fake-gh-login-env.txt'),
  `argv ${process.argv.slice(2).join(' ')}\n` +
    `keys ${Object.keys(process.env).sort().join(' ')}\n` +
    `PATH ${process.env.PATH}\n` +
    `HOME ${process.env.HOME}\n` +
    `GH_CONFIG_DIR ${process.env.GH_CONFIG_DIR}\n`
)

process.stderr.write(
  `\n! First copy your one-time code: ${CODE}\n` +
    `Open this URL to continue in your web browser: ${DEVICE_URL}\n`
)

const approved = path.join(home, 'approve-gh-login')
const denied = path.join(home, 'deny-gh-login')

const wait = setInterval(() => {
  if (fs.existsSync(denied)) {
    clearInterval(wait)
    process.stderr.write('failed to authenticate via web browser: access_denied\n')
    process.exit(1)
  }
  if (!fs.existsSync(approved)) return
  clearInterval(wait)
  const login = process.env.KOLOFT_FAKE_GH_LOGIN_AS || 'bob'
  const token = process.env.KOLOFT_FAKE_GH_LOGIN_TOKEN || 'gho_fake_bob'
  fs.writeFileSync(
    path.join(process.env.GH_CONFIG_DIR, 'hosts.yml'),
    `github.com:\n    users:\n        ${login}:\n            oauth_token: ${token}\n    git_protocol: https\n    oauth_token: ${token}\n    user: ${login}\n`,
    { mode: 0o600 }
  )
  process.stderr.write('✓ Authentication complete.\n')
  process.exit(0)
}, POLL_MS)
