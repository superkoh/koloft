import { parentPort, workerData } from 'worker_threads'
import { firstPriceOf } from '@shared/pricing'
import type { ScannedFile, UsageFile } from '@core/agent/usage'
import { USAGE_WORKER_SCANS } from '@agents/usageWorkerScans'

const priceOf = firstPriceOf(USAGE_WORKER_SCANS.map((agent) => agent.priceOf))

async function scanAll(files: UsageFile[]): Promise<void> {
  for (const f of files) {
    let scanned: Omit<ScannedFile, 'file'>
    try {
      scanned = await USAGE_WORKER_SCANS.find((agent) => agent.id === f.backend)!.scan(f, priceOf)
    } catch (error) {
      console.error('[koloft] usage read failed, retried next read:', f.file, error)
      continue
    }
    parentPort?.postMessage({ file: f.file, ...scanned })
  }
}

void scanAll((workerData as { files: UsageFile[] }).files)
