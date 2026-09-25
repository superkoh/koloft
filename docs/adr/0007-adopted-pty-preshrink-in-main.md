# 0007 Main shrinks an adopted claude pty by one row so it redraws

**Constraint**: after a renderer reload, claude redraws only when the terminal size
really changes. When the renderer wiggled the size itself, the changes either merged
into one no-change resize (a blank tab) or made claude draw at the wrong size (a ghost
status line). The fake claude in the e2e suite cannot show either failure.
**Decision**: before any terminal view exists, main shrinks each adopted claude pty by
one row. The new renderer's normal fit puts the real size back, so claude gets exactly
one real resize and draws one full frame at a size that already holds.
**Rejected**: wiggling the size from the renderer after it attaches — simpler and more
local, but it gives a blank tab or a ghost status line on a real claude, while T-REL-01
still passes.
