/**
 * The Workbench panel's geometry floor (FR-08 / NFR-07).
 *
 * The merge inherited two different floors — Preview's 320 and the Browser's 440 — and
 * the HIGHER one wins, because after the merge any tab can be a `web` tab: below 440px a
 * page hits most sites' mobile breakpoint, which is also why the window minimum is 1020.
 * A single panel cannot have a per-content floor without the width jumping as the user
 * switches tabs, so there is one number.
 *
 * `auxSurfaceOf` retired with the mutually-exclusive column it arbitrated: which surface
 * the aux column showed was a question only while there were two of them.
 *
 * RE-EXPORTED, not re-declared. `settingsOps`' own comment says the drag clamp and the
 * load-time repair "must agree exactly", and two constants holding 440 do not agree —
 * they merely match, until someone edits one. This is the drag clamp's name for the
 * repair's number.
 */
export { WORKBENCH_WIDTH_FLOOR as WORKBENCH_PANE_MIN } from '@shared/settingsOps'
