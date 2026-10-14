import fs from 'fs'
import path from 'path'
import {
  answered,
  errorText,
  EXIT_USAGE,
  refused,
  type AgentCaller,
  type AgentReply,
  type AgentVerb
} from '../agentRequests'
import { startAndroid } from './android'
import { sdkMissing } from './androidSdk'
import { PHONE_KEYS, type PhoneDevice, type PhoneKey, type PhoneKind, type Point } from './device'
import { iosToolsMissing, startIos } from './ios'
import { PhoneScreen } from './screenServer'

export interface PhoneDeps {
  dir(): string
  agentDeviceBin(): string
  ready(): Promise<void>
  open(tabId: string, url: string): void
  machineOf(tabId: string): string | undefined
  writeOnMachine(machine: string, file: string, bytes: Buffer): Promise<void>
  sessionName(tabId: string): string | undefined
}

type Phase =
  | { at: 'starting'; note: string }
  | { at: 'ready'; device: PhoneDevice }
  | { at: 'failed'; error: string }

interface Phone {
  kind: PhoneKind
  tabId: string
  screen: PhoneScreen
  phase: Phase
  abort: AbortController
  lastLong?: string
}

const NAME: Record<PhoneKind, string> = { android: 'Android phone', ios: 'iPhone' }
const KINDS: PhoneKind[] = ['android', 'ios']
const REPLY_BEFORE_THE_SHIM_GIVES_UP_MS = 8_000
const READY_NOTE = 'Click to tap, drag to swipe, and type on your keyboard.'

export const PHONE_USAGE = `koloft phone: one of
  start android|ios, status, stop,
  snapshot, tap <@ref | x y>, type <text>, swipe <x1> <y1> <x2> <y2>,
  key home|back|enter|delete, screenshot <file>, install <app file>, open <app id>.
Run "koloft help" for what each one does.`

const NO_PHONE =
  'koloft: no phone is running. Start one with "koloft phone start android" or "koloft phone start ios".'

function usage(): AgentReply {
  return refused(PHONE_USAGE, EXIT_USAGE)
}

function number(s: string | undefined): number | null {
  return s !== undefined && /^\d+$/.test(s) ? Number(s) : null
}

function points(args: string[]): Point[] | null {
  const n = args.map(number)
  if (n.some((v) => v === null) || n.length % 2) return null
  const out: Point[] = []
  for (let i = 0; i < n.length; i += 2) out.push({ x: n[i]!, y: n[i + 1]! })
  return out
}

export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.toString('latin1', 12, 16) !== 'IHDR') return null
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

export class Phones {
  private phone: Phone | null = null

  constructor(private deps: PhoneDeps) {}

  readonly verb: AgentVerb = (args, caller) => this.run(args, caller)

  private async run(args: string[], caller: AgentCaller): Promise<AgentReply> {
    const [sub, ...rest] = args
    if (sub === 'start') {
      const kind = rest[0] as PhoneKind
      return rest.length === 1 && KINDS.includes(kind) ? this.start(kind, caller) : usage()
    }
    if (sub === 'status') return rest.length ? usage() : answered(this.status(caller.tabId))
    if (sub === 'stop') return rest.length ? usage() : this.stopFor(caller.tabId)
    const verb = sub ? this.deviceVerbs[sub] : undefined
    if (!verb) return usage()
    const phone = this.phone
    const why = this.whyNot(phone, caller.tabId)
    if (why || !phone || phone.phase.at !== 'ready') return refused(why ?? NO_PHONE)
    return verb(phone.phase.device, rest, caller, phone)
  }

  private whyNot(phone: Phone | null, tabId: string): string | null {
    if (!phone) return NO_PHONE
    if (phone.tabId !== tabId) return `koloft: ${this.elsewhere(phone)}`
    if (phone.phase.at === 'starting')
      return `koloft: the ${NAME[phone.kind]} is still starting (${phone.phase.note}). Run "koloft phone status" until it says ready.`
    if (phone.phase.at === 'failed')
      return `koloft: the ${NAME[phone.kind]} did not start: ${phone.phase.error} Run "koloft phone start ${phone.kind}" to try again.`
    return null
  }

  private elsewhere(phone: Phone): string {
    const name = this.deps.sessionName(phone.tabId)
    return `another session${name ? ` ("${name}")` : ''} has the ${NAME[phone.kind]}, and only one phone runs at a time. It can stop it with "koloft phone stop", or the owner can close that session's tab.`
  }

