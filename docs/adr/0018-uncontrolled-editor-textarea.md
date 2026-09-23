# 0018 The file editor's textarea is uncontrolled

**Constraint**: a React-controlled textarea rewrites its value on every keystroke —
about 28 ms per character on a big file (measured). Rewriting it during IME
composition throws away a Chinese input method's candidate characters, and setting
`value` also moves the caret to the end and wipes the undo history.
**Decision**: the DOM node owns the text and React only reads it. The one place that
writes it back is the registry sync effect, which runs only for a reload or a discard,
never on a keystroke.
**Rejected**: the usual controlled textarea (`value` plus `onChange`) — the standard
React pattern, but too slow on big files and broken for CJK input.
