const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function isNativeBuildOutput(rel) {
  const name = path.basename(rel)
  return (
    rel.split(path.sep).join('/').includes('/build/Release/') &&
    (name.endsWith('.node') || name === 'spawn-helper')
  )
}

exports.default = async function stripNativeBuildPaths(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const unpacked = path.join(app, 'Contents', 'Resources', 'app.asar.unpacked')
  for (const rel of fs.readdirSync(unpacked, { recursive: true })) {
    const file = path.join(unpacked, rel)
    if (!isNativeBuildOutput(rel) || !fs.statSync(file).isFile()) continue
    execFileSync('strip', ['-S', file])
    execFileSync('codesign', ['-s', '-', '-f', file], { stdio: 'ignore' })
  }
}
