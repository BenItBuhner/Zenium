import type { ExtensionInfo } from '@shared/types'

/** Desktop toolbar icon button and the gap between neighbours (design-language.md §5, §8.3). */
export const TOOLBAR_BUTTON = 28
export const TOOLBAR_GAP = 2

/**
 * Narrowest address pill worth keeping before actions start folding into the puzzle menu: the
 * site icon and about eight characters of host, close to where Firefox lets its toolbar overflow.
 * The default 240 sidebar leaves the pill under this with no actions at all, so there every
 * pinned action lives in the puzzle panel until the sidebar is widened past about 290.
 */
export const MIN_PILL_WIDTH = 100

export interface ToolbarFit {
  /** Pinned actions that get their own 28 button, in pin order. */
  shown: number
  /** Pinned actions folded into the puzzle-piece panel. */
  hidden: number
}

export interface ToolbarFitInput {
  /** Width of the whole navigation row. */
  rowWidth: number
  /** Buttons that are always present (back, forward, reload, puzzle, menu…). */
  fixedButtons: number
  /** How many actions are pinned. */
  pinned: number
  /** Address pill floor; 0 when the row has no pill (compact layouts). */
  minPillWidth?: number
  button?: number
  gap?: number
}

/**
 * How many pinned actions fit beside the address pill. Every button costs its box plus one gap;
 * the pill keeps `minPillWidth` and takes the rest. Never negative, never more than pinned.
 */
export function fitToolbarActions({
  rowWidth,
  fixedButtons,
  pinned,
  minPillWidth = MIN_PILL_WIDTH,
  button = TOOLBAR_BUTTON,
  gap = TOOLBAR_GAP
}: ToolbarFitInput): ToolbarFit {
  if (pinned <= 0 || rowWidth <= 0) return { shown: 0, hidden: Math.max(0, pinned) }
  const slot = button + gap
  const fixed = fixedButtons * slot + minPillWidth
  const free = rowWidth - fixed
  const shown = Math.max(0, Math.min(pinned, Math.floor(free / slot)))
  return { shown, hidden: pinned - shown }
}

/** Extensions that can act from the toolbar: enabled, loaded, and either popup- or click-driven. */
export function actionable(extensions: readonly ExtensionInfo[]): ExtensionInfo[] {
  return extensions.filter((e) => e.enabled && !e.error && (e.action?.enabled ?? true))
}

/** The toolbar's pinned actions, in list order (the puzzle panel holds the rest). */
export function pinnedActions(extensions: readonly ExtensionInfo[]): ExtensionInfo[] {
  return actionable(extensions).filter((e) => e.pinned)
}

/** The icon the toolbar shows: the action's own icon first, then the manifest icon. */
export function actionIcon(ext: ExtensionInfo): string | null {
  return ext.action?.icon ?? ext.icon
}

/** The tooltip: the action title (Chrome's `action.default_title`), then the extension name. */
export function actionTitle(ext: ExtensionInfo): string {
  const title = ext.action?.title?.trim()
  return title && title.length > 0 ? title : ext.name
}
