import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import type {
  ChannelCredentials,
  ClientReadableStream,
  Metadata,
  ServiceError
} from '@grpc/grpc-js'
import {
  runTool,
  ToolFailed,
  type PhoneDevice,
  type PhoneKey,
  type Point,
  type TouchPhase
} from './device'
import { AVD_NAME, ensureAndroidSdk, SCREEN, writeAvd } from './androidSdk'

export interface AndroidPaths {
  sdk: string
  avdHome: string
  emulatorHome: string
  agentDeviceHome: string
  agentDeviceBin: string
  log: string
}

type Callback = (err: ServiceError | null, res: Record<string, unknown>) => void
type Unary = (req: unknown, md: Metadata, cb: Callback) => void
interface EmulatorClient {
  getStatus: Unary
  getScreenshot: Unary
  sendTouch: Unary
  sendKey: Unary
  streamScreenshot(req: unknown, md: Metadata): ClientReadableStream<{ image: Buffer }>
  close(): void
}

const FIRST_CONSOLE_PORT = 5554
const LAST_CONSOLE_PORT = 5682
const TOKEN_WAIT_MS = 60_000
const BOOT_WAIT_MS = 5 * 60_000
const POLL_MS = 1_000
const QUICK_MS = 9_000
const HELPER_INSTALL_MS = 3 * 60_000
const READ_UI_TRIES_AFTER_BOOT = 4
const INSTALL_MS = 5 * 60_000
const STOP_GRACE_MS = 5_000
// PLATFORM§54
const IDLE_GRPC_TIMEOUT_S = 300
const HEARTBEAT_WELL_UNDER_IDLE_TIMEOUT_MS = 60_000
const LIVE_FRAME = { width: SCREEN.width / 2, height: SCREEN.height / 2 }
const KEY_NAME: Record<PhoneKey, string> = {
  home: 'GoHome',
  back: 'GoBack',
  enter: 'Enter',
  delete: 'Backspace'
}

function listenable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
  })
}

