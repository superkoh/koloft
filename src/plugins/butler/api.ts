export { butlerRole, butlerHelperRole } from './prompts/role'
export { conductorFolder } from './main/folder'
export { butlerTitle } from './shared/names'

export interface ButlerRowEntry {
  label: string
  run: () => void
  danger?: true
}
