import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'

const HERE = path.dirname(new URL(import.meta.url).pathname)
const ROOT = path.dirname(HERE)
const NAME = 'p1668-agy'
const dk = (args, opts = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts })

const [mode, ...rest] = process.argv.slice(2)

if (mode === 'up') {
  try {
    dk(['rm', '-f', NAME])
  } catch {}
  dk(['run', '-d', '--network', 'none', '--name', NAME, 'agy-a-img', 'sleep', '14400'])
  for (const v of ['agy153', 'agy155']) {
    dk(['exec', NAME, 'mkdir', '-p', `/home/u/${v}`])
    dk(['cp', path.join(ROOT, v, 'cli.tar.gz'), `${NAME}:/home/u/${v}/cli.tar.gz`])
    dk(['exec', NAME, 'tar', 'xzf', `/home/u/${v}/cli.tar.gz`, '-C', `/home/u/${v}`])
  }
  dk(['exec', NAME, 'chown', '-R', 'u:u', '/home/u'])
  console.log('up')
} else if (mode === 'down') {
  dk(['rm', '-f', NAME])
  console.log('down')
} else if (mode === 'run') {
  const cases = JSON.parse(fs.readFileSync(path.join(HERE, rest[0]), 'utf8'))
  const outFile = path.join(HERE, rest[1])
  dk(['cp', path.join(HERE, 'agy_probe.py'), `${NAME}:/home/u/agy_probe.py`])
  for (const c of cases) {
    let out
    try {
      out = dk(
        [
          'exec',
          '-u',
          'u',
          '-w',
          '/home/u',
          NAME,
          'python3',
          '/home/u/agy_probe.py',
          JSON.stringify(c)
        ],
        {
          timeout: 120_000
        }
      )
    } catch (e) {
      out = `FAILED ${e.message}\n${e.stdout ?? ''}\n${e.stderr ?? ''}`
    }
    fs.appendFileSync(outFile, `\n===== ${c.label} =====\n${out}\n`)
    console.log(`done ${c.label}`)
  }
}
