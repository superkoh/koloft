import { describe, expect, it } from 'vitest'
import { mutedWhileHidden, type SoundingPage } from '../../src/main/mutedWhileHidden'

function page(muted = false): SoundingPage & { muted: boolean; destroyed: boolean } {
  return {
    muted,
    destroyed: false,
    isDestroyed() {
      return this.destroyed
    },
    isAudioMuted() {
      return this.muted
    },
    setAudioMuted(m) {
      this.muted = m
    }
  }
}

describe('web pages while the Koloft window is hidden', () => {
  it('hiding the window mutes every page, and showing it again gives sound back to the pages that had it', () => {
    const playing = page()
    const mutedByOwner = page(true)
    const sound = mutedWhileHidden()
    sound.hide([playing, mutedByOwner])
    expect([playing.muted, mutedByOwner.muted]).toEqual([true, true])
    sound.show()
    expect([playing.muted, mutedByOwner.muted]).toEqual([false, true])
  })

  it('a page opened while the window is hidden starts muted and gets its sound once the window shows; one opened while it shows is left alone', () => {
    const sound = mutedWhileHidden()
    sound.hide([])
    const openedHidden = page()
    sound.opened(openedHidden)
    expect(openedHidden.muted).toBe(true)
    sound.show()
    expect(openedHidden.muted).toBe(false)
    const openedShown = page()
    sound.opened(openedShown)
    expect(openedShown.muted).toBe(false)
  })

  it('a page closed while the window was hidden is not touched when it shows again', () => {
    const sound = mutedWhileHidden()
    const closed = page()
    sound.hide([closed])
    closed.destroyed = true
    sound.show()
    expect(closed.muted).toBe(true)
  })
})
