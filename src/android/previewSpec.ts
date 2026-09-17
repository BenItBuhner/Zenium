import type { OverlayKind } from '@shared/types'

/** The overlays a preview state may open by name. */
export const PREVIEW_OVERLAYS: readonly OverlayKind[] = [
  'settings',
  'history',
  'bookmarks',
  'downloads',
  'theme',
  'onboarding',
  'shortcuts',
  'space-editor',
  'boosts',
  'addons',
  'live-folder',
  'sync'
]

export type PreviewState =
  { kind: 'idle' } | { kind: 'overlay'; overlay: OverlayKind } | { kind: 'find'; text: string }

/**
 * A preview state spec is a query string: `idle` (or anything unrecognised), `overlay=<kind>` for
 * one of PREVIEW_OVERLAYS, or `find=<text>` for the find bar with that text typed (`find=` opens
 * it empty). `overlay` wins when both are given. A leading `#` (the URL hash as read) is ignored.
 */
export function parsePreviewSpec(spec: string): PreviewState {
  const params = new URLSearchParams(spec.startsWith('#') ? spec.slice(1) : spec)
  const overlay = params.get('overlay')
  if (overlay !== null && (PREVIEW_OVERLAYS as readonly string[]).includes(overlay)) {
    return { kind: 'overlay', overlay: overlay as OverlayKind }
  }
  const find = params.get('find')
  if (find !== null) return { kind: 'find', text: find }
  return { kind: 'idle' }
}
