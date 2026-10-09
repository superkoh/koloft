const { execFileSync, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MACH_O_64_LITTLE_ENDIAN_MAGIC = 0xfeedfacf

function isMachO(file) {
  const fd = fs.openSync(file, 'r')
  const head = Buffer.alloc(4)
  const read = fs.readSync(fd, head, 0, 4, 0)
  fs.closeSync(fd)
  return read === 4 && head.readUInt32LE(0) === MACH_O_64_LITTLE_ENDIAN_MAGIC
}

function isNativeBinary(rel) {
  const name = path.basename(rel)
  return name.endsWith('.node') || name === 'spawn-helper'
}

exports.default = function stripNativeBuildPaths(context) {
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  const resources = path.join(app, 'Contents', 'Resources')
  const unpacked = path.join(resources, 'app.asar.unpacked')
  for (const rel of fs.readdirSync(unpacked, { recursive: true })) {
    const file = path.join(unpacked, rel)
    if (!isNativeBinary(rel) || !isMachO(file)) continue
    execFileSync('strip', ['-S', file])
    execFileSync('codesign', ['-s', '-', '-f', file], { stdio: 'ignore' })
  }
  const leaks = spawnSync('grep', ['-rlaF', os.homedir(), resources], { encoding: 'utf8' })
  if (leaks.stdout.trim()) {
    throw new Error(`the app still contains ${os.homedir()}:\n${leaks.stdout}`)
  }
}
