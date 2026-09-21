/**
 * `chrome.system.display` on the phone: the one screen the WebView draws on, read from the chrome
 * page's `screen` (its CSS pixels are Chrome's DIPs, `devicePixelRatio` the scale factor,
 * `screen.orientation.angle` the rotation), in the shape Chrome's `DisplayInfoProvider` gives off
 * ChromeOS (`core/extensions/api/systemDisplay.ts`): `getInfo` lists it as the primary, internal,
 * touch display, `getDisplayLayout` is empty and the ChromeOS-only functions fail with Chrome's
 * error. Chrome hides the namespace from extensions that do not declare the permission, and so
 * does the engine's table; the host checks again. LINE's background sizes its sign-in window from
 * `getInfo` and never opened it while the call rejected.
 */
import {
  displayUnitInfos,
  SYSTEM_DISPLAY_CROS_ONLY_ERROR,
  SYSTEM_DISPLAY_CROS_ONLY_METHODS,
  type DisplayUnitInfo,
  type ScreenDisplay
} from '@core/extensions/api/systemDisplay'

/** What the phone's screen tells: `window.screen` and `devicePixelRatio` of the chrome page. */
export interface PhoneScreen {
  width: number
  height: number
  availWidth: number
  availHeight: number
  scaleFactor: number
  /** `screen.orientation.angle`: 0, 90, 180 or 270. */
  angle: number
}

/** The id Chrome's info carries for the one display; the primary and the only one. */
export const PHONE_DISPLAY_ID = 1

/** The name of the display in `getInfo` (Chrome's macOS provider names the built-in one too). */
export const PHONE_DISPLAY_NAME = 'Built-in display'

interface ScreenLike {
  width?: unknown
  height?: unknown
  availWidth?: unknown
  availHeight?: unknown
  orientation?: { angle?: unknown } | null
}

const dimension = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback

/** The screen as the chrome page's window reports it; a window without one reads as a blank display. */
export function readPhoneScreen(win: {
  screen?: ScreenLike
  devicePixelRatio?: unknown
}): PhoneScreen {
  const screen = win.screen ?? {}
  const width = dimension(screen.width, 0)
  const height = dimension(screen.height, 0)
  const ratio = win.devicePixelRatio
  const angle = screen.orientation?.angle
  return {
    width,
    height,
    availWidth: dimension(screen.availWidth, width),
    availHeight: dimension(screen.availHeight, height),
    scaleFactor: typeof ratio === 'number' && Number.isFinite(ratio) && ratio > 0 ? ratio : 1,
    angle: typeof angle === 'number' && Number.isFinite(angle) ? angle : 0
  }
}

/** The phone's screen as the engine's display record: internal, touch, with an accelerometer. */
export function phoneDisplay(screen: PhoneScreen): ScreenDisplay {
  return {
    id: PHONE_DISPLAY_ID,
    label: PHONE_DISPLAY_NAME,
    bounds: { x: 0, y: 0, width: screen.width, height: screen.height },
    workArea: { x: 0, y: 0, width: screen.availWidth, height: screen.availHeight },
    scaleFactor: screen.scaleFactor,
    rotation: screen.angle,
    internal: true,
    touchSupport: 'available',
    accelerometerSupport: 'available'
  }
}

/**
 * Chrome's answer to one `system.display` call on the phone. Throws an `Error` carrying the
 * message Chrome reports through `runtime.lastError` where Chrome fails the call; the host turns
 * that into the call's error. The permission is the caller's to check.
 */
export function answerSystemDisplay(method: string, screen: PhoneScreen): unknown {
  switch (method) {
    case 'getInfo':
      return displayUnitInfos([phoneDisplay(screen)], PHONE_DISPLAY_ID) satisfies DisplayUnitInfo[]
    case 'getDisplayLayout':
      return []
    default:
      if ((SYSTEM_DISPLAY_CROS_ONLY_METHODS as readonly string[]).includes(method))
        throw new Error(SYSTEM_DISPLAY_CROS_ONLY_ERROR)
      throw new Error(`chrome.system.display.${method} is not implemented on Zenium for Android`)
  }
}
