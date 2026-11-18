export { butlerRole, butlerHelperRole } from './prompts/role'
export { conductorFolder } from './main/folder'

export interface ButlerRowEntry {
  label: string
  run: () => void
  danger?: true
}
