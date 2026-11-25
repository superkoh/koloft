// ADR-0054
import { usageWorkerScan as claude } from './claude/main/usageWorkerScan'
import { usageWorkerScan as codex } from './codex/main/usageWorkerScan'
import { usageWorkerScan as agy } from './agy/main/usageWorkerScan'

export const USAGE_WORKER_SCANS = [claude, codex, agy]
