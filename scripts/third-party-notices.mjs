import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const OUT = path.resolve(process.argv[2] ?? path.join(ROOT, 'out'))
const BUILDS = ['main', 'preload', 'renderer']
const VITE_LICENSES = '.vite/license.json'
const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i
const NOT_FROM_A_PACKAGE = [
  [
    'Bootstrap Icons, the brand marks drawn through react-icons/bs',
    'build/licenses/bootstrap-icons.txt'
  ],
  ['@lobehub/icons-static-svg, the Antigravity mark', 'build/licenses/lobehub-icons.txt'],
  ['JetBrains Mono Nerd Font', 'src/renderer/public/fonts/OFL.txt'],
  ['Geist', 'src/renderer/public/fonts/Geist-OFL.txt'],
  ['Instrument Serif', 'src/renderer/public/fonts/InstrumentSerif-OFL.txt']
]

const read = (file) => fs.readFileSync(file, 'utf8')

function bundledPackages() {
  return BUILDS.flatMap((build) => JSON.parse(read(path.join(OUT, build, VITE_LICENSES))))
}

function shippedPackages() {
  const lock = JSON.parse(read(path.join(ROOT, 'package-lock.json')))
  return Object.entries(lock.packages)
    .filter(([key, entry]) => key.startsWith('node_modules/') && !entry.dev)
    .map(([key]) => path.join(ROOT, key))
    .filter((dir) => fs.existsSync(path.join(dir, 'package.json')))
    .map((dir) => {
      const pkg = JSON.parse(read(path.join(dir, 'package.json')))
      const text = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && LICENSE_FILE.test(entry.name))
        .map((entry) => entry.name)
        .sort()
        .map((file) => read(path.join(dir, file)).trim())
        .join('\n\n')
      return { name: pkg.name, version: pkg.version, identifier: pkg.license, text }
    })
}

const section = (title, text) => `==== ${title} ====\n\n${text.trim()}\n`

const byKey = new Map()
for (const pkg of [...shippedPackages(), ...bundledPackages()]) {
  const key = `${pkg.name}@${pkg.version}`
  if (byKey.has(key)) continue
  const text =
    pkg.text || `License: ${pkg.identifier ?? 'not stated'} (the package ships no license file)`
  byKey.set(key, section(`${pkg.name} ${pkg.version}`, text))
}

const notices = [
  'Koloft includes the third-party software, artwork and fonts below, each with its license.\n',
  ...[...byKey].sort(([a], [b]) => a.localeCompare(b)).map(([, text]) => text),
  ...NOT_FROM_A_PACKAGE.map(([title, file]) => section(title, read(path.join(ROOT, file))))
].join('\n')

fs.writeFileSync(path.join(OUT, 'THIRD-PARTY-NOTICES.txt'), notices)
