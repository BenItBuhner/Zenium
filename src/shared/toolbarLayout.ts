import type { ToolbarLayout } from './types'

/** The desktop layouts, in the order Look and Feel's card grid shows them (v2 §9.37, §10.4). */
export const TOOLBAR_LAYOUTS: readonly ToolbarLayout[] = [
  'single',
  'multiple',
  'collapsed',
  'horizontal'
]

/** The card's caption for a layout, as Settings names it. */
export const TOOLBAR_LAYOUT_LABELS: Readonly<Record<ToolbarLayout, string>> = {
  single: 'Only sidebar',
  multiple: 'Sidebar and top toolbar',
  collapsed: 'Collapsed sidebar',
  horizontal: 'Horizontal tabs'
}

/**
 * A stored layout read back: the three values older profiles wrote are kept as they are, the
 * new one is taken, and anything else (a value a newer build may write one day, a corrupt
 * field) falls back to the default rather than leaving the chrome without a shell.
 */
export function sanitizeToolbarLayout(value: unknown, fallback: ToolbarLayout): ToolbarLayout {
  return typeof value === 'string' && (TOOLBAR_LAYOUTS as readonly string[]).includes(value)
    ? (value as ToolbarLayout)
    : fallback
}

/** Whether the layout runs the tabs along the caption band (the strip, the rail, the toolbar row). */
export function isHorizontalTabs(layout: ToolbarLayout): boolean {
  return layout === 'horizontal'
}

/**
 * Whether the layout draws a top toolbar row of its own – the `multiple` layout's toolbar, or
 * the horizontal layout's row under the strip – as opposed to the navigation living in the
 * sidebar. What decides whether the sidebar's own nav row shows, and whether compact mode's
 * "hide toolbar" switch has a toolbar to hide.
 */
export function hasTopToolbar(layout: ToolbarLayout): boolean {
  return layout === 'multiple' || layout === 'horizontal'
}

/**
 * Whether the layout fixes the sidebar at the 56 rail whatever `sidebarExpanded` says: the
 * Collapsed sidebar layout, which is that rail with the navigation folded into it, and the
 * horizontal layout, whose rail beside the frame is the sidebar (§9.37). Where it does, the
 * expanded width is not the user's to choose, and Look and Feel's "Expanded sidebar" is a
 * dependent row (§10.4) until one of the other two layouts gives the choice back.
 */
export function forcesRail(layout: ToolbarLayout): boolean {
  return layout === 'collapsed' || layout === 'horizontal'
}
