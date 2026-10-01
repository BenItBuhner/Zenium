/**
 * The Badging API for installed web apps (MW-51): `navigator.setAppBadge(contents?)` and
 * `navigator.clearAppBadge()` (w3c.github.io/badging), which Electron's engine declares but
 * never answers (no badge service is bound, so a page's promise never settled) and the Android
 * WebView leaves out. The API is write-only: a page sets a count, a flag (no number) or nothing,
 * and never reads the badge back.
 *
 * Three parts share this module. `installAppBadgeShim` runs in the page's own world (serialised
 * through `contextBridge.executeInMainWorld`, so it is self-contained) and posts every call as a
 * DOM event on `document`; the page script's relay (`shared/pageScript`) turns the event into a
 * `webapp: 'badge'` message while the page is an installed app's document in the app's own
 * window (`PageFlags.installedApp`); the core (`WebAppService`) keeps one badge per installed
 * app for the hosts to draw. Nothing here is persisted: Chrome keeps its badges in memory
 * (`BadgeManager`'s map, chrome/browser/badging) and so does Zenium.
 */

/** An installed app's badge: a count above zero, or a flag with no number (the spec's "flag"). */
export type AppBadge = { kind: 'count'; value: number } | { kind: 'flag' }

/**
 * Counts above this show as "99+" – Chrome's `kMaxBadgeContent` (chrome/browser/badging), the
 * saturation the spec allows a platform's convention ("a badge with a value of 100 as 99+").
 */
export const APP_BADGE_MAX_SHOWN = 99

/** Chrome's glyph for a flag badge (`GetBadgeString`: "•" when the badge has no number). */
export const APP_BADGE_FLAG_GLYPH = '•'

/**
 * The DOM event the page-world shim dispatches on `document` at every call, the badge as JSON
 * in `detail`: `{ badge: AppBadge | null }` (null for `clearAppBadge()` and `setAppBadge(0)`).
 */
export const APP_BADGE_EVENT = 'zen-app-badge'

/**
 * A badge as the page script posted it, checked before the core keeps it: `null` is a cleared
 * badge, a count carries a safe integer above zero, a flag carries nothing else. `undefined` for
 * anything else – a message that is not a badge is dropped, never guessed at.
 */
export function appBadgeOf(value: unknown): AppBadge | null | undefined {
  if (value === null) return null
  if (!value || typeof value !== 'object') return undefined
  const kind = (value as { kind?: unknown }).kind
  if (kind === 'flag') return { kind: 'flag' }
  if (kind !== 'count') return undefined
  const count = (value as { value?: unknown }).value
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) return undefined
  return { kind: 'count', value: count }
}

/** Whether two badges (or none) are the same badge. */
export function sameAppBadge(a: AppBadge | null, b: AppBadge | null): boolean {
  if (a === b) return true
  if (!a || !b || a.kind !== b.kind) return false
  return a.kind === 'flag' || a.value === (b as { value: number }).value
}

/**
 * What the badge shows: the count, `99+` past the maximum, `•` for a flag – Chrome's
 * `GetBadgeString` (chrome/browser/badging/badge_manager.cc).
 */
export function appBadgeLabel(badge: AppBadge): string {
  if (badge.kind === 'flag') return APP_BADGE_FLAG_GLYPH
  return badge.value > APP_BADGE_MAX_SHOWN ? `${APP_BADGE_MAX_SHOWN}+` : String(badge.value)
}

/**
 * The badge's accessible text – the taskbar overlay's `description`, read by a screen reader on
 * the app's button and never shown. Chrome's three cases (`badge_manager_delegate_win.cc`; the
 * strings in ui/strings/ui_strings.grd), in Zenium's register: the count pluralised, "more than
 * 99" once the badge saturates, an unspecific line for a flag.
 */
export function appBadgeDescription(badge: AppBadge): string {
  if (badge.kind === 'flag') return 'Unread notifications'
  if (badge.value > APP_BADGE_MAX_SHOWN)
    return `More than ${APP_BADGE_MAX_SHOWN} unread notifications`
  return badge.value === 1 ? '1 unread notification' : `${badge.value} unread notifications`
}

/**
 * Runs in the page's main world (the function is serialised, so it is self-contained and takes
 * everything it needs as arguments; nothing here may throw into the page). Defines
 * `navigator.setAppBadge` / `clearAppBadge` on secure-context documents – the spec's
 * `[SecureContext]`, so an `http:` page sees neither, as in Chrome – and leaves an engine that
 * has a working pair of its own alone. Each call is checked as WebIDL's `optional [EnforceRange]
 * unsigned long long` conversion would (a BigInt, a Symbol, NaN, an infinity, a negative or a
 * value past 2^53 − 1 is a TypeError; a fraction keeps its integer part), an argument left out or
 * `undefined` is the flag, 0 clears, and the badge goes to the isolated world as JSON on
 * `eventName`. A conversion error rejects the promise rather than throwing (WebIDL's rule for
 * operations that return a promise). Every call resolves, an installed app's or not: the
 * browser decides where the badge lands, and a plain tab's call is Chrome's resolving no-op.
 */
export function installAppBadgeShim(eventName: string): void {
  const win = window
  const doc = document
  if (!win.isSecureContext) return
  const nav = win.navigator
  // WebIDL's upper bound for `[EnforceRange] unsigned long long`: 2^53 − 1.
  const MAX_CONTENTS = 9007199254740991
  const typeError = (): TypeError =>
    new TypeError(
      "Failed to execute 'setAppBadge' on 'Navigator': Value is not of type 'unsigned long long'."
    )
  const post = (badge: { kind: 'count'; value: number } | { kind: 'flag' } | null): void => {
    try {
      doc.dispatchEvent(new CustomEvent(eventName, { detail: JSON.stringify({ badge }) }))
    } catch {
      /* a document on its way out; the badge is the browser's to keep */
    }
  }
  const setAppBadge = function (this: unknown, ...args: unknown[]): Promise<undefined> {
    // `setAppBadge()` and `setAppBadge(undefined)` are the same call: the argument is missing.
    if (args.length === 0 || args[0] === undefined) {
      post({ kind: 'flag' })
      return Promise.resolve(undefined)
    }
    const value = args[0]
    if (typeof value === 'bigint' || typeof value === 'symbol') return Promise.reject(typeError())
    let n: number
    try {
      n = Number(value)
    } catch {
      return Promise.reject(typeError())
    }
    if (!Number.isFinite(n)) return Promise.reject(typeError())
    const contents = Math.trunc(n)
    if (contents < 0 || contents > MAX_CONTENTS) return Promise.reject(typeError())
    // `-0` truncates to a zero too: nothing to show.
    post(contents === 0 ? null : { kind: 'count', value: contents })
    return Promise.resolve(undefined)
  }
  const clearAppBadge = function (this: unknown): Promise<undefined> {
    post(null)
    return Promise.resolve(undefined)
  }
  // Electron's engine declares the pair but never answers it (no badge service is bound), and
  // the WebView has none: either way the shim's pair replaces what is there.
  const proto: object =
    typeof win.Navigator === 'function' && win.Navigator.prototype ? win.Navigator.prototype : nav
  try {
    Object.defineProperty(proto, 'setAppBadge', {
      value: setAppBadge,
      writable: true,
      configurable: true,
      enumerable: true
    })
    Object.defineProperty(proto, 'clearAppBadge', {
      value: clearAppBadge,
      writable: true,
      configurable: true,
      enumerable: true
    })
  } catch {
    /* a frozen navigator keeps the engine's members */
  }
}
