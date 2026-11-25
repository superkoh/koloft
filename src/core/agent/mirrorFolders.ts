interface FolderOnTheMachine {
  from: string
  to: string
  holds: 'records' | 'usage'
}

export interface WholeFolder extends FolderOnTheMachine {
  flags: string[]
}

export interface FolderSplitByWorkspace extends FolderOnTheMachine {
  subfolderOf(workspacePath: string): string
  flagsFor(subfolders: string[]): string[]
}

export type MirrorFolder = WholeFolder | FolderSplitByWorkspace
