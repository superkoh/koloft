export interface SoundingPage {
  isDestroyed(): boolean
  isAudioMuted(): boolean
  setAudioMuted(muted: boolean): void
}

export function mutedWhileHidden(): {
  hide(pages: SoundingPage[]): void
  opened(page: SoundingPage): void
  show(): void
} {
  let hidden = false
  const mutedByHiding = new Set<SoundingPage>()
  const mute = (page: SoundingPage): void => {
    if (page.isDestroyed() || page.isAudioMuted()) return
    page.setAudioMuted(true)
    mutedByHiding.add(page)
  }
  return {
    hide(pages) {
      hidden = true
      for (const page of pages) mute(page)
    },
    opened(page) {
      if (hidden) mute(page)
    },
    show() {
      hidden = false
      for (const page of mutedByHiding) if (!page.isDestroyed()) page.setAudioMuted(false)
      mutedByHiding.clear()
    }
  }
}
