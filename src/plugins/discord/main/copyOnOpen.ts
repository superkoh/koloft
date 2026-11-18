import { errorText } from '@core/errorText'
import type { FileOpened, Moment } from '@core/moment'

export function copyEachOpenedFile(
  fileOpened: Moment<FileOpened>,
  copyToPhone: (opened: FileOpened) => Promise<string | undefined>
): void {
  fileOpened.listen((opened) =>
    copyToPhone(opened).catch(
      (error: unknown) => `Koloft could not also send it to Discord: ${errorText(error)}`
    )
  )
}
