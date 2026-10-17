import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveCliRuntime, type CliSpec } from '../../src/main/cliRuntime'

let directory: string
let environment: NodeJS.ProcessEnv

const COMMAND = 'koloft-fixture-cli'
const spec: CliSpec = {
  command: COMMAND,
  testCommandEnv: 'KOLOFT_FIXTURE_CLI_CMD',
  name: 'Fixture',
  cliName: 'Fixture CLI',
  notInstalled: 'Install the Fixture CLI.',
  environment: (env) => env,
  version: /^(\d+)\.(\d+)\.(\d+)/m,
  testedLine: '1.4',
  installedOffPath: (env) => path.join(env.HOME || '', '.local', 'bin', COMMAND)
}

const ownFolderCopy = (): string => path.join(directory, '.local', 'bin', COMMAND)

function writeCli(file: string, version: string, mode = 0o700): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!/bin/sh\nprintf "${version}\\n"\n`, { mode })
}

beforeEach(() => {
  directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-cli-runtime-')))
  environment = { PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', ZDOTDIR: directory, HOME: directory }
  fs.writeFileSync(path.join(directory, '.zshrc'), 'printf "interactive banner\\n"\n')
})

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true })
})

describe('resolveCliRuntime for a CLI whose installer leaves it off the login PATH (AGY§3)', () => {
  it('finds the CLI in the folder its own installer uses when the login shell cannot', async () => {
    writeCli(ownFolderCopy(), '1.4.0')
    expect(await resolveCliRuntime(spec, { env: environment })).toMatchObject({
      binary: ownFolderCopy(),
      version: '1.4.0',
      verified: true
    })
  })

  it('takes the one the login shell finds over the copy in that folder', async () => {
    writeCli(ownFolderCopy(), '1.4.0')
    const onPath = path.join(directory, 'bin', COMMAND)
    writeCli(onPath, '1.5.2')
    fs.appendFileSync(path.join(directory, '.zshrc'), 'export PATH="$ZDOTDIR/bin:$PATH"\n')
    expect(await resolveCliRuntime(spec, { env: environment })).toMatchObject({
      binary: onPath,
      version: '1.5.2',
      verified: false
    })
  })

  it('reads a file there that cannot run as not installed', async () => {
    writeCli(ownFolderCopy(), '1.4.0', 0o600)
    await expect(resolveCliRuntime(spec, { env: environment })).rejects.toThrow(
      'Install the Fixture CLI.'
    )
  })
})
