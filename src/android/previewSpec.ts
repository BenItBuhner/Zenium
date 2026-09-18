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

/** The furthest a held pull goes, as a multiple of the threshold (the disc is well out by then). */
export const PREVIEW_PULL_MAX = 2.5

export type PreviewState =
  | { kind: 'idle' }
  | {
      kind: 'overlay'
      overlay: OverlayKind
      /** Settings section to land on. */
      section?: string
      /** Text of an element in the overlay to scroll into view once it is open. */
      show?: string
    }
  | {
      kind: 'menu'
      /** Text of an item in the menu to scroll into view once it is open. */
      show?: string
    }
  | { kind: 'find'; text: string }
  | {
      kind: 'pull'
      /** How far the page is pulled: 1 is the threshold at which letting go refreshes. */
      progress: number
      /** Let go (past the threshold): the page reloads under the spinning disc. */
      released: boolean
    }
  | {
      kind: 'error'
      /** The Chromium `net::` code the load failed with (-105 for ERR_NAME_NOT_RESOLVED, …). */
      code: number
      /** The URL that failed; null for the active tab's own. */
      url: string | null
    }

/**
 * A preview state spec is a query string: `idle` (or anything unrecognised), `overlay=<kind>` for
 * one of PREVIEW_OVERLAYS (with `section=<id>` to land on a Settings section and `show=<text>` to
 * scroll a row of the overlay into view), `menu=app` for the app menu sheet (with `show=<text>` to
 * scroll an item into view), `find=<text>` for the find bar with that text typed (`find=` opens it
 * empty), `pull=<n>` for the active page held pulled down at n percent of the refresh threshold
 * (`pull=refresh` pulls past it and lets go), or `error=<code>` for the active tab's load failing
 * with that Chromium `net::` code (with `url=<target>` for the URL that failed, else the tab's
 * own), which puts up the zen://error page. When several are given, `overlay` wins over `menu`,
 * `menu` over `find`, `find` over `pull`, and `pull` over `error`. A leading `#` (the URL hash as
 * read) is ignored.
 */
export function parsePreviewSpec(spec: string): PreviewState {
  const params = new URLSearchParams(spec.startsWith('#') ? spec.slice(1) : spec)
  const overlay = params.get('overlay')
  if (overlay !== null && (PREVIEW_OVERLAYS as readonly string[]).includes(overlay)) {
    const state: Extract<PreviewState, { kind: 'overlay' }> = {
      kind: 'overlay',
      overlay: overlay as OverlayKind
    }
    const section = params.get('section')
    if (section) state.section = section
    const show = params.get('show')
    if (show) state.show = show
    return state
  }
  if (params.get('menu') === 'app') {
    const show = params.get('show')
    return show ? { kind: 'menu', show } : { kind: 'menu' }
  }
  const find = params.get('find')
  if (find !== null) return { kind: 'find', text: find }
  const pull = params.get('pull')
  if (pull === 'refresh') return { kind: 'pull', progress: PREVIEW_PULL_MAX, released: true }
  if (pull !== null && pull !== '' && Number.isFinite(Number(pull))) {
    const progress = Math.min(PREVIEW_PULL_MAX, Math.max(0, Number(pull) / 100))
    return { kind: 'pull', progress, released: false }
  }
  const error = params.get('error')
  if (error !== null && error !== '' && Number.isInteger(Number(error))) {
    return { kind: 'error', code: Number(error), url: params.get('url') || null }
  }
  return { kind: 'idle' }
}
