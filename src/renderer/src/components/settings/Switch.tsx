import type { JSX } from 'react'

/** FR-16: the one new control primitive of the settings redesign — a native
 *  checkbox styled as a pill switch (styles.css `input.switch`), so keyboard/AT
 *  semantics and every `input[type=checkbox]` e2e selector keep working. */
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
  /** account-row size (30×18) instead of the standard 36×21 */
  small?: boolean
  title?: string
  /** for a switch whose row has no label of its own to be named by */
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
