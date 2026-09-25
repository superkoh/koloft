# 0013 Floating menus and cards are portalled to `document.body`

**Constraint**: a CSS transform on any parent box traps a `position: fixed` child
(PLATFORM§24), and overflow clipping or stacking layers (as in the sidebar footer) can
cut it off. The panel is full of animated, transformed surfaces.
**Decision**: every `position: fixed` menu, popover, card or dialog renders into
`document.body` through `createPortal`, even where no transformed parent exists today.
**Rejected**: rendering the overlay next to whatever opened it — simpler, but it breaks
silently the day a parent gains a transform or a clip.
