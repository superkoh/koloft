const FACES_XTERM_DRAWS = ['normal 400', 'normal 700', 'italic 400', 'italic 700']

const familiesLoaded = new Set<string>()

export const terminalFontsLoaded = (family: string): boolean => familiesLoaded.has(family)

// PLATFORM§66
export async function loadTerminalFonts(family: string, size: number): Promise<void> {
  if (familiesLoaded.has(family)) return
  await Promise.allSettled(
    FACES_XTERM_DRAWS.map((face) => document.fonts.load(`${face} ${size}px ${family}`))
  )
  familiesLoaded.add(family)
}
