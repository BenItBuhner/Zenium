import type { OverlayKind } from '@shared/types'
import { INTERNAL_PAGE_IDS, type InternalPageId } from '@shared/internalPages'

/**
 * The overlays a preview state may open by name. Settings (with the Shortcuts and Sync overlays,
 * its sections) is not one: on this host it is a tab, `page=settings`.
 */
export const PREVIEW_OVERLAYS: readonly OverlayKind[] = [
  'history',
  'bookmarks',
  'downloads',
  'theme',
  'onboarding',
  'space-editor',
  'boosts',
  'addons',
  'live-folder',
  'passwords'
]

/** The furthest a held pull goes, as a multiple of the threshold (the disc is well out by then). */
export const PREVIEW_PULL_MAX = 2.5

/**
 * A step taken on a page once it is open, in order: `tap` presses the first button whose label
 * or text reads so (a row opens its sheet, a sheet's row stacks another, a destructive action
 * asks first), `back` is one system back (the top sheet closes, a section pops), `overview` opens
 * the tab overview over the page, `urlbar` opens the pill for editing.
 */
export type PreviewStep =
  { kind: 'tap'; text: string } | { kind: 'back' } | { kind: 'overview' } | { kind: 'urlbar' }

/**
 * The "Add to Home screen" surfaces a preview state may raise on the active tab: the install
 * sheet for the demo app (`install`), the name-edit sheet for a plain page (`name`), the ambient
 * banner (`banner`; the core raises it once the demo app has the engagement the profile seeds)
 * and the confirmation toast after a pin (`pinned`).
 */
export const PREVIEW_WEBAPP_SURFACES = ['install', 'name', 'banner', 'pinned'] as const
export type PreviewWebAppSurface = (typeof PREVIEW_WEBAPP_SURFACES)[number]

/** A download the preview host's stand-in downloader plays back (`download=<file>`). */
export interface PreviewDownloadSpec {
  filename: string
  url: string
  mimeType: string
  totalBytes: number
  /** Bytes already there when the transfer shows up. */
  receivedBytes: number
  bytesPerSecond: number
  /** The transfer stops right away, paused where it is. */
  paused: boolean
  /** The transfer fails where it is, with this error (`network-timeout`, `file-no-space`, …). */
  error: string | null
  /** The transfer is already complete and its file since gone: the row reads Deleted (#166). */
  deleted: boolean
  /** The file comes from the private container. */
  private: boolean
}

export type PreviewState =
  | { kind: 'idle' }
  | {
      /** An internal page in its tab (`page.open`): Settings, on its landing or a section. */
      kind: 'page'
      page: InternalPageId
      section?: string
      /** Text of an element on the page to scroll into view once it is open. */
      show?: string
      /** Text typed into the page's search field once it is open (the Settings landing). */
      search?: string
      /** Steps taken after the page is open, searched and scrolled. */
      then?: PreviewStep[]
    }
  | {
      kind: 'overlay'
      overlay: OverlayKind
      /** The overlay's section to land on (History's `host:<host>`). */
      section?: string
      /** Text of an element in the overlay to scroll into view once it is open. */
      show?: string
      /** A sheet that opens at its peek detent: tap its handle so it rests expanded. */
      expand?: boolean
    }
  | {
      kind: 'menu'
      /** Text of an item in the menu to scroll into view once it is open. */
      show?: string
    }
  | {
      kind: 'prompt'
      /** The permission the active page asks for (`camera`, `notifications`, `geolocation`, …). */
      permission: string
    }
  | {
      kind: 'private'
      /** The page the private tab opens on; null for a blank one. */
      url: string | null
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
      /** The page zoom sheet, the active tab's site at `factor` (null: as it is). */
      kind: 'zoom'
      factor: number | null
    }
  | {
      kind: 'error'
      /** The Chromium `net::` code the load failed with (-105 for ERR_NAME_NOT_RESOLVED, …). */
      code: number
      /** The URL that failed; null for the active tab's own. */
      url: string | null
    }
  | {
      kind: 'messages'
      /** A toast with this text (and an action labelled `action`, an `error` when so marked). */
      toast: { message: string; action: string | null; error: boolean } | null
      /** This many sample banners stacked under the toolbar. */
      banners: number
      /** The active tab shown loading, its bar at this fraction. */
      progress: number | null
    }
  | { kind: 'webapp'; surface: PreviewWebAppSurface }
  | { kind: 'download'; download: PreviewDownloadSpec }

