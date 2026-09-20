import type { Folder, FolderColor, Tab, UIState } from '@shared/types'
import { FOLDER_COLOR_ORDER, FOLDER_COLORS } from '@shared/defaults'
import { hexToRgb } from '@shared/theme'

/** Folders are tab groups on the phone; this is the colour a group without one is painted in. */
export const DEFAULT_GROUP_COLOR: FolderColor = 'grey'

const GROUP_COLOR_NAMES: Record<FolderColor, string> = {
  grey: 'Grey',
  blue: 'Blue',
  red: 'Red',
  yellow: 'Yellow',
  green: 'Green',
  pink: 'Pink',
  purple: 'Purple',
  cyan: 'Cyan',
  orange: 'Orange'
}

/**
 * Chrome's nine group colours in Chrome's order (`FOLDER_COLOR_ORDER`, the order the core hands
 * them to new folders too), each with the name its swatch announces – the desktop group editor
 * bubble (tabs-13). The values are Zenium's own (`FOLDER_COLORS`, shared with the phone's
 * group cards).
 */
export const GROUP_PALETTE: ReadonlyArray<{ color: FolderColor; name: string }> =
  FOLDER_COLOR_ORDER.map((color) => ({ color, name: GROUP_COLOR_NAMES[color] }))

/** The group's colour as space-separated channels, for `rgb(<channels> / <alpha>)`. */
export function groupColorChannels(color: FolderColor | null | undefined): string {
  const rgb = hexToRgb(FOLDER_COLORS[color ?? DEFAULT_GROUP_COLOR]) ?? [138, 143, 156]
  return rgb.join(' ')
}

export function groupColorHex(color: FolderColor | null | undefined): string {
  return FOLDER_COLORS[color ?? DEFAULT_GROUP_COLOR]
}

/** The first colour no other group of the space wears yet, cycling once they are all taken. */
export function nextGroupColor(state: UIState, spaceId: string): FolderColor {
  const palette = Object.keys(FOLDER_COLORS) as FolderColor[]
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
