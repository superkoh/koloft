import type { WebContents } from 'electron'
import type { MadeLater } from '@core/moment'
import type { BuildLater, PluginStart } from '@core/pluginStart'
import { within } from '@core/within'
import {
  A_PAGE_ANSWERS_WITHIN_MS,
  compositionDone,
  findPart,
  pictureOfPart,
  tapAt,
  type PartOnPage
} from '@plugins/workbench/api'
import { pushAsks, registerChannels } from './channels'
import { registerPageCommand, type PictureFile, type TapPage, type TapRounds } from './pageVerb'
import { SecretAsks, type SecretAsk, type SecretAskDeps } from './secretAsks'
import { registerSecretCommand } from './secretVerb'
import { forgetSecretAsksOfEndedTabs } from './sessionHooks'
import {
  SUDO_FILES_WHERE_ANY_TERMINAL_IS_THE_OWNERS,
  SUDO_SHIM_FILES,
  writeSudoShims
} from './sudoShim'
import { gridPictureHtml } from './tapGrid'

type OwnerAsk = SecretAsk & { taps?: TapRounds }

export interface PasswordsStartDeps {
  secretCommand: Parameters<typeof registerSecretCommand>[1]
  pageCommand: Omit<Parameters<typeof registerPageCommand>[1], 'pages' | 'draw'> & {
    webPagesOf(tabId: string): WebContents[]
    shoot(page: ReturnType<typeof gridPictureHtml>): Promise<PictureFile>
  }
}

function tapPagesOf(pages: WebContents[]): TapPage[] {
  return pages.map((wc) => ({
    guestId: wc.id,
    url: () => wc.getURL(),
    find: (selector, scroll) =>
      within(
        wc.executeJavaScript(findPart(selector, scroll)) as Promise<PartOnPage>,
        A_PAGE_ANSWERS_WITHIN_MS,
        'the page did not answer'
      ),
    picture: (box, ratio) => pictureOfPart(wc, box, ratio),
    // PLATFORM§10
    tap: async (point) => {
      await compositionDone()
      await tapAt(wc, point)
    }
  }))
}

export const start: PluginStart<
  PasswordsStartDeps,
  {
    buildAsks: BuildLater<Pick<SecretAskDeps, 'owner'>, SecretAsks<OwnerAsk>>
    writeSudoShims: typeof writeSudoShims
    SUDO_SHIM_FILES: typeof SUDO_SHIM_FILES
    SUDO_FILES_WHERE_ANY_TERMINAL_IS_THE_OWNERS: typeof SUDO_FILES_WHERE_ANY_TERMINAL_IS_THE_OWNERS
  }
> = ({ commands, moments, ipc }, d) => {
  let asks: SecretAsks<OwnerAsk> | null = null
  const built: MadeLater<SecretAsks<OwnerAsk>> = () => asks
  const { webPagesOf, shoot, ...pageCommand } = d.pageCommand
  registerSecretCommand(commands, d.secretCommand)
  registerPageCommand(commands, {
    ...pageCommand,
    pages: (tabId) => tapPagesOf(webPagesOf(tabId)),
    draw: async (png, grid) => shoot(gridPictureHtml(png, grid))
  })
  forgetSecretAsksOfEndedTabs(moments, built)
  registerChannels(ipc, built)
  return {
    buildAsks: ({ owner }) => (asks = new SecretAsks<OwnerAsk>({ show: pushAsks(ipc), owner })),
    writeSudoShims,
    SUDO_SHIM_FILES,
    SUDO_FILES_WHERE_ANY_TERMINAL_IS_THE_OWNERS
  }
}