/** More sample banners than the stack holds are pointless. */
const MAX_PREVIEW_BANNERS = 3

/** Types for the stand-in downloader to report, by extension; anything else is a plain stream. */
const PREVIEW_MIME_TYPES: Record<string, string> = {
  apk: 'application/vnd.android.package-archive',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mp3: 'audio/mpeg',
  zip: 'application/zip',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  exe: 'application/x-msdownload',
  sh: 'application/x-sh'
}

/**
 * A preview state spec is a query string: `idle` (or anything unrecognised), `page=<id>` for an
 * internal page opened in its tab (`section=<id>` for one of its sections, `search=<text>` types
 * into its search field, `show=<text>` scrolls a row into view, `then=<steps>` takes steps on it
 * afterwards, `;`-separated: `tap:<text>`, `back`, `overview`, `urlbar`), `overlay=<kind>` for
 * one of PREVIEW_OVERLAYS (with `section=<id>` for an overlay that has sections, `show=<text>`
 * to scroll a row of the overlay into view, and `expand` to rest a sheet that opened at its peek
 * detent on its expanded one), `menu=app` for the app menu sheet (with `show=<text>` to scroll an
 * item into view), `prompt=<permission>` for the active page asking for that permission (the
 * prompt sheet), `private=new` for a blank private tab (`private=<url>` opens one on that page),
 * `find=<text>` for the find bar with that text typed (`find=` opens it empty),
 * `pull=<n>` for the active page held pulled down at n percent of the refresh threshold
 * (`pull=refresh` pulls past it and lets go), `zoom=<factor>` for the page zoom sheet with the
 * active tab's site at that factor (`zoom=` opens it as it is), `error=<code>` for the active
 * tab's load failing with that Chromium `net::` code (with `url=<target>` for the URL that
 * failed, else the tab's own), which puts up the zen://error page, any of `toast=<text>` (with
 * `action=<label>`, `kind=error`), `banners=<n>` and `progress=<0…1>` together for the message
 * surfaces and the load bar, `webapp=<surface>` for one of PREVIEW_WEBAPP_SURFACES ("Add to
 * Home screen"), or `download=<file>` for a transfer the stand-in downloader plays back
 * (`size=<bytes>`, `at=<percent>` already received, `speed=<bytes per second>`, `paused`,
 * `fail=<error>`, `deleted` for a finished file since gone from disk, `private`, `url=<url>`,
 * `mime=<type>`). When several are given, `page` wins over `overlay`, `overlay` over `menu`,
 * `menu` over `prompt`, `prompt` over `private`, `private` over `find`, `find` over `pull`,
 * `pull` over `zoom`, `zoom` over `error`, `error` over the messages, the messages over `webapp`
 * and `webapp` over `download`. A leading `#` (the URL hash as read) is ignored.
 */
