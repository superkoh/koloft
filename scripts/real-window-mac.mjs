import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const CONFIG = 'test/real-window/playwright.config.ts'
const RESULTS = path.join(REPO, 'test-results', 'real-window')
const PLAYWRIGHT_CLI = 'node_modules/@playwright/test/cli.js'

// PLATFORM§52
const BASE_IMAGE = 'ghcr.io/cirruslabs/macos-golden-gate-vanilla:latest'
const GUEST_LOGIN = 'admin'
const GUEST_UID = 501
const GUEST_HOME = '/Users/admin'
const GUEST_SHARES = '/Volumes/My Shared Files'
const VM_MEMORY_MB = 6144
const VM_CPUS = 4
const IP_WAIT_SECONDS = 300
const SSH_READY_TRIES = 60
// PLATFORM§52
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'

const USAGE = `Runs test/real-window on a Mac whose screen the run may take over.

  node scripts/real-window-mac.mjs here [playwright args]
      This Mac is that Mac (a GitHub macOS runner, an idle Mac). Never your own
      desk Mac: the run takes the keyboard, the mouse and the screen.

  node scripts/real-window-mac.mjs tart [playwright args]
      A throwaway macOS VM: cloned from ${BASE_IMAGE}, run with no window on
      this screen, deleted afterwards. Needs tart on PATH and TART_HOME set to
      the folder tart keeps its images in (the base image is about 35 GB).

Both need \`npm run build\` first. Results land in test-results/real-window.`

function fail(message) {
  console.error(message)
  process.exit(2)
}

function runHere(args) {
  const r = spawnSync(process.execPath, [PLAYWRIGHT_CLI, 'test', '-c', CONFIG, ...args], {
    cwd: REPO,
    stdio: 'inherit',
    env: { ...process.env, KOLOFT_REAL_WINDOW: '1' }
  })
  return r.status ?? 1
}

function run(command, args, opts = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', ...opts })
  if (r.error) throw new Error(`${command} could not run: ${r.error.message}`)
  if (r.status !== 0) throw new Error(`${command} ${args.join(' ')} failed: ${r.stderr}`)
  return (r.stdout ?? '').trim()
}

const tart = (args, opts) => run('tart', args, opts)

// PLATFORM§52
const SCREEN_CAPTURE_APPROVED_FOR_TESTS_RUN_OVER_SSH = `approvals="${GUEST_HOME}/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist"
approved="/usr/libexec/sshd-keygen-wrapper"
mkdir -p "\${approvals:h}"
plutil -create xml1 "$approvals"
plutil -insert "$approved" -dictionary "$approvals"
plutil -insert "$approved.kScreenCaptureApprovalLastAlerted" -date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$approvals"
plutil -insert "$approved.kScreenCaptureApprovalLastUsed" -date "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$approvals"
plutil -insert "$approved.kScreenCapturePrivacyHintDate" -date "$(date -u -v+30d +%Y-%m-%dT%H:%M:%SZ)" "$approvals"
plutil -insert "$approved.kScreenCapturePrivacyHintPolicy" -integer 2592000 "$approvals"
plutil -insert "$approved.kScreenCaptureAlertableUsageCount" -integer 1 "$approvals"`

function guestScript(args) {
  const quoted = args.map((a) => `'${a.replaceAll("'", "'\\''")}'`).join(' ')
  return `set -u
${SCREEN_CAPTURE_APPROVED_FOR_TESTS_RUN_OVER_SSH}
rsync -a --exclude /.git --exclude /.claude --exclude /dist --exclude /test-results "${GUEST_SHARES}/repo/" ${GUEST_HOME}/koloft/
cp "${GUEST_SHARES}/kit/node" ${GUEST_HOME}/node
cd ${GUEST_HOME}/koloft
codesign --force --deep --sign - node_modules/electron/dist/Electron.app
${LSREGISTER} -f node_modules/electron/dist/Electron.app
sudo launchctl asuser ${GUEST_UID} sudo -u ${GUEST_LOGIN} HOME=${GUEST_HOME} USER=${GUEST_LOGIN} ${GUEST_HOME}/node scripts/real-window-mac.mjs here ${quoted}
code=$?
rsync -a ${GUEST_HOME}/koloft/test-results/real-window/ "${GUEST_SHARES}/kit/results/"
exit $code
`
}

// PLATFORM§52
const GRANTS_FOR_TESTS_RUN_OVER_SSH = `insert or replace into access
  (service, client, client_type, auth_value, auth_reason, auth_version, flags) values
  ('kTCCServiceAccessibility', '/usr/libexec/sshd-keygen-wrapper', 1, 2, 4, 1, 0),
  ('kTCCServiceAccessibility', '/usr/bin/osascript', 1, 2, 4, 1, 0),
  ('kTCCServicePostEvent', '/usr/libexec/sshd-keygen-wrapper', 1, 2, 4, 1, 0),
  ('kTCCServicePostEvent', '/usr/bin/osascript', 1, 2, 4, 1, 0),
  ('kTCCServiceScreenCapture', '/usr/libexec/sshd-keygen-wrapper', 1, 2, 4, 1, 0),
  ('kTCCServiceAccessibility', '/usr/libexec/sshd-session', 1, 2, 4, 1, 0),
  ('kTCCServicePostEvent', '/usr/libexec/sshd-session', 1, 2, 4, 1, 0),
  ('kTCCServiceScreenCapture', '/usr/libexec/sshd-session', 1, 2, 4, 1, 0),
  ('kTCCServiceScreenCapture', 'com.apple.sshd-session', 0, 2, 4, 1, 0);`

