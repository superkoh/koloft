import type { JSX } from 'react'

export function Switch({
  checked,
  onChange,
  disabled,
  small,
  title,
  ariaLabel
}: {
  checked: boolean
  onChange(next: boolean): void
  disabled?: boolean
  small?: boolean
  title?: string
  ariaLabel?: string
}): JSX.Element {
  return (
    <input
      type="checkbox"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      className={'switch' + (small ? ' sm' : '')}
      checked={checked}
      disabled={disabled}
      title={title}
      onChange={(e) => onChange(e.target.checked)}
    />
  )
}
