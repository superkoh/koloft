import { errorText } from '@core/errorText'
import { INSTRUCTIONS_CHANGED, type Moments } from '@core/moment'
import { plugin } from '../plugin'

export const SEE_OR_UNDO_IT_IN_KOLOFT = 'You can see the change, or undo it, in Koloft.'

export function tellThePhoneOfInstructionChanges(
  moments: Moments,
  sendToTheOwner: (text: string) => Promise<boolean>
): void {
  moments.listen(plugin.id, INSTRUCTIONS_CHANGED, (notice) =>
    sendToTheOwner(`${notice} ${SEE_OR_UNDO_IT_IN_KOLOFT}`).then(
      () => undefined,
      (error: unknown) => `Koloft could not also tell the owner on Discord: ${errorText(error)}`
    )
  )
}
