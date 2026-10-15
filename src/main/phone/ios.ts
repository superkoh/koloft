import { spawn } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  runTool,
  ToolFailed,
  type PhoneDevice,
  type PhoneKey,
  type Point,
  type Screen,
  type TouchPhase
} from './device'
import { MjpegFrames } from './mjpeg'
import {
  axElements,
  axScreenSize,
  elementAt,
  elementLines,
  type AxNode,
  type ScreenElement
} from './screenElements'

const XCODE_MISSING =
  'iOS needs Xcode. Install Xcode from the App Store, open it once so it finishes setting up, and make sure it has an iOS simulator (Xcode ▸ Settings ▸ Components).'
const AXE_MISSING =
  'iOS needs AXe, a free command-line tool that taps and types on the simulator. Install it with: brew install cameroncooke/axe/axe'
const NO_IPHONE =
  'Xcode has no iPhone simulator. Add one in Xcode ▸ Settings ▸ Components, then try again.'

const QUICK_MS = 15_000
const READ_UI_MS = 9_000
// PLATFORM§55
const FIRST_BOOT_MS = 5 * 60_000
const READ_UI_AFTER_BOOT_MS = 3 * 60_000
const READ_UI_RETRY_PAUSE_MS = 1_000
const LIVE_TAP_MAX_MOVE_PT = 10
const LIVE_TYPE_BATCH_MS = 120
const STREAM_FPS = '30'
const STREAM_SCALE = '0.5'
const HID_KEY: Record<'enter' | 'delete', string> = { enter: '40', delete: '42' }

interface SimDevice {
  udid: string
  name: string
  state: string
  isAvailable?: boolean
}

export function pickSimulator(
  devices: Record<string, SimDevice[]>
): { udid: string; name: string; booted: boolean } | null {
  const runtimes = Object.keys(devices)
    .filter((r) => /SimRuntime\.iOS-/.test(r))
    .sort((a, b) => iosVersion(b) - iosVersion(a))
  const all = runtimes.flatMap((r) => devices[r].filter((d) => d.isAvailable !== false))
  const iphones = all.filter((d) => d.name.startsWith('iPhone'))
  const pick = iphones.find((d) => d.state === 'Booted') ?? iphones[0]
  return pick ? { udid: pick.udid, name: pick.name, booted: pick.state === 'Booted' } : null
}

function iosVersion(runtime: string): number {
  const [major = 0, minor = 0] = (/iOS-(\d+)-(\d+)/.exec(runtime) ?? []).slice(1).map(Number)
  return major * 100 + minor
}

async function xcrun(args: string[], timeoutMs = QUICK_MS): Promise<string> {
  return runTool('xcrun', args, { timeoutMs })
}

export async function iosToolsMissing(): Promise<string | null> {
  try {
    await xcrun(['simctl', 'help'])
  } catch {
    return XCODE_MISSING
  }
  try {
    await runTool('axe', ['--version'], { timeoutMs: QUICK_MS })
  } catch {
    return AXE_MISSING
  }
  return null
}

export async function startIos(progress: (text: string) => void): Promise<IosPhone> {
  const listed = JSON.parse(await xcrun(['simctl', 'list', 'devices', 'available', '-j'])) as {
    devices: Record<string, SimDevice[]>
  }
  const sim = pickSimulator(listed.devices)
  if (!sim) throw new ToolFailed(NO_IPHONE)
  progress(`booting ${sim.name} (the first boot of a new simulator takes a few minutes)`)
  if (!sim.booted) await xcrun(['simctl', 'bootstatus', sim.udid, '-b'], FIRST_BOOT_MS)
  progress(`reading ${sim.name}'s screen`)
  const phone = new IosPhone(sim.udid, !sim.booted)
  try {
    await phone.readScreenOnceBooted()
  } catch (error) {
    phone.stopNow()
    throw error
  }
  return phone
}

export class IosPhone implements PhoneDevice {
  screen: Screen = { width: 0, height: 0 }
  private elements: ScreenElement[] = []
  private queue: Promise<unknown> = Promise.resolve()
  private down: { at: Point; t: number } | null = null
  private last: Point | null = null
  private typed = ''
  private typeTimer: NodeJS.Timeout | null = null

  constructor(
    private udid: string,
    private bootedByUs: boolean
  ) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  private axe(args: string[], timeoutMs = QUICK_MS): Promise<string> {
    return this.serial(() => runTool('axe', [...args, '--udid', this.udid], { timeoutMs }))
  }