  private status(tabId: string): string {
    const phone = this.phone
    if (!phone) return 'No phone is running.'
    if (phone.tabId !== tabId) return `No phone here: ${this.elsewhere(phone)}`
    const name = NAME[phone.kind]
    const last = phone.lastLong ? `\nLast long command: ${phone.lastLong}` : ''
    if (phone.phase.at === 'starting') return `The ${name} is starting: ${phone.phase.note}.`
    if (phone.phase.at === 'failed') return `The ${name} did not start: ${phone.phase.error}`
    const { width, height } = phone.phase.device.screen
    return `The ${name} is ready. Its screen is ${width}×${height}: tap and swipe take x and y in that size, from the top left. Its live screen is in this session's Workbench.${last}`
  }

  private async start(kind: PhoneKind, caller: AgentCaller): Promise<AgentReply> {
    const had = this.phone
    if (had && had.tabId !== caller.tabId) return refused(`koloft: ${this.elsewhere(had)}`)
    if (had && had.kind !== kind)
      return refused(
        `koloft: the ${NAME[had.kind]} is running; run "koloft phone stop" first, since only one phone runs at a time.`
      )
    if (had && had.phase.at !== 'failed') {
      this.deps.open(caller.tabId, had.screen.url)
      return answered(`${this.status(caller.tabId)}\nOpened its screen in the Workbench again.`)
    }
    if (had) await this.stop(had)
    await this.deps.ready()
    if (kind === 'ios') {
      const missing = await iosToolsMissing()
      if (missing) return refused(`koloft: ${missing}`)
    }
    const screen = await PhoneScreen.open(kind)
    if (this.phone) {
      screen.close()
      return refused(`koloft: ${this.elsewhere(this.phone)}`)
    }
    const phone: Phone = {
      kind,
      tabId: caller.tabId,
      screen,
      phase: { at: 'starting', note: 'starting' },
      abort: new AbortController()
    }
    this.phone = phone
    this.boot(phone)
    this.deps.open(caller.tabId, screen.url)
    const firstAndroid = kind === 'android' && sdkMissing(this.androidPaths().sdk).length > 0
    return answered(
      `Starting the ${NAME[kind]}; its live screen opens in this session's Workbench. It takes ${kind === 'android' ? 'about half a minute' : 'up to a few minutes the first time'}${firstAndroid ? ", plus a one-time 2.3 GB download of Google's Android emulator (Android SDK License: https://developer.android.com/studio/terms)" : ''}. Run "koloft phone status" until it says ready.`
    )
  }

  private androidPaths() {
    const dir = this.deps.dir()
    return {
      sdk: path.join(dir, 'android-sdk'),
      avdHome: path.join(dir, 'android-avd'),
      emulatorHome: path.join(dir, 'android-home'),
      agentDeviceHome: path.join(dir, 'agent-device'),
      agentDeviceBin: this.deps.agentDeviceBin(),
      log: path.join(dir, 'android-emulator.log')
    }
  }

  private boot(phone: Phone): void {
    const progress = (note: string): void => {
      if (this.phone !== phone || phone.phase.at !== 'starting') return
      phone.phase = { at: 'starting', note }
      phone.screen.setNote(`${note[0].toUpperCase()}${note.slice(1)}…`)
    }
    let started: Promise<PhoneDevice>
    if (phone.kind === 'ios') started = startIos(progress)
    else {
      const paths = this.androidPaths()
      fs.mkdirSync(paths.agentDeviceHome, { recursive: true })
      started = startAndroid(paths, progress, phone.abort.signal)
    }
    started.then(
      (device) => {
        if (this.phone !== phone) return device.stopNow()
        phone.phase = { at: 'ready', device }
        phone.screen.setNote(READY_NOTE)
        phone.screen.attach(device)
      },
      (error: unknown) => {
        if (this.phone !== phone) return
        const text = errorText(error)
        phone.phase = { at: 'failed', error: /[.!?]$/.test(text) ? text : `${text}.` }
        phone.screen.setNote(`Did not start: ${text}`)
      }
    )
  }

  private async stopFor(tabId: string): Promise<AgentReply> {
    const phone = this.phone
    if (!phone) return answered('No phone is running.')
    if (phone.tabId !== tabId) return refused(`koloft: ${this.elsewhere(phone)}`)
    await this.stop(phone)
    return answered(`Stopped the ${NAME[phone.kind]}.`)
  }

