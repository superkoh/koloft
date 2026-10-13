const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const release = require('./vendor-release.json')

const VENDOR = path.join(__dirname, '..', 'vendor')
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

async function download(url, sha256) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`)
  const body = Buffer.from(await res.arrayBuffer())
  const sum = createHash('sha256').update(body).digest('hex')
  if (sum !== sha256) throw new Error(`checksum mismatch: ${sum} ${url}`)
  return body
}

async function refresh(name, version, unpack) {
  const dir = path.join(VENDOR, name)
  const stamp = path.join(dir, 'VERSION')
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === version) return
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `koloft-${name}-`))
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    await unpack(tmp, dir)
    fs.writeFileSync(stamp, version + '\n')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// PLATFORM§44
async function unpackGh(tmp, dir) {
  const { version, macArm64Sha256 } = release.gh
  const name = `gh_${version}_macOS_arm64`
  const zip = await download(
    `https://github.com/cli/cli/releases/download/v${version}/${name}.zip`,
    macArm64Sha256
  )
  fs.writeFileSync(path.join(tmp, 'gh.zip'), zip)
  execFileSync('ditto', ['-x', '-k', path.join(tmp, 'gh.zip'), tmp])
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true })
  fs.copyFileSync(path.join(tmp, name, 'bin', 'gh'), path.join(dir, 'bin', 'gh'))
  fs.chmodSync(path.join(dir, 'bin', 'gh'), 0o755)
  fs.copyFileSync(path.join(tmp, name, 'LICENSE'), path.join(dir, 'LICENSE'))
}

const credentialManagerFile = (name) =>
  name.startsWith('git-credential-manager') ||
  name.endsWith('.dylib') ||
  name.endsWith('.dll') ||
  name.endsWith('.json')

function keepInGitCore(coreDir) {
  return (src) => {
    const rel = path.relative(coreDir, src)
    if (!rel) return true
    const top = rel.split(path.sep)[0]
    if (NOT_GIT_ITSELF.has(top) || credentialManagerFile(top)) return false
    return !fs.lstatSync(path.join(coreDir, top)).isDirectory() || top === 'mergetools'
  }
}

// PLATFORM§45
async function unpackGit(tmp, dir) {
  const { version, dugiteTag, macArm64Asset, macArm64Sha256, copyingSha256 } = release.git
  const tarball = await download(
    `https://github.com/desktop/dugite-native/releases/download/${dugiteTag}/${macArm64Asset}`,
    macArm64Sha256
  )
  const copying = await download(
    `https://raw.githubusercontent.com/git/git/v${version}/COPYING`,
    copyingSha256
  )
  fs.writeFileSync(path.join(tmp, 'git.tar.gz'), tarball)
  const unpacked = path.join(tmp, 'unpacked')
  fs.mkdirSync(unpacked)
  execFileSync('tar', ['-xzf', path.join(tmp, 'git.tar.gz'), '-C', unpacked])
  const coreDir = path.join(unpacked, 'libexec', 'git-core')
  fs.cpSync(coreDir, path.join(dir, 'libexec', 'git-core'), {
    recursive: true,
    verbatimSymlinks: true,
    filter: keepInGitCore(coreDir)
  })
  fs.cpSync(
    path.join(unpacked, 'share', 'git-core', 'templates'),
    path.join(dir, 'share', 'git-core', 'templates'),
    { recursive: true, verbatimSymlinks: true }
  )
  fs.writeFileSync(path.join(dir, 'COPYING'), copying)
}

// PLATFORM§50
async function unpackGcm(tmp, dir) {
  const { version, macArm64Sha256, licenseSha256 } = release.gcm
  const base = 'https://github.com/git-ecosystem/git-credential-manager'
  const tarball = await download(
    `${base}/releases/download/v${version}/gcm-osx-arm64-${version}.tar.gz`,
    macArm64Sha256
  )
  const license = await download(
    `https://raw.githubusercontent.com/git-ecosystem/git-credential-manager/v${version}/LICENSE`,
    licenseSha256
  )
  fs.writeFileSync(path.join(tmp, 'gcm.tar.gz'), tarball)
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('tar', ['-xzf', path.join(tmp, 'gcm.tar.gz'), '-C', dir])
  fs.writeFileSync(path.join(dir, 'LICENSE'), license)
}

async function fetchVendor() {
  await refresh('gh', release.gh.version, unpackGh)
  await refresh('git', release.git.dugiteTag, unpackGit)
  await refresh('gcm', release.gcm.version, unpackGcm)
}

exports.default = fetchVendor

if (require.main === module) {
  fetchVendor().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