async function freeConsolePort(): Promise<number> {
  for (let p = FIRST_CONSOLE_PORT; p <= LAST_CONSOLE_PORT; p += 2)
    if ((await listenable(p)) && (await listenable(p + 1))) return p
  throw new ToolFailed('no free port for the Android emulator.')
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

export function tokenFor(iniTexts: string[], grpcPort: number): string | null {
  for (const text of iniTexts) {
    const kv = new Map(
      text.split('\n').map((line) => {
        const i = line.indexOf('=')
        return [line.slice(0, i).trim(), line.slice(i + 1).trim()] as const
      })
    )
    if (kv.get('grpc.port') === String(grpcPort) && kv.get('grpc.token'))
      return kv.get('grpc.token') ?? null
  }
  return null
}

// PLATFORM§54
function readDiscovery(): string[] {
  const dir = path.join(os.homedir(), 'Library', 'Caches', 'TemporaryItems', 'avd', 'running')
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => /^pid_\d+\.ini$/.test(f))
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
  } catch {
    return []
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until<T>(
  deadlineMs: number,
  what: string,
  probe: () => Promise<T | null> | T | null,
  alive: () => boolean
): Promise<T> {
  const end = Date.now() + deadlineMs
  while (Date.now() < end) {
    if (!alive()) throw new ToolFailed(`the Android emulator stopped while ${what}.`)
    const got = await probe()
    if (got !== null) return got
    await sleep(POLL_MS)
  }
  throw new ToolFailed(`the Android emulator took too long ${what}.`)
}

export async function startAndroid(
  paths: AndroidPaths,
  progress: (text: string) => void,
  signal: AbortSignal
): Promise<AndroidPhone> {
  await ensureAndroidSdk(paths.sdk, progress, signal)
  writeAvd(paths.avdHome)
  fs.mkdirSync(paths.emulatorHome, { recursive: true })
  const consolePort = await freeConsolePort()
  const grpcPort = await freePort()
  const env = {
    ...process.env,
    ANDROID_ADB_SERVER_PORT: String(await freePort()),
    ANDROID_HOME: paths.sdk,
    ANDROID_SDK_ROOT: paths.sdk,
    ANDROID_AVD_HOME: paths.avdHome,
    ANDROID_EMULATOR_HOME: paths.emulatorHome,
    ANDROID_USER_HOME: paths.emulatorHome,
    PATH: `${path.join(paths.sdk, 'platform-tools')}:${process.env.PATH ?? ''}`
  }
  const log = fs.openSync(paths.log, 'w')
  progress('starting the Android emulator')
  // PLATFORM§54
  const child = spawn(
    path.join(paths.sdk, 'emulator', 'emulator'),
    [
      '-avd',
      AVD_NAME,
      '-no-window',
      '-no-audio',
      '-no-boot-anim',
      '-no-snapshot',
      '-port',
      String(consolePort),
      '-grpc',
      String(grpcPort),
      '-grpc-use-token',
      '-idle-grpc-timeout',
      String(IDLE_GRPC_TIMEOUT_S)
    ],
    { env, detached: true, stdio: ['ignore', log, log] }
  )
  fs.closeSync(log)
  const phone = new AndroidPhone(paths, env, child, `emulator-${consolePort}`)
  signal.addEventListener('abort', () => phone.stopNow())
  try {
    await phone.connect(grpcPort, progress)
    return phone
  } catch (error) {
    phone.stopNow()
    throw error
  }
}

export class AndroidPhone implements PhoneDevice {
  readonly screen = SCREEN
  private client: EmulatorClient | null = null
  private md!: Metadata
  private heartbeat: NodeJS.Timeout | null = null
  private exited = false

  constructor(
    private paths: AndroidPaths,
    private env: NodeJS.ProcessEnv,
    private child: ChildProcess,
    private serial: string
  ) {
    child.once('exit', () => (this.exited = true))
  }

  private alive = (): boolean => !this.exited

  async connect(grpcPort: number, progress: (text: string) => void): Promise<void> {
    const token = await until(
      TOKEN_WAIT_MS,
      'to open its control port',
      () => tokenFor(readDiscovery(), grpcPort),
      this.alive
    )
    const grpc = await import('@grpc/grpc-js')
    const protoLoader = await import('@grpc/proto-loader')
    this.md = new grpc.Metadata()
    this.md.set('authorization', `Bearer ${token}`)
    const proto = path.join(this.paths.sdk, 'emulator', 'lib', 'emulator_controller.proto')
    const def = protoLoader.loadSync(proto, {
      keepCase: true,
      longs: Number,
      enums: String,
      defaults: true
    })
    const pkg = grpc.loadPackageDefinition(def) as unknown as {
      android: {
        emulation: {
          control: {
            EmulatorController: new (
              addr: string,
              creds: ChannelCredentials,
              opts: object
            ) => EmulatorClient
          }
        }
      }
    }
    this.client = new pkg.android.emulation.control.EmulatorController(
      `127.0.0.1:${grpcPort}`,
      grpc.credentials.createInsecure(),
      { 'grpc.max_receive_message_length': 64 * 1024 * 1024 }
    )
    progress('booting Android (about half a minute)')
    await until(
      BOOT_WAIT_MS,
      'to boot',
      async () =>
        (await this.adb(['shell', 'getprop', 'sys.boot_completed']).catch(() => '')).trim() === '1'
          ? true
          : null,
      this.alive
    )
    this.heartbeat = setInterval(
      () => void this.call('getStatus', {}).catch(() => {}),
      HEARTBEAT_WELL_UNDER_IDLE_TIMEOUT_MS
    )
    progress(
      "getting ready to read Android's screen (the first time it installs a small helper app)"
    )
    await this.firstSnapshot()
  }

  // PLATFORM§54
  private async firstSnapshot(): Promise<void> {
    for (let i = 1; ; i++) {
      try {
        await this.agentDevice(['snapshot', '-i'], HELPER_INSTALL_MS)
        return
      } catch (error) {
        if (i === READ_UI_TRIES_AFTER_BOOT || !this.alive()) throw error
        await sleep(POLL_MS)
      }
    }
  }

  private call(
    method: Exclude<keyof EmulatorClient, 'streamScreenshot' | 'close'>,
    req: unknown
  ): Promise<Record<string, unknown>> {
    const client = this.client
    if (!client) return Promise.reject(new ToolFailed('the Android emulator is not connected.'))
    return new Promise((resolve, reject) =>
      client[method](req, this.md, (err, res) =>
        err ? reject(new ToolFailed(err.details || err.message)) : resolve(res)
      )
    )
  }

  private get adbBin(): string {
    return path.join(this.paths.sdk, 'platform-tools', 'adb')
  }

  private async adb(args: string[], timeoutMs = QUICK_MS): Promise<string> {
    return runTool(this.adbBin, ['-s', this.serial, ...args], { timeoutMs, env: this.env })
  }

  private get agentDeviceEnv(): NodeJS.ProcessEnv {
    return {
      ...this.env,
      ELECTRON_RUN_AS_NODE: '1',
      AGENT_DEVICE_HOME: this.paths.agentDeviceHome,
      AGENT_DEVICE_STATE_DIR: this.paths.agentDeviceHome,
      AGENT_DEVICE_NO_UPDATE_NOTIFIER: '1'
    }
  }

  // PLATFORM§42
  private async agentDevice(args: string[], timeoutMs = QUICK_MS): Promise<string> {
    const out = await runTool(
      process.execPath,
      [this.paths.agentDeviceBin, ...args, '--platform', 'android', '--serial', this.serial],
      { timeoutMs, cwd: this.paths.agentDeviceHome, env: this.agentDeviceEnv }
    )
    return out.trim()
  }

  snapshot(): Promise<string> {
    return this.agentDevice(['snapshot', '-i'])
  }

  tap(target: string | Point): Promise<string> {
    return this.agentDevice(
      typeof target === 'string' ? ['press', target] : ['press', String(target.x), String(target.y)]
    )
  }

  async type(text: string): Promise<void> {
    await this.agentDevice(['type', text])
  }

  async swipe(from: Point, to: Point): Promise<void> {
    await this.agentDevice(['swipe', ...[from.x, from.y, to.x, to.y].map(String)])
  }

  async key(key: PhoneKey): Promise<void> {
    await this.call('sendKey', { eventType: 'keypress', key: KEY_NAME[key] })
  }

  async screenshot(): Promise<Buffer> {
    const res = await this.call('getScreenshot', { format: 'PNG' })
    return res.image as Buffer
  }

  async install(file: string): Promise<void> {
    await this.adb(['install', '-r', file], INSTALL_MS)
  }

  async launch(appId: string): Promise<void> {
    const out = await this.adb([
      'shell',
      'monkey',
      '-p',
      appId,
      '-c',
      'android.intent.category.LAUNCHER',
      '1'
    ])
    if (/No activities found|monkey aborted/i.test(out))
      throw new ToolFailed(`there is no app ${appId} on the phone.`)
  }

  frames(onFrame: (image: Buffer) => void): () => void {
    if (!this.client) return () => {}
    const stream = this.client.streamScreenshot({ format: 'PNG', ...LIVE_FRAME }, this.md)
    stream.on('data', (img) => onFrame(img.image))
    stream.on('error', () => {})
    return () => stream.cancel()
  }

  touch(at: Point, phase: TouchPhase): void {
    const pressure = phase === 'up' ? 0 : 1
    void this.call('sendTouch', { touches: [{ ...at, identifier: 0, pressure }] }).catch(() => {})
  }

  typeLive(text: string): void {
    void this.call('sendKey', { text }).catch(() => {})
  }

  keyLive(key: PhoneKey): void {
    void this.key(key).catch(() => {})
  }

  async stop(): Promise<void> {
    await this.agentDevice(['close']).catch(() => '')
    this.stopNow()
    const end = Date.now() + STOP_GRACE_MS
    while (!this.exited && Date.now() < end) await sleep(100)
    if (!this.exited) this.kill('SIGKILL')
  }

  stopNow(): void {
    if (this.heartbeat) clearInterval(this.heartbeat)
    this.heartbeat = null
    this.client?.close()
    this.client = null
    this.kill('SIGTERM')
    const leave = { detached: true, stdio: 'ignore' } as const
    spawn(this.adbBin, ['kill-server'], { ...leave, env: this.env }).unref()
    spawn(
      process.execPath,
      [this.paths.agentDeviceBin, 'daemon', 'stop', '--state-dir', this.paths.agentDeviceHome],
      { ...leave, cwd: this.paths.agentDeviceHome, env: this.agentDeviceEnv }
    ).unref()
  }

  private kill(signal: NodeJS.Signals): void {
    if (this.exited || !this.child.pid) return
    try {
      process.kill(-this.child.pid, signal)
    } catch {}
  }
}
