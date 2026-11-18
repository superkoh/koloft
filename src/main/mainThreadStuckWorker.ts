import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { parentPort, workerData } from 'worker_threads'
import { watchOneBeat, type StuckWatchData } from './mainThreadStalls'

const SAMPLE_SECONDS = 1
const SAMPLE_GIVES_UP_MS = 30_000
const SAMPLES_KEPT = 10
const SAMPLE_SUFFIX = '.txt'

const { beats, pid, samplesDir, stuckAfterMs } = workerData as StuckWatchData
const beat = new Int32Array(beats)

// PLATFORM§70
function sampleOfTheProcess(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const file = path.join(samplesDir, stamp + SAMPLE_SUFFIX)
  try {
    fs.mkdirSync(samplesDir, { recursive: true })
    try {
      execFileSync('/usr/bin/sample', [String(pid), String(SAMPLE_SECONDS), '-file', file], {
        stdio: 'ignore',
        timeout: SAMPLE_GIVES_UP_MS
      })
    } catch (error) {
      fs.writeFileSync(file, `could not sample the stuck main thread: ${error}\n`)
    }
    const samples = fs.readdirSync(samplesDir).filter((name) => name.endsWith(SAMPLE_SUFFIX))
    for (const old of samples.sort().slice(0, -SAMPLES_KEPT))
      fs.rmSync(path.join(samplesDir, old), { force: true })
    return file
  } catch (error) {
    return `nothing, as ${samplesDir} could not be written (${error})`
  }
}

for (;;)
  watchOneBeat({
    stuckAfterMs,
    now: () => Date.now(),
    beats: () => Atomics.load(beat, 0),
    beatAfter: (seen, withinMs) => Atomics.wait(beat, 0, seen, withinMs) !== 'timed-out',
    leaveWhatItIsIn: sampleOfTheProcess,
    resumed: (afterMs, whatItWasIn) =>
      parentPort?.postMessage(
        `main thread took no new work for ${afterMs} ms; what it was in ${stuckAfterMs} ms into that: ${whatItWasIn}`
      )
  })
