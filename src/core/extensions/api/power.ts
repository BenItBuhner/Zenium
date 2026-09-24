/**
 * `chrome.power` as Chrome shows it: `requestKeepAwake(level)` keeps the system or the display
 * from sleeping while the extension holds the request, `releaseKeepAwake()` lets it go, and
 * the request goes with the extension when it unloads. One request per extension: a second
 * call replaces the level. Chrome hides the namespace from extensions that do not declare
 * the permission, and checks the level against its enum before anything else.
 *
 * On the phone both levels keep the screen on while the browser is in front: an app cannot
 * hold the system awake with its screen off on a user's behalf, so `'system'` is served as
 * `'display'` (what Chrome on Android would do too).
 */

export const POWER_PERMISSION = 'power'

export const POWER_NO_PERMISSION_ERROR = "The extension does not have the 'power' permission."

/** Chrome's `power.Level`. */
export type KeepAwakeLevel = 'system' | 'display'

export const KEEP_AWAKE_LEVELS: readonly KeepAwakeLevel[] = ['system', 'display']

/** Chrome's argument error for a level outside the enum (the bindings' wording). */
export const POWER_BAD_LEVEL_ERROR =
  "Error in invocation of power.requestKeepAwake(power.Level level): Error at parameter 'level': Value must be one of display, system."

export function isKeepAwakeLevel(value: unknown): value is KeepAwakeLevel {
  return typeof value === 'string' && (KEEP_AWAKE_LEVELS as readonly string[]).includes(value)
}
