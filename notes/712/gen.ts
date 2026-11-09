import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MUSE_WRAP_PY, MUSE_HOOK_FILE, REMOTE_MUSE_HOOK_SH, museRunLines } from '../../src/main/museRemote'
import { remoteMuseHooks } from '../../src/main/museHooks'
import { ENSURE_SH, TMUX_CONF } from '../../src/main/remote/install'
import { STATUS_RELAY_PY } from '../../src/main/remote/statusRelay'
import { tabScript, machineToolProgram } from '../../src/main/remote/launch'
import { remoteMachineDir } from '../../src/main/remote/paths'

const out = process.argv[2]
const cwd = process.argv[3] ?? '/home/u/w'
const museArgs = (process.argv[4] ?? '--provider echo --trust-workspace').split(' ')
mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'muse-wrap.py'), MUSE_WRAP_PY)
writeFileSync(join(out, MUSE_HOOK_FILE), REMOTE_MUSE_HOOK_SH)
writeFileSync(join(out, 'tmux.conf'), TMUX_CONF)
writeFileSync(join(out, 'ensure.sh'), ENSURE_SH)
writeFileSync(join(out, 'status-relay.py'), STATUS_RELAY_PY)
writeFileSync(join(out, 'tab1.hooks.json'), remoteMuseHooks(`${remoteMachineDir('mac1')}/${MUSE_HOOK_FILE}`, 'tab1'))
const run = museRunLines({
  tabId: 'tab1',
  account: 'acct',
  args: museArgs,
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
    cwd,
    banner: '[Koloft] probe tab',
    program: machineToolProgram('muse', run, {})
  } as never)
)
