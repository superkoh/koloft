const koloftQuits = new AbortController()

export const oneShotsEnded = (): boolean => koloftQuits.signal.aborted

export const endOneShots = (): void => koloftQuits.abort()

export const untilKoloftQuits = (signal?: AbortSignal): AbortSignal =>
  signal ? AbortSignal.any([signal, koloftQuits.signal]) : koloftQuits.signal
