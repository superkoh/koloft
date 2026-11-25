import { parentPort, workerData } from 'worker_threads'
import { searchTranscripts, type TranscriptFile } from './transcriptSearch'

const { files, term } = workerData as { files: TranscriptFile[]; term: string }

void searchTranscripts(files, term, (id, snippet) => parentPort?.postMessage({ id, snippet }))