  private async readUi(): Promise<AxNode[]> {
    return JSON.parse(await this.axe(['describe-ui'], READ_UI_MS)) as AxNode[]
  }

  // PLATFORM§55
  async readScreenOnceBooted(): Promise<void> {
    let lastError: unknown
    const end = Date.now() + READ_UI_AFTER_BOOT_MS
    while (Date.now() < end) {
      try {
        const size = axScreenSize(await this.readUi())
        if (size) {
          this.screen = size
          return
        }
      } catch (error) {
        lastError = error
      }
      await new Promise((r) => setTimeout(r, READ_UI_RETRY_PAUSE_MS))
    }
    throw lastError instanceof Error ? lastError : new ToolFailed('could not read the screen.')
  }

  async snapshot(): Promise<string> {
    const roots = await this.readUi()
    this.screen = axScreenSize(roots) ?? this.screen
    this.elements = axElements(roots)
    return elementLines(this.elements)
  }

  async tap(target: string | Point): Promise<string> {
    const at = typeof target === 'string' ? elementAt(this.elements, target) : target
    if (!at) throw new ToolFailed(`there is no ${target} in the last snapshot.`)
    await this.axe(['tap', '-x', String(at.x), '-y', String(at.y)])
    return `Tapped at ${at.x} ${at.y}.`
  }

  async type(text: string): Promise<void> {
    await this.axe(['type', text])
  }

  async swipe(from: Point, to: Point): Promise<void> {
    await this.axe([
      'swipe',
      '--start-x',
      String(from.x),
      '--start-y',
      String(from.y),
      '--end-x',
      String(to.x),
      '--end-y',
      String(to.y)
    ])
  }

  async key(key: PhoneKey): Promise<void> {
    if (key === 'home') await this.axe(['button', 'home'])
    else if (key === 'back')
      throw new ToolFailed("an iPhone has no Back button: tap the app's own back control.")
    else await this.axe(['key', HID_KEY[key]])
  }

  async screenshot(): Promise<Buffer> {
    const file = path.join(os.tmpdir(), `koloft-phone-${process.pid}-${Date.now()}.png`)
    try {
      await xcrun(['simctl', 'io', this.udid, 'screenshot', file])
      return fs.readFileSync(file)
    } finally {
      fs.rmSync(file, { force: true })
    }
  }

  async install(file: string): Promise<void> {
    await xcrun(['simctl', 'install', this.udid, file], FIRST_BOOT_MS)
  }

  async launch(appId: string): Promise<void> {
    await xcrun(['simctl', 'launch', this.udid, appId])
  }

  frames(onFrame: (image: Buffer) => void): () => void {
    const child = spawn(
      'axe',
      [
        'stream-video',
        '--udid',
        this.udid,
        '--format',
        'mjpeg',
        '--fps',
        STREAM_FPS,
        '--scale',
        STREAM_SCALE
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] }
    )
    const splitter = new MjpegFrames()
    child.stdout.on('data', (chunk: Buffer) => {
      for (const frame of splitter.push(chunk)) onFrame(frame)
    })
    child.on('error', () => {})
    return () => child.kill()
  }

  touch(at: Point, phase: TouchPhase): void {
    if (phase === 'down') {
      this.down = { at, t: Date.now() }
      this.last = at
      return
    }
    if (phase === 'move') {
      this.last = at
      return
    }
    const start = this.down
    this.down = null
    if (!start) return
    const moved = Math.hypot(at.x - start.at.x, at.y - start.at.y)
    const done =
      moved < LIVE_TAP_MAX_MOVE_PT ? this.tap(start.at) : this.swipe(start.at, this.last ?? at)
    void done.catch(() => {})
  }

  typeLive(text: string): void {
    this.typed += text
    if (!this.typeTimer) this.typeTimer = setTimeout(() => this.sendTyped(), LIVE_TYPE_BATCH_MS)
  }

  private sendTyped(): void {
    if (this.typeTimer) clearTimeout(this.typeTimer)
    this.typeTimer = null
    const batch = this.typed
    this.typed = ''
    if (batch) void this.type(batch).catch(() => {})
  }

  keyLive(key: PhoneKey): void {
    this.sendTyped()
    void this.key(key).catch(() => {})
  }

  async stop(): Promise<void> {
    if (this.bootedByUs) await xcrun(['simctl', 'shutdown', this.udid]).catch(() => '')
  }

  stopNow(): void {
    if (!this.bootedByUs) return
    spawn('xcrun', ['simctl', 'shutdown', this.udid], { detached: true, stdio: 'ignore' }).unref()
  }
}
