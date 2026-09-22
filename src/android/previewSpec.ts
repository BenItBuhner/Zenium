import type { OverlayKind, PhoneBarPosition } from '@shared/types'
import { INTERNAL_PAGE_IDS, type InternalPageId } from '@shared/internalPages'
import type { ThirdPartyCookieMode } from '@shared/privacy'
import type { SiteDataList } from '@shared/siteData'
import { isPreviewPdfVariant, type PreviewPdfVariant } from './previewPdf'
import { isPreviewSiteDataOrigins, type PreviewSiteDataOrigins } from './previewSiteData'

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
 * asks first), `hold` long-presses it (a row's menu opens), `press` rests a finger on it for
 * the long-press time and lifts in place (an overview card's hold sheet, which the pointer's
 * timer opens, not the `contextmenu` a row's hold takes), `type` fills the field with that id
 * the way a keyboard would and leaves it (the field is touched: a form's validation shows),
 * `back` is one system back (the top sheet closes, a section pops), `overview` opens the tab
 * overview over the page, `urlbar` opens the pill for editing.
 */
export type PreviewStep =
  | { kind: 'tap'; text: string }
  | { kind: 'hold'; text: string }
  | { kind: 'press'; text: string }
  | { kind: 'type'; id: string; text: string }
  | { kind: 'back' }
  | { kind: 'overview' }
  | { kind: 'urlbar' }

/**
 * The chrome's own sheets a preview state may open by name (`sheet=<name>`): the Extensions
 * sheet, the new tab page's customise sheet (`customise`), which mounts above whichever page
 * is up, the default-browser promo (`promo`: the core's campaign made due over the active
 * page, as the third session raises it) and the Send to your devices picker (`send-tab`, the
 * menu's row on a phone with several devices; `sync=tabs` gives it the devices to list).
 */
export const PREVIEW_SHEETS = ['extensions', 'customise', 'promo', 'send-tab'] as const
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
 * The read-aloud player's scripted states (`readAloud=<status>`): the model's `ReadAloudStatus`
 * values a docked player shows – `playing` (the default), `paused`, `loading` (the engine
 * preparing: the play control busy), `ended` (the last sentence read) and `error` (no voice for
 * the text's language); `idle` has no panel, so it is not one.
 */
export const PREVIEW_READ_ALOUD_STATUSES = [
  'playing',
  'paused',
  'loading',
  'ended',
  'error'
] as const
export type PreviewReadAloudStatus = (typeof PREVIEW_READ_ALOUD_STATUSES)[number]

/**
 * The private-tab surfaces a preview state may show (`private=<surface>`): a private tab on its
 * new tab page (`newtab`; `new` is the same, as #135 first spelt it) or on a page (`page`;
 * `url=<page>` names it, example.com by default; `private=<url>` is that page as well), the tab
 * overview on its Private pane with that tab (`overview`), the overview on its Tabs pane while a
 * private tab is open elsewhere (`tabs`: the segment, and no private card among the regular
 * ones), and the Private pane with no private tab (`empty`: the explainer). `cookies=<mode>`
 * sets the third-party cookie setting first (`allow`, `block-private`, `block`), for the new tab
 * page's switch in each of its states; `then=<steps>` takes steps once the surface is up
 * (`tap:More` opens the overview's header menu, a second tap on its row the question).
 */
export const PREVIEW_PRIVATE_SURFACES = ['newtab', 'page', 'overview', 'tabs', 'empty'] as const
export type PreviewPrivateSurface = (typeof PREVIEW_PRIVATE_SURFACES)[number]
const PREVIEW_COOKIE_MODES: readonly ThirdPartyCookieMode[] = ['allow', 'block-private', 'block']

/**
 * The phone new tab page's field on its way to the omnibox (`ntp=<pose>`; NTP-02 / MOT-08,
 * `lib/fakeboxMorph.ts`): `rest` is the page as it opens, `morph:<n>` the field held n percent
 * of the way from the page to the omnibox with the bar open under it (the stills' source; the
 * spring never rests there), `open` the field landed and the omnibox its own, `scroll:<px>` the
 * page scrolled by that many px (the field carried toward the pill's slot as far as the page can
 * scroll), `scrub:<n>` the page scrolled to n percent of the field's travel to the slot, and
 * `docked` scrolled until the field has landed in the slot. `&private` puts the pose on the
 * private new tab page; `bar=top` on the spec docks the bar at the top first (a seed).
 */
export type PreviewNtpPose =
  | { kind: 'rest' }
  | { kind: 'morph'; t: number }
  | { kind: 'open' }
  | { kind: 'scroll'; px: number }
  | { kind: 'scrub'; t: number }
  | { kind: 'docked' }

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
  /**
   * With `error` a `network-*` reason: how many of the downloader's own attempts fail again
   * before one gets through. The stand-in then retries as `Downloads.kt` does (HB-43) – 2, 4,
   * then 8 s after each failure, the attempt's time announced with the interruption
   * (`autoResumeAt`), so the row counts down – and gives up after the third attempt fails,
   * leaving the row interrupted with Resume. Absent or 0, the failure is final at once.
   */
  retrying?: number
  /** The transfer is already complete and its file since gone: the row reads Deleted (#166). */
  deleted: boolean
  /** The file comes from the private container. */
  private: boolean
  /** The tab whose own navigation produced the response (a PDF the viewer opens), if one did. */
  sourceTabId?: string | null
  /** The response came from the tab's navigation rather than a "Download link" (`core/pdf.ts`). */
  navigation?: boolean
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
 * the real one behind a passphrase vault). Three more from the credential-safety package: the
 * sign-in leak warning over the active tab (`leak-warning`: the detector checks a sample sign-in
 * against a stand-in range answer, so the sheet or dialog is the engine's own, ID-31), the
 * password manager open on a login that carries a note (`login-note`: the vault seeded with it,
 * the manager over the page; `then=tap:<row>;tap:Edit` walks to the detail and its edit view,
 * ID-34) and Safety check after a Password Checkup (`safety-check`: the vault seeded with logins
 * the checkup finds breached, weak and reused against the stand-in, the checkup run, Safety
 * check run, the Settings tab on its Privacy section – a manager-like surface, so it takes
 * `show` and `then`; ID-19).
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
  'passphrase',
  'leak-warning',
  'login-note',
  'safety-check'
] as const

export type PreviewAutofillSurface = (typeof PREVIEW_AUTOFILL)[number]

/**
 * What a `media=<variant>` state has a page report (the Now playing chip comes up in the pill):
 * `audio`, a track with Media Session metadata, artwork and track handlers, playing; `paused`,
 * the same paused; `video`, a video without metadata or handlers (the tab's title, the site, the
 * note tile, the track buttons at .4, the picture-in-picture row); `elsewhere`, the track
 * playing in another tab than the one on screen (the sheet's "Switch to tab" row).
 */
export const PREVIEW_MEDIA = ['audio', 'paused', 'video', 'elsewhere'] as const
export type PreviewMediaVariant = (typeof PREVIEW_MEDIA)[number]

export type PreviewState =
  | { kind: 'idle' }
  | {
      kind: 'autofill'
      surface: PreviewAutofillSurface
      /** For a manager surface (the Settings tab): text of a row to scroll into view once it is open. */
      show?: string
      /**
       * For a manager surface: steps taken on the page once it is open and scrolled; for
       * `login-note`, steps taken in the manager once it is open (`tap:<row>`, `tap:Edit`).
       */
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
       * in the bar band); `then` steps are taken once the group has formed. With `saved`, a
       * second group is made and closed first, so the space also holds a SAVED group – its tabs
       * closed, their pages kept (TAB-16) – for the overview's Groups pane and the tablet
       * sidebar's saved row. `link` names a page: once the steps are taken, the active page's
       * context menu is raised for a link to it, the way a hold on a link raises it (TAB-15's
       * Open Link in New Tab in Group is in it while the tab is in the group).
       */
      kind: 'group'
      members: number
      saved?: boolean
      link?: string
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
      /** Steps taken once the overlay is open (a row held for selection mode, a row tapped). */
      then?: PreviewStep[]
    }
  | {
      kind: 'menu'
      /** Which menu: the app menu sheet, or the Tabs button's quick menu. */
      menu: PreviewMenu
      /** Text of an item in the menu to scroll into view once it is open. */
      show?: string
      /**
       * The active page reads as an article first (`article`): the stand-in host cannot run the
       * readability probe inside a site's frame, so the items an article enables (Reader View,
       * Listen to This Page) are shown enabled by marking the tab readerable, as the probe would.
       */
      article?: boolean
    }
  | {
      /** One of the chrome's own sheets, open over the active page; `then` steps are taken on it. */
      kind: 'sheet'
      sheet: PreviewSheet
      then?: PreviewStep[]
    }
  | {
      /** The phone new tab page with its field at a pose of the morph (`ntp=<pose>`). */
      kind: 'ntp'
      pose: PreviewNtpPose
      /** On the private new tab page rather than the space's. */
      private: boolean
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
      /** Steps taken once the surface is up (the overview's header menu, its question). */
      then?: PreviewStep[]
    }
  | {
      /**
       * The active tab navigated to a PDF (`pdf=<variant>`, one of `PREVIEW_PDF_VARIANTS`): the
       * stand-in downloader completes the file and the core opens it in the viewer page, whose
       * bar is up under the pages.
       */
      kind: 'pdf'
      variant: PreviewPdfVariant
      /** The find bar opened over the viewer with this typed (`find=`; empty opens it blank). */
      find?: string
      /** Steps taken once the document has reported (the bar's controls, its sheets' rows). */
      then?: PreviewStep[]
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
      /** The phone bar hiding on scroll (`lib/barHide.ts`). */
      kind: 'barhide'
      /** How far the bar is off its edge: 0 shown … 1 hidden. */
      progress: number
      /** The finger has lifted: the bar snaps to the nearer end and rests there. */
      released: boolean
    }
  | {
      /** The page zoom sheet, the active tab's site at `factor` (null: as it is). */
      kind: 'zoom'
      factor: number | null
    }
  | {
      /**
       * Read aloud's docked player on the active tab with the model's state scripted (a stand-in
       * article's title, sentence 9 of 42), at `status`; `rate` on the speed chip; `voices` opens
       * the voice picker sheet over it.
       */
      kind: 'readAloud'
      status: PreviewReadAloudStatus
      rate: number
      voices: boolean
    }
  | {
      /** The active tab in Reader View on a stand-in article; `preferences` opens its text sheet. */
      kind: 'reader'
      preferences: boolean
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
  | {
      /**
       * A page's media as one of PREVIEW_MEDIA; `player` opens the in-app player (the media
       * sheet) on it – `&player`, not `sheet=`, which names the chrome's own sheets.
       */
      kind: 'media'
      variant: PreviewMediaVariant
      player: boolean
    }
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
  | {
      /** The tab overview over the active page, as a pull on the pill opens it. */
      kind: 'overview'
      /**
       * Steps taken once the grid is up: `tap:More;tap:Select Tabs` enters the select-tabs mode
       * from the header's menu, `press:<card title>` opens a card's hold sheet, `tap:<card
       * title>` picks a card while the mode is on, `tap:Group` opens the action row's picker.
       */
      then?: PreviewStep[]
    }
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
  /**
   * The private tabs' lock is on once the state is up (`lock=on`): the lock cover over a private
   * tab in front or over the Private pane (INC-05), the way the host puts it on as the app is
   * left and come back to.
   */
  lock: boolean
  /**
   * Whether the device has a screen lock (`screenlock=off` says none: Settings' "Lock private
   * tabs when you leave Zenium" is disabled with its description, SET-17); `null` leaves the
   * stand-in host's word (`vault=none` is a device without one).
   */
  screenLock: boolean | null
  /** Where the phone bar docks (`bar=top` / `bar=bottom`; the setting `phoneBarPosition`). */
  bar: PhoneBarPosition | null
  /**
   * Cookies and site data (`sitedata=<sample>[,<site>][,blockall][,exit]`): the three lists
   * seeded with sample patterns and the stand-in profile answering with the `sample` of stored
   * origins named (`none`, `some`, `many`; see `previewSiteData.ts`); `never`, `allow` or
   * `clear` puts the active tab's site on that list, so the site-information sheet shows the
   * state; `blockall` sets the default to "Block all cookies"; `exit` turns on a few
   * clear-on-exit types. `null` leaves the policy as it is.
   */
  siteData: PreviewSiteDataSeed | null
}

export interface PreviewSiteDataSeed {
  origins: PreviewSiteDataOrigins
  /** The list the active tab's site goes on; null for none. */
  site: SiteDataList | null
  blockAll: boolean
  exit: boolean
}

const PREVIEW_SITE_LISTS: Record<string, SiteDataList> = {
  never: 'block',
  block: 'block',
  allow: 'allow',
  clear: 'clearOnExit'
}

/** `sitedata=<sample>[,<site>][,blockall][,exit]`, in any order; null when absent. */
export function parsePreviewSiteData(value: string | null): PreviewSiteDataSeed | null {
  if (value === null) return null
  const seed: PreviewSiteDataSeed = { origins: 'some', site: null, blockAll: false, exit: false }
  for (const raw of value.split(',')) {
    const part = raw.trim().toLowerCase()
    if (isPreviewSiteDataOrigins(part)) seed.origins = part
    else if (part in PREVIEW_SITE_LISTS) seed.site = PREVIEW_SITE_LISTS[part]
    else if (part === 'blockall') seed.blockAll = true
    else if (part === 'exit') seed.exit = true
  }
  return seed
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
 * show chip, `tap:New tab in Research` its plus chip; `&saved` makes a saved group beside it,
 * `&link=<url>` raises the page's link menu for that URL after the steps), `overlay=<kind>` for
 * one of PREVIEW_OVERLAYS (with `section=<id>` for an overlay that has sections, `show=<text>`
 * to scroll a row of the overlay into view, and `expand` to rest a sheet that opened at its peek
 * detent on its expanded one), `menu=app` for the app menu sheet or `menu=tabs` for the Tabs
 * button's quick menu (with `show=<text>` to scroll an item into view; `article` marks the
 * active page an article, so the items an article enables show enabled), `sheet=<name>` for one
 * of PREVIEW_SHEETS, the chrome's own sheets (the Extensions sheet the app menu's row opens;
 * `then=<steps>` takes steps on it: `tap:<row>` is the row's tap, `hold:<row>` its long press),
 * `prompt=<permission>` for the active page asking for that permission (the prompt sheet),
 * `ntp=<pose>` for the phone new tab page with its field at a pose of its morph into the omnibox
 * (`rest`, `morph:<percent>`, `open`, `scroll:<px>`, `scrub:<percent>`, `docked`; `&private`
 * for the private page; see `PreviewNtpPose`),
 * `private=<surface>` for one of PREVIEW_PRIVATE_SURFACES (a private tab on its new tab page or
 * a page, the overview's Tabs and Private panes and the empty Private pane; `url=<page>` names
 * the private tab's page; `private=new` is the new tab page and `private=<url>` that page, as
 * #135 spelt them),
 * `autofill=<surface>` for one of PREVIEW_AUTOFILL staged with sample data (a manager surface is
 * the Settings tab on its Autofill section and takes `show=<text>` and `then=<steps>` like
 * `page`; `login-note` opens the password manager and takes `then=<steps>` on it; `safety-check`
 * is the Settings tab on its Privacy section after a Password Checkup over a seeded vault),
 * `pdf=<variant>` for the active tab navigated to a sample PDF the viewer page opens
 * (`sample`, `locked`, `broken`, `slow`; see `previewPdf.ts`; with `find=<text>` for the find
 * bar over it and `then=<steps>` for the bar's controls: `tap:Contents`, `tap:Unlock;type:pdf-password=zenium`),
 * `find=<text>` for the find bar with that text typed (`find=` opens it empty),
 * `pull=<n>` for the active page held pulled down at n percent of the refresh threshold
 * (`pull=refresh` pulls past it and lets go), `barhide=<n>` for the phone bar held n percent
 * of the way off its edge by a scroll (`barhide=hidden` scrolls it off and lets go, so it rests
 * hidden), `zoom=<factor>` for the page zoom sheet with the
 * active tab's site at that factor (`zoom=` opens it as it is), `readAloud=<status>` for read
 * aloud's docked player on the active tab with the model's state scripted at one of
 * PREVIEW_READ_ALOUD_STATUSES (`readAloud=` is `playing`; `rate=<n>` sets the speed chip,
 * `voices` opens the voice picker sheet over it), `reader=article` for the active
 * tab in Reader View on a stand-in article (`reader=preferences` opens its text preferences
 * sheet over it), `error=<code>` for the active
 * tab's load failing with that Chromium `net::` code (with `url=<target>` for the URL that
 * failed, else the tab's own), which puts up the zen://error page, any of `toast=<text>` (with
 * `action=<label>`, `kind=error`), `banners=<n>` and `progress=<0…1>` together for the message
 * surfaces and the load bar, `webapp=<surface>` for one of PREVIEW_WEBAPP_SURFACES ("Add to
 * Home screen"), `download=<file>` for a transfer the stand-in downloader plays back
 * (`size=<bytes>`, `at=<percent>` already received, `speed=<bytes per second>`, `paused`,
 * `fail=<error>` – with `retrying=<n>` for a network failure the stand-in downloader retries on
 * its own n more times, the row counting down to each attempt – `deleted` for a finished file
 * since gone from disk, `private`, `url=<url>` (an `http:` one is refused as insecure under the
 * stand-in's https referrer, HB-44), `mime=<type>`), `media=<variant>` for the active page
 * reporting media as one of PREVIEW_MEDIA (the Now playing chip in the pill; `&player` opens the
 * in-app player on it), `popups=<n>` for n pop-ups blocked on the active page (`&list` opens the
 * list of them, `&allowed` remembers the site as allowed), `prompt=http-auth` /
 * `prompt=certificate` for a security dialog over the
 * page (`&failed`, `&proxy`, `&secure` vary the sign-in), `prompt=<any other value>` for the
 * permission that page asks for (the permission prompt sheet), `private=<surface>|new|<url>`
 * for a private tab, `voice=<script>` for voice search from the active tab, `overview` for the
 * tab overview over the active page (the grid of cards, with whatever pictures the stand-in
 * host has of the tabs), or `urlbar=<text>` for the pill's editor over the active tab with that
 * text typed (`urlbar=` opens it search-ready, with the page's header row; `newtab` opens it
 * over a new tab page instead; `clip=<text>` puts that on the stand-in clipboard first, so the
 * clipboard row shows; `then=tap:<label>;…` presses the editor's controls once the suggestions
 * are up: `Show`, `Edit`, `Refine`). When several are given, `page` wins over
 * `extension-page`, that over `group`, `group` over `overlay`, `overlay` over `menu`, `menu`
 * over `sheet`, `sheet` over the permission `prompt`, that over `ntp`, `ntp` over `private`,
 * `private` over `autofill`, `autofill` over `pdf`, `pdf` over `find` (which it takes along),
 * `find` over `pull`, `pull` over `barhide`, `barhide` over `zoom`, `zoom` over `readAloud`,
 * `readAloud` over `reader`, `reader` over `error`, `error` over the messages, the messages over
 * `webapp`, `webapp` over `media`, `media` over `download`, `download` over `popups`, `popups`
 * over the security `prompt`, that over `voice`, `voice` over `overview`, and `overview` over
 * `urlbar`. A leading `#` (the URL hash as read) is ignored.
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
    const state: Extract<PreviewState, { kind: 'group' }> = { kind: 'group', members }
    if (params.has('saved')) state.saved = true
    const link = params.get('link')
    if (link) state.link = link
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
    const then = parsePreviewSteps(params.get('then'))
    if (then.length > 0) state.then = then
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
    if (params.has('article')) state.article = true
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
  const ntp = params.get('ntp')
  if (ntp !== null) {
    return { kind: 'ntp', pose: parsePreviewNtpPose(ntp), private: params.has('private') }
  }
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
  const pdf = params.get('pdf')
  const find = params.get('find')
  if (pdf !== null && isPreviewPdfVariant(pdf)) {
    const state: Extract<PreviewState, { kind: 'pdf' }> = { kind: 'pdf', variant: pdf }
    if (find !== null) state.find = find
    const then = parsePreviewSteps(params.get('then'))
    if (then.length > 0) state.then = then
    return state
  }
  if (find !== null) return { kind: 'find', text: find }
  const pull = params.get('pull')
  if (pull === 'refresh') return { kind: 'pull', progress: PREVIEW_PULL_MAX, released: true }
  if (pull !== null && pull !== '' && Number.isFinite(Number(pull))) {
    const progress = Math.min(PREVIEW_PULL_MAX, Math.max(0, Number(pull) / 100))
    return { kind: 'pull', progress, released: false }
  }
  const barhide = params.get('barhide')
  if (barhide === 'hidden') return { kind: 'barhide', progress: 1, released: true }
  if (barhide !== null && barhide !== '' && Number.isFinite(Number(barhide))) {
    const progress = Math.min(1, Math.max(0, Number(barhide) / 100))
    return { kind: 'barhide', progress, released: false }
  }
  const zoom = params.get('zoom')
  if (zoom !== null) {
    const factor = parseFloat(zoom)
    return { kind: 'zoom', factor: Number.isFinite(factor) && factor > 0 ? factor : null }
  }
  const readAloud = params.get('readAloud')
  if (readAloud !== null) {
    const rate = Number(params.get('rate'))
    return {
      kind: 'readAloud',
      status: (PREVIEW_READ_ALOUD_STATUSES as readonly string[]).includes(readAloud)
        ? (readAloud as PreviewReadAloudStatus)
        : 'playing',
      rate: Number.isFinite(rate) && rate >= 0.5 && rate <= 4 ? rate : 1,
      voices: params.has('voices')
    }
  }
  const reader = params.get('reader')
  if (reader !== null) return { kind: 'reader', preferences: reader === 'preferences' }
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
  const media = params.get('media')
  if (media !== null && (PREVIEW_MEDIA as readonly string[]).includes(media)) {
    return { kind: 'media', variant: media as PreviewMediaVariant, player: params.has('player') }
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
  if (params.has('overview')) {
    const state: Extract<PreviewState, { kind: 'overview' }> = { kind: 'overview' }
    const then = parsePreviewSteps(params.get('then'))
    if (then.length > 0) state.then = then
    return state
  }
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
  const then = parsePreviewSteps(params.get('then'))
  if (then.length) state.then = then
  return state
}

/**
 * The `then=` list: `tap:<text>;hold:<text>;press:<text>;type:<id>=<text>;back;overview;urlbar`;
 * blanks and unknown steps are dropped.
 */
export function parsePreviewSteps(list: string | null): PreviewStep[] {
  if (!list) return []
  const steps: PreviewStep[] = []
  for (const raw of list.split(';')) {
    const step = raw.trim()
    const pressing = (['tap', 'hold', 'press'] as const).find((k) => step.startsWith(`${k}:`))
    if (pressing) {
      const text = step.slice(pressing.length + 1).trim()
      if (text) steps.push({ kind: pressing, text })
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
    retrying: Math.round(number('retrying', 0)),
    deleted: params.has('deleted'),
    private: params.has('private')
  }
}

/**
 * The seeding a spec asks for on top of its state: `rules=<n>` remembered site permissions,
 * `lock=on` the private tabs' lock, `screenlock=off` (or `on`) the device's screen lock,
 * `bar=top` / `bar=bottom` the phone bar's dock (the setting; left as it is without one),
 * `sitedata=<sample>[,<site>][,blockall][,exit]` the cookie and site-data policy with the
 * stand-in profile's sample of stored origins (see `PreviewSiteDataSeed`).
 */
export function parsePreviewSeed(spec: string): PreviewSeed {
  const params = new URLSearchParams(spec.startsWith('#') ? spec.slice(1) : spec)
  const rules = params.get('rules')
  const onOff = (value: string | null): boolean | null =>
    value === null ? null : ['on', '1', 'true', ''].includes(value)
  const bar = params.get('bar')
  return {
    rules:
      rules !== null && rules !== '' && Number.isFinite(Number(rules))
        ? Math.max(0, Math.floor(Number(rules)))
        : null,
    lock: onOff(params.get('lock')) === true,
    screenLock: onOff(params.get('screenlock')),
    bar: bar === 'top' || bar === 'bottom' ? bar : null,
    siteData: parsePreviewSiteData(params.get('sitedata'))
  }
}

/**
 * `ntp=<pose>`: `rest`, `open`, `docked`, `morph:<n>` and `scrub:<n>` with n a percentage
 * (clamped to 0…100), `scroll:<px>`; anything else is the page at rest.
 */
export function parsePreviewNtpPose(value: string): PreviewNtpPose {
  const at = value.indexOf(':')
  const kind = at < 0 ? value : value.slice(0, at)
  const number = at < 0 ? NaN : Number(value.slice(at + 1))
  const percent = Number.isFinite(number) ? Math.min(1, Math.max(0, number / 100)) : 0
  switch (kind) {
    case 'open':
      return { kind: 'open' }
    case 'docked':
      return { kind: 'docked' }
    case 'morph':
      return { kind: 'morph', t: percent }
    case 'scrub':
      return { kind: 'scrub', t: percent }
    case 'scroll':
      return { kind: 'scroll', px: Number.isFinite(number) ? Math.max(0, number) : 0 }
    default:
      return { kind: 'rest' }
  }
}
