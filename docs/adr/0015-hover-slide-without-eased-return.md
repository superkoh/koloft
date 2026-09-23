# 0015 The hover-slide on long names snaps back with no easing

**Constraint**: React rewrites a label's className when its git letter changes, and the
pointer can go straight from one row to the next. Any slide-back that runs on a timer
has to survive both.
**Decision**: the slide keeps one active element and no timers; leaving a row puts the
label straight back.
**Rejected**: an eased slide-back that kept the CSS class on for a moment after the
pointer left. It was tried and removed the same day: its timers caused three bugs
(re-entry, React rewriting className, moving to the next row) for a cosmetic effect.
