import type { Folder, FolderColor, FolderColorScheme, Tab, UIState } from '@shared/types'
import {
  FOLDER_COLOR_NAMES,
  FOLDER_COLOR_ORDER,
  FOLDER_COLORS_DARK,
  FOLDER_COLORS_LIGHT
} from '@shared/defaults'
import { hexToRgb } from '@shared/theme'

/** Folders are tab groups on the phone; this is the colour a group without one is painted in. */
export const DEFAULT_GROUP_COLOR: FolderColor = 'grey'
/** The icon folders get by default; a group wearing it shows its colour's glyph instead (`GroupGlyph`). */
export const DEFAULT_FOLDER_ICON = '📁'

/**
 * Chrome's nine group colours in Chrome's order (`FOLDER_COLOR_ORDER`, the order the core hands
 * them to new folders too), each with the name its swatch announces – the desktop group editor
 * bubble (tabs-13), the touch hosts' Colour menu (`FOLDER_COLOR_NAMES`). The values are the
 * §9.14 pair (`FOLDER_COLORS_LIGHT` / `FOLDER_COLORS_DARK`, shared with the phone's group cards).
 */
export const GROUP_PALETTE: ReadonlyArray<{ color: FolderColor; name: string }> =
  FOLDER_COLOR_ORDER.map((color) => ({ color, name: FOLDER_COLOR_NAMES[color] }))

/** The group's colour in one scheme's set, `#rrggbb`. */
export function groupColorHex(
  color: FolderColor | null | undefined,
  scheme: FolderColorScheme
): string {
  const set = scheme === 'dark' ? FOLDER_COLORS_DARK : FOLDER_COLORS_LIGHT
  return set[color ?? DEFAULT_GROUP_COLOR]
}

/** The group's colour in one scheme's set as space-separated channels, for `rgb(<channels> / <alpha>)`. */
export function groupColorChannels(
  color: FolderColor | null | undefined,
  scheme: FolderColorScheme
): string {
  const rgb = hexToRgb(groupColorHex(color, scheme)) ?? hexToRgb(groupColorHex(null, scheme))!
  return rgb.join(' ')
}

export interface GroupColorVars {
  '--zen-group-rgb-light': string
  '--zen-group-rgb-dark': string
}

/**
 * The group's colour as the §9.14 pair on an element: both schemes' channels, from which one
 * rule per theme in main.css derives `--zen-group-rgb` on every element marked `data-group-rgb`
 * (`:root[data-theme='dark'] [data-group-rgb] { --zen-group-rgb: var(--zen-group-rgb-dark) }`),
 * so every dot, ring, swatch, chip and line goes on reading `rgb(var(--zen-group-rgb) / α)` and a
 * theme flip recolours them all in the frame the window's tokens flip, with no component
 * reading the theme (the root's `data-theme`, `useTheme`'s, is the one source). Spread into the
 * element's `style`, with `data-group-rgb=""` on the same element.
 */
export function groupColorVars(color: FolderColor | null | undefined): GroupColorVars {
  return {
    '--zen-group-rgb-light': groupColorChannels(color, 'light'),
    '--zen-group-rgb-dark': groupColorChannels(color, 'dark')
  }
}

/** The first colour no other group of the space wears yet, cycling once they are all taken. */
export function nextGroupColor(state: UIState, spaceId: string): FolderColor {
  const palette = Object.keys(FOLDER_COLORS_LIGHT) as FolderColor[]
  const used = Object.values(state.folders)
    .filter((f) => f.spaceId === spaceId)
    .map((f) => f.color)
  const free = palette.find((c) => !used.includes(c))
  if (free) return free
  return palette[used.length % palette.length]
}

/** The group a tab is in, if it is in one that still exists. */
export function groupOf(state: UIState, tab: Tab | null | undefined): Folder | null {
  if (!tab?.folderId) return null
  return state.folders[tab.folderId] ?? null
}

/** Groups of a space in the order the overview and the swipe track show them. */
export function groupsOf(state: UIState, spaceId: string): Folder[] {
  return Object.values(state.folders).filter((f) => f.spaceId === spaceId)
}
