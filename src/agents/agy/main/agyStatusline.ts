import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import {
  bundlePath,
  compileCacheIn,
  EXEC_MARKER,
  type StatuslinePaths
} from '../../../main/statuslineParts'
import { AGY_COST_ENV } from './agyHooks'

// AGY§11 PLATFORM§36
export const AGY_STATUSLINE_JS = `const fs = require('fs')
const { Readable } = require('stream')
const { pathToFileURL } = require('url')
const [bundle, config] = process.argv.slice(2)
try {
  process.cwd()
} catch {
  process.chdir('/')
}
let input = {}
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'))
} catch {
  process.exit(0)
}
if (!input.model) process.exit(0)
let cost
try {
  cost = Number(fs.readFileSync(process.env.${AGY_COST_ENV}, 'utf8'))
} catch {}
if (Number.isFinite(cost)) input.cost = { ...(input.cost || {}), total_cost_usd: cost }
if (!input.effort) {
  const raw = typeof input.model?.effort === 'string' ? input.model.effort.trim() : ''
  const name =
    typeof input.model === 'object' ? input.model.display_name || input.model.id || '' : ''
  const fromName =
    typeof name === 'string'
      ? /\\((low|medium|high|xhigh|max)\\)$/i.exec(name.trim())?.[1] || ''
      : ''
  const effort = /^(?=.*[a-z0-9])[a-z0-9-]{2,20}$/i.test(raw) ? raw : fromName
  input.effort = { level: effort || null }
}
Object.defineProperty(process, 'stdin', {
  configurable: true,
  value: Readable.from([Buffer.from(JSON.stringify(input))], { objectMode: false })
})
process.argv = [process.argv[0], bundle, '--config', config]
import(pathToFileURL(bundle).href)
`

export function setupAgyStatusline(paths: StatuslinePaths): string {
  const dir = path.dirname(paths.wrapper)
  const script = path.join(dir, 'agy-statusline.js')
  fs.writeFileSync(script, AGY_STATUSLINE_JS)
  const wrapper = path.join(dir, `agy-${path.basename(paths.wrapper)}`)
  fs.writeFileSync(
    wrapper,
    `#!/usr/bin/env bash
${EXEC_MARKER}${process.execPath}
export ELECTRON_RUN_AS_NODE=1
# PLATFORM§36
export NODE_COMPILE_CACHE=${shq(compileCacheIn(dir))}
[ -d "$(pwd -P 2>/dev/null)" ] || cd / 2>/dev/null
[ -n "$COLUMNS" ] && export CCSTATUSLINE_WIDTH="$COLUMNS"
exec ${shq(process.execPath)} ${shq(script)} ${shq(bundlePath())} ${shq(paths.config)}
`,
    { mode: 0o755 }
  )
  return `/bin/bash ${shq(wrapper)}`
}
