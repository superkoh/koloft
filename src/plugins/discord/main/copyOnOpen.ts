import { errorText } from '@core/errorText'
import type { FileOpened, SaysInReply } from '@core/moment'

export const copyEachOpenedFile =
  (copyToPhone: (opened: FileOpened) => Promise<string | undefined>): SaysInReply<FileOpened> =>
  (opened) =>
    copyToPhone(opened).catch(
      (error: unknown) => `Koloft could not also send it to Discord: ${errorText(error)}`
    )
