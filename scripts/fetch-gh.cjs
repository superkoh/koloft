const { createHash } = require('node:crypto')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const release = require('./gh-release.json')

const ROOT = path.join(__dirname, '..')
const VENDOR = path.join(ROOT, 'vendor', 'gh')
const STAMP = path.join(VENDOR, 'VERSION')

function fetched() {
  return fs.existsSync(STAMP) && fs.readFileSync(STAMP, 'utf8').trim() === release.version
}

async function fetchGh() {
  if (fetched()) return
  const name = `gh_${release.version}_macOS_arm64`
  const url = `https://github.com/cli/cli/releases/download/v${release.version}/${name}.zip`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`gh download failed: ${res.status} ${url}`)
  const zip = Buffer.from(await res.arrayBuffer())
  const sum = createHash('sha256').update(zip).digest('hex')
  if (sum !== release.macArm64Sha256) throw new Error(`gh download checksum mismatch: ${sum}`)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-gh-'))
  try {
    fs.writeFileSync(path.join(tmp, 'gh.zip'), zip)
    execFileSync('ditto', ['-x', '-k', path.join(tmp, 'gh.zip'), tmp])
    fs.rmSync(VENDOR, { recursive: true, force: true })
    fs.mkdirSync(path.join(VENDOR, 'bin'), { recursive: true })
    fs.copyFileSync(path.join(tmp, name, 'bin', 'gh'), path.join(VENDOR, 'bin', 'gh'))
    fs.chmodSync(path.join(VENDOR, 'bin', 'gh'), 0o755)
    fs.copyFileSync(path.join(tmp, name, 'LICENSE'), path.join(VENDOR, 'LICENSE'))
    fs.writeFileSync(STAMP, release.version + '\n')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

exports.default = fetchGh

if (require.main === module) {
  fetchGh().catch((err) => {
    console.error(err.message)
    process.exit(1)
  })
}
