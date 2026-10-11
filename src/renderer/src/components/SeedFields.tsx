import type { JSX, KeyboardEvent } from 'react'

type FieldKeys = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => void

export function SeedFields({
  title,
  prompt,
  onTitle,
  onPrompt,
  onKeyDown,
  disabled
}: {
  title: string
  prompt: string
  onTitle: (v: string) => void
  onPrompt: (v: string) => void
  onKeyDown: FieldKeys
  disabled: boolean
}): JSX.Element {
  return (
    <>
      <span className="flabel">Title · Claude only</span>
      <div className="cb-input">
        <input
          className="cb-field"
          spellCheck={false}
          autoComplete="off"
          placeholder="name the session, or leave it to Claude"
          aria-label="Title"
          disabled={disabled}
          value={title}
          onChange={(e) => onTitle(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <span className="flabel">First prompt</span>
      <div className="cb-input">
        <textarea
          className="cb-field task"
          rows={3}
          spellCheck={false}
          aria-label="First prompt"
          disabled={disabled}
          value={prompt}
          onChange={(e) => onPrompt(e.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </>
  )
}
