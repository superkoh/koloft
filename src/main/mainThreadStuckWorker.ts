import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { workerData } from 'worker_threads'
import { watchOneBeat, type StuckWatchData } from './mainThreadStalls'

const SAMPLE_SECONDS = 1
const SAMPLE_GIVES_UP_MS = 30_000
const SAMPLES_KEPT = 10

const { beats, pid, log, samplesDir, stuckAfterMs } = workerData as StuckWatchData
const beat = new Int32Array(beats)

function say(line: string): void {
  try {
    fs.appendFileSync(log, `${new Date().toISOString()} ${line}\n`)
  } catch {
    return
  }
}

// PLATFORM§70
function sampleOfTheProcess(): string {
  const file = path.join(samplesDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.txt`)
  try {
    fs.mkdirSync(samplesDir, { recursive: true })
    const older = fs.readdirSync(samplesDir).sort()
    for (const name of older.slice(0, Math.max(0, older.length - SAMPLES_KEPT + 1)))
      fs.rmSync(path.join(samplesDir, name), { force: true })
    execFileSync('/usr/bin/sample', [String(pid), String(SAMPLE_SECONDS), '-file', file], {
      stdio: 'ignore',
      timeout: SAMPLE_GIVES_UP_MS
    })
    return `what the main thread was in while stuck: ${file}`
  } catch (error) {
    return `could not sample the stuck main thread: ${String(error).split('\n')[0]}`
  }
}

for (;;)
  watchOneBeat({
    stuckAfterMs,
    now: () => performance.now(),
    beats: () => Atomics.load(beat, 0),
    beatAfter: (seen, withinMs) => Atomics.wait(beat, 0, seen, withinMs) !== 'timed-out',
    stuck: () => {
      say(`main thread has taken no new work for ${stuckAfterMs} ms and is still stuck`)
      say(sampleOfTheProcess())
    },
    resumed: (afterMs) => say(`main thread took work again after ${Math.round(afterMs)} ms`)
  })
