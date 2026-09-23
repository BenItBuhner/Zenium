/**
 * The native window title (Alt+Tab, taskbar, Dock, window switcher). Kept platform neutral and
 * pure so it can be unit tested; hosts apply the result through `WindowHost.setTitle`.
 *
 * Format: `<active tab title> - Zenium`, with ` (Private)` appended for private windows. A window
 * with no active tab (or a blank/untitled one) shows the bare product name, still marked private.
 * A window the user named (Chrome's Name window…, `windowName`) reads `<name> — Zenium` whatever
 * its tabs: the name is the window's, so it stands where the tab's title would and is joined
 * with the design language's title–detail dash rather than the tab form's hyphen. A web app's
 * standalone window (`appName`) is titled as Chrome titles its app windows: the page's title
 * alone, the app's name while the page has none – the window is the app's, not the browser's.
 */
export const PRODUCT_NAME = 'Zenium'

/** The longest name a window keeps (the prompt's field stops there too). */
export const WINDOW_NAME_MAX = 120

export function formatWindowTitle(
  activeTabTitle: string | null | undefined,
  isPrivate: boolean,
  appName?: string | null,
  windowName?: string | null
): string {
  const title = activeTabTitle?.trim()
  if (appName) return title || appName
  const name = normalizeWindowName(windowName)
  const base = name
    ? `${name} — ${PRODUCT_NAME}`
    : title
      ? `${title} - ${PRODUCT_NAME}`
      : PRODUCT_NAME
  return isPrivate ? `${base} (Private)` : base
}

/**
 * A window name as the model keeps it: trimmed, cut at `WINDOW_NAME_MAX`, null when nothing is
 * left – an emptied field in the prompt clears the name, as Chrome's does.
 */
export function normalizeWindowName(input: string | null | undefined): string | null {
  const name = input?.trim().slice(0, WINDOW_NAME_MAX).trim()
  return name ? name : null
}

/** Native title changes per window are capped at ten a second. */
export const TITLE_UPDATE_INTERVAL_MS = 100

/**
 * Rate limiter for native title changes: the first title applies at once, titles that arrive
 * within the interval coalesce into one trailing apply of the latest (page titles come in bursts
 * while a document loads). A title equal to the one already applied is dropped.
 */
export class TitleThrottle {
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastAppliedAt = Number.NEGATIVE_INFINITY
  private pending: string | null = null

  constructor(
    private readonly apply: (title: string) => void,
    /** The title the window already carries, so the first equal update is a no-op. */
    private applied: string | null = null,
    private readonly now: () => number = Date.now
  ) {}

  set(title: string): void {
    const elapsed = this.now() - this.lastAppliedAt
    if (!this.timer && elapsed >= TITLE_UPDATE_INTERVAL_MS) {
      this.applyNow(title)
      return
    }
    this.pending = title
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      const next = this.pending
      this.pending = null
      if (next !== null) this.applyNow(next)
    }, TITLE_UPDATE_INTERVAL_MS - elapsed)
  }

  /** Drop any trailing update (the window is gone). */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.pending = null
  }

  private applyNow(title: string): void {
    if (title === this.applied) return
    this.applied = title
    this.lastAppliedAt = this.now()
    this.apply(title)
  }
}
