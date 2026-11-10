const FACES_DRAWN = ['normal 400', 'normal 700', 'italic 400', 'italic 700']
const SIZE_IGNORED_BY_FACE_MATCHING = '16px'

const familiesLoaded = new Set<string>()

export const monoFontsLoaded = (family: string): boolean => familiesLoaded.has(family)

// PLATFORM§66
export async function loadMonoFonts(family: string): Promise<void> {
  if (familiesLoaded.has(family)) return
  await Promise.allSettled(
    FACES_DRAWN.map((face) =>
      document.fonts.load(`${face} ${SIZE_IGNORED_BY_FACE_MATCHING} ${family}`)
    )
  )
  familiesLoaded.add(family)
}
