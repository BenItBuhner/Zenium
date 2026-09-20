/**
 * `chrome.system.display` as Chrome shows it on Windows, macOS and Linux: `getInfo` lists the
 * screens the engine knows (`DisplayInfoProvider::CreateDisplayUnitInfo` field for field),
 * `getDisplayLayout` has nothing to say, and the functions that move, mirror and calibrate
 * displays answer with Chrome's "ChromeOS only" error. Chrome hides the namespace from
 * extensions that do not declare the permission.
 */

export const SYSTEM_DISPLAY_PERMISSION = 'system.display'

export const SYSTEM_DISPLAY_NO_PERMISSION_ERROR =
  "The extension does not have the 'system.display' permission."

/** Chrome's `SystemDisplayCrOSRestrictedFunction::kCrosOnlyError`. */
export const SYSTEM_DISPLAY_CROS_ONLY_ERROR = 'Function available only on ChromeOS.'

/** The functions Chrome restricts to ChromeOS (every other platform gets the error above). */
export const SYSTEM_DISPLAY_CROS_ONLY_METHODS = [
  'setDisplayProperties',
  'setDisplayLayout',
  'enableUnifiedDesktop',
  'overscanCalibrationStart',
  'overscanCalibrationAdjust',
  'overscanCalibrationReset',
  'overscanCalibrationComplete',
  'showNativeTouchCalibration',
  'startCustomTouchCalibration',
  'completeCustomTouchCalibration',
  'clearTouchCalibration',
  'setMirrorMode'
] as const

/** Chrome's `kDefaultDpi`: `dpiX` / `dpiY` are the scale factor times this. */
export const DEFAULT_DPI = 96

export interface DisplayRect {
  x: number
  y: number
  width: number
  height: number
}

export type SupportState = 'available' | 'unavailable' | 'unknown'

/** One screen as the engine reports it (Electron's `Display`, the fields Chrome's info reads). */
export interface ScreenDisplay {
  id: number
  label: string
  bounds: DisplayRect
  workArea: DisplayRect
  scaleFactor: number
  /** Degrees clockwise: 0, 90, 180 or 270. */
  rotation: number
  internal: boolean
  touchSupport: SupportState
  accelerometerSupport: SupportState
}

export interface Bounds {
  left: number
  top: number
  width: number
  height: number
}

export interface Insets {
  left: number
  top: number
  right: number
  bottom: number
}

/** Chrome's `system.display.DisplayUnitInfo`. */
export interface DisplayUnitInfo {
  id: string
  name: string
  mirroringSourceId: string
  mirroringDestinationIds: string[]
  isPrimary: boolean
  isInternal: boolean
  isEnabled: boolean
  isUnified: boolean
  activeState: 'active' | 'inactive'
  dpiX: number
  dpiY: number
  rotation: number
  bounds: Bounds
  overscan: Insets
  workArea: Bounds
  modes: never[]
  hasTouchSupport: boolean
  hasAccelerometerSupport: boolean
  availableDisplayZoomFactors: number[]
  displayZoomFactor: number
}

const bounds = (rect: DisplayRect): Bounds => ({
  left: rect.x,
  top: rect.y,
  width: rect.width,
  height: rect.height
})

/**
 * Chrome's info for one display: the id as a decimal string, the primary flagged, the DPI from
 * the scale factor, the rotation in degrees, no overscan, no modes and no zoom choices (ChromeOS
 * fills those); the name is the engine's label for the monitor (Chrome's Windows provider names
 * monitors too; its Linux provider leaves the name empty).
 */
export function displayUnitInfo(display: ScreenDisplay, primaryId: number | null): DisplayUnitInfo {
  const dpi = display.scaleFactor * DEFAULT_DPI
  return {
    id: String(display.id),
    name: display.label,
    mirroringSourceId: '',
    mirroringDestinationIds: [],
    isPrimary: display.id === primaryId,
    isInternal: display.internal,
    isEnabled: true,
    isUnified: false,
    activeState: 'active',
    dpiX: dpi,
    dpiY: dpi,
    rotation: normalizeRotation(display.rotation),
    bounds: bounds(display.bounds),
    overscan: { left: 0, top: 0, right: 0, bottom: 0 },
    workArea: bounds(display.workArea),
    modes: [],
    hasTouchSupport: display.touchSupport === 'available',
    hasAccelerometerSupport: display.accelerometerSupport === 'available',
    availableDisplayZoomFactors: [],
    displayZoomFactor: 1
  }
}

/** Every display in the engine's order, the primary one flagged. */
export function displayUnitInfos(
  displays: readonly ScreenDisplay[],
  primaryId: number | null
): DisplayUnitInfo[] {
  return displays.map((display) => displayUnitInfo(display, primaryId))
}

/** Chrome reports 0, 90, 180 or 270; anything else the engine says becomes 0. */
export function normalizeRotation(rotation: number): number {
  return rotation === 90 || rotation === 180 || rotation === 270 ? rotation : 0
}
