export { butlerRole, butlerHelperRole } from './prompts/role'
export { conductorFolder } from './main/folder'
export { OwnerAsleep, THIS_MAC } from './main/ownerAsleep'

export interface ButlerRowEntry {
  label: string
  run: () => void
  danger?: true
}
