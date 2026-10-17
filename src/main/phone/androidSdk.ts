import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { Readable } from 'stream'
import { runTool, ToolFailed } from './device'

export interface SdkPackage {
  name: string
  url: string
  size: number
  sha1: string
  into: string
}

const REPO = 'https://dl.google.com/android/repository/'
const SYSTEM_IMAGE_DIR = 'system-images/android-36/google_apis/arm64-v8a'

// PLATFORM§58
export const ANDROID_PACKAGES: SdkPackage[] = [
  {
    name: 'platform-tools',
    url: `${REPO}platform-tools_r37.0.1-darwin.zip`,
    size: 16_110_554,
    sha1: '6ae73f4de6452dc57e62ec02b68eed92a4c21661',
    into: '.'
  },
  {
    name: 'emulator',
    url: `${REPO}emulator-darwin_aarch64-16428233.zip`,
    size: 416_112_708,
    sha1: '3af4fe44ce82b3d88ae5678a53735f27ad729c15',
    into: '.'
  },
  {
    name: 'system-image',
    url: `${REPO}sys-img/google_apis/arm64-v8a-36_r07.zip`,
    size: 1_872_691_175,
    sha1: '5a99183b6d924da606260e45fd41a3eb8eca6eb7',
    into: path.dirname(SYSTEM_IMAGE_DIR)
  }
]

const TOTAL_BYTES = ANDROID_PACKAGES.reduce((n, p) => n + p.size, 0)
const UNZIP_MS = 15 * 60_000
const GB = 1024 ** 3

function readyMark(sdk: string, p: SdkPackage): string {
  return path.join(sdk, `.koloft-${p.name}-ready`)
}

export function sdkMissing(sdk: string): SdkPackage[] {
  return ANDROID_PACKAGES.filter((p) => !fs.existsSync(readyMark(sdk, p)))
}

function downloadText(done: number): string {
  const pct = Math.floor((done / TOTAL_BYTES) * 100)
  return `downloading Google's Android emulator, ${pct}% of ${(TOTAL_BYTES / GB).toFixed(1)} GB (only the first time)`
}

async function download(
  p: SdkPackage,
  file: string,
  onBytes: (n: number) => void,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch(p.url, { signal })
  if (!res.ok || !res.body)
    throw new ToolFailed(`could not download ${p.url} (HTTP ${res.status}).`)
  const hash = crypto.createHash('sha1')
  const out = fs.createWriteStream(file)
  let got = 0
  try {
    for await (const chunk of Readable.fromWeb(res.body as never) as AsyncIterable<Buffer>) {
      hash.update(chunk)
      got += chunk.length
      onBytes(chunk.length)
      if (!out.write(chunk)) await new Promise<void>((r) => out.once('drain', () => r()))
    }
  } finally {
    await new Promise<void>((r) => out.end(() => r()))
  }
  if (got !== p.size || hash.digest('hex') !== p.sha1)
    throw new ToolFailed(`the download of ${p.url} came out damaged; try again.`)
}

export async function ensureAndroidSdk(
  sdk: string,
  progress: (text: string) => void,
  signal: AbortSignal
): Promise<void> {
  const missing = sdkMissing(sdk)
  let done = TOTAL_BYTES - missing.reduce((n, p) => n + p.size, 0)
  const downloads = path.join(sdk, '.downloads')
  fs.mkdirSync(downloads, { recursive: true })
  for (const p of missing) {
    const zip = path.join(downloads, `${p.name}.zip`)
    progress(downloadText(done))
    await download(
      p,
      zip,
      (n) => {
        done += n
        progress(downloadText(done))
      },
      signal
    )
    progress(`unpacking ${p.name}`)
    const into = path.join(sdk, p.into)
    fs.mkdirSync(into, { recursive: true })
    await runTool('/usr/bin/ditto', ['-x', '-k', zip, into], { timeoutMs: UNZIP_MS })
    fs.rmSync(zip, { force: true })
    fs.writeFileSync(readyMark(sdk, p), '')
  }
  fs.rmSync(downloads, { recursive: true, force: true })
}

export const AVD_NAME = 'koloft'
export const SCREEN = { width: 1080, height: 2400 }

// PLATFORM§58
function avdConfig(): string {
  return [
    'PlayStore.enabled=false',
    'abi.type=arm64-v8a',
    'avd.ini.encoding=UTF-8',
    'disk.dataPartition.size=6G',
    'hw.cpu.arch=arm64',
    'hw.cpu.ncore=4',
    'hw.ramSize=2048',
    `hw.lcd.width=${SCREEN.width}`,
    `hw.lcd.height=${SCREEN.height}`,
    'hw.lcd.density=420',
    'hw.keyboard=yes',
    'hw.gpu.enabled=yes',
    'hw.gpu.mode=auto',
    `image.sysdir.1=${SYSTEM_IMAGE_DIR}/`,
    'tag.id=google_apis',
    'tag.display=Google APIs',
    'target=android-36',
    ''
  ].join('\n')
}

export function writeAvd(avdHome: string): void {
  const avd = path.join(avdHome, `${AVD_NAME}.avd`)
  fs.mkdirSync(avd, { recursive: true })
  fs.writeFileSync(
    path.join(avdHome, `${AVD_NAME}.ini`),
    `avd.ini.encoding=UTF-8\npath=${avd}\npath.rel=avd/${AVD_NAME}.avd\ntarget=android-36\n`
  )
  const config = path.join(avd, 'config.ini')
  if (!fs.existsSync(config)) fs.writeFileSync(config, avdConfig())
}
