const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const release = require('./git-release.json')

const ROOT = path.join(__dirname, '..')
const VENDOR = path.join(ROOT, 'vendor', 'git')
const STAMP = path.join(VENDOR, 'VERSION')
const NOT_GIT_ITSELF = new Set([
  'git-lfs',
  'scalar',
  'git-daemon',
  'git-http-backend',
  'git-imap-send',
  'git-shell',
  'git-http-push',
  'git-http-fetch',
  'createdump',
  'NOTICE',
  'uninstall.sh'
])

function fetched() {
  return fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === release.dugiteTag
}

async function download(url, sha256) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`git download failed: ${res.status} ${url}`)
  const body = Buffer.from(await res.arrayBuffer())
  const sum = createHash('sha256').update(body).digest('hex')
  if (sum !== sha256) throw new Error(`git download checksum mismatch: ${sum} ${url}`)
  return body
}

function credentialManagerFile(name) {
  return (
    name.startsWith('git-credential-manager') ||
    name.endsWith('.dylib') ||
    name.endsWith('.dll') ||
    name.endsWith('.json')
  )
}

function keepInGitCore(coreDir) {
  return (src) => {
    const rel = path.relative(coreDir, src)
    if (!rel) return true
    const top = rel.split(path.sep)[0]
    if (NOT_GIT_ITSELF.has(top) || credentialManagerFile(top)) return false
    const st = fs.lstatSync(path.join(coreDir, top))
    return !st.isDirectory() || top === 'mergetools'
  }
}

async function fetchGit() {
  if (fetched()) return
  const url = `https://github.com/desktop/dugite-native/releases/download/${release.dugiteTag}/${release.macArm64Asset}`
  const tarball = await download(url, release.macArm64Sha256)
  const copying = await download(
    `https://raw.githubusercontent.com/git/git/v${release.gitVersion}/COPYING`,
    release.copyingSha256
  )
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-git-'))
  try {
    fs.writeFileSync(path.join(tmp, 'git.tar.gz'), tarball)
    const unpacked = path.join(tmp, 'unpacked')
    fs.mkdirSync(unpacked)
    execFileSync('tar', ['-xzf', path.join(tmp, 'git.tar.gz'), '-C', unpacked])
    fs.rmSync(VENDOR, { recursive: true, force: true })
    const coreDir = path.join(unpacked, 'libexec', 'git-core')
    fs.cpSync(coreDir, path.join(VENDOR, 'libexec', 'git-core'), {
      recursive: true,
      verbatimSymlinks: true,
      filter: keepInGitCore(coreDir)
    })
    fs.cpSync(
      path.join(unpacked, 'share', 'git-core', 'templates'),
      path.join(VENDOR, 'share', 'git-core', 'templates'),
      { recursive: true, verbatimSymlinks: true }
    )
    fs.writeFileSync(path.join(VENDOR, 'COPYING'), copying)
    fs.writeFileSync(STAMP, release.dugiteTag + '\n')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

exports.default = fetchGit

if (require.main === module) {
  fetchGit().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
