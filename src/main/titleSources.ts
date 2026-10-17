import { PLACEHOLDER_SESSION_TITLE } from '@shared/types'
import type { TranscriptRecord } from './transcriptRecord'

const PROMPT_TITLE_CHARS = 60

export interface PromptTitles {
  title: string | null
  commandArgs: string | null
  commandName: string | null
}

export class TitleSources {
  private custom: string | null = null
  private ai: string | null = null
  private firstPrompt: string | null = null
  private commandArgs: string | null = null
  private commandName: string | null = null

  noteRecord(obj: TranscriptRecord): void {
    if (obj.type === 'ai-title' && typeof obj.aiTitle === 'string') this.ai = obj.aiTitle
    // CC§9
    if (obj.type === 'custom-title' && typeof obj.customTitle === 'string' && obj.customTitle)
      this.custom = obj.customTitle
  }

  notePrompt(p: PromptTitles): void {
    if (p.title && !this.firstPrompt) this.firstPrompt = p.title
    if (p.commandArgs && !this.commandArgs) this.commandArgs = p.commandArgs
    if (p.commandName && !this.commandName) this.commandName = p.commandName
  }

  title(sidecar: string | null): string {
    return (
      sidecar ||
      this.custom ||
      this.ai ||
      this.firstPrompt?.slice(0, PROMPT_TITLE_CHARS) ||
      this.commandArgs?.slice(0, PROMPT_TITLE_CHARS) ||
      this.commandName ||
      PLACEHOLDER_SESSION_TITLE
    )
  }
}
