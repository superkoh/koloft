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

const bytes = (r: MachineSaid): BytesResult => ({
  code: r.code,
  stdout: Buffer.from(r.stdout ?? ''),
  stderr: r.stderr ?? ''
})

export function standInMachine(name: string, s: StandInSetup = {}): Machine {
  const notSetUp = (what: string) => (): never => {
    throw new Error(`the stand-in for ${name} was not set up for ${what}`)
  }
  const run = async (cmd: string): Promise<BytesResult> =>
    bytes((await s.run?.(cmd)) ?? { code: 0 })
  return {
    name,
    bare: notSetUp('bare'),
    ready: async () => {},
    run,
    sh: async (script, args) =>
      s.sh ? bytes(await s.sh(script, args)) : run(remoteAnswerCommand(script, args)),
    runScript: notSetUp('runScript'),
    reachOrThrow: notSetUp('reachOrThrow'),
    sshArgs: s.sshArgs ?? (() => []),
    loginPath: s.loginPath ?? (async () => ''),
    packageName: () => s.packageName ?? 'm-0000000000000000',
    tabFiles: s.tabFiles ?? notSetUp('tabFiles'),
    tmux: {
      open: notSetUp('tmux.open'),
      end: notSetUp('tmux.end'),
      endedByKoloft: notSetUp('tmux.endedByKoloft'),
      rename: notSetUp('tmux.rename')
    },
    answerRequest: notSetUp('answerRequest'),
    requestCallerWaits: notSetUp('requestCallerWaits')
  }
}
