import type { FormFactor } from './types'

/**
 * What the layout decision is made from: the window's size in CSS px and what its primary
 * pointer can do (the `pointer: coarse` and `hover: hover` media features).
 */
export interface ViewportMetrics {
  width: number
  height: number
  /** The primary pointer is a finger (or the screen is a touch screen without a mouse). */
  coarse: boolean
  /** The primary pointer can hover: a mouse or trackpad. */
  hover: boolean
}

/**
 * Below this many CSS px on the deciding side the chrome is a phone. Android's own tablet line
 * (`sw600dp`), so a device gets the same class the system gives it.
 */
export const PHONE_MAX_WIDTH = 600

/**
 * How the chrome should lay itself out. Derived from the window and its pointer, not from the
 * platform name.
 *
 * A touch screen that cannot hover is held in the hand: its class follows the shorter side of the
 * window, like Android's smallest-width qualifier, so a phone turned sideways keeps its bar and
 * overview and a tablet keeps its sidebar layout in either orientation. A pointer that hovers (a
 * mouse or trackpad: a laptop, a DeX desktop, a tablet with a keyboard) means a windowed desktop,
 * where only a window too narrow for the sidebar layout gets the phone one.
 *
 * The class follows the window, not the device: a tablet window narrowed in split screen to
 * under 600 px on its short side is a phone for as long as it stays so, and a tablet again when
 * it is widened back.
 */
export function classifyViewport({ width, height, coarse, hover }: ViewportMetrics): FormFactor {
  const handheld = coarse && !hover
  const side = handheld ? Math.min(width, height) : width
  if (side < PHONE_MAX_WIDTH) return 'phone'
  return coarse ? 'tablet' : 'desktop'
}

/**
 * The layouts a finger drives, the phone's and the tablet's: they share what the desktop has no
 * use for (the docked read-aloud player, a menu's sheet, the tab overview) while each keeps its
 * own composition. The desktop layout is the mouse's, DeX included.
 */
export function touchLayout(formFactor: FormFactor): boolean {
  return formFactor !== 'desktop'
}

/** The desktop's name for a group made with no name of its own: the desktop says Folder (§6). */
export const NEW_FOLDER_NAME = 'New Folder'

/**
 * The touch hosts' name for a group made with no name of its own: the phone and the tablet say
 * Group (§6), and a group a touch host makes is named "Group", never "New Folder" – the name
 * the phone overview's drag-to-group gives, the group strip's for a group with no name.
 */
export const NEW_GROUP_NAME = 'Group'

/**
 * What a group made with no name of its own is called on the host `formFactor` draws – the
 * desktop's "New Folder", the phone's and the tablet's "Group" (§6). A caller with no window to
 * read a form factor from (the menu bar's binding, a command with no window) names as the
 * desktop does, which is what every path named before this helper.
 */
export function newFolderName(formFactor: FormFactor | undefined): string {
  return formFactor !== undefined && touchLayout(formFactor) ? NEW_GROUP_NAME : NEW_FOLDER_NAME
}
