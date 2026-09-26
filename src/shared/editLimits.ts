const KB = 1024
const MB = 1024 * KB

export const EDIT_WRITE_MAX_BYTES = MB

export const EDIT_OPEN_MAX_BYTES = 512 * KB

export function sizeLabel(bytes: number): string {
  return bytes >= MB ? `${bytes / MB} MB` : `${bytes / KB} KB`
}