function diskutilPlist(args) {
  const xml = run('diskutil', args)
  return JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml }))
}

function grantWhileStopped(name, kit) {
  const disk = path.join(process.env.TART_HOME, 'vms', name, 'disk.img')
  const devs = diskutilPlist(['image', 'attach', '--noMount', '--plist', disk])[
    'system-entities'
  ].map((e) => e['dev-entry'])
  const mountPoint = path.join(kit, 'guest-data')
  fs.mkdirSync(mountPoint)
  try {
    const data = devs.find((d) => diskutilPlist(['info', '-plist', d]).VolumeName === 'Data')
    if (!data) throw new Error(`no Data volume in ${disk}`)
    run('diskutil', [
      'mount',
      '-mountOptions',
      'nobrowse,noowners',
      '-mountPoint',
      mountPoint,
      data
    ])
    const db = path.join(mountPoint, 'Library/Application Support/com.apple.TCC/TCC.db')
    run('sqlite3', [db, GRANTS_FOR_TESTS_RUN_OVER_SSH])
    run('diskutil', ['unmount', mountPoint])
  } finally {
    spawnSync('diskutil', ['eject', devs[0]], { stdio: 'ignore' })
  }
}

function ssh(ip, kit, remote, opts = {}) {
  return spawnSync(
    'ssh',
    [
      '-F',
      '/dev/null',
      '-o',
      'UserKnownHostsFile=/dev/null',
      '-o',
      'StrictHostKeyChecking=no',
      '-o',
      'LogLevel=ERROR',
      '-o',
      'PubkeyAuthentication=no',
      '-o',
      'IdentityAgent=none',
      '-o',
      'PreferredAuthentications=password,keyboard-interactive',
      '-o',
      'NumberOfPasswordPrompts=1',
      '-o',
      'ConnectTimeout=5',
      `${GUEST_LOGIN}@${ip}`,
      remote
    ],
    {
      encoding: 'utf8',
      ...opts,
      env: {
        ...process.env,
        SSH_ASKPASS: path.join(kit, 'askpass'),
        SSH_ASKPASS_REQUIRE: 'force'
      }
    }
  )
}

async function runInTart(args) {
  if (!process.env.TART_HOME)
    fail('set TART_HOME to the folder tart keeps its images in\n\n' + USAGE)
  const name = `koloft-real-window-${process.pid}`
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), 'koloft-real-window-'))
  fs.writeFileSync(path.join(kit, 'askpass'), `#!/bin/sh\necho ${GUEST_LOGIN}\n`, { mode: 0o700 })
  fs.copyFileSync(process.execPath, path.join(kit, 'node'))
  fs.writeFileSync(path.join(kit, 'run.sh'), guestScript(args))
  let vm
  try {
    console.log(`cloning ${BASE_IMAGE} into ${name}`)
    tart(['clone', BASE_IMAGE, name], { stdio: 'inherit' })
    tart(['set', name, '--memory', String(VM_MEMORY_MB), '--cpu', String(VM_CPUS)])
    grantWhileStopped(name, kit)
    vm = spawn(
      'tart',
      ['run', '--no-graphics', '--no-audio', `--dir=repo:${REPO}:ro`, `--dir=kit:${kit}`, name],
      { stdio: 'ignore' }
    )
    const ip = tart(['ip', '--wait', String(IP_WAIT_SECONDS), name])
    let ready = false
    for (let i = 0; i < SSH_READY_TRIES && !ready; i++) {
      ready = ssh(ip, kit, 'true').status === 0
      if (!ready) await new Promise((r) => setTimeout(r, 1000))
    }
    if (!ready) throw new Error(`no ssh login on ${ip}`)
    const r = ssh(ip, kit, `/bin/zsh "${GUEST_SHARES}/kit/run.sh"`, { stdio: 'inherit' })
    fs.rmSync(RESULTS, { recursive: true, force: true })
    if (fs.existsSync(path.join(kit, 'results')))
      fs.cpSync(path.join(kit, 'results'), RESULTS, { recursive: true })
    return r.status ?? 1
  } finally {
    spawnSync('tart', ['stop', name], { stdio: 'ignore' })
    vm?.kill()
    spawnSync('tart', ['delete', name], { stdio: 'ignore' })
    fs.rmSync(kit, { recursive: true, force: true })
  }
}

const [where, ...args] = process.argv.slice(2)
if (where === 'here') process.exit(runHere(args))
else if (where === 'tart') process.exit(await runInTart(args))
else fail(USAGE)
