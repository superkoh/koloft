#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const tool = process.argv[2]
const home = process.env.HOME
fs.appendFileSync(path.join(home, 'fake-tool-installs.txt'), `${tool}\n`)
if (fs.existsSync(path.join(home, 'fake-tool-installer-fails'))) {
  console.log('curl: (6) Could not resolve host')
  process.exit(0)
}
const stalls = path.join(home, 'fake-tool-installer-stalls')
if (fs.existsSync(stalls)) {
  fs.writeFileSync(stalls, String(process.pid))
  setInterval(() => {}, 60_000)
} else {
  const bin = path.join(home, '.local', 'bin')
  fs.mkdirSync(bin, { recursive: true })
  fs.symlinkSync(path.join(__dirname, `fake-${tool}.js`), path.join(bin, tool))
  console.log(`${tool} installed`)
}
