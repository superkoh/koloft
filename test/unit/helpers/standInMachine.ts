import { remoteAnswerCommand } from '../../../src/main/remote/install'
import type { Machine } from '../../../src/main/host/machine'
import type { BytesResult } from '../../../src/main/remote/ssh'

export interface MachineSaid {
  code: number | null
  stdout?: string
  stderr?: string
}

export interface StandInSetup {
  run?: (cmd: string) => MachineSaid | Promise<MachineSaid>
  sh?: (script: string, args: string[]) => MachineSaid | Promise<MachineSaid>
  sshArgs?: (background: boolean) => string[]
  packageName?: string
  tabFiles?: (tabId: string) => { dir: string; pushedLine(): string }
  loginPath?: () => Promise<string>
}

type WhatCodexAsks =
  'name' | 'ready' | 'run' | 'sh' | 'sshArgs' | 'loginPath' | 'packageName' | 'tabFiles'

const bytes = (r: MachineSaid): BytesResult => ({
  code: r.code,
  stdout: Buffer.from(r.stdout ?? ''),
  stderr: r.stderr ?? ''
})

export function standInMachine(name: string, s: StandInSetup = {}): Machine {
  const run = async (cmd: string): Promise<BytesResult> =>
    bytes((await s.run?.(cmd)) ?? { code: 0 })
  const machine: Pick<Machine, WhatCodexAsks> = {
    name,
    ready: async () => {},
    run,
    sh: async (script, args) =>
      s.sh ? bytes(await s.sh(script, args)) : run(remoteAnswerCommand(script, args)),
    sshArgs: s.sshArgs ?? (() => []),
    loginPath: s.loginPath ?? (async () => ''),
    packageName: () => s.packageName ?? 'm-0000000000000000',
    tabFiles:
      s.tabFiles ??
      (() => {
        throw new Error(`no tab files on the stand-in for ${name}`)
      })
  }
  return machine as Machine
}
