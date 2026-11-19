import fs from 'fs'
import { errorText } from '@core/errorText'
import { isRemoteKey } from '@shared/remoteKey'
import type { ArtifactView } from '@shared/types'
import type { DiscordRelay } from '../../../main/discord/relay'
import { shootHtml, shootPage } from '../../../main/discord/pageShot'
import {
  sendPhoneCopy,
  sendWholeCopy,
  shownOf,
  tooLarge,
  whereTheCopyGoes,
  type FileDiff,
  type PhoneCopyDeps
} from './phoneCopy'
import type { TabChannels } from './tabChannels'

type PhoneRelay = Pick<
  DiscordRelay,
  'quietTurn' | 'reaches' | 'sendWithNextAsk' | 'sendParts' | 'cardsWaitFor'
>

interface PhoneCopierDeps {
  relay(): PhoneRelay | null
  channels: Pick<TabChannels, 'askChannelOf' | 'boundChannelOf'>
  butlerSide(tabId: string): boolean
  butlerName(): string
  machineOf(tabId: string): string | undefined
  readBytes(file: string): Promise<Buffer>
  fileDiff(file: string): Promise<FileDiff>
}

export function phoneCopier(d: PhoneCopierDeps) {
  return async (
    tabId: string,
    target: string,
    view?: ArtifactView
  ): Promise<string | undefined> => {
    const relay = d.relay()
    const channelId = d.channels.askChannelOf(tabId)
    if (!relay || !channelId || relay.quietTurn(tabId)) return undefined
    const shown = shownOf(target, d.machineOf(tabId), view)
    if (!shown) return undefined
    const copyTo = (channelId: string): PhoneCopyDeps => ({
      shoot: (url, machine) => shootPage(url, { machine }),
      shootHtml,
      size: async (file) => (isRemoteKey(file) ? undefined : (await fs.promises.stat(file)).size),
      readBytes: (file) =>
        d.readBytes(file).catch((error: unknown) => {
          throw errorText(error) === 'KOLOFT_TOO_LARGE' ? new Error(tooLarge()) : error
        }),
      fileDiff: d.fileDiff,
      send: (files, parts) => relay.sendParts(channelId, files, parts),
      cardsWaitFor: (copy) => relay.cardsWaitFor(tabId, copy)
    })
    if (!relay.reaches(tabId)) {
      relay.sendWithNextAsk(tabId, (askedIn) => sendWholeCopy(copyTo(askedIn), shown))
      return undefined
    }
    const where = whereTheCopyGoes(
      !!d.channels.boundChannelOf(tabId),
      d.butlerSide(tabId),
      d.butlerName
    )
    return sendPhoneCopy(copyTo(channelId), shown, where)
  }
}
