import type { FileOpened, SaysInReply } from '@core/moment'

export const copyEachOpenedFile =
  (copyToPhone: SaysInReply<FileOpened>): SaysInReply<FileOpened> =>
  (opened) =>
    copyToPhone(opened).catch(
      (error: unknown) =>
        `Koloft could not also send it to Discord: ${error instanceof Error ? error.message : String(error)}`
    )
