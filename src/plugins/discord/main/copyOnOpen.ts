import { errorText } from '@core/errorText'
import { FILE_OPENED, type FileOpened, type Moments } from '@core/moment'
import { plugin } from '../plugin'

export function copyEachOpenedFile(
  moments: Moments,
  copyToPhone: (opened: FileOpened) => Promise<string | undefined>
): void {
  moments.listen(plugin.id, FILE_OPENED, (opened) =>
    copyToPhone(opened).catch(
      (error: unknown) => `Koloft could not also send it to Discord: ${errorText(error)}`
    )
  )
}
