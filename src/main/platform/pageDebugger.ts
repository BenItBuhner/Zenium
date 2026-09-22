import type { WebContents } from 'electron'

/**
 * Who holds a page's DevTools session. Electron gives a WebContents one `debugger` client, and
 * Zenium's own holders share it: the resource governor's overrides keep it attached on nearly
 * every page (`Emulation.setHardwareConcurrencyOverride`), captures, input, the dark theme for
 * sites and the page fonts borrow it while they run. `debugger.isAttached()` therefore says
 * nothing about ownership – it is true on an ordinary page.
 *
 * Another owner is an extension's `chrome.debugger` session (`extensionApi/debugger.ts`): the
 * agent's state is the extension's (its emulations, `Page.setFontFamilies`' once-per-agent
 * slot), and detaching to get a fresh agent would end its session as `target_closed`. The
 * extension API registers here for as long as it is attached; a holder that would recycle the
 * session or spend the agent's once-only commands asks first and leaves such a page to its
 * next load.
 *
 * Recycling (detach, attach again) drops every emulation override the session carried; the
 * governor's lifecycle knows which of its own to put back, so it installs the recycler and a
 * holder in need of a fresh agent calls `recycleDebugger`. Without the governor the session is
 * simply dropped.
 */

const foreignOwners = new Map<number, number>()

/** An extension attached to the page's session (`webContentsId`); counted, one per extension. */
export function addForeignDebuggerOwner(webContentsId: number): void {
  foreignOwners.set(webContentsId, (foreignOwners.get(webContentsId) ?? 0) + 1)
}

export function removeForeignDebuggerOwner(webContentsId: number): void {
  const n = (foreignOwners.get(webContentsId) ?? 0) - 1
  if (n > 0) foreignOwners.set(webContentsId, n)
  else foreignOwners.delete(webContentsId)
}

/** Whether a session other than Zenium's own holds the page (an extension's `chrome.debugger`). */
export function hasForeignDebuggerOwner(webContentsId: number): boolean {
  return foreignOwners.has(webContentsId)
}

export type DebuggerRecycler = (wc: WebContents) => Promise<void>

/** Without the governor: the session is dropped and the caller attaches again. */
function drop(wc: WebContents): Promise<void> {
  if (wc.isDestroyed()) return Promise.resolve()
  try {
    if (wc.debugger.isAttached()) wc.debugger.detach()
  } catch {
    /* already detached */
  }
  return Promise.resolve()
}

let recycler: DebuggerRecycler = drop

/** The governor's lifecycle installs itself here (`TabLifecycle.recycle`); tests may too. */
export function setDebuggerRecycler(fn: DebuggerRecycler | null): void {
  recycler = fn ?? drop
}

/**
 * A fresh agent for the page: the session is detached and whatever Zenium's own holders had
 * on it is put back (the governor's overrides, which attach again). The caller attaches again
 * if it finds the session closed and re-sends what it held itself.
 */
export function recycleDebugger(wc: WebContents): Promise<void> {
  return recycler(wc)
}
