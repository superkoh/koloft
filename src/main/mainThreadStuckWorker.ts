import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import { parentPort, workerData } from 'worker_threads'
import type { AskedForABeatAt, StuckWatchData, WhatTheMainThreadWasIn } from './mainThreadStalls'

const ASKS_PER_STUCK_LIMIT = 5
const SAMPLE_SECONDS = 1
const SAMPLE_GIVES_UP_MS = 10_000
const STUCK_LIMITS_UNTIL_THE_NEXT_ASK_AFTER_A_SAMPLE = 12
const SAMPLES_KEPT = 10
const SAMPLE_SUFFIX = '.txt'

const { beats, pid, samplesDir, stuckAfterMs } = workerData as StuckWatchData
const beat = new Int32Array(beats)
const nothingEverWakesThis = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT))

function tellMain(said: AskedForABeatAt | WhatTheMainThreadWasIn): void {
  parentPort?.postMessage(said)
}

// PLATFORM§70
function sampleOfTheProcess(): WhatTheMainThreadWasIn {
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

// PLATFORM§70
for (;;) {
  const seen = Atomics.load(beat, 0)
  tellMain(Date.now())
  const stuck = Atomics.wait(beat, 0, seen, stuckAfterMs) === 'timed-out'
  if (stuck) {
    const whatItWasIn = sampleOfTheProcess()
    Atomics.wait(beat, 0, seen)
    tellMain(whatItWasIn)
  }
  const untilTheNextAskMs = stuck
    ? stuckAfterMs * STUCK_LIMITS_UNTIL_THE_NEXT_ASK_AFTER_A_SAMPLE
    : stuckAfterMs / ASKS_PER_STUCK_LIMIT
  Atomics.wait(nothingEverWakesThis, 0, 0, untilTheNextAskMs)
}
