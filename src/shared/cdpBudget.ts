/**
 * how long a client's "mount this tab" may take, agreed between the two sides
 * that each hold a piece of it. The renderer does the work in three waits; main holds a
 * single timer over the whole request. Main's budget MUST exceed the renderer's worst
 * case, or a slow first load ends with main telling the client "the window did not
 * answer" while the renderer finishes anyway — a guest the relay never attaches, and a
 * client holding an error for a page that exists. Keeping the pieces here is what stops
 * the two sides drifting apart again.
 */

/** the renderer's wait for a fresh <webview> to reach did-attach */
export const CDP_MOUNT_ATTACH_MS = 12_000
/** …then for its first load to settle (or this grace, for a page that never stops) */
export const CDP_MOUNT_SETTLE_MS = 4_000
/** …then polling for the guest's webContents id (electron#31918: not readable at once) */
export const CDP_GUEST_ID_RETRY_MS = 100
export const CDP_GUEST_ID_RETRIES = 20

/** main's timer over the whole op: the renderer's worst case plus room for IPC and a
 *  busy render loop */
export const CDP_OP_BUDGET_MS =
  CDP_MOUNT_ATTACH_MS + CDP_MOUNT_SETTLE_MS + CDP_GUEST_ID_RETRY_MS * CDP_GUEST_ID_RETRIES + 4_000
