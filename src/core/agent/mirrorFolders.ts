interface FolderOnTheMachine {
  from: string
  to: string
}

export interface WholeFolder extends FolderOnTheMachine {
  holds: 'records' | 'usage'
  flags: string[]
}

export interface FolderSplitByWorkspace extends FolderOnTheMachine {
  holds: 'records'
  subfolderOf(workspacePath: string): string
  flagsFor(subfolders: string[]): string[]
}

export type MirrorFolder = WholeFolder | FolderSplitByWorkspace
