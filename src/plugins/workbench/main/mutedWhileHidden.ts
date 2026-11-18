export interface SoundingPage {
  isDestroyed(): boolean
  isAudioMuted(): boolean
  setAudioMuted(muted: boolean): void
}

export function mutedWhileHidden<P extends SoundingPage>(): {
  hide(pages: P[]): void
  opened(page: P): void
  show(): P[]
} {
  let hidden = false
  const mutedByHiding = new Set<P>()
  const mute = (page: P): void => {
    for (const gone of mutedByHiding) if (gone.isDestroyed()) mutedByHiding.delete(gone)
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
      const unmuted = [...mutedByHiding].filter((page) => !page.isDestroyed())
      for (const page of unmuted) page.setAudioMuted(false)
      mutedByHiding.clear()
      return unmuted
    }
  }
}
