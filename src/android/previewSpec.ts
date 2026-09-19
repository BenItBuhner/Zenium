import type { OverlayKind } from '@shared/types'
import { INTERNAL_PAGE_IDS, type InternalPageId } from '@shared/internalPages'
import type { ThirdPartyCookieMode } from '@shared/privacy'

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
 * asks first), `hold` long-presses it (a row's menu opens), `type` fills the field with that id
 * the way a keyboard would and leaves it (the field is touched: a form's validation shows),
 * `back` is one system back (the top sheet closes, a section pops), `overview` opens the tab
 * overview over the page, `urlbar` opens the pill for editing.
 */
export type PreviewStep =
  | { kind: 'tap'; text: string }
  | { kind: 'hold'; text: string }
  | { kind: 'type'; id: string; text: string }
  | { kind: 'back' }
  | { kind: 'overview' }
  | { kind: 'urlbar' }

/** The chrome's own sheets a preview state may open by name (`sheet=<name>`). */
export const PREVIEW_SHEETS = ['extensions'] as const
export type PreviewSheet = (typeof PREVIEW_SHEETS)[number]

/** An extension id as Chrome forms them: 32 letters a–p. */
const EXTENSION_ID = /^[a-p]{32}$/

/**
 * The "Add to Home screen" surfaces a preview state may raise on the active tab: the install
 * sheet for the demo app (`install`), the name-edit sheet for a plain page (`name`), the ambient
 * banner (`banner`; the core raises it once the demo app has the engagement the profile seeds)
 * and the confirmation toast after a pin (`pinned`).
 */
export const PREVIEW_WEBAPP_SURFACES = ['install', 'name', 'banner', 'pinned'] as const
export type PreviewWebAppSurface = (typeof PREVIEW_WEBAPP_SURFACES)[number]

/**
 * The private-tab surfaces a preview state may show (`private=<surface>`): a private tab on its
 * new tab page (`newtab`; `new` is the same, as #135 first spelt it) or on a page (`page`;
 * `url=<page>` names it, example.com by default; `private=<url>` is that page as well), the tab
 * overview on its Private pane with that tab (`overview`), the overview on its Tabs pane while a
 * private tab is open elsewhere (`tabs`: the segment, and no private card among the regular
 * ones), and the Private pane with no private tab (`empty`: the explainer). `cookies=<mode>`
 * sets the third-party cookie setting first (`allow`, `block-private`, `block`), for the new tab
 * page's switch in each of its states.
 */
export const PREVIEW_PRIVATE_SURFACES = ['newtab', 'page', 'overview', 'tabs', 'empty'] as const
export type PreviewPrivateSurface = (typeof PREVIEW_PRIVATE_SURFACES)[number]
const PREVIEW_COOKIE_MODES: readonly ThirdPartyCookieMode[] = ['allow', 'block-private', 'block']

/** The menus a preview state may open: the app menu sheet, the Tabs button's quick menu. */
export const PREVIEW_MENUS = ['app', 'tabs'] as const
export type PreviewMenu = (typeof PREVIEW_MENUS)[number]

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

/** The most blocked pop-ups a preview seeds on the page (the list scrolls past a handful). */
export const PREVIEW_POPUPS_MAX = 12

/**
 * The autofill surfaces a preview state may stage with sample data: the four save prompts and
 * the passkey chooser (sheets), the picker strip for logins, addresses and cards (behind a
 * passphrase vault, `?vault=none`, its rows wear the lock and a tap asks for the passphrase),
 * Settings > Autofill with saved entries (`manager`), with none (`manager-empty`) and behind the
 * vault gate (`manager-locked`), its two editors (`edit-address` adds one, `edit-card` edits a
 * saved card) and the vault passphrase dialog a re-authenticated command puts up (`passphrase`,
 * the real one behind a passphrase vault).
 */
export const PREVIEW_AUTOFILL = [
  'save-login',
  'update-login',
  'save-address',
  'save-card',
  'passkey-account',
  'picker',
  'picker-address',
  'picker-card',
  'manager',
  'manager-empty',
  'manager-locked',
  'edit-address',
  'edit-card',
  'passphrase'
] as const

export type PreviewAutofillSurface = (typeof PREVIEW_AUTOFILL)[number]

export type PreviewState =
  | { kind: 'idle' }
  | {
      kind: 'autofill'
      surface: PreviewAutofillSurface
      /** For a manager surface (the Settings tab): text of a row to scroll into view once it is open. */
      show?: string
      /** For a manager surface: steps taken on the page once it is open and scrolled. */
      then?: PreviewStep[]
    }
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
      /**
       * An extension's page open as a tab (`chrome-extension://<id>/<path>`, the way its
       * options page opens), the stand-in host serving a page for it; `then` steps are taken
       * once it has loaded. With `extensions=<variant>` seeded, the chrome knows the extension.
       */
      kind: 'extension-page'
      id: string
      /** The page's path within the extension, no leading slash. */
      path: string
      then?: PreviewStep[]
    }
  | {
      /**
       * The active tab in a group of this many members, made on the spot (the group strip is up
       * in the bar band); `then` steps are taken once the group has formed.
       */
      kind: 'group'
      members: number
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
      /** Which menu: the app menu sheet, or the Tabs button's quick menu. */
      menu: PreviewMenu
      /** Text of an item in the menu to scroll into view once it is open. */
      show?: string
    }
  | {
      /** One of the chrome's own sheets, open over the active page; `then` steps are taken on it. */
      kind: 'sheet'
      sheet: PreviewSheet
      then?: PreviewStep[]
    }
  | {
      /** The active page asks for a permission (`prompt=<permission>`; the security dialogs' `prompt=` values are `kind: 'prompt'`). */
      kind: 'permission'
      /** The permission the active page asks for (`camera`, `notifications`, `geolocation`, …). */
      permission: string
    }
  | {
      kind: 'private'
      surface: PreviewPrivateSurface
      /** The page the private tab is on (`page`, `overview`, `tabs`); null for the default. */
      url: string | null
      /** The third-party cookie setting to put in place first; absent, the profile's stands. */
      cookies?: ThirdPartyCookieMode
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
  | {
      /**
       * QR scanning started from the active tab, the stand-in camera playing `script` back
       * (`previewQrScript` in preview.ts: `scanning`, `starting`, `torch`, `text`, `wifi`,
       * `busy`, `camera`, `denied`, `denied-permanently`, `unavailable`, or the default run to
       * a decoded address).
       */
      kind: 'qr'
      script: string
    }
  | {
      kind: 'popups'
      /** Pop-ups the blocker refused on the active page (the third and every sixth is an app launch). */
      count: number
      /** Open the list of them (the sheet on a phone). */
      list: boolean
      /** The site has "Always allow pop-ups" remembered. */
      allowed: boolean
    }
  | {
      kind: 'prompt'
      prompt: 'http-auth' | 'certificate'
      /** `http-auth`: the previous answer was refused. */
      failed: boolean
      /** `http-auth`: a proxy challenge. */
      proxy: boolean
      /** `http-auth`: the credentials travel over TLS (no unencrypted-password notice). */
      secure: boolean
    }
  | {
      /**
       * Voice search started from the active tab, the stand-in recogniser playing `script` back
       * (`previewVoiceScript` in preview.ts: `listening`, `partial`, `no-match`, `network`,
       * `busy`, `denied`, `denied-permanently`, `unavailable`, or the default run to a result).
       */
      kind: 'voice'
      script: string
    }
  /** The tab overview over the active page, as a pull on the pill opens it. */
  | { kind: 'overview' }
  | {
      /** The pill's editor (the phone omnibox) over the active tab, or over a new tab. */
      kind: 'urlbar'
      /** What has been typed; empty for the search-ready state with the page's header row. */
      text: string
      /** Over a new tab page (no header row) rather than the active tab's page. */
      newTab: boolean
      /** What the stand-in clipboard holds (null: unchanged); the clipboard row reads its kind. */
      clip: string | null
      /** Steps taken once the suggestions are up (`tap:Show`, `tap:Edit`, `tap:Refine`). */
      then?: PreviewStep[]
    }

/** More sample banners than the stack holds are pointless. */
const MAX_PREVIEW_BANNERS = 3
/** A group of more members than this would only scroll the strip further. */
const MAX_PREVIEW_GROUP = 24

/** What a spec seeds before its state is applied; `null` leaves the store as it is. */
export interface PreviewSeed {
  /** Remembered site permissions for Settings → Security (0 forgets them all). */
  rules: number | null
}

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
 * afterwards, `;`-separated: `tap:<text>`, `hold:<text>`, `type:<id>=<text>`, `back`,
 * `overview`, `urlbar`), `extension-page=<id>/<path>` for an extension's page open as a tab (its
 * options page, say; `extensions=<variant>` alongside seeds the extensions the chrome knows,
 * `then=<steps>` takes steps once it has loaded), `group=<n>` for the
 * active tab in a group of n members made on the spot, the group strip up in the bar band (with
 * `then=<steps>` taken once the group has formed: `tap:Show group, Research` presses the strip's
 * show chip, `tap:New tab in Research` its plus chip), `overlay=<kind>` for
 * one of PREVIEW_OVERLAYS (with `section=<id>` for an overlay that has sections, `show=<text>`
 * to scroll a row of the overlay into view, and `expand` to rest a sheet that opened at its peek
 * detent on its expanded one), `menu=app` for the app menu sheet or `menu=tabs` for the Tabs
 * button's quick menu (with `show=<text>` to scroll an item into view), `sheet=<name>` for one
 * of PREVIEW_SHEETS, the chrome's own sheets (the Extensions sheet the app menu's row opens;
 * `then=<steps>` takes steps on it: `tap:<row>` is the row's tap, `hold:<row>` its long press),
 * `prompt=<permission>` for the active page asking for that permission (the prompt sheet),
 * `private=<surface>` for one of PREVIEW_PRIVATE_SURFACES (a private tab on its new tab page or
 * a page, the overview's Tabs and Private panes and the empty Private pane; `url=<page>` names
 * the private tab's page; `private=new` is the new tab page and `private=<url>` that page, as
 * #135 spelt them),
 * `autofill=<surface>` for one of PREVIEW_AUTOFILL staged with sample data (a manager surface is
 * the Settings tab on its Autofill section and takes `show=<text>` and `then=<steps>` like
 * `page`), `find=<text>` for the find bar with that text typed (`find=` opens it empty),
 * `pull=<n>` for the active page held pulled down at n percent of the refresh threshold
 * (`pull=refresh` pulls past it and lets go), `zoom=<factor>` for the page zoom sheet with the
 * active tab's site at that factor (`zoom=` opens it as it is), `error=<code>` for the active
 * tab's load failing with that Chromium `net::` code (with `url=<target>` for the URL that
 * failed, else the tab's own), which puts up the zen://error page, any of `toast=<text>` (with
 * `action=<label>`, `kind=error`), `banners=<n>` and `progress=<0…1>` together for the message
 * surfaces and the load bar, `webapp=<surface>` for one of PREVIEW_WEBAPP_SURFACES ("Add to
 * Home screen"), `download=<file>` for a transfer the stand-in downloader plays back
 * (`size=<bytes>`, `at=<percent>` already received, `speed=<bytes per second>`, `paused`,
 * `fail=<error>`, `deleted` for a finished file since gone from disk, `private`, `url=<url>`,
 * `mime=<type>`), `popups=<n>` for n pop-ups blocked on the active page (`&list` opens the list
 * of them, `&allowed` remembers the site as allowed), `prompt=http-auth` / `prompt=certificate`
 * for a security dialog over the page (`&failed`, `&proxy`, `&secure` vary the sign-in),
 * `prompt=<any other value>` for the permission that page asks for (the permission prompt
 * sheet), `private=<surface>|new|<url>` for a private tab, `voice=<script>` for voice search from the
 * active tab, `overview` for the tab overview over the active page (the grid of cards, with
 * whatever pictures the stand-in host has of the tabs), or `urlbar=<text>` for the pill's
 * editor over the active tab with that text typed (`urlbar=` opens it search-ready, with the
 * page's header row; `newtab` opens it over a new tab page instead; `clip=<text>` puts that on
 * the stand-in clipboard first, so the clipboard row shows; `then=tap:<label>;…` presses the
 * editor's controls once the suggestions are up: `Show`, `Edit`, `Refine`). When several are
 * given, `page` wins over `extension-page`, that over `group`, `group` over `overlay`, `overlay`
 * over `menu`, `menu` over `sheet`, `sheet` over the permission `prompt`, that over `private`,
 * `private` over `autofill`, `autofill` over `find`, `find` over `pull`, `pull` over `zoom`,
 * `zoom` over `error`, `error` over the messages, the messages over `webapp`, `webapp` over
 * `download`, `download` over `popups`, `popups` over the security `prompt`, that over `voice`,
 * `voice` over `overview`, and `overview` over `urlbar`. A leading `#` (the URL hash as read) is
 * ignored.
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
  const extensionPage = parseExtensionPage(params.get('extension-page'))
  if (extensionPage) {
    const then = parsePreviewSteps(params.get('then'))
    return then.length > 0 ? { ...extensionPage, then } : extensionPage
  }
  const group = params.get('group')
  if (group !== null && group !== '' && Number.isFinite(Number(group))) {
    const members = Math.min(MAX_PREVIEW_GROUP, Math.max(1, Math.floor(Number(group))))
    const then = parsePreviewSteps(params.get('then'))
    return then.length > 0 ? { kind: 'group', members, then } : { kind: 'group', members }
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
  const menu = params.get('menu')
  if (menu !== null && (PREVIEW_MENUS as readonly string[]).includes(menu)) {
    const state: Extract<PreviewState, { kind: 'menu' }> = {
      kind: 'menu',
      menu: menu as PreviewMenu
    }
    const show = params.get('show')
    if (show) state.show = show
    return state
  }
  const sheet = params.get('sheet')
  if (sheet !== null && (PREVIEW_SHEETS as readonly string[]).includes(sheet)) {
    const then = parsePreviewSteps(params.get('then'))
    const state: Extract<PreviewState, { kind: 'sheet' }> = {
      kind: 'sheet',
      sheet: sheet as PreviewSheet
    }
    return then.length > 0 ? { ...state, then } : state
  }
  // `prompt=` names a permission the page asks for, unless it names one of the security dialogs
  // (`http-auth`, `certificate`), which come up last in this order (below).
  const prompt = params.get('prompt')
  const securityPrompt = prompt === 'http-auth' || prompt === 'certificate'
  if (prompt && !securityPrompt) return { kind: 'permission', permission: prompt }
  const priv = params.get('private')
  if (priv !== null && priv !== '') return parsePrivate(priv, params)
  const autofill = params.get('autofill')
  if (autofill !== null && (PREVIEW_AUTOFILL as readonly string[]).includes(autofill)) {
    const state: Extract<PreviewState, { kind: 'autofill' }> = {
      kind: 'autofill',
      surface: autofill as PreviewAutofillSurface
    }
    const show = params.get('show')
    if (show) state.show = show
    const then = parsePreviewSteps(params.get('then'))
    if (then.length > 0) state.then = then
    return state
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
  const qr = params.get('qr')
  if (qr !== null) return { kind: 'qr', script: qr || 'url' }
  const popups = params.get('popups')
  if (popups !== null && popups !== '' && Number.isFinite(Number(popups))) {
    const count = Math.min(PREVIEW_POPUPS_MAX, Math.max(0, Math.floor(Number(popups))))
    return { kind: 'popups', count, list: params.has('list'), allowed: params.has('allowed') }
  }
  if (prompt === 'http-auth' || prompt === 'certificate') {
    return {
      kind: 'prompt',
      prompt,
      failed: params.has('failed'),
      proxy: params.has('proxy'),
      secure: params.has('secure')
    }
  }
  const voice = params.get('voice')
  if (voice !== null) return { kind: 'voice', script: voice || 'heard' }
  if (params.has('overview')) return { kind: 'overview' }
  const urlbar = params.get('urlbar')
  if (urlbar !== null) {
    const state: Extract<PreviewState, { kind: 'urlbar' }> = {
      kind: 'urlbar',
      text: urlbar,
      newTab: params.has('newtab'),
      clip: params.get('clip')
    }
    const then = parsePreviewSteps(params.get('then'))
    if (then.length > 0) state.then = then
    return state
  }
  return { kind: 'idle' }
}

/**
 * `private=<value>`: one of PREVIEW_PRIVATE_SURFACES, with `url=<page>` for the page the private
 * tab is on; a URL as the value is that page (`private=<url>`), and any other value – `new`,
 * `1` – is the private tab on its new tab page. `cookies=<mode>` rides along on any of them.
 */
function parsePrivate(value: string, params: URLSearchParams): PreviewState {
  const state: Extract<PreviewState, { kind: 'private' }> = (
    PREVIEW_PRIVATE_SURFACES as readonly string[]
  ).includes(value)
    ? { kind: 'private', surface: value as PreviewPrivateSurface, url: params.get('url') || null }
    : /^https?:\/\//.test(value)
      ? { kind: 'private', surface: 'page', url: value }
      : { kind: 'private', surface: 'newtab', url: null }
  const cookies = params.get('cookies')
  if (cookies !== null && (PREVIEW_COOKIE_MODES as readonly string[]).includes(cookies)) {
    state.cookies = cookies as ThirdPartyCookieMode
  }
  return state
}

/**
 * The `then=` list: `tap:<text>;hold:<text>;type:<id>=<text>;back;overview;urlbar`; blanks and
 * unknown steps are dropped.
 */
export function parsePreviewSteps(list: string | null): PreviewStep[] {
  if (!list) return []
  const steps: PreviewStep[] = []
  for (const raw of list.split(';')) {
    const step = raw.trim()
    if (step.startsWith('tap:') || step.startsWith('hold:')) {
      const kind = step.startsWith('tap:') ? 'tap' : 'hold'
      const text = step.slice(kind.length + 1).trim()
      if (text) steps.push({ kind, text })
    } else if (step.startsWith('type:')) {
      const at = step.indexOf('=')
      const id = at === -1 ? '' : step.slice('type:'.length, at).trim()
      if (id) steps.push({ kind: 'type', id, text: step.slice(at + 1) })
    } else if (step === 'back' || step === 'overview' || step === 'urlbar') {
      steps.push({ kind: step })
    }
  }
  return steps
}

/**
 * `extension-page=<id>/<path>`: the id as Chrome forms them, then the page's path within the
 * extension (`<id>` alone or `<id>/` is the extension's root). Null for anything else.
 */
function parseExtensionPage(
  value: string | null
): Extract<PreviewState, { kind: 'extension-page' }> | null {
  if (!value) return null
  const slash = value.indexOf('/')
  const id = slash === -1 ? value : value.slice(0, slash)
  if (!EXTENSION_ID.test(id)) return null
  const path = slash === -1 ? '' : value.slice(slash + 1).replace(/^\/+/, '')
  return { kind: 'extension-page', id, path }
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

/** The seeding a spec asks for on top of its state: `rules=<n>` remembered site permissions. */
export function parsePreviewSeed(spec: string): PreviewSeed {
  const params = new URLSearchParams(spec.startsWith('#') ? spec.slice(1) : spec)
  const rules = params.get('rules')
  return {
    rules:
      rules !== null && rules !== '' && Number.isFinite(Number(rules))
        ? Math.max(0, Math.floor(Number(rules)))
        : null
  }
}
