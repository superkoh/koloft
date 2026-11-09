import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MUSE_WRAP_PY, REMOTE_MUSE_HOOK_SH, museRunLines } from '../../src/main/museRemote'
import { TMUX_CONF } from '../../src/main/remote/install'
import { STATUS_RELAY_PY } from '../../src/main/remote/statusRelay'
import { tabScript, machineToolProgram } from '../../src/main/remote/launch'

const out = process.argv[2]
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'muse-wrap.py'), MUSE_WRAP_PY)
writeFileSync(join(out, 'muse-hook.sh'), REMOTE_MUSE_HOOK_SH)
writeFileSync(join(out, 'tmux.conf'), TMUX_CONF)
writeFileSync(join(out, 'status-relay.py'), STATUS_RELAY_PY)
const run = museRunLines({
  tabId: 'tab1',
  account: 'acct',
  args: ['--provider', 'echo', '--trust-workspace'],
  trust: [],
  koloftSkill: false,
  sandboxed: true
})
writeFileSync(
  join(out, 'tab1.sh'),
  tabScript({
    tabId: 'tab1',
    tmuxName: 'k-tab1',
    machineName: 'mac1',
    cwd: '/home/u/w',
    banner: '[Koloft] probe tab',
    program: machineToolProgram('muse', run, {})
  } as never)
)
