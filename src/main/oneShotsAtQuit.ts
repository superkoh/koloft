const koloftQuits = new AbortController()

export const oneShotsEnded = (): boolean => koloftQuits.signal.aborted

export const endOneShots = (): void => koloftQuits.abort()

export const untilKoloftQuits = (signal?: AbortSignal): AbortSignal =>
  AbortSignal.any(signal ? [signal, koloftQuits.signal] : [koloftQuits.signal])
