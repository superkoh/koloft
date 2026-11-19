import { describe, expect, it, vi } from 'vitest'

const partition = {}
const guest = { getType: () => 'webview', session: partition }

vi.mock('electron', () => ({
  app: { on: () => undefined },
  clipboard: { writeText: () => undefined },
  session: { fromPartition: () => partition },
  webContents: { fromId: () => guest, getAllWebContents: () => [] }
}))

vi.mock('../../../../src/plugins/workbench/main/elementPick', () => ({
  pickElement: async () => ({ pictureFailed: 'the page went blank', png: Buffer.from('png') }),
  pickText: (_picked: unknown, picture: string | null) => `picture: ${picture}`,
  stopPick: () => undefined
}))

const { PageTools } = await import('../../../../src/plugins/workbench/main/pageTools')

async function toastsOfAPick(machine: string | undefined): Promise<unknown[]> {
  const toasts: unknown[] = []
  const tools = new PageTools({
    send: (_channel, text) => {
      toasts.push(text)
      return true
    },
    push: () => true,
    pages: {} as never,
    machineOfTab: () => machine,
    savePickOn: async () => {
      throw new Error('no room left')
    },
    savePickOnThisMac: async () => {
      throw new Error('no room left')
    },
    handsOn: () => undefined,
    underTest: true
  })
  await tools.pick(7, 'tab-1')
  return toasts
}

describe('what the owner reads when a picked element has no picture, pinned so that moving it changes no character', () => {
  it('on this Mac', async () => {
    expect(await toastsOfAPick(undefined)).toEqual([
      'The picture of the element could not be taken: the page went blank',
      'The picture of the element could not be saved: no room left'
    ])
  })

  it('in a tab on another machine', async () => {
    expect(await toastsOfAPick('devbox')).toEqual([
      'The picture of the element could not be taken: the page went blank',
      'The picture of the element could not be copied to devbox: no room left'
    ])
  })
})