export function parsePreviewSpec(spec: string): PreviewState {
  const params = new URLSearchParams(spec.startsWith('#') ? spec.slice(1) : spec)
  const page = params.get('page')
  if (page !== null && (INTERNAL_PAGE_IDS as readonly string[]).includes(page)) {
    const state: Extract<PreviewState, { kind: 'page' }> = {
      kind: 'page',
      page: page as InternalPageId
    }
    const section = params.get('section')
    if (section) state.section = section
    const search = params.get('search')
    if (search) state.search = search
    const show = params.get('show')
    if (show) state.show = show
    const then = parsePreviewSteps(params.get('then'))
    if (then.length > 0) state.then = then
    return state
  }
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
    if (params.has('expand')) state.expand = true
    return state
  }
  if (params.get('menu') === 'app') {
    const show = params.get('show')
    return show ? { kind: 'menu', show } : { kind: 'menu' }
  }
  const prompt = params.get('prompt')
  if (prompt) return { kind: 'prompt', permission: prompt }
  const priv = params.get('private')
  if (priv !== null && priv !== '') {
    return { kind: 'private', url: /^https?:\/\//.test(priv) ? priv : null }
  }
  const find = params.get('find')
  if (find !== null) return { kind: 'find', text: find }
  const pull = params.get('pull')
  if (pull === 'refresh') return { kind: 'pull', progress: PREVIEW_PULL_MAX, released: true }
  if (pull !== null && pull !== '' && Number.isFinite(Number(pull))) {
    const progress = Math.min(PREVIEW_PULL_MAX, Math.max(0, Number(pull) / 100))
    return { kind: 'pull', progress, released: false }
  }
  const zoom = params.get('zoom')
  if (zoom !== null) {
    const factor = parseFloat(zoom)
    return { kind: 'zoom', factor: Number.isFinite(factor) && factor > 0 ? factor : null }
  }
  const error = params.get('error')
  if (error !== null && error !== '' && Number.isInteger(Number(error))) {
    return { kind: 'error', code: Number(error), url: params.get('url') || null }
  }
  const toast = params.get('toast')
  const banners = params.get('banners')
  const progress = params.get('progress')
  if (toast !== null || banners !== null || progress !== null) {
    const count = banners === null ? 0 : Math.floor(Number(banners))
    const fraction = progress === null ? Number.NaN : Number(progress)
    return {
      kind: 'messages',
      toast:
        toast === null
          ? null
          : {
              message: toast,
              action: params.get('action'),
              error: params.get('kind') === 'error'
            },
      banners: Number.isFinite(count) ? Math.min(MAX_PREVIEW_BANNERS, Math.max(0, count)) : 0,
      progress: Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : null
    }
  }
  const webapp = params.get('webapp')
  if (webapp !== null && (PREVIEW_WEBAPP_SURFACES as readonly string[]).includes(webapp)) {
    return { kind: 'webapp', surface: webapp as PreviewWebAppSurface }
  }
  const download = params.get('download')
  if (download) return { kind: 'download', download: parseDownload(download, params) }
  return { kind: 'idle' }
}

/** The `then=` list: `tap:<text>;back;overview;urlbar`; blanks and unknown steps are dropped. */
export function parsePreviewSteps(list: string | null): PreviewStep[] {
  if (!list) return []
  const steps: PreviewStep[] = []
  for (const raw of list.split(';')) {
    const step = raw.trim()
    if (step.startsWith('tap:')) {
      const text = step.slice('tap:'.length).trim()
      if (text) steps.push({ kind: 'tap', text })
    } else if (step === 'back' || step === 'overview' || step === 'urlbar') {
      steps.push({ kind: step })
    }
  }
  return steps
}

function parseDownload(filename: string, params: URLSearchParams): PreviewDownloadSpec {
  const number = (key: string, fallback: number): number => {
    const raw = params.get(key)
    const value = raw === null || raw === '' ? NaN : Number(raw)
    return Number.isFinite(value) && value >= 0 ? value : fallback
  }
  const totalBytes = Math.round(number('size', 48_217_088))
  const at = Math.min(100, number('at', 40))
  const ext = filename.toLowerCase().split('.').pop() ?? ''
  const error = params.get('fail')
  return {
    filename,
    url: params.get('url') || `https://downloads.example.com/${encodeURIComponent(filename)}`,
    mimeType: params.get('mime') || PREVIEW_MIME_TYPES[ext] || 'application/octet-stream',
    totalBytes,
    receivedBytes: Math.round((totalBytes * at) / 100),
    bytesPerSecond: Math.round(number('speed', 2_400_000)),
    paused: params.has('paused'),
    error: error ? error : null,
    deleted: params.has('deleted'),
    private: params.has('private')
  }
}
