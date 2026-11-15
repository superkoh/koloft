const FACES_DRAWN = ['normal 400', 'normal 700', 'italic 400', 'italic 700']
const SIZE_IGNORED_BY_FACE_MATCHING = '16px'

const loads = new Map<string, Promise<void>>()
const familiesLoaded = new Set<string>()

export const monoFontsLoaded = (family: string): boolean => familiesLoaded.has(family)

// PLATFORM§66
export function loadMonoFonts(family: string): Promise<void> {
  let load = loads.get(family)
  if (!load) {
    load = Promise.allSettled(
      FACES_DRAWN.map((face) =>
        document.fonts.load(`${face} ${SIZE_IGNORED_BY_FACE_MATCHING} ${family}`)
      )
    ).then(() => {
      familiesLoaded.add(family)
    })
    loads.set(family, load)
  }
  return load
}
