import fs from 'fs'
import type { ElectronApplication, Page } from '@playwright/test'
import { CH } from '../../../src/shared/ipcChannels'

const TYPING_EVENTS = [
  'keydown',
  'keyup',
  'compositionstart',
  'compositionupdate',
  'compositionend',
  'input'
]

interface Recorded {
  at: number
  [field: string]: unknown
}

type RecordingWindow = {
  __typingRecord: Recorded[]
  __koloftTerms: Record<
    string,
    {
      textarea?: HTMLTextAreaElement
      onData(listener: (data: string) => void): void
      _core?: { _compositionHelper?: { _isComposing: boolean; _isSendingComposition: boolean } }
    }
  >
}

type RecordingMain = typeof globalThis & { __ptyWritesRecord: Recorded[] }

export interface TypingRecording {
  save(file: string): Promise<void>
}

export async function recordTyping(
  app: ElectronApplication,
  page: Page,
  tabId: string
): Promise<TypingRecording> {
  await page.evaluate(
    ([id, types]) => {
      const w = window as unknown as RecordingWindow
      w.__typingRecord = []
      const term = w.__koloftTerms[id]
      const helper = term._core?._compositionHelper
      const note = (fields: Record<string, unknown>): void => {
        w.__typingRecord.push({
          at: Date.now(),
          where: 'renderer',
          textarea: term.textarea?.value,
          xtermComposing: helper?._isComposing,
          xtermSendingComposition: helper?._isSendingComposition,
          ...fields
        })
      }
      for (const type of types)
        document.addEventListener(
          type,
          (e) => {
            const ev = e as KeyboardEvent & InputEvent & CompositionEvent
            note({
              type,
              key: ev.key,
              keyCode: ev.keyCode,
              data: ev.data,
              inputType: ev.inputType,
              isComposing: ev.isComposing
            })
          },
          true
        )
      term.onData((data) => note({ type: 'xterm onData', data }))
    },
    [tabId, TYPING_EVENTS] as const
  )
  await app.evaluate(
    ({ ipcMain }, [channel, id]) => {
      const g = globalThis as RecordingMain
      g.__ptyWritesRecord = []
      ipcMain.on(channel, (_e, tab: string, data: string) => {
        if (tab === id)
          g.__ptyWritesRecord.push({ at: Date.now(), where: 'main', type: channel, data })
      })
    },
    [CH.terminal.write, tabId] as const
  )
  return {
    async save(file) {
      const halves = await Promise.allSettled([
        page.evaluate(() => (window as unknown as RecordingWindow).__typingRecord),
        app.evaluate(() => (globalThis as RecordingMain).__ptyWritesRecord)
      ])
      const lines = halves.flatMap((half) =>
        half.status === 'fulfilled'
          ? half.value
          : [{ at: 0, unreadable: String(half.reason) } as Recorded]
      )
      lines.sort((a, b) => a.at - b.at)
      fs.writeFileSync(file, lines.map((r) => JSON.stringify(r)).join('\n') + '\n')
    }
  }
}