  private async stop(phone: Phone): Promise<void> {
    if (this.phone === phone) this.phone = null
    phone.abort.abort()
    phone.screen.close()
    if (phone.phase.at === 'ready') await phone.phase.device.stop()
  }

  tabClosed(tabId: string): void {
    if (this.phone?.tabId === tabId) void this.stop(this.phone)
  }

  quit(): void {
    const phone = this.phone
    if (!phone) return
    this.phone = null
    phone.abort.abort()
    phone.screen.close()
    if (phone.phase.at === 'ready') phone.phase.device.stopNow()
  }

  private async slow(phone: Phone, what: string, work: Promise<string>): Promise<AgentReply> {
    const settled = work.then(
      (text) => answered(text),
      (error: unknown) => refused(`koloft: ${what} failed: ${errorText(error)}`)
    )
    const timer = new Promise<null>((r) =>
      setTimeout(() => r(null), REPLY_BEFORE_THE_SHIM_GIVES_UP_MS)
    )
    const first = await Promise.race([settled, timer])
    if (first) return first
    phone.lastLong = `${what} is still running.`
    void settled.then((reply) => {
      phone.lastLong = reply.exit === 0 ? `${what}: done. ${reply.text}` : reply.text
    })
    return answered(
      `${what} is still running. Run "koloft phone status" in a moment to see how it ended.`
    )
  }

  private filePath(caller: AgentCaller, file: string): string {
    const resolve = this.deps.machineOf(caller.tabId) ? path.posix.resolve : path.resolve
    return resolve(caller.cwd, file)
  }

  private readonly deviceVerbs: Record<
    string,
    (device: PhoneDevice, args: string[], caller: AgentCaller, phone: Phone) => Promise<AgentReply>
  > = {
    snapshot: async (device, args, _caller, phone) =>
      args.length ? usage() : this.slow(phone, 'snapshot', device.snapshot()),
    tap: async (device, args, _caller, phone) => {
      if (args.length === 1 && /^@e\d+$/.test(args[0]))
        return this.slow(phone, `tap ${args[0]}`, device.tap(args[0]))
      const at = points(args)
      if (!at || at.length !== 1) return usage()
      return this.slow(phone, `tap ${args.join(' ')}`, device.tap(at[0]))
    },
    type: async (device, args, _caller, phone) => {
      const text = args.join(' ')
      if (!text) return usage()
      return this.slow(
        phone,
        'type',
        device.type(text).then(() => `Typed ${text.length} characters.`)
      )
    },
    swipe: async (device, args, _caller, phone) => {
      const at = points(args)
      if (!at || at.length !== 2) return usage()
      return this.slow(
        phone,
        'swipe',
        device.swipe(at[0], at[1]).then(() => 'Swiped.')
      )
    },
    key: async (device, args, _caller, phone) => {
      const key = args[0] as PhoneKey
      if (args.length !== 1 || !PHONE_KEYS.includes(key)) return usage()
      return this.slow(
        phone,
        `key ${key}`,
        device.key(key).then(() => `Pressed ${key}.`)
      )
    },
    screenshot: async (device, args, caller, phone) => {
      if (args.length !== 1) return usage()
      const file = this.filePath(caller, args[0])
      const machine = this.deps.machineOf(caller.tabId)
      return this.slow(
        phone,
        'screenshot',
        device.screenshot().then(async (png) => {
          if (machine) await this.deps.writeOnMachine(machine, file, png)
          else {
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.writeFileSync(file, png)
          }
          const size = pngSize(png)
          const { width, height } = device.screen
          return `Saved the screenshot to ${file}${size ? ` (${size.width}×${size.height} pixels)` : ''}. Tap and swipe take x and y in ${width}×${height}.`
        })
      )
    },
    install: async (device, args, caller, phone) => {
      if (args.length !== 1) return usage()
      if (this.deps.machineOf(caller.tabId))
        return refused(
          'koloft: install takes an app file on the Mac the phone runs on, and this session runs on another machine.'
        )
      const file = this.filePath(caller, args[0])
      if (!fs.existsSync(file)) return refused(`koloft: there is no file at ${file}.`)
      return this.slow(
        phone,
        `install ${args[0]}`,
        device.install(file).then(() => `Installed ${file}.`)
      )
    },
    open: async (device, args, _caller, phone) => {
      if (args.length !== 1) return usage()
      return this.slow(
        phone,
        `open ${args[0]}`,
        device.launch(args[0]).then(() => `Opened ${args[0]}.`)
      )
    }
  }
}
