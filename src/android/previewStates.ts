import type {
  CertificateDetails,
  ClientCertificateInfo,
  CommandArgs,
  CommandName,
  CommandResult,
  ExtensionAction,
  ExtensionInfo,
  MenuItemDescriptor,
  PhoneBarPosition,
  SyncDeviceTabs,
  Tab,
  UIState
} from '@shared/types'
import type { Browser } from '@core/browser'
import { fileSources } from '@core/import/sources'
import { READER_URL_PREFIX } from '@core/reader'
import type { ClearOnExitType, SiteDataList } from '@shared/siteData'
import { isCertificateError } from '@shared/siteInfo'
import { cmd, run } from '@renderer/lib/api'
import { dispatchBackEvent, topBackSurface } from '@renderer/lib/back'
import { dismissOverview, openOverview, overviewIsOpen } from '@renderer/lib/gestures/stage'
import { chromeInertHeld } from '@renderer/lib/portals'
import { isPrivateTab, pickOverviewPane } from '@renderer/lib/privateTabs'
import { applyPrivateLock, liftLanded, privateLockStore } from '@renderer/lib/privateLock'
import { rememberThumbnail } from '@renderer/lib/thumbnails'
import { abortPull, dispatchPullEvent, PULL_THRESHOLD, pullTravelFor } from '@renderer/lib/pull'
import { barHideStore, dispatchBarScroll, resetBarHide } from '@renderer/lib/barHide'
import {
  fakeboxMorphStore,
  fakeboxScrubTravel,
  holdFakeboxMorph,
  tapFakebox
} from '@renderer/lib/fakeboxMorph'
import { Download, Smartphone, Star } from 'lucide-react'
import { installBannerShown, presentInstallBanner } from '@renderer/lib/installBanner'
import { isInternalPageUrl } from '@shared/internalPages'
import { isEmptyTabUrl } from '@shared/url'
import { closeCustomize, openCustomize } from '@renderer/lib/newtab'
import { blockedPopupsOf, closeBlockedPopups, openBlockedPopups } from '@renderer/lib/security'
import { BLANK_URL, ERROR_URL_PREFIX, EXTENSION_SCHEME, crashPageOptionsOf } from '@shared/url'
import { DEFAULT_FOLDER_ICON } from '@renderer/components/phone/GroupCard'
import { activeSpace, activeTab, regularOf } from '@renderer/lib/selectors'
import {
  browserStore,
  closeMediaSheet,
  closeMenu,
  closeOverlay,
  closeReaderPreferences,
  closeTabsMenu,
  closeUrlbar,
  closeLongScreenshot,
  dismissBanner,
  dismissToast,
  forgetBanner,
  forgetScreenshotCard,
  forgetToast,
  holdScreenshotCard,
  openExtensionsSheet,
  pickScreenshotAction,
  openSendTabSheet,
  openMediaSheet,
  openOverlay,
  openReaderPreferences,
  openTabsMenu,
  openUrlbar,
  openZoom,
  pushToast,
  showBanner,
  uiStore,
  type UiState
} from '@renderer/lib/ui'
import {
  customListId,
  DEFAULT_FILTER_LISTS,
  enabledListsFor,
  siteOriginOf,
  type BlockingStatus,
  type FilterListStatus,
  type TrackingLevel
} from '@shared/blocking'
import { syncSetupStore } from '@renderer/lib/syncSetup'
import { cancelVoiceSearch, startVoiceSearch } from '@renderer/lib/voiceSearch'
import { cancelQrScan, startQrScan } from '@renderer/lib/qrScan'
import type { HostGlobal } from './boot'
import {
  DEFAULT_BROWSER_KEY,
  PREVIEW_ARTICLE,
  PREVIEW_CLIP_EVENT,
  PREVIEW_EXTENSION_PAGE_EVENT,
  PREVIEW_QR_EVENT,
  PREVIEW_READ_ALOUD_EVENT,
  PREVIEW_SAMPLE_ORIGIN,
  PREVIEW_SETTLE_LOADS_EVENT,
  PREVIEW_SLOW_LOAD_EVENT,
  PREVIEW_VOICE_EVENT,
  PREVIEW_WEB_APP,
  postPreviewManifest,
  previewQrScript,
  previewVoiceScript,
  type PreviewExtensionPage
} from './preview'
import { DEFAULT_PROMO_STATE, PROMO_FIRST_SESSION } from '@shared/defaultBrowser'
import { clearPdfReport, isPdfViewerTab, pdfViewerStore } from '@renderer/lib/pdfViewer'
import { dismissSiteInfo, openSiteInfo } from '@renderer/lib/siteInfo'
import type { ReadAloudStatus } from '@shared/readAloud'
import type { TranslateStatus, TranslateTabState } from '@shared/translate'
import { clearAutofill, stageAutofill } from './previewAutofill'
import { PREVIEW_DOWNLOAD_EVENT } from './previewDownloads'
import { PREVIEW_PDF_FILES, previewPdf } from './previewPdf'
import { PREVIEW_SITE_DATA_EVENT } from './previewSiteData'
import {
  parsePreviewSeed,
  parsePreviewSpec,
  parsePreviewSteps,
  type PreviewCrashVariant,
  type PreviewDownloadSpec,
  type PreviewSiteDataSeed,
  type PreviewMediaVariant,
  type PreviewNetworkVariant,
  type PreviewNtpPose,
  type PreviewPrivateSurface,
  type PreviewState,
  type PreviewStep,
  type PreviewWebAppSurface
} from './previewSpec'
import { holdPreviewScreenshots, resetPreviewScreenshots } from './previewScreenshots'
import { hideUnresponsivePrompt, showUnresponsivePrompt } from './previewUnresponsive'
import { EMPTY_MEDIA_REPORT, type MediaReport } from '@shared/mediaSession'

/** A pause between steps for a sheet to mount, slide in and settle before the next tap. */
const STEP_SETTLE_MS = 450
/**
 * How long a `press` step's finger rests before it lifts: past the overview card's long press
 * (`useCardLift`'s 380 ms), so the card is in the hand when the finger goes and its sheet is
 * scheduled (250 ms after); the step's own settle then covers the sheet's slide.
 */
const PRESS_HOLD_MS = 480
const PRESS_SETTLE_MS = PRESS_HOLD_MS + 250 + STEP_SETTLE_MS

/**
 * The back surfaces a page's sheets register (`settings-options:<row>`, `settings-confirm:<row>`,
 * …), the PDF viewer bar's (`pdf-zoom`, `pdf-outline`, `pdf-password`, …) and the default-browser
 * promo's (`default-browser`, the sheet `sheet=promo` raises; its back is a "Not now").
 */
const SHEET_SURFACE =
  /^(?:settings-(?:options|field|confirm|form|item|detail):|pdf-|default-browser$|long-screenshot$)/
/** How long a dismissed sheet may take to leave (its motion) before the reset gives up on it. */
const SHEET_LEAVE_MS = 1500
/** How long a seeded state may take to arrive in the store before the spec is reported reached anyway. */
const SETTLE_TIMEOUT_MS = 4000
/** Past a voice script's last event: the listening sheet's halo spring settling on the level. */
const VOICE_EVENT_MARGIN_MS = 250
/** Past a QR script's last event: the still's image decoding into the window, the torch's fill. */
const QR_EVENT_MARGIN_MS = 250

/**
 * Chrome states selectable from outside the preview host (`npm run dev:android`), so screenshots
 * and quick checks need no tapping through the menus. A state is a query string (see
 * `parsePreviewSpec`): `idle`, `page=settings` (the Settings tab; `section=<id>` opens a section
 * over the landing, `search=<text>` types into the landing's search, `show=<text>` scrolls a row
 * into view, `then=tap:<text>;type:<id>=<text>;back;overview;urlbar` takes steps on the open page
 * in order: a tap on a row opens its sheet and a second tap stacks one, `type` fills a form's
 * field, `back` closes the top sheet, `overview` opens the tab overview, `urlbar` the pill for
 * editing), `group=<n>` (the active tab in a group of n members made on the spot, so the group
 * strip is up in the bar band; `then=` steps run once the group has formed), `overlay=<kind>`
 * (history, bookmarks,
 * downloads, addons, …: the chrome overlays a phone still has – Settings is not one, it is
 * `page=settings`; `show=<text>` scrolls the row with that text into view, `expand` rests a
 * sheet on its expanded detent, `then=hold:<row>;tap:<row>` takes steps on it once it is up;
 * History's other devices are the `sync=tabs` fixture's, each its own group, and
 * `hold:<device name>` opens a device's sheet – with `sync=off` the From your other devices
 * group is the prompt to turn sync on, with `sync=on` (the core's scope, Open tabs off) the
 * prompt to put Open tabs in it; the seed's `recentlyClosed` fills the Recently closed group
 * over them),
 * `menu=app` (the app menu sheet; `show=<text>` scrolls an item
 * into view), `menu=tabs` (the Tabs button's quick menu), `sheet=extensions` (the Extensions
 * sheet the app menu's row opens, over the active page; `then=tap:<row>;hold:<row>` taps a row
 * or long-presses it for its menu), `sheet=customise` (the new tab page's customise sheet, over
 * the active page), `sheet=promo` (the default-browser promo, the core's campaign made due over
 * the active page as the third session raises it), `extension-page=<id>/<path>` (an extension's page open as a
 * tab, the way its options page opens: `chrome-extension://<id>/<path>`, which the stand-in
 * host serves a page for; with `extensions=installed` the chrome knows the extension, so the
 * pill shows its name), `prompt=<permission>` (the active page asks for that permission: the
 * prompt sheet is up), `private=<surface>` (a private tab on its new tab page or on
 * `url=<page>`, and the overview's Tabs and Private panes; see `PREVIEW_PRIVATE_SURFACES`;
 * `private=new` and `private=<url>` still read),
 * `autofill=<surface>` (a save prompt, the passkey chooser, a picker strip or the vault
 * passphrase dialog staged with sample data; see `PREVIEW_AUTOFILL`), `pdf=<variant>` (the
 * active tab navigated to a sample PDF, which the viewer page shows with its bar under the
 * pages; `find=<text>` opens the find bar over it, `then=` steps press the bar's controls; see
 * `previewPdf.ts`), `find=<text>` (the find
 * bar with that text typed), `pull=<n>` (the page held pulled down at n percent of the
 * refresh threshold; `pull=refresh` lets go past it), `zoom=<factor>` (the page zoom sheet at
 * that factor), `readAloud=<status>` (read aloud's docked player on the active tab, the
 * model's state scripted – the stand-in article's title, sentence 9 of 42 – at `playing`,
 * `paused`, `loading`, `ended` or `error`; `rate=<n>` on the speed chip, `voices` opens the
 * voice picker over it), `error=<code>` (the active tab's load failed with that Chromium `net::` code,
 * `url=<target>` naming the URL that failed: the zen://error page is up), the message surfaces
 * and the load bar: `toast=<text>&action=<label>`, `banners=<n>`, `progress=<0…1>`,
 * `webapp=<surface>` (an "Add to Home screen" surface on the active tab), `download=<file>`
 * (the stand-in downloader starts that transfer; see `PreviewDownloadSpec`), `popups=<n>` (n
 * pop-ups blocked on the page; `&list` opens the list, `&allowed` remembers the site),
 * `prompt=http-auth` / `prompt=certificate` (a security dialog over the page; `&failed`,
 * `&proxy`, `&secure`), `voice=<script>` (voice search started, the stand-in recogniser
 * playing that script into the listening sheet: `listening`, `listening-rest`, `partial`,
 * `no-match`, `denied`, …; see `previewVoiceScript`), `qr=<script>` (QR scanning started, the
 * stand-in camera playing that script into the scan sheet: `scanning`, `torch`, `text`,
 * `denied`, …; see `previewQrScript`), `overview` (the tab overview open over the active
 * page, its cards with whatever pictures the stand-in host has of the tabs; `then=` presses
 * its header and cards once it is up: `tap:More;tap:Select Tabs` enters the select-tabs mode,
 * `tap:<card's label>` picks a card in it, `press:<card title>` opens a card's hold sheet,
 * `tap:Search tabs;type:overview-search=<text>` opens the tab search and types the query – the
 * seed's `recentlyClosed` and, with `sync=tabs`, the other devices' tabs are in its reach, as
 * rows under the cards) or `urlbar=<text>` (the pill's editor over the active tab with that text typed; `newtab` opens
 * it over a new tab, `clip=<text>` seeds the stand-in clipboard for the clipboard row, `then=`
 * presses its controls: `tap:Show`, `tap:Edit`, `tap:Refine`). `rules=<n>` on any spec seeds n
 * remembered site permissions for Settings › Security; `blocking=<variant>` may accompany any
 * spec too (see `seedBlocking`; `&blocked=<n>` sets the count blocked on the page), as may
 * `sync=<variant>` for Settings › Sync (see `seedSync`), `translate=<status>` (the active page
 * `offered` for translation, `translated`, `translating` or `error`, or `idle` for none; the bar
 * stays down unless `&bar`; see `seedTranslate`),
 * `favicon=<url>` (the active tab's icon, which this host cannot read off a cross-origin page),
 * `siteinfo` (the site-information sheet up on the active tab once the state is reached: the
 * shield row with its count and the translate row are in it, OMN-02) and `import=failed` (a
 * last import that failed before any kind ran, for Settings › Import's Last import group; see
 * `seedImport`). `lock=on` puts the private tabs' lock on once the state is up (the lock cover
 * over a private tab in front or over the Private pane, INC-05: `private=page&lock=on`,
 * `private=overview&lock=on`, `private=newtab&lock=on`), and `screenlock=off` says the device
 * has no screen lock (Settings' "Lock private tabs when you leave Zenium" disabled with its
 * description, SET-17).
 * It comes in as the URL hash, `http://localhost:41734/#overlay=history`, or as
 * `window.postMessage({ zenPreview: 'find=coffee' }, '*')`, which also re-applies an unchanged
 * state. Once applied it is echoed in `<html data-preview-state>` so a driver can wait for it;
 * `.github/scripts/android-preview-shots.mjs` is one.
 *
 * The seeds go through the core the way the host would: a prompt is the permission service asked
 * by the active page, a private tab is `tab.newPrivate`, and the core (`browser`) stages what the
 * chrome cannot reach through its own state: the autofill surfaces.
 */
export function installPreviewStates(browser: Browser): void {
  window.addEventListener('hashchange', () => apply(browser, location.hash.slice(1)))
  window.addEventListener('message', (e: MessageEvent<unknown>) => {
    const data = e.data
    if (data && typeof data === 'object' && 'zenPreview' in data) {
      const spec = (data as { zenPreview: unknown }).zenPreview
      if (typeof spec === 'string') apply(browser, spec)
    }
  })
  if (location.hash.length > 1) apply(browser, location.hash.slice(1))
}

function apply(browser: Browser, spec: string): void {
  whenReady(() => {
    // Every spec starts from idle so states do not stack: a pull in flight is put back at once
    // (a `cancel` would spring home, and the next pull would catch that spring part-way); the
    // pill's editor, the overview and the page's sheets a previous state's steps opened go too,
    // a request state a previous spec seeded stops being held, and the permission prompts up
    // are answered as a dismissal, the way a press outside would.
    unseedBlocking()
    unseedExtensions()
    unseedSync()
    unseedImport()
    unseedTranslate()
    unseedFavicon()
    unseedMedia()
    unseedSiteData(browser)
    siteInfoSteps = null
    dismissSiteInfo()
    closeOverlay()
    closeMenu()
    closeTabsMenu()
    closeUrlbar()
    dismissOverview()
    closeReaderPreferences({ keepFocus: true })
    closeCustomize()
    uiStore.set({
      findOpen: false,
      findTabId: null,
      zoomTabId: null,
      install: null,
      extensionsSheetOpen: false,
      sendTabSheet: null,
      barEditorOpen: false
    })
    abortPull()
    cancelVoiceSearch()
    cancelQrScan()
    resetBarHide()
    // A flash a `screenshot=` state held, and the long-screenshot editor it opened, go too.
    resetPreviewScreenshots()
    closeLongScreenshot()
    // The unresponsive-page prompt's stand-in goes at once (no answer: nothing hangs here).
    hideUnresponsivePrompt()
    // A read-aloud session a previous state scripted ends: its docked player goes with it.
    browser.readAloud.stop()
    const state = browserStore.get().state
    const tab = state ? activeTab(state) : null
    clearMessages(tab?.loading ? tab.id : null)
    closeBlockedPopups()
    for (const prompt of state?.permissionPrompts ?? [])
      run('permissions.respond', { id: prompt.id, answer: 'dismiss' })
    const securityAtRest = tab ? resetSecurity(browser, tab) : Promise.resolve()
    const seed = parsePreviewSeed(spec)
    if (seed.rules !== null) seedRules(browser, seed.rules)
    if (seed.siteData) seedSiteData(browser, seed.siteData, tab)
    // The private tabs' lock a previous spec put on comes off at once (no lift: the cover goes
    // with the private tab, below), and the device's screen lock is as the spec says or as the
    // stand-in host reported it at boot.
    liftLanded()
    hostScreenLock ??= privateLockStore.get().screenLock
    privateLockStore.set({
      locked: false,
      lifting: false,
      prompting: false,
      confirming: false,
      screenLock: seed.screenLock ?? hostScreenLock
    })
    // The autofill surfaces are the core's: cleared before the sheets close, so a staged prompt
    // or picker of the previous state is gone with them – and before the group goes, since
    // they hang from the tab that was active in it. A private tab a previous state opened goes
    // too (its session ends, as when the user closes the last one): the next state starts on
    // the regular tabs, and an "empty" pane is empty. A tab a `pdf=` state turned to the viewer
    // goes back to its page, unless the next state is another document for the same viewer. The
    // new tab page an `ntp=` state opened goes the same way, the device is back online if a
    // `network=` state took it off, the active tab is back on its page if a state left it on an
    // error page, and the bar is docked where the seed says before the state is reached.
    void clearAutofill(browser)
      .then(dissolveGroup)
      .then(closeExtensionPage)
      .then(() => (parsePreviewSpec(spec).kind === 'pdf' ? undefined : leavePdf()))
      .then(closeNewTabPage)
      .then(restoreConnectivity)
      .then(leaveHungPage)
      .then(leaveErrorPage)
      .then(() =>
        dockBar(seed.bar, () =>
          closePrivateTabs(() => closeSheets(() => reach(browser, spec, securityAtRest)))
        )
      )
  })
}

/**
 * The tab the last `extension-page=` state opened and the tab that was active before it, put
 * back before the next state (as the group is): a run of stills takes each state from the same
 * loose profile.
 */
let previewExtensionPage: { tabId: string; activeId: string | null } | null = null

/** The page's tab goes and the tab that was active before it is active again. */
async function closeExtensionPage(): Promise<void> {
  const made = previewExtensionPage
  previewExtensionPage = null
  const state = made ? browserStore.get().state : null
  if (!made || !state) return
  const quiet = (): undefined => undefined
  const restored = made.activeId && state.tabs[made.activeId] ? made.activeId : null
  if (restored && activeTab(state)?.id !== restored)
    await cmd('tab.activate', { tabId: restored }).catch(quiet)
  if (state.tabs[made.tabId])
    await cmd('tab.close', { tabId: made.tabId, force: true }).catch(quiet)
  await new Promise<void>((resolve) =>
    untilState(
      (s) => !s.tabs[made.tabId] && (restored === null || activeTab(s)?.id === restored),
      resolve
    )
  )
}

/**
 * Open the extension's page as a tab, the way `extensions.openOptions` does: the stand-in host
 * is told what to serve for it first (the name of the extension the seed put in the state; the
 * document's title the way an options page tends to have one). Resolves once the tab is active
 * and its page has loaded.
 */
async function openExtensionPage(id: string, path: string): Promise<void> {
  const state = browserStore.get().state
  // The page keeps the name its extension had – as a tab that outlived the extension's removal
  // does (`extensions=removed`): the chrome's list no longer has it, the document still says it.
  const known =
    state?.extensions.find((e) => e.id === id) ??
    (state ? extensionsFixture(state, 'installed', Date.now()).extensions : []).find(
      (e) => e.id === id
    )
  const name = known?.name || id
  const url = `${EXTENSION_SCHEME}://${id}/${path}`
  const page: PreviewExtensionPage = { url, name, title: `${name} settings` }
  window.dispatchEvent(new CustomEvent(PREVIEW_EXTENSION_PAGE_EVENT, { detail: page }))
  const activeId = state ? (activeTab(state)?.id ?? null) : null
  const tabId = await cmd('tab.create', { url, active: true })
  previewExtensionPage = { tabId, activeId }
  await new Promise<void>((resolve) =>
    untilState((s) => {
      const tab = activeTab(s)
      return tab !== null && tab.id === tabId && !tab.loading
    }, resolve)
  )
}

// ---------------------------------------------------------------------------
// The PDF viewer
// ---------------------------------------------------------------------------

/** How long the viewer document gets to report before the state is reported reached anyway. */
const PDF_REPORT_TIMEOUT_MS = 6000
/** The page the tab a `pdf=<variant>` state turned to the viewer was on, put back before the next state. */
let previewPdfReturn: { tabId: string; url: string } | null = null

/**
 * The active tab navigated to a PDF: the stand-in downloader (`previewDownloads.ts`) announces
 * the response as the tab's own navigation and completes it at once – the bytes are the sample
 * document's (`previewPdf.ts`), which the dev server answers the viewer page with – and the core
 * turns the tab to the viewer (`core/pdf.ts`), whose bar is up under the pages. The state is
 * reached once the document has reported past loading (its pages, its password prompt or its
 * failure); the `slow` document is held back by the server, so its state is the bar loading.
 * Then the find bar opens over the viewer, or the steps press the bar's controls.
 */
function reachPdf(
  tab: Tab,
  target: Extract<PreviewState, { kind: 'pdf' }>,
  finish: () => void
): void {
  const state = browserStore.get().state
  if (state && !isPdfViewerTab(state, tab.id) && previewPdfReturn?.tabId !== tab.id)
    previewPdfReturn = { tabId: tab.id, url: tab.url }
  clearPdfReport(tab.id)
  const filename = PREVIEW_PDF_FILES[target.variant]
  const download: PreviewDownloadSpec = {
    filename,
    url: `https://harbour.example/notices/${filename}`,
    mimeType: 'application/pdf',
    totalBytes: previewPdf(target.variant).length,
    receivedBytes: 0,
    bytesPerSecond: 2_400_000,
    paused: false,
    error: null,
    deleted: false,
    private: false,
    sourceTabId: tab.id,
    navigation: true
  }
  window.dispatchEvent(new CustomEvent(PREVIEW_DOWNLOAD_EVENT, { detail: download }))
  // The viewer says nothing while it loads: the `slow` document's state is the bar up loading.
  const reported = (): boolean => {
    if (target.variant === 'slow') return true
    const report = pdfViewerStore.get().reports[tab.id]
    return report !== undefined && report.state !== 'loading'
  }
  const then = (): void => {
    const query = target.find
    if (query !== undefined) {
      uiStore.set({ findOpen: true, findTabId: tab.id })
      // The bar mounts on the next render; type into it the way a keyboard would, then wait for
      // the viewer's tally: it grows as the pages are read, and the state is the count settled.
      requestAnimationFrame(() => {
        if (query) type('input[data-testid="find-input"]', query)
        const counted = (): boolean => {
          const find = pdfViewerStore.get().reports[tab.id]?.find
          return !query || (find?.query === query && !find.searching)
        }
        whenPdf(tab.id, counted, 'the viewer did not finish its search', () =>
          afterFrames(2, () => steps(target.then ?? [], finish))
        )
      })
      return
    }
    const list = target.then ?? []
    if (list.length === 0) finish()
    else setTimeout(() => steps(list, finish), STEP_SETTLE_MS)
  }
  // The tab turns to the viewer page once the transfer is done and the core has it (the bar
  // mounts with it); the document reports from inside the page after that.
  whenState(
    (s) => isPdfViewerTab(s, tab.id),
    () =>
      whenPdf(tab.id, reported, 'the viewer document did not report', () => afterFrames(2, then))
  )
}

/**
 * `fn` once the viewer store satisfies `test` – now, or as the viewer's reports come – or after
 * `PDF_REPORT_TIMEOUT_MS` anyway (with `why` in the console), so a document that never says
 * cannot hold the captures up.
 */
function whenPdf(tabId: string, test: () => boolean, why: string, fn: () => void): void {
  if (test()) {
    fn()
    return
  }
  let settled = false
  const settle = (): void => {
    if (settled) return
    settled = true
    unsubscribe()
    window.clearTimeout(timer)
    fn()
  }
  const unsubscribe = pdfViewerStore.subscribe(() => {
    if (test()) settle()
  })
  const timer = window.setTimeout(() => {
    console.warn(`[zen preview] ${why} (tab ${tabId}); reporting the spec reached anyway`)
    settle()
  }, PDF_REPORT_TIMEOUT_MS)
}

/**
 * The tab a previous `pdf=` state turned to the viewer goes back to the page it was on (the
 * viewer's bar leaves with it), so the next state starts on a page. Bounded: waits for the
 * address to turn, not for the page to load.
 */
async function leavePdf(): Promise<void> {
  const made = previewPdfReturn
  previewPdfReturn = null
  const state = made ? browserStore.get().state : null
  if (!made || !state || !state.tabs[made.tabId]) return
  clearPdfReport(made.tabId)
  if (!isPdfViewerTab(state, made.tabId)) return
  await cmd('tab.navigate', { tabId: made.tabId, input: made.url }).catch(() => undefined)
  await new Promise<void>((resolve) => untilState((s) => !isPdfViewerTab(s, made.tabId), resolve))
}

/**
 * The tab a previous `unresponsive&url=` state took to the page it hung, and the page it was on
 * before, put back before the next state (as the PDF viewer's tab is).
 */
let previewHungReturn: { tabId: string; url: string } | null = null

/** The tab back on the page it was on before the unresponsive state took it elsewhere. */
async function leaveHungPage(): Promise<void> {
  const made = previewHungReturn
  previewHungReturn = null
  const state = made ? browserStore.get().state : null
  if (!made || !state || !state.tabs[made.tabId] || state.tabs[made.tabId]?.url === made.url) return
  await cmd('tab.navigate', { tabId: made.tabId, input: made.url }).catch(() => undefined)
  await new Promise<void>((resolve) =>
    untilState((s) => s.tabs[made.tabId]?.url === made.url, resolve)
  )
}

/**
 * The blank tab the last `ntp=` state opened and the tab that was active before it, put back
 * before the next state (as the extension page is). A private pose's tab is a private tab, and
 * `closePrivateTabs` takes it.
 */
let previewNewTab: { tabId: string; activeId: string | null } | null = null

/** The new tab page's tab goes and the tab that was active before it is active again. */
async function closeNewTabPage(): Promise<void> {
  const made = previewNewTab
  previewNewTab = null
  const state = made ? browserStore.get().state : null
  if (!made || !state) return
  const quiet = (): undefined => undefined
  const restored = made.activeId && state.tabs[made.activeId] ? made.activeId : null
  if (restored && activeTab(state)?.id !== restored)
    await cmd('tab.activate', { tabId: restored }).catch(quiet)
  if (state.tabs[made.tabId])
    await cmd('tab.close', { tabId: made.tabId, force: true }).catch(quiet)
  await new Promise<void>((resolve) =>
    untilState(
      (s) => !s.tabs[made.tabId] && (restored === null || activeTab(s)?.id === restored),
      resolve
    )
  )
}

/**
 * Dock the phone bar where the seed says (`bar=top` / `bar=bottom`) through the setting, and
 * `then` once the state carries it (the bar has moved by its next render); no seed leaves the
 * dock as it is.
 */
function dockBar(position: PhoneBarPosition | null, then: () => void): void {
  const state = browserStore.get().state
  if (position === null || !state || state.settings.phoneBarPosition === position) {
    then()
    return
  }
  run('settings.update', { phoneBarPosition: position })
  whenState(
    (s) => s.settings.phoneBarPosition === position,
    () => afterFrames(2, then)
  )
}

/** The name and colour of the group a `group=<n>` state makes. */
const PREVIEW_GROUP_NAME = 'Research'
/** Pages for the members a `group=<n>` state has to make when the space has too few tabs. */
const PREVIEW_GROUP_PAGES = [
  'https://en.wikipedia.org/wiki/Tea',
  'https://news.ycombinator.com/',
  'https://www.rfc-editor.org/rfc/rfc2324.html',
  'https://developer.mozilla.org/en-US/docs/Web/CSS/corner-shape',
  'https://en.wikipedia.org/wiki/Damping',
  'https://www.rfc-editor.org/rfc/rfc1149.html',
  'https://en.wikipedia.org/wiki/Spring_(device)',
  'https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API',
  'https://en.wikipedia.org/wiki/Kerning'
]
/**
 * The saved group a `group=<n>&saved` state makes beside the open one (TAB-16): its name, its
 * colour's pages – closed at once, so only the record stays – and how long ago it counts as last
 * used, so its row reads "2 h ago" beside the open group's "Just now".
 */
const PREVIEW_SAVED_GROUP_NAME = 'Trip planning'
const PREVIEW_SAVED_GROUP_PAGES = [
  'https://en.wikipedia.org/wiki/Kyoto',
  'https://en.wikipedia.org/wiki/Shinkansen',
  'https://developer.mozilla.org/en-US/docs/Web/API/Geolocation_API'
]
const PREVIEW_SAVED_GROUP_AGE_MS = 2 * 60 * 60 * 1000

/**
 * The groups the last `group=<n>` state made and the world before them (the tab that was active,
 * the tabs there were), put back before the next state: a run of stills takes each state from
 * the same loose profile.
 */
let previewGroup: {
  folderId: string
  savedFolderId: string | null
  activeId: string
  tabIds: ReadonlySet<string>
} | null = null

/**
 * Put the active tab in a group of `members`: the space's loose pages join first, then tabs made
 * for the purpose, each filed after the last member so it lands in the group – the way the plus
 * chip's tab does. The strip enters on its spring as the group forms. With `saved`, a second
 * group is made first and closed at once – its pages kept, its record saved – so the space also
 * holds a saved group, last used a while ago.
 */
async function makeGroup(
  browser: Browser,
  activeId: string,
  members: number,
  saved: boolean
): Promise<void> {
  const state = browserStore.get().state
  if (!state) return
  const space = activeSpace(state)
  const tabIds = new Set(Object.keys(state.tabs))
  let savedFolderId: string | null = null
  if (saved) {
    savedFolderId = await cmd('folder.create', {
      spaceId: space.id,
      name: PREVIEW_SAVED_GROUP_NAME,
      icon: DEFAULT_FOLDER_ICON,
      color: 'green',
      rename: false
    })
    for (const url of PREVIEW_SAVED_GROUP_PAGES)
      await cmd('tab.create', { url, active: false, folderId: savedFolderId })
    await cmd('folder.close', { folderId: savedFolderId })
    const folder = browser.state.model.folders[savedFolderId]
    if (folder) {
      folder.lastUsedAt = Date.now() - PREVIEW_SAVED_GROUP_AGE_MS
      browser.state.commit()
    }
  }
  const folderId = await cmd('folder.create', {
    spaceId: space.id,
    name: PREVIEW_GROUP_NAME,
    icon: DEFAULT_FOLDER_ICON,
    color: 'blue',
    rename: false
  })
  previewGroup = { folderId, savedFolderId, activeId, tabIds }
  await cmd('tab.moveToFolder', { tabId: activeId, folderId })
  const loose = regularOf(state, space).filter(
    (t) => t.id !== activeId && !t.folderId && !isInternalPageUrl(t.url) && t.url !== BLANK_URL
  )
  let last = activeId
  for (let i = 1; i < members; i++) {
    const next = loose.shift()
    if (next) {
      await cmd('tab.moveToFolder', { tabId: next.id, folderId })
      last = next.id
    } else {
      last = await cmd('tab.create', {
        url: PREVIEW_GROUP_PAGES[i % PREVIEW_GROUP_PAGES.length],
        active: false,
        afterTabId: last
      })
    }
  }
}

/**
 * The groups a previous state made go and the world before them comes back: the tab that was
 * active then is active again (first, so closing the others never has the core pick a
 * neighbour), the tabs made since – for the group, or in it by its plus chip, or by a saved
 * group's Open – close, and the folders are deleted with their tabs unpacked (the saved one's
 * record with them), so the next state starts loose.
 */
async function dissolveGroup(): Promise<void> {
  const made = previewGroup
  previewGroup = null
  const state = made ? browserStore.get().state : null
  if (!made || !state) return
  const quiet = (): undefined => undefined
  const restored = state.tabs[made.activeId] ? made.activeId : null
  if (restored && activeTab(state)?.id !== restored)
    await cmd('tab.activate', { tabId: restored }).catch(quiet)
  for (const id of Object.keys(state.tabs)) {
    if (!made.tabIds.has(id)) await cmd('tab.close', { tabId: id, force: true }).catch(quiet)
  }
  const folderIds = [made.folderId, made.savedFolderId].filter((id): id is string => id !== null)
  for (const folderId of folderIds) {
    if (state.folders[folderId]) await cmd('folder.delete', { folderId, unpack: true }).catch(quiet)
  }
  // A command's answer comes before the state it changed does: the next state reads the store,
  // so the store is waited for (bounded) to show the folders gone and the tab back.
  await new Promise<void>((resolve) =>
    untilState(
      (s) =>
        folderIds.every((id) => !s.folders[id]) &&
        (restored === null || activeTab(s)?.id === restored) &&
        Object.keys(s.tabs).every((id) => made.tabIds.has(id)),
      resolve
    )
  )
}

/**
 * Raise the active page's context menu for a link to `url`, the way a hold on the link raises it
 * (`views.ts`: the host's `contextMenu` event with the link's URL), at a point in the page's
 * upper third – where a phone's link menu sheet leaves the page showing above it, and a tablet's
 * popover anchors.
 */
function holdLink(tabId: string, url: string): void {
  hostGlobal().viewEvent(
    tabId,
    'contextMenu',
    JSON.stringify({
      x: Math.round(window.innerWidth / 2),
      y: Math.round(window.innerHeight / 3),
      linkURL: url
    })
  )
}

/** Close the private tabs, then `then` once none is left. */
function closePrivateTabs(then: () => void): void {
  if (!anyPrivateTab(browserStore.get().state)) {
    then()
    return
  }
  void run('tab.closePrivate', undefined)
  whenState((state) => !anyPrivateTab(state), then)
}

function anyPrivateTab(state: UIState | null): boolean {
  return state !== null && Object.values(state.tabs).some(isPrivateTab)
}

/**
 * Dismiss the page's open sheets, top first, the way a back would (a sheet leaves with its
 * motion and its surface goes with it), then `then`. Bounded: a sheet that will not leave is
 * not waited on for ever.
 */
function closeSheets(then: () => void, deadline = performance.now() + SHEET_LEAVE_MS): void {
  const top = topBackSurface()
  if (!top || !SHEET_SURFACE.test(top.name) || performance.now() > deadline) {
    whenSheetLanded(then, deadline)
    return
  }
  dispatchBackEvent('commit')
  const gone = (): void => {
    if (topBackSurface() === top && performance.now() <= deadline) {
      setTimeout(gone, 50)
      return
    }
    closeSheets(then, deadline)
  }
  setTimeout(gone, 50)
}

/**
 * Runs `then` once the frame's sheet chassis has landed, or at the deadline: `FrameDialogHost`
 * on a phone carries `data-sheet-up` while anything of a dialog's sheet shows, and keeps a
 * panel its owner took out on the way down (`data-leaving`) until the spring rests, when the
 * chrome stops being inert with it (the spring's last frames may sit at 0 before it rests, so
 * the kept panel is what is waited for). A dialog the reset closed by other means than a back
 * – the new tab page's shortcut sheet, which goes with its tab (`closeNewTabPage`) – is still
 * on its way down when the next state's steps would press the page under it.
 */
function whenSheetLanded(then: () => void, deadline: number): void {
  const host = document.querySelector('.zen-frame-dialogs')
  const up =
    host !== null &&
    (host.hasAttribute('data-sheet-up') || host.querySelector('[data-leaving]') !== null)
  if (!up || performance.now() > deadline) {
    then()
    return
  }
  setTimeout(() => whenSheetLanded(then, deadline), 50)
}

/**
 * Raise the default-browser promo (`DefaultBrowserService`, `components/defaultbrowser`): the
 * campaign is put where the third session finds it – onboarding behind the user, the sessions
 * counted, nothing shown or dismissed yet, the role not held by the stand-in host – and the
 * core asked to decide again, as a session start asks it. The sheet goes up once the layer has
 * the page's picture (`defaultBrowserPrompt` in the ui store); `then` runs from there. The
 * dismissals a run of stills spends on it never add up: the seed starts the count over.
 */
function raisePromo(browser: Browser, then: () => void): void {
  localStorage.setItem(DEFAULT_BROWSER_KEY, 'false')
  const { settings } = browser.state
  settings.onboardingDone = true
  settings.defaultBrowserPromo = { ...DEFAULT_PROMO_STATE, sessions: PROMO_FIRST_SESSION }
  browser.state.commit()
  if (uiStore.get().defaultBrowserPrompt) {
    then()
    return
  }
  const unsubscribe = uiStore.subscribe(() => {
    if (!uiStore.get().defaultBrowserPrompt) return
    unsubscribe()
    then()
  })
  void browser.defaultBrowser.refresh()
}

/**
 * Take the chrome, now idle, to the state `spec` names. `securityAtRest` settles once the
 * previous state's security prompts are cancelled and forgotten (a prompt raised before that
 * would join the cancelled one's protection space instead of asking).
 */
function reach(browser: Browser, spec: string, securityAtRest: Promise<void>): void {
  const state = browserStore.get().state
  const tab = state ? activeTab(state) : null
  const target = parsePreviewSpec(spec)
  // The request engine's state the spec asks for is patched in once the target is up (the core's
  // push on the way there would replace an earlier patch) and again before a page's rows are
  // shown or tapped, so a row the seeded state adds is there for `show` and the steps.
  const params = new URLSearchParams(spec.startsWith('#') ? spec.slice(1) : spec)
  const blocking = params.get('blocking')
  const blocked = Number(params.get('blocked'))
  const extensions = params.get('extensions')
  const sync = params.get('sync')
  const lastImport = params.get('import')
  const translate = params.get('translate')
  const favicon = params.get('favicon')
  const seed = (): void => {
    if (blocking)
      seedBlocking(blocking, Number.isFinite(blocked) && blocked > 0 ? blocked : undefined)
    if (extensions) seedExtensions(extensions)
    if (sync) seedSync(sync, browser)
    if (lastImport) seedImport(lastImport)
    if (translate) seedTranslate(translate, params.has('bar'))
    if (favicon) seedFavicon(favicon)
  }
  const lock = parsePreviewSeed(spec).lock
  const finish = (): void => {
    seed()
    if (!lock) {
      done(spec)
      return
    }
    lockPrivateTabs(() => afterFrames(2, () => done(spec)))
  }

  if (target.kind === 'autofill') {
    void stageAutofill(browser, target.surface, tab).then((page) => {
      // A manager state is the Settings tab on its Autofill section (staged vault behind it):
      // reached the way a page state is. Any other surface mounts on the next render; the
      // sheets take a moment to rise. Steps on one of those (the manager over the page,
      // `login-note`) wait for its entrance to settle.
      const then = target.then ?? []
      if (page) settlePage(target, seed, finish)
      else if (then.length > 0) setTimeout(() => steps(then, finish), STEP_SETTLE_MS)
      else requestAnimationFrame(() => requestAnimationFrame(() => done(spec)))
    })
  } else if (target.kind === 'page') {
    // The Extensions category is only on a host with the capability: the seed turns it on before
    // the page opens on that section, so the section resolves and its rows are what is waited for.
    if (extensions) seedExtensions(extensions)
    settlePage(target, seed, finish)
    run('page.open', { id: target.page, section: target.section ?? null })
  } else if (target.kind === 'extension-page') {
    // The seed goes first, so the tab opens on a page of an extension the chrome knows (its icon
    // and name in the pill); the steps wait for the page's entrance to settle.
    seed()
    void openExtensionPage(target.id, target.path).then(() => {
      const then = target.then ?? []
      if (then.length === 0) requestAnimationFrame(finish)
      else setTimeout(() => steps(then, finish), STEP_SETTLE_MS)
    })
  } else if (target.kind === 'group' && tab) {
    // The state is reached as the group forms (the strip is entering: a driver that wants it
    // mid-slide captures at once); the steps wait for the entrance to settle. A `link` is held
    // once the steps are taken: the page's menu comes up through the core (`menu.show` lands in
    // the ui store), and the state is reached once its sheet has had a frame to mount.
    const link = target.link
    const end = (): void => {
      if (!link) {
        finish()
        return
      }
      const unsubscribe = uiStore.subscribe(() => {
        if (!uiStore.get().menu) return
        unsubscribe()
        afterFrames(2, finish)
      })
      holdLink(tab.id, link)
    }
    void makeGroup(browser, tab.id, target.members, Boolean(target.saved)).then(() => {
      const then = target.then ?? []
      if (then.length === 0) end()
      else setTimeout(() => steps(then, end), STEP_SETTLE_MS)
    })
  } else if (target.kind === 'overlay') {
    // A seeded engine state stands before the overlay opens: the History page's From your other
    // devices group reads the sync status and asks for the devices' tabs as it mounts (TAB-02),
    // so its rows are up with the page rather than a round trip after it.
    if (sync) seedSync(sync, browser)
    // The steps, if any, once the overlay is up and settled: a row held for selection mode.
    const then = target.then ?? []
    const settled = (): void => {
      if (then.length === 0) finish()
      else setTimeout(() => steps(then, finish), STEP_SETTLE_MS)
    }
    void openOverlay(target.overlay, tab?.id ?? null, null, null, target.section ?? null).then(
      () => {
        if (target.show) requestAnimationFrame(() => show(target.show))
        if (target.expand) expandSheet(settled)
        else settled()
      }
    )
  } else if (target.kind === 'download') {
    // The stand-in host (preview.ts) plays the transfer back; it reports like Kotlin would.
    window.dispatchEvent(new CustomEvent(PREVIEW_DOWNLOAD_EVENT, { detail: target.download }))
    finish()
  } else if (target.kind === 'menu' && target.menu === 'tabs') {
    // A hold on the Tabs button: its quick menu, anchored to the button as the hold would.
    const button = document.querySelector<HTMLElement>('[data-bar-item="tabs"]')
    const rect = button?.getBoundingClientRect()
    if (!rect) {
      finish()
      return
    }
    void openTabsMenu(
      { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      tab?.id ?? null
    ).then(() => requestAnimationFrame(finish))
  } else if (target.kind === 'menu') {
    // `article`: the page is an article to the menu (the stand-in host cannot run the
    // readability probe in a site's frame; the flag stands for the probe's answer).
    if (target.article && tab) {
      const live = browser.tabs.tab(tab.id)
      if (live && !live.readerable) {
        live.readerable = true
        browser.state.commitVolatile()
      }
    }
    // A seeded sync stands in the core before the menu is built (its Send to your devices item
    // reads the engine's status), the rest of the seed once the sheet is up, as for every menu.
    if (sync) seedSync(sync, browser)
    // The core answers with `menu.show`; the state is reached once the descriptor is in the store.
    const unsubscribe = uiStore.subscribe(() => {
      if (!uiStore.get().menu) return
      unsubscribe()
      // The sheet mounts on the next render; give it a frame before scrolling an item into view.
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          show(target.show)
          finish()
        })
      )
    })
    run('app.menu', {})
  } else if (target.kind === 'sheet' && target.sheet === 'promo') {
    // The campaign's promo comes up through the core, once the layer has the page's picture.
    seed()
    raisePromo(browser, () => {
      const then = target.then ?? []
      if (then.length === 0) afterFrames(2, finish)
      else setTimeout(() => steps(then, finish), STEP_SETTLE_MS)
    })
  } else if (target.kind === 'sheet') {
    // The Extensions sheet lists what the seed put in the state, so the seed goes first; the
    // sheet mounts on the next render and slides in, and the steps wait for it to settle. The
    // customise sheet is the new tab page's gear, opened by name over whichever page is up.
    seed()
    if (target.sheet === 'customise') openCustomize()
    else if (target.sheet === 'send-tab') {
      if (tab) openSendTabSheet(tab.id)
    } else openExtensionsSheet()
    const then = target.then ?? []
    if (then.length === 0) requestAnimationFrame(() => requestAnimationFrame(finish))
    else setTimeout(() => steps(then, finish), STEP_SETTLE_MS)
  } else if (target.kind === 'permission' && tab) {
    // The active page asks, as its script would (`permissions.decide` is what the host calls
    // from the WebView's permission request); the answer is the prompt sheet's business.
    void browser.permissions.decide(target.permission, tab.url, { tabId: tab.id })
    untilState(
      (s) => s.permissionPrompts.some((p) => p.tabId === tab.id),
      () => afterFrames(2, () => done(spec))
    )
  } else if (target.kind === 'ntp' && state) {
    applyNewTabPose(target, state, finish)
  } else if (target.kind === 'private' && state) {
    // The steps, if any, once the surface is up: the overview's header menu, then its question.
    const then = target.then ?? []
    const surface = (): void => {
      const now = browserStore.get().state ?? state
      applyPrivate(
        target.surface,
        target.url ?? PRIVATE_PAGE,
        now,
        () => (then.length ? steps(then, finish) : finish()),
        target.count ?? 1
      )
    }
    // The global cookie mode first, through the settings command as the Settings page writes it,
    // and the surface once the core says so: the new tab page's switch reads the private status
    // the core derives from it in the same state (`privacy.privateThirdPartyCookies`; with no
    // private override, `allow` is off, `block-private` on, `block` on and locked).
    const cookies = target.cookies
    if (cookies !== undefined && state.settings.privacy.thirdPartyCookies !== cookies) {
      run('settings.update', {
        privacy: { ...state.settings.privacy, thirdPartyCookies: cookies }
      })
      whenState((s) => s.settings.privacy.thirdPartyCookies === cookies, surface)
    } else {
      surface()
    }
  } else if (target.kind === 'zoom' && tab) {
    if (target.factor !== null) run('tab.setZoomFactor', { tabId: tab.id, factor: target.factor })
    openZoom(tab.id)
    requestAnimationFrame(finish)
  } else if (target.kind === 'pdf' && tab) {
    seed()
    reachPdf(tab, target, () => done(spec))
  } else if (target.kind === 'readAloud' && tab) {
    // The panel mounts on the render after the state; the picker's sheet, once the panel's
    // Voice is there – then a step's settle for the stand-in voices to arrive and the sheet to open.
    scriptReadAloud(tab, target, () => {
      afterFrames(2, () => {
        if (!target.voices) {
          finish()
          return
        }
        tap('Voice')
        window.setTimeout(finish, STEP_SETTLE_MS)
      })
    })
  } else if (target.kind === 'reader' && tab && state) {
    // Reader View is a web page's: a Settings tab left active by a previous state is not the one
    // to read, so a site's tab in the space is made active first. The stand-in host cannot run
    // Readability inside a site's frame: the article is handed to the reader the way the page
    // script's result is, and the tab goes to zen://reader.
    const isWeb = (t: Tab): boolean => /^https?:/.test(t.url)
    const web = isWeb(tab)
      ? tab
      : (Object.values(state.tabs).find((t) => t.spaceId === tab.spaceId && isWeb(t)) ?? tab)
    const activated = web.id === tab.id ? Promise.resolve() : cmd('tab.activate', { tabId: web.id })
    void activated
      .catch(() => undefined)
      .then(() => {
        browser.reader.open(web.id, PREVIEW_ARTICLE)
        untilState(
          (s) => Boolean(activeTab(s)?.url.startsWith(READER_URL_PREFIX)),
          () => {
            if (!target.preferences) {
              afterFrames(2, finish)
              return
            }
            // The page's document mounts and paints before the sheet takes its picture.
            window.setTimeout(() => {
              void openReaderPreferences(web.id).then(() => afterFrames(2, finish))
            }, STEP_SETTLE_MS)
          }
        )
      })
  } else if (target.kind === 'find' && tab) {
    uiStore.set({ findOpen: true, findTabId: tab.id })
    // The bar mounts on the next render; type into it the way a keyboard would.
    requestAnimationFrame(() => {
      if (target.text) type('input[data-testid="find-input"]', target.text)
      finish()
    })
  } else if (target.kind === 'pull' && tab) {
    pull(tab.id, target.progress, target.released)
    requestAnimationFrame(finish)
  } else if (target.kind === 'barhide' && tab) {
    barHide(tab.id, target.progress, target.released, () => requestAnimationFrame(finish))
  } else if (target.kind === 'error' && tab) {
    failLoad(tab.id, target.code, target.url ?? tab.url)
    requestAnimationFrame(finish)
  } else if (target.kind === 'screenshot' && tab) {
    applyScreenshot(target, tab.id, finish)
  } else if (target.kind === 'network' && tab) {
    playConnectivity(tab, target.variant, finish)
  } else if (target.kind === 'crash' && tab) {
    crashTab(tab, target.variant, finish)
  } else if (target.kind === 'unresponsive' && tab) {
    // The prompt is about the page in front: the one the spec names is loaded first (a page this
    // host can picture stands behind the scrim; the reset has left the tab on its own page,
    // loaded, otherwise). Then the sheet rises with its motion, and the state is reached once it
    // has settled.
    const url = target.url
    const staged = (): void => {
      const now = activeTab(browserStore.get().state!) ?? tab
      showUnresponsivePrompt(safeHost(now.url) || now.url, now.favicon)
      window.setTimeout(finish, STEP_SETTLE_MS)
    }
    if (url && tab.url !== url) {
      previewHungReturn = { tabId: tab.id, url: tab.url }
      run('tab.navigate', { tabId: tab.id, input: url })
      whenActiveTabIs(
        (t) => t.id === tab.id && t.url === url && !t.loading,
        () => void untilPainted(tab.id).then(staged)
      )
    } else staged()
  } else if (target.kind === 'messages') {
    showMessages(target, tab?.id ?? null)
    finish()
  } else if (target.kind === 'webapp' && tab) {
    seed()
    applyWebApp(target.surface, tab.id, spec)
  } else if (target.kind === 'media' && state && tab) {
    // The seeds first, held over the media state's pushes: a blocked count or a translate offer
    // beside the Now playing chip is how the pill's fold is looked at.
    seed()
    void applyMedia(state, tab, target.variant, target.player, spec)
  } else if (target.kind === 'qr') {
    // The stand-in camera takes the script, then the camera button is "tapped" for the active
    // tab: the scan sheet goes up and the script's events play into it. The state is reached at
    // the script's end – a refusal's toast up (the sheet gone again), or the sheet up and the
    // last event landed – so a still catches the still, the torch or the start the script names.
    window.dispatchEvent(new CustomEvent(PREVIEW_QR_EVENT, { detail: target.script }))
    const script = previewQrScript(target.script)
    void startQrScan({ tabId: tab?.id ?? null, newTab: false })
    if (script.outcome === 'scanning') {
      const played = script.events.reduce((ms, [delay]) => ms + delay, 0)
      whenStore(() => uiStore.get().qrScan !== null, spec, played + QR_EVENT_MARGIN_MS)
    } else {
      whenStore(() => uiStore.get().toasts.length > 0, spec)
    }
  } else if (target.kind === 'popups' && tab) {
    seedPopups(browser, tab, target)
    // The list opens once the store carries what was seeded: over a state still without the
    // entries it would find nothing to show and leave again (a user opens it from the chip,
    // which is only there once they are).
    whenState(
      (state) => blockedPopupsOf(state, tab.id).length >= target.count,
      () => {
        if (target.list) void openBlockedPopups(tab.id, null).then(() => done(spec))
        else requestAnimationFrame(() => done(spec))
      }
    )
  } else if (target.kind === 'prompt' && tab) {
    void securityAtRest.then(() => {
      showPrompt(browser, tab, target)
      requestAnimationFrame(() => done(spec))
    })
  } else if (target.kind === 'voice') {
    // The stand-in recogniser takes the script, then the mic is "tapped" for the active tab: the
    // listening sheet goes up and the script's events play into it. The state is reached at the
    // script's end – a refusal's toast up (the sheet gone again), or the sheet up and the last
    // event landed – so a still catches the level, the partial or the no-match the script names.
    window.dispatchEvent(new CustomEvent(PREVIEW_VOICE_EVENT, { detail: target.script }))
    const script = previewVoiceScript(target.script)
    void startVoiceSearch({ tabId: tab?.id ?? null, newTab: false })
    if (script.outcome === 'listening') {
      const played = script.events.reduce((ms, [delay]) => ms + delay, 0)
      whenStore(() => uiStore.get().voice !== null, spec, played + VOICE_EVENT_MARGIN_MS)
    } else {
      whenStore(() => uiStore.get().toasts.length > 0, spec)
    }
  } else if (target.kind === 'overview' && state) {
    // The grid mounts on the next render and its cards read their pictures then; the steps, if
    // any, press its header and its cards once it is up (the select-tabs mode, a card's sheet,
    // the tab search). A seeded engine state stands before the overview opens: the search's
    // reach reads the sync status and asks for the other devices' tabs with the query (TAB-21).
    seed()
    openOverview(state)
    const then = target.then ?? []
    if (then.length === 0) requestAnimationFrame(() => done(spec))
    else whenOverviewUp(() => afterFrames(2, () => steps(then, finish)))
  } else if (target.kind === 'urlbar') {
    applyUrlbar(target, tab?.id ?? null, finish)
  } else {
    finish()
  }
}

// ---------------------------------------------------------------------------
// Request blocking, seeded
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000
/** Network filters per default list, about what the bundled snapshot carries. */
const FILTER_COUNTS: Record<string, number> = {
  urlhaus: 2183,
  'ubo-badware': 3412,
  easylist: 56828,
  easyprivacy: 31207,
  'ubo-filters': 18942,
  'peter-lowe': 3589,
  'ubo-privacy': 4210
}
const CUSTOM_LIST_URL = 'https://filters.adtidy.org/extension/ublock/filters/14.txt'
const USER_FILTERS = '||ads.example.com^\n@@||news.example.com^$document\n||tracker.example^$foo'
const EXCEPTED_SITES = [
  'https://news.ycombinator.com',
  'https://en.wikipedia.org',
  'https://mail.proton.me'
]
/** Lets go of the request state the current spec holds over the core's pushes. */
/**
 * The fixtures a spec holds over the core's pushes (the request state, the extensions, the
 * translation), applied in ONE pass by one subscriber: each patch of the store is seen once and
 * every fixture laid over it, so two held fixtures cannot answer each other's writes (each
 * re-patching the other's output until the stack ran out, as two subscribers did).
 */
const heldFixtures = new Map<string, (state: UIState) => UIState>()
let heldOutput: UIState | null = null
let unholdFixtures: (() => void) | null = null

/** The requests the seeded engine has blocked on the page, unless `blocked=<n>` says otherwise. */
const BLOCKED_ON_PAGE = 12

function holdFixture(name: string, fixture: ((state: UIState) => UIState) | null): void {
  if (fixture) heldFixtures.set(name, fixture)
  else heldFixtures.delete(name)
  heldOutput = null
  if (heldFixtures.size === 0) {
    unholdFixtures?.()
    unholdFixtures = null
    return
  }
  const patch = (): void => {
    const state = browserStore.get().state
    if (!state || state === heldOutput) return
    let next = state
    for (const apply of heldFixtures.values()) next = apply(next)
    heldOutput = next
    if (next !== state) browserStore.set({ state: next })
  }
  patch()
  unholdFixtures ??= browserStore.subscribe(patch)
}

/**
 * Settings > Privacy and security and the URL bar's blocked-count chip in states this stand-in
 * host cannot reach on its own (it has no request engine and ships no filter lists): the chrome's
 * copy of the browser state is patched in place, and patched again over every state the core
 * pushes while the spec stands (a row's tap is answered with one, and it would put the host's
 * own request state back under an open sheet), until the next spec is applied. Variants: `on`
 * (Balanced, lists fresh, requests blocked on the page), `off` (the master switch off),
 * `level-off`, `strict`, `full` (excepted sites, a custom list, the user's filters with a parse
 * error), `excepted` (the current site excepted), `updating`, `loading` and `bundled` (first run
 * on the snapshot built into the app).
 */
function seedBlocking(variant: string, blocked: number = BLOCKED_ON_PAGE): void {
  holdFixture('blocking', (state) => blockingFixture(state, variant, Date.now(), blocked))
}

/** Stop holding a seeded request state over the core's pushes. */
function unseedBlocking(): void {
  holdFixture('blocking', null)
}

/**
 * The active tab's favicon, in a state this stand-in host cannot reach on its own: its pages are
 * cross-origin iframes, whose icons it cannot read (a device's WebView reports them). `favicon=`
 * names the icon's URL – a site's own, so the pill shows what the device would. Held over the
 * core's pushes like the request state, until the next spec.
 */
function seedFavicon(url: string): void {
  holdFixture('favicon', (state) => {
    const tab = activeTab(state)
    if (!tab || tab.favicon === url) return state
    return { ...state, tabs: { ...state.tabs, [tab.id]: { ...tab, favicon: url } } }
  })
}

function unseedFavicon(): void {
  holdFixture('favicon', null)
}

// ---------------------------------------------------------------------------
// Translation, seeded
// ---------------------------------------------------------------------------

const TRANSLATE_STATUSES: ReadonlySet<TranslateStatus> = new Set<TranslateStatus>([
  'offered',
  'downloading',
  'translating',
  'translated',
  'error'
])

/**
 * The translation state of the active page in a state this stand-in host cannot reach on its
 * own (it runs no engine): the page detected as German and `offered` for translation into
 * English, `translating`, `translated` or in `error`, the pill's translate chip up for it (in
 * the accent while the translation shows), and the translate bar down – the offer dismissed,
 * the chip still offering – unless `bar` keeps it up. Held over the core's pushes like the
 * request state, until the next spec.
 */
function seedTranslate(status: string, bar: boolean): void {
  if (status !== 'idle' && !(TRANSLATE_STATUSES as ReadonlySet<string>).has(status)) {
    unseedTranslate()
    return
  }
  holdFixture('translate', (state) => translateFixture(state, status as TranslateStatus, bar))
}

function unseedTranslate(): void {
  holdFixture('translate', null)
}

/**
 * The active page's translation at `status`; `idle` takes the page's entry away (the offer the
 * stand-in host makes for its pages on its own is gone: the pill has no translate chip).
 */
export function translateFixture(state: UIState, status: TranslateStatus, bar: boolean): UIState {
  const tab = activeTab(state)
  if (!tab) return state
  if (status === 'idle') {
    if (!state.translate.tabs[tab.id]) return state
    const tabs = { ...state.translate.tabs }
    delete tabs[tab.id]
    return { ...state, translate: { ...state.translate, tabs } }
  }
  const translated = status === 'translated' || status === 'translating'
  const page: TranslateTabState = {
    tabId: tab.id,
    status,
    source: 'de',
    confidence: 0.94,
    target: 'en',
    progress: translated ? { done: status === 'translated' ? 42 : 17, total: 42 } : null,
    download: status === 'downloading' ? { received: 9_437_184, total: 41_943_040 } : null,
    error: status === 'error' ? 'The model could not be downloaded' : null,
    auto: true,
    dismissed: !bar
  }
  return {
    ...state,
    translate: {
      ...state.translate,
      available: true,
      tabs: { ...state.translate.tabs, [tab.id]: page }
    }
  }
}

export function blockingFixture(
  state: UIState,
  variant: string,
  now: number,
  blocked: number = BLOCKED_ON_PAGE
): UIState {
  const active = activeTab(state)
  // The page the state is about: the active tab, or – with the Settings tab up – the web page it
  // was opened from, whose site the "Sites without blocking" rows name (§10.5).
  const opener = active?.openerTabId ? state.tabs[active.openerTabId] : undefined
  const tab = active && siteOriginOf(active.url) ? active : (opener ?? active)
  const origin = tab ? siteOriginOf(tab.url) : null
  const level: TrackingLevel =
    variant === 'strict' ? 'strict' : variant === 'level-off' ? 'off' : 'balanced'
  const enabled = variant !== 'off'
  const full = variant === 'full'
  const bundled = variant === 'bundled'
  const updating = variant === 'updating'
  const customLists = full
    ? [
        {
          id: customListId(CUSTOM_LIST_URL),
          url: CUSTOM_LIST_URL,
          name: 'AdGuard Annoyances',
          enabled: true
        }
      ]
    : []
  const settings: UIState['settings'] = {
    ...state.settings,
    blocking: {
      ...state.settings.blocking,
      level,
      lists: {},
      customLists,
      userFilters: full ? USER_FILTERS : '',
      autoUpdate: true
    }
  }
  const on = enabledListsFor(settings.blocking, enabled)
  const updatedAt = bundled ? null : now - 2 * HOUR_MS
  const lists: FilterListStatus[] = DEFAULT_FILTER_LISTS.map((l) => ({
    ...l,
    enabled: on.has(l.id),
    version: bundled ? null : '202609170807',
    updatedAt,
    filterCount: FILTER_COUNTS[l.id] ?? 0,
    bundled,
    updating: updating && (l.id === 'easylist' || l.id === 'easyprivacy'),
    lastError: null
  }))
  for (const c of customLists)
    lists.push({
      id: c.id,
      name: c.name,
      description: c.url,
      url: c.url,
      homepage: c.url,
      licence: 'GPL-3.0',
      tier: null,
      enabled: c.enabled,
      version: null,
      updatedAt,
      filterCount: 7120,
      bundled: false,
      updating: false,
      lastError: null
    })
  const siteExceptions = [
    ...(full ? EXCEPTED_SITES : []),
    ...(variant === 'excepted' && origin ? [origin] : [])
  ].sort()
  const blocking: BlockingStatus = {
    ready: variant !== 'loading',
    enabled,
    siteExceptions,
    sessionBlocked: 1284,
    lists,
    updating,
    lastUpdatedAt: bundled || variant === 'loading' ? null : now - 2 * HOUR_MS,
    userFilterErrors: full ? [{ line: 3, message: 'Unknown option "foo"' }] : []
  }
  const blocks = enabled && level !== 'off' && !(origin !== null && siteExceptions.includes(origin))
  const tabs = { ...state.tabs }
  if (tab) tabs[tab.id] = { ...tab, blockedCount: blocks ? blocked : 0 }
  return { ...state, settings, blocking, tabs }
}

// ---------------------------------------------------------------------------
// Extensions, seeded
// ---------------------------------------------------------------------------

/** Lets go of the extension state the current spec holds over the core's pushes. */
let extensionsSeed: (() => void) | null = null

/**
 * Settings > Extensions in states this stand-in host cannot reach (it has no extension store, so
 * it reports the capability off and installs nothing): the chrome's copy of the browser state is
 * patched with the capability on and a set of installed extensions, and patched again over every
 * state the core pushes while the spec stands, as the request state is. Variants: `installed`
 * (six extensions: two stores, an unpacked one on Manifest V2, one turned off, one that failed to
 * load, one whose error console holds errors and warnings; three of them enabled with an action,
 * one wearing a badge, so the Extensions sheet has rows), `removed` (the same less Dark Reader,
 * for a tab on its options page that outlived its removal), `empty` (the capability on, nothing
 * installed) and `checking` (the update check running).
 */
function seedExtensions(variant: string): void {
  unseedExtensions()
  holdFixture('extensions', (state) => extensionsFixture(state, variant, Date.now()))
  const unanswer = answerActionMenus(variant)
  extensionsSeed = () => {
    holdFixture('extensions', null)
    unanswer()
  }
}

/** Stop holding a seeded extension state over the core's pushes. */
function unseedExtensions(): void {
  extensionsSeed?.()
  extensionsSeed = null
}

// ---------------------------------------------------------------------------
// Sync, seeded
// ---------------------------------------------------------------------------

/** Lets go of the sync state the current spec holds over the core's pushes. */
let syncSeed: (() => void) | null = null

/** The tree the `chosen` variant has picked: a Drive folder, as the system picker names one. */
const SYNC_FIXTURE_TREE =
  'content://com.android.externalstorage.documents/tree/primary%3ADrive%2FZenium'

/**
 * Settings › Sync in states this stand-in host cannot reach (it has no folder to pick and no
 * other device): the chrome's copy of the browser state is patched with the engine's status,
 * and patched again over every state the core pushes while the spec stands. Variants: `off`
 * (nothing set up, no folder chosen), `chosen` (the setup draft holds a picked tree, so Turn on
 * sync is live and its sheet has a folder to set up), `busy` (`chosen`, with the engine's
 * `sync.setup` held open so the passphrase sheet stays on its §9.30 busy form once sent), `on`
 * (connected: two other devices, last synced five minutes ago), `tabs` (`on` with Open tabs
 * syncing and the two devices' open tabs published: Tabs from other devices, History's From your
 * other devices group and the tab search's reach (TAB-02, TAB-21) are live, the menus carry
 * Send to your devices, and the core's sync stands in for the engine so they act; see
 * `standInEngine`), `empty` (connected, no other
 * device yet), `syncing` (a sync running), `error` (the last sync failed), `lost` (the folder's
 * permission is gone) and `merge` (the first sync waits on the merge question). The scope stays
 * the core's, so a tapped toggle shows its new state.
 */
function seedSync(variant: string, browser: Browser): void {
  unseedSync()
  const chosen = variant === 'chosen' || variant === 'busy'
  syncSetupStore.set({ folder: chosen ? SYNC_FIXTURE_TREE : null })
  let seeded: UIState | null = null
  const patch = (): void => {
    const state = browserStore.get().state
    if (!state || state === seeded) return
    seeded = syncFixture(state, variant, Date.now())
    browserStore.set({ state: seeded })
  }
  patch()
  const unpatch = browserStore.subscribe(patch)
  const release = holdSetup(variant)
  const restore = standInEngine(browser, variant)
  syncSeed = () => {
    unpatch()
    release()
    restore()
  }
}

/**
 * While the `tabs` fixture stands the core's own sync stands in as a connected engine: the menus
 * read its status (Send to your devices is in the tab menu and the app menu with two devices to
 * pick from), `sync.tabsFromDevices` answers the fixture's lists (`REMOTE_TABS`: the two devices'
 * open tabs, as the engine sorts them) and `sync.sendTab` confirms with the engine's toast, "Sent
 * to Work laptop", writing nothing – the stand-in host has no folder. Every other call goes to
 * the real engine. Returns the undo.
 */
function standInEngine(browser: Browser, variant: string): () => void {
  if (variant !== 'tabs') return () => undefined
  const real = browser.sync
  const status = (): UIState['sync'] =>
    syncFixture({ sync: real.status() } as UIState, variant, Date.now()).sync
  const standIn = new Proxy(real, {
    get: (target, key) => {
      if (key === 'status') return status
      if (key === 'tabsFromDevices')
        return async (): Promise<SyncDeviceTabs[]> => REMOTE_TABS(Date.now())
      if (key === 'sendTab')
        return async ({ deviceId }: { deviceId: string }): Promise<void> => {
          const device = status().devices.find((d) => d.id === deviceId)
          if (device) pushToast(`Sent to ${device.name}`)
        }
      return Reflect.get(target, key)
    }
  })
  Object.defineProperty(browser, 'sync', { value: standIn, configurable: true, writable: true })
  return () => {
    Object.defineProperty(browser, 'sync', { value: real, configurable: true, writable: true })
  }
}

/** A favicon the stand-in host can draw offline: a 16 px disc in the site's colour. */
const disc = (fill: string): string =>
  `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="${fill}"/></svg>`)}`

/**
 * The other devices' open tabs of the `tabs` fixture (ID-28): the laptop's four and the
 * desktop's two, each list newest activity first as the engine publishes it; one tab without a
 * favicon for the globe the row falls back to.
 */
const REMOTE_TABS = (now: number): SyncDeviceTabs[] => [
  {
    deviceId: 'device-desktop',
    deviceName: 'Home desktop',
    updatedAt: now - 3 * 60_000,
    tabs: [
      {
        tabId: 'd-1',
        windowId: null,
        url: 'https://www.wikipedia.org/wiki/Web_browser',
        title: 'Web browser - Wikipedia',
        favicon: disc('#3366cc'),
        lastActive: now - 4 * 60_000
      },
      {
        tabId: 'd-2',
        windowId: null,
        url: 'https://archive.org/details/software',
        title: 'Software Library : Free Software : Internet Archive',
        favicon: null,
        lastActive: now - 50 * 60_000
      }
    ]
  },
  {
    deviceId: 'device-laptop',
    deviceName: 'Work laptop',
    updatedAt: now - 2 * HOUR_MS,
    tabs: [
      {
        tabId: 'l-1',
        windowId: null,
        url: 'https://github.com/BenItBuhner/Zenium/pulls',
        title: 'Pull requests · BenItBuhner/Zenium',
        favicon: disc('#24292f'),
        lastActive: now - 2 * HOUR_MS
      },
      {
        tabId: 'l-2',
        windowId: null,
        url: 'https://developer.mozilla.org/en-US/docs/Web/API/Web_Share_API',
        title: 'Web Share API - Web APIs | MDN',
        favicon: disc('#000000'),
        lastActive: now - 3 * HOUR_MS
      },
      {
        tabId: 'l-3',
        windowId: null,
        url: 'https://www.figma.com/files/recent',
        title: 'Recents – Figma',
        favicon: disc('#a259ff'),
        lastActive: now - 5 * HOUR_MS
      },
      {
        tabId: 'l-4',
        windowId: null,
        url: 'https://news.ycombinator.com/',
        title: 'Hacker News',
        favicon: disc('#ff6600'),
        lastActive: now - 26 * HOUR_MS
      }
    ]
  }
]

/** Stop holding a seeded sync state over the core's pushes; the setup draft goes with it. */
function unseedSync(): void {
  syncSeed?.()
  syncSeed = null
  syncSetupStore.set({ folder: null })
}

/**
 * While the `busy` fixture stands the chrome's bridge takes `sync.setup` and never answers it,
 * the way a slow key derivation over a slow tree would look: the passphrase form stays busy
 * (fields read-only, the primary's spinner, Cancel at .4) for as long as the sheet is up. The
 * call is left pending on release – the sheet closes with the state, and the form goes with it.
 * Every other command goes through. Returns the undo.
 */
function holdSetup(variant: string): () => void {
  if (variant !== 'busy') return () => undefined
  const zen = window.zen
  const invoke = zen.invoke
  zen.invoke = <K extends CommandName>(
    name: K,
    args: CommandArgs<K>
  ): Promise<CommandResult<K>> => {
    if (name === 'sync.setup') return new Promise<CommandResult<K>>(() => undefined)
    return invoke(name, args)
  }
  return () => {
    if (zen.invoke !== invoke) zen.invoke = invoke
  }
}

export function syncFixture(state: UIState, variant: string, now: number): UIState {
  const base = state.sync
  const deviceName = 'Pixel 8'
  if (variant === 'off' || variant === 'chosen' || variant === 'busy') {
    return {
      ...state,
      sync: {
        ...base,
        enabled: false,
        folder: null,
        folderName: null,
        folderLost: false,
        deviceName,
        lastSyncAt: null,
        lastError: null,
        syncing: false,
        devices: [],
        pendingMerge: false
      }
    }
  }
  const lost = variant === 'lost'
  const merge = variant === 'merge'
  const devices =
    variant === 'empty' || merge
      ? []
      : [
          { id: 'device-laptop', name: 'Work laptop', lastSeen: now - 2 * HOUR_MS },
          { id: 'device-desktop', name: 'Home desktop', lastSeen: now - 3 * 60_000 }
        ]
  // `tabs`: `on` with Open tabs among what syncs and the devices' lists published (ID-28), so
  // Tabs from other devices, History's From your other devices group (TAB-02) and the menus'
  // Send to your devices (ID-27) are live.
  const tabs = variant === 'tabs'
  return {
    ...state,
    sync: {
      ...base,
      scope: tabs ? { ...base.scope, openTabs: true } : base.scope,
      remoteTabsVersion: tabs ? 1 : base.remoteTabsVersion,
      enabled: true,
      folder: SYNC_FIXTURE_TREE,
      folderName: 'Zenium',
      folderLost: lost,
      deviceName,
      lastSyncAt: merge ? null : now - 5 * 60_000,
      lastError: lost
        ? 'The sync folder is no longer accessible. Choose it again to keep syncing.'
        : variant === 'error'
          ? 'Could not read the folder: the drive is not mounted'
          : null,
      syncing: variant === 'syncing',
      devices,
      pendingMerge: merge
    }
  }
}

/**
 * The stand-in host has no extension to ask, so while the `installed` fixture stands the chrome's
 * bridge answers `extension.actionMenuItems` for the fixture extension that declares
 * action-context `contextMenus` items (Dark Reader's, `FIXTURE_ACTION_MENUS`) and takes the pick
 * (`extension.actionMenuClick`) as done, the way the core would; every other command goes
 * through. Returns the undo.
 */
function answerActionMenus(variant: string): () => void {
  if (variant !== 'installed') return () => undefined
  const zen = window.zen
  const invoke = zen.invoke
  zen.invoke = <K extends CommandName>(
    name: K,
    args: CommandArgs<K>
  ): Promise<CommandResult<K>> => {
    if (name === 'extension.actionMenuItems') {
      const { id } = args as CommandArgs<'extension.actionMenuItems'>
      return Promise.resolve((FIXTURE_ACTION_MENUS[id] ?? []) as CommandResult<K>)
    }
    if (name === 'extension.actionMenuClick') return Promise.resolve(undefined as CommandResult<K>)
    return invoke(name, args)
  }
  return () => {
    if (zen.invoke !== invoke) zen.invoke = invoke
  }
}

/**
 * The action-context `contextMenus` items a fixture extension adds to its long-press menu, as
 * `extension.actionMenuItems` answers them: Dark Reader's toggles (check states) and a plain row
 * under its own separator, so the menu sheet shows the extension's group above the browser's.
 */
const FIXTURE_ACTION_MENUS: Record<string, MenuItemDescriptor[]> = {
  eimadpbcbfnmbkopoojfekhnkhdbieeh: [
    {
      id: 'action_1_1',
      type: 'checkbox',
      label: 'Dark Reader On',
      enabled: true,
      checked: true,
      icon: null,
      submenu: null
    },
    {
      id: 'action_1_2',
      type: 'checkbox',
      label: 'Enable on This Site',
      enabled: true,
      checked: false,
      icon: null,
      submenu: null
    },
    {
      id: 'action_1_3',
      type: 'separator',
      label: '',
      enabled: true,
      checked: false,
      submenu: null
    },
    {
      id: 'action_1_4',
      type: 'normal',
      label: 'Open Developer Tools',
      enabled: true,
      checked: false,
      icon: null,
      submenu: null
    }
  ]
}

/** A 48 px icon for a fixture extension: a rounded tile in its colour with its initial. */
function fixtureIcon(letter: string, fill: string): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">` +
    `<rect width="48" height="48" rx="10" fill="${fill}"/>` +
    `<text x="24" y="32" text-anchor="middle" font-family="system-ui, sans-serif" ` +
    `font-size="24" font-weight="600" fill="#fff">${letter}</text></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}

/**
 * A fixture extension's `chrome.action` state, as the runtime reports it once the extension has
 * loaded: the manifest's title and popup, a badge when `badgeText` is given, in the colours the
 * extension set (null: the chrome's own).
 */
function fixtureAction(title: string, over: Partial<ExtensionAction> = {}): ExtensionAction {
  return {
    badgeText: '',
    badgeBackgroundColor: null,
    badgeTextColor: null,
    title,
    icon: null,
    popup: 'popup.html',
    enabled: true,
    ...over
  }
}

function fixtureExtension(now: number, over: Partial<ExtensionInfo>): ExtensionInfo {
  return {
    id: '',
    name: '',
    version: '1.0.0',
    description: '',
    path: '',
    enabled: true,
    icon: null,
    popup: 'popup.html',
    error: null,
    source: 'chrome-web-store',
    publisher: 'chrome-web-store',
    updateUrl: 'https://clients2.google.com/service/update2/crx',
    installedAt: now - 40 * 24 * HOUR_MS,
    updatedAt: now - 40 * 24 * HOUR_MS,
    pinned: false,
    toolbarPinned: false,
    allowFileAccess: false,
    allowPrivate: false,
    allowUserScripts: false,
    manifestVersion: 3,
    permissions: ['storage'],
    hostPermissions: [],
    optionsPage: null,
    newTabPage: null,
    newTabOverride: false,
    warnings: [],
    pendingWarnings: null,
    updateState: 'up-to-date',
    availableVersion: null,
    updateError: null,
    updateCheckedAt: now - 2 * HOUR_MS,
    errors: [],
    ...over
  }
}

export function extensionsFixture(state: UIState, variant: string, now: number): UIState {
  const darkReader = 'eimadpbcbfnmbkopoojfekhnkhdbieeh'
  const tabTools = 'pkmhldhpnjffdmnnpcgfcjoaebbhbmcn'
  const extensions: ExtensionInfo[] =
    variant === 'empty'
      ? []
      : [
          fixtureExtension(now, {
            id: darkReader,
            name: 'Dark Reader',
            version: '4.9.132',
            description:
              'Dark mode for every website. Take care of your eyes, use dark theme for night and daily browsing.',
            path: `/data/user/0/app.zen.chromium/files/zen/extensions/${darkReader}`,
            icon: fixtureIcon('D', '#3f3f52'),
            action: fixtureAction('Dark Reader', { popup: 'ui/popup/index.html' }),
            permissions: ['alarms', 'contextMenus', 'storage', 'tabs', 'theme', 'fontSettings'],
            hostPermissions: ['<all_urls>'],
            optionsPage: 'ui/options/index.html',
            warnings: [
              'Read and change all your data on all websites',
              'Change your settings that control websites’ access to features such as cookies, JavaScript, plugins, geolocation, microphone, camera etc.'
            ],
            installedAt: now - 90 * 24 * HOUR_MS,
            updatedAt: now - 6 * 24 * HOUR_MS,
            errors: [
              {
                id: 1,
                level: 'warning',
                source: 'load',
                message: 'browser_specific_settings: Unrecognized manifest key',
                url: `chrome-extension://${darkReader}/manifest.json`,
                line: null,
                context: null,
                at: now - 6 * 24 * HOUR_MS,
                lastAt: now - 6 * 24 * HOUR_MS,
                count: 1
              },
              {
                id: 2,
                level: 'error',
                source: 'worker',
                message: "Uncaught TypeError: Cannot read properties of undefined (reading 'id')",
                url: `chrome-extension://${darkReader}/background/index.js`,
                line: 214,
                context: `chrome-extension://${darkReader}/background/index.js`,
                at: now - 3 * HOUR_MS,
                lastAt: now - 25 * 60 * 1000,
                count: 3
              },
              {
                id: 3,
                level: 'error',
                source: 'page',
                message:
                  'Unchecked runtime.lastError: The message port closed before a response was received.',
                url: `chrome-extension://${darkReader}/ui/popup/index.js`,
                line: 58,
                context: `chrome-extension://${darkReader}/ui/popup/index.html`,
                at: now - 40 * 60 * 1000,
                lastAt: now - 40 * 60 * 1000,
                count: 1
              },
              {
                id: 4,
                level: 'warning',
                source: 'content',
                message:
                  'Deprecated: chrome.extension.sendRequest is not supported; use chrome.runtime.sendMessage',
                url: `chrome-extension://${darkReader}/inject/index.js`,
                line: 3,
                context: 'https://news.ycombinator.com/',
                at: now - 8 * 60 * 1000,
                lastAt: now - 4 * 60 * 1000,
                count: 2
              }
            ]
          }),
          fixtureExtension(now, {
            id: 'ddkjiahejlhfcafbddmgiahcphecmpfh',
            name: 'uBlock Origin Lite',
            version: '2026.912.1352',
            description: 'An efficient content blocker. Easy on CPU and memory.',
            icon: fixtureIcon('U', '#800000'),
            // Blocked on this page, the way the blocker counts on its badge.
            action: fixtureAction('uBlock Origin Lite', {
              badgeText: '12',
              badgeBackgroundColor: '#800000',
              badgeTextColor: '#ffffff'
            }),
            permissions: ['activeTab', 'declarativeNetRequest', 'scripting', 'storage'],
            hostPermissions: ['<all_urls>'],
            optionsPage: 'dashboard.html',
            warnings: ['Read and change all your data on all websites'],
            updateState: 'available',
            availableVersion: '2026.918.1145',
            installedAt: now - 60 * 24 * HOUR_MS,
            updatedAt: now - 7 * 24 * HOUR_MS
          }),
          fixtureExtension(now, {
            id: 'nngceckbapebfimnlniiiahkandclblb',
            name: 'Bitwarden Password Manager',
            version: '2026.8.2',
            description:
              'At home, at work, or on the go, Bitwarden easily secures all your passwords, passkeys and sensitive information.',
            icon: fixtureIcon('B', '#175ddc'),
            action: fixtureAction('Bitwarden Password Manager'),
            permissions: [
              'tabs',
              'contextMenus',
              'storage',
              'clipboardRead',
              'clipboardWrite',
              'webRequest',
              'alarms',
              'scripting'
            ],
            hostPermissions: ['http://*/*', 'https://*/*'],
            optionsPage: 'popup/index.html#/settings',
            warnings: [
              'Read and change all your data on all websites',
              'Read data you copy and paste',
              'Modify data you copy and paste'
            ],
            installedAt: now - 120 * 24 * HOUR_MS,
            updatedAt: now - 20 * 24 * HOUR_MS
          }),
          fixtureExtension(now, {
            id: 'gebbhagfogifgggkldgodflihgfeippi',
            name: 'Return YouTube Dislike',
            version: '3.0.0.19',
            description: 'Returns ability to see dislike statistics on YouTube',
            icon: fixtureIcon('R', '#ff4c4c'),
            action: fixtureAction('Return YouTube Dislike'),
            enabled: false,
            hostPermissions: ['*://*.youtube.com/*', '*://returnyoutubedislikeapi.com/*'],
            warnings: [
              'Read and change your data on all youtube.com sites and returnyoutubedislikeapi.com'
            ],
            installedAt: now - 200 * 24 * HOUR_MS,
            updatedAt: now - 200 * 24 * HOUR_MS
          }),
          fixtureExtension(now, {
            id: tabTools,
            name: 'Zenium Tab Tools',
            version: '0.4.1',
            description: 'Sorts and groups the tabs of a Space by site.',
            path: `/storage/emulated/0/Download/zenium-tab-tools`,
            icon: fixtureIcon('Z', '#6264dc'),
            source: 'unpacked',
            publisher: null,
            updateUrl: null,
            updateState: 'unknown',
            updateCheckedAt: null,
            manifestVersion: 2,
            permissions: ['tabs', 'tabGroups', 'storage', 'userScripts'],
            hostPermissions: [],
            warnings: ['Read your browsing history'],
            installedAt: now - 3 * 24 * HOUR_MS,
            updatedAt: now - 3 * 24 * HOUR_MS
          }),
          fixtureExtension(now, {
            id: 'bfnaelmomeimhlpmgjnjophhpkkoljpa',
            name: 'Phantom',
            version: '25.19.0',
            description: 'A friendly crypto wallet built for DeFi and NFTs.',
            icon: fixtureIcon('P', '#ab9ff2'),
            source: 'crx',
            publisher: 'unknown',
            updateUrl: null,
            updateState: 'unknown',
            updateCheckedAt: null,
            popup: null,
            error: 'manifest_version: Required key is missing',
            permissions: [],
            hostPermissions: [],
            warnings: [],
            installedAt: now - HOUR_MS,
            updatedAt: now - HOUR_MS,
            errors: [
              {
                id: 1,
                level: 'error',
                source: 'load',
                message: 'manifest_version: Required key is missing',
                url: `chrome-extension://bfnaelmomeimhlpmgjnjophhpkkoljpa/manifest.json`,
                line: null,
                context: null,
                at: now - HOUR_MS,
                lastAt: now - HOUR_MS,
                count: 1
              }
            ]
          })
        ]
  return {
    ...state,
    capabilities: { ...state.capabilities, extensions: true },
    // `removed`: Dark Reader is gone, as after its Remove – a tab on its options page outlives it.
    extensions: variant === 'removed' ? extensions.filter((e) => e.id !== darkReader) : extensions,
    extensionUpdates: {
      lastCheckedAt: variant === 'empty' ? null : now - 2 * HOUR_MS,
      checking: variant === 'checking'
    }
  }
}

// ---------------------------------------------------------------------------
// The last import, seeded
// ---------------------------------------------------------------------------

/** Lets go of the import state the current spec holds over the core's pushes. */
let importSeed: (() => void) | null = null

/**
 * Settings > Import's Last import group in a state the stand-in host cannot reach through its
 * file input (ID-23, PR #259): the chrome's copy of the browser state is patched with a finished
 * import and patched again over every state the core pushes while the spec stands, as the
 * request state is. Variant: `failed` – a run-level failure, the outer catch of
 * `ImportService.run` when the picker's bridge call rejects before any kind ran, so the failure
 * is the headline row's label in the danger ink over the neutral caption (§9.33). The results a
 * real file gives (what came in, a kind that failed) need no seed: the driver feeds the file.
 */
function seedImport(variant: string): void {
  unseedImport()
  let seeded: UIState | null = null
  const patch = (): void => {
    const state = browserStore.get().state
    if (!state || state === seeded) return
    seeded = importFixture(state, variant, Date.now())
    browserStore.set({ state: seeded })
  }
  patch()
  importSeed = browserStore.subscribe(patch)
}

/** Stop holding a seeded import state over the core's pushes. */
function unseedImport(): void {
  importSeed?.()
  importSeed = null
}

export function importFixture(state: UIState, variant: string, now: number): UIState {
  if (variant !== 'failed') return state
  const [bookmarksFile] = fileSources(false)
  return {
    ...state,
    import: {
      source: bookmarksFile!,
      kinds: ['bookmarks'],
      status: 'failed',
      current: null,
      results: {},
      error: 'The file picker could not be opened.',
      folderId: null,
      startedAt: now - 3000,
      finishedAt: now - 2000
    }
  }
}

/** How long the editor's first suggestions are waited for before the state goes ahead anyway. */
const SUGGESTIONS_MS = 4000

/**
 * The pill's editor the way a tap on the pill opens it: search-ready over the page (`edit`,
 * nothing typed: the header row with Share, Copy link and Edit; the clipboard row when the
 * stand-in clipboard holds something), or over a new tab (`new-tab`, no header). `text` is then
 * typed into the field as a keyboard would (the suggestions refresh, query rows grow their Refine
 * arrow), the first suggestions are waited for, the steps pressed in order, and `finish` called.
 */
function applyUrlbar(
  target: Extract<PreviewState, { kind: 'urlbar' }>,
  tabId: string | null,
  finish: () => void
): void {
  if (target.clip !== null) {
    window.dispatchEvent(new CustomEvent(PREVIEW_CLIP_EVENT, { detail: target.clip }))
  }
  const mode = target.newTab || !tabId ? 'new-tab' : 'edit'
  void openUrlbar(mode, mode === 'edit' ? tabId : null, { attached: true }).then(() => {
    requestAnimationFrame(() => {
      if (target.text) type(URLBAR_FIELD, target.text)
      whenSuggested(() => steps(target.then ?? [], finish))
    })
  })
}

const URLBAR_FIELD = 'input[data-testid="urlbar-input"]'

/** Runs `fn` once the editor lists a row (or the hint that there is none), or after {@link SUGGESTIONS_MS}. */
function whenSuggested(fn: () => void, deadline = performance.now() + SUGGESTIONS_MS): void {
  const listed = document.querySelector(
    '.zen-omnibox-sheet [role="option"], [data-testid="urlbar-page-header"]'
  )
  if (listed || performance.now() > deadline) {
    // A frame for the rows to lay out before a step presses one of their controls.
    setTimeout(fn, 300)
    return
  }
  setTimeout(() => whenSuggested(fn, deadline), 50)
}

/**
 * The certificate the host reports with a certificate error (`failLoad` in `views.ts`), so that
 * `error=<ERR_CERT_*>` shows the interstitial whole: the Advanced block lists these fields and
 * offers to proceed. An expired one, as expired.badssl.com serves.
 */
const PREVIEW_CERTIFICATE: CertificateDetails = {
  subjectName: '*.badssl.com',
  issuerName: 'COMODO RSA Domain Validation Secure Server CA',
  validStart: Date.UTC(2015, 3, 9),
  validExpiry: Date.UTC(2015, 3, 12),
  fingerprint: 'sha256/1DqoEDv6Bl2oL9bHAXqmcK+mfhLl7Ts2kyR6DDzgROo='
}

/**
 * A page tab is the state: reached once the active tab is a page tab and the page has its rows
 * (its chunk loads on the first open), then a moment for its drill-in's slide to settle before
 * the search is typed, a row shown or a step taken. `seed` patches the seeded state in before the
 * rows are shown (a row it adds is there for `show` and the steps); `finish` ends the state.
 */
function settlePage(
  target: { search?: string; show?: string; then?: readonly PreviewStep[] },
  seed: () => void,
  finish: () => void
): void {
  whenActiveTabIs(
    (active) => isInternalPageUrl(active.url),
    () => {
      whenPageRendered(() => {
        setTimeout(() => {
          seed()
          // The landing keeps its query between states unless it is retyped: an empty one clears it.
          type('input[placeholder="Find in Settings"]', target.search ?? '')
          requestAnimationFrame(() => {
            // The page keeps where a previous state scrolled it; every state starts at the top.
            for (const el of document.querySelectorAll<HTMLElement>('[data-page] *')) {
              if (el.scrollTop > 0) el.scrollTop = 0
            }
            show(target.show)
            steps(target.then ?? [], finish)
          })
        }, 300)
      })
    }
  )
}

/**
 * The load of `url` in the tab failed with `code`, as the host would report it (`failLoad` in
 * `views.ts`): the core answers with the zen://error page for that code, in the tab's frame – for
 * a certificate error the interstitial, with the refused certificate's details.
 */
function failLoad(tabId: string, code: number, url: string): void {
  const host = (window as unknown as { __zenHost: HostGlobal }).__zenHost
  const certificate = isCertificateError(code) ? PREVIEW_CERTIFICATE : undefined
  host.viewEvent(tabId, 'failLoad', JSON.stringify({ code, description: '', url, certificate }))
}

/** Chromium's `net::ERR_INTERNET_DISCONNECTED`: the failure that means offline by itself. */
const ERR_INTERNET_DISCONNECTED = -106

/** The host's word on the device's connectivity, as `Connectivity.kt` would send it. */
function setConnectivity(online: boolean): void {
  const host = (window as unknown as { __zenHost: HostGlobal }).__zenHost
  host.hostEvent('connectivity', JSON.stringify({ online }))
}

/**
 * The device's connectivity played over the active tab (ERR-06, ERR-07) through the core's own
 * model (`ConnectivityService`, with its debounce): the device goes offline and, for `offline`,
 * the state is reached once the chrome shows it (the banner up). For `back-online` the device
 * comes back at once and the state is reached once the chrome agrees (the toast up). For
 * `reloading` the tab's load fails as offline first – the error page, armed to reload itself –
 * then the device comes back: the core puts the page in its own Reloading state and navigates
 * it to the page again, a load the stand-in host makes take its time (PREVIEW_SLOW_LOAD_EVENT),
 * so the still shows the error page reloading with the toast beside it.
 */
function playConnectivity(tab: Tab, variant: PreviewNetworkVariant, then: () => void): void {
  setConnectivity(false)
  untilState(
    (s) => !s.network.online,
    () => {
      if (variant === 'offline') {
        afterFrames(2, then)
        return
      }
      const back = (): void => {
        setConnectivity(true)
        untilState(
          (s) => s.network.online,
          () => afterFrames(2, then)
        )
      }
      if (variant === 'back-online') {
        back()
        return
      }
      failLoad(tab.id, ERR_INTERNET_DISCONNECTED, tab.url)
      // The error page's document must be up before the device comes back: the core's busy
      // state runs inside it, and the load it starts is the unhurried one.
      whenActiveTabIs(
        (t) => t.id === tab.id && t.url.startsWith(ERROR_URL_PREFIX) && !t.loading,
        () => {
          window.dispatchEvent(new CustomEvent(PREVIEW_SLOW_LOAD_EVENT, { detail: tab.id }))
          window.setTimeout(back, STEP_SETTLE_MS)
        }
      )
    }
  )
}

/**
 * The device back online before the next state, when a `network=` state took it off: the core
 * hears the host's word and, once its debounce has passed, answers with the Back online toast,
 * which the next state must not carry – so the return is waited for and the toast cleared
 * before the state is reached.
 */
function restoreConnectivity(): Promise<void> {
  const state = browserStore.get().state
  if (!state || state.network.online) return Promise.resolve()
  setConnectivity(true)
  return new Promise<void>((resolve) =>
    untilState(
      (s) => s.network.online,
      () =>
        afterFrames(2, () => {
          clearMessages(null)
          resolve()
        })
    )
  )
}

/**
 * The active tab back on its page, loaded, before the next state: a previous state may have left
 * it on an error page (`error=`, `crash=`, `network=reloading`) or with a load on its way (the
 * reloading state's unhurried one). The next state starts on the page – a `network=reloading`
 * fails the page's own URL, the prompt is about the page – and an error page the next state puts
 * up is a fresh document, which matters for the scheme: the page reads it once, at load (on a
 * device the host reloads pages on a theme switch; this host does not). Bounded by `untilState`.
 */
async function leaveErrorPage(): Promise<void> {
  const state = browserStore.get().state
  const tab = state ? activeTab(state) : null
  if (!tab) return
  if (tab.url.startsWith(ERROR_URL_PREFIX)) {
    run('tab.reload', { tabId: tab.id })
    await new Promise<void>((resolve) =>
      untilState((s) => {
        const t = activeTab(s)
        return t === null || t.id !== tab.id || !t.url.startsWith(ERROR_URL_PREFIX)
      }, resolve)
    )
  }
  // The core's word on the load is not enough here: the reset above marked the tab as loaded
  // for the messages, while the stand-in host may still be holding the page back. The held
  // loads land, and the tab's frame is waited for until it shows what it was told to.
  window.dispatchEvent(new CustomEvent(PREVIEW_SETTLE_LOADS_EVENT))
  await untilPainted(tab.id)
}

/** How long a page load in the stand-in host is waited for before the next state goes ahead anyway. */
const PAINT_TIMEOUT_MS = 6000

/**
 * Resolves once the stand-in host's frame for `tabId` shows the URL it was last told to load
 * (`preview.ts` marks `data-painted` on the frame's load), or once waiting stops being worth it.
 */
function untilPainted(tabId: string): Promise<void> {
  const deadline = performance.now() + PAINT_TIMEOUT_MS
  return new Promise<void>((resolve) => {
    const check = (): void => {
      const frame = [
        ...document.querySelectorAll<HTMLIFrameElement>('iframe.zen-preview-view')
      ].find((f) => f.dataset.tabId === tabId)
      if (!frame || frame.dataset.painted === frame.dataset.url || performance.now() > deadline) {
        resolve()
        return
      }
      window.setTimeout(check, 50)
    }
    check()
  })
}

/**
 * The active tab's renderer went (ERR-15), as the host reports it (`crashed` in `views.ts`,
 * `RendererExits.kt` behind it): the core answers with the crash page for the way it went, in
 * the tab's frame – for `repeat`, the page's second-time variant with Show tabs beside Reload.
 * Reached once the tab shows that crash page and its document has had a moment to paint.
 */
function crashTab(tab: Tab, variant: PreviewCrashVariant, then: () => void): void {
  const host = (window as unknown as { __zenHost: HostGlobal }).__zenHost
  const reason = variant === 'memory' ? 'oom-kill' : variant === 'hung' ? 'hung' : 'crashed'
  const repeat = variant === 'repeat'
  host.viewEvent(tab.id, 'crashed', JSON.stringify({ reason, repeat }))
  const expected = variant === 'repeat' ? 'crash' : variant
  whenActiveTabIs(
    (t) => {
      if (t.id !== tab.id || t.loading || !t.url.startsWith(ERROR_URL_PREFIX)) return false
      const params = new URL(t.url).searchParams
      if (params.get('code') !== '-1') return false
      const options = crashPageOptionsOf(params)
      return options.variant === expected && options.repeat === repeat
    },
    () => window.setTimeout(then, STEP_SETTLE_MS)
  )
}

/** Type `text` into the first element matching `selector` the way a keyboard would. */
function type(selector: string, text: string): void {
  const input = document.querySelector<HTMLInputElement>(selector)
  if (input) typeInto(input, text)
}

function typeInto(input: HTMLInputElement, text: string): void {
  if (input.value === text) return
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, text)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

/** Take `list` in order, a settle between steps, then `then`. */
function steps(list: readonly PreviewStep[], then: () => void): void {
  const [step, ...rest] = list
  if (!step) {
    then()
    return
  }
  takeStep(step)
  setTimeout(() => steps(rest, then), step.kind === 'press' ? PRESS_SETTLE_MS : STEP_SETTLE_MS)
}

function takeStep(step: PreviewStep): void {
  const state = browserStore.get().state
  switch (step.kind) {
    case 'tap':
      tap(step.text)
      return
    case 'hold':
      hold(step.text)
      return
    case 'press':
      press(step.text)
      return
    case 'type': {
      // A finger in the field, the text, then a tap elsewhere: the field is left touched, so a
      // form's validation has its say in the still.
      const field = document.getElementById(step.id)
      if (!(field instanceof HTMLInputElement)) return
      field.focus()
      type(`#${step.id}`, step.text)
      field.blur()
      return
    }
    case 'back':
      // One system back, committed: the top sheet, or the section over the landing, goes.
      dispatchBackEvent('start', { edge: 'left' })
      dispatchBackEvent('commit')
      return
    case 'overview':
      if (state) openOverview(state)
      return
    case 'urlbar': {
      const tab = state ? activeTab(state) : null
      void openUrlbar(tab ? 'edit' : 'new-tab', tab?.id ?? null, { attached: true })
    }
  }
}

/**
 * Press the first button whose accessible label or own text reads `text` – a row (its label is
 * the first line of its text), a sheet's option, a footer button – the way a finger would.
 */
function tap(text: string): void {
  pressable(text)?.click()
}

/**
 * Hold the first button whose accessible label or own text reads `text` – a row with a menu –
 * the way a finger resting on it would: the row's gestures take the `contextmenu` Chromium
 * raises for a touch hold (`useRowGestures`), so that event stands for the hold.
 */
function hold(text: string): void {
  const button = pressable(text)
  if (!button) return
  const box = button.getBoundingClientRect()
  button.dispatchEvent(
    new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      clientX: box.left + box.width / 2,
      clientY: box.top + box.height / 2
    })
  )
}

/**
 * Rest a finger on the first button whose accessible label or own text reads `text` for the
 * long-press time and lift it in place – an overview card, whose hold is the pointer's timer
 * (`useCardLift`), not a `contextmenu`: the card is lifted, put back, and its sheet comes up.
 * The pointer's events as Chromium sends a touch's: down on the card, up seen by the window.
 */
function press(text: string): void {
  const button = pressable(text)
  if (!button) return
  const box = button.getBoundingClientRect()
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
    button: 0,
    buttons: 1
  }
  button.dispatchEvent(new PointerEvent('pointerdown', init))
  setTimeout(
    () => button.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 })),
    PRESS_HOLD_MS
  )
}

/**
 * What a finger could press: a button, a checkbox in its span form (an overview card in the
 * select-tabs mode, a row's box, §9.34), or a checkbox row's label (`.zen-v2-check-row`, §9.30),
 * whose whole face toggles its box.
 */
const PRESSABLE = 'button, [role="button"], [role="checkbox"], label:has(> input[type="checkbox"])'

/** The first button a finger could press whose accessible label or own text reads `text`. */
function pressable(text: string): HTMLElement | null {
  const wanted = text.trim()
  const reachable = (el: Element | null | undefined): el is HTMLElement =>
    el instanceof HTMLElement && !el.closest('[inert]') && el.getAttribute('aria-hidden') !== 'true'
  for (const el of document.querySelectorAll<HTMLElement>(PRESSABLE)) {
    if (!reachable(el)) continue
    if (el.getAttribute('aria-label')?.trim() === wanted || el.textContent?.trim() === wanted)
      return el
  }
  // A row draws its label in a child beside its description: the nearest button up from the
  // text node that reads the label.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim() !== wanted) continue
    const button = node.parentElement?.closest(PRESSABLE)
    if (reachable(button)) return button
  }
  return null
}

/** How long the page's first render (its chunk) is waited for before the state goes ahead anyway. */
const PAGE_RENDER_MS = 4000

/**
 * Runs `fn` once the page in the frame has drawn a row (a section's or the landing's), or after
 * {@link PAGE_RENDER_MS}: the page's code loads on its first open, and a search typed, a row
 * shown or a step taken before the rows exist would find nothing.
 */
function whenPageRendered(fn: () => void, deadline = performance.now() + PAGE_RENDER_MS): void {
  if (document.querySelector('[data-page] button') || performance.now() > deadline) {
    fn()
    return
  }
  setTimeout(() => whenPageRendered(fn, deadline), 50)
}

/**
 * Runs `fn` once the overview is on the stage and takes a press, or after {@link PAGE_RENDER_MS}:
 * `openOverview` mounts it only once the page's picture is captured (`showOverview`), a round
 * trip through the host that outlasts a couple of frames when a previous state's overlay or
 * sheet invalidated the picture; and a sheet the reset dismissed (a menu, `closeMenu`) holds the
 * window chrome – the overview's root among it – inert until it has landed (`holdChromeInert`).
 * A step taken before the header exists, or while it is inert, would find nothing to press.
 */
function whenOverviewUp(fn: () => void, deadline = performance.now() + PAGE_RENDER_MS): void {
  const up = document.querySelector('.zen-overview header') && !chromeInertHeld()
  if (up || performance.now() > deadline) {
    fn()
    return
  }
  setTimeout(() => whenOverviewUp(fn, deadline), 50)
}

/** Runs `fn` once the active tab satisfies `test` (at once when it already does). */
function whenActiveTabIs(test: (tab: Tab) => boolean, fn: () => void): void {
  whenState((state) => {
    const tab = activeTab(state)
    return tab !== null && test(tab)
  }, fn)
}

/** Runs `fn` once the core's state satisfies `test` (at once when it already does). */
function whenState(test: (state: UIState) => boolean, fn: () => void): void {
  const check = (): boolean => {
    const state = browserStore.get().state
    return state !== null && test(state)
  }
  if (check()) {
    fn()
    return
  }
  const unsubscribe = browserStore.subscribe(() => {
    if (!check()) return
    unsubscribe()
    fn()
  })
}

/** The new tab page's scroller (`NewTabPage.tsx`), which carries the field toward the pill's slot. */
const NTP_SCROLLER = '.zen-ntp-scroll'

/**
 * The new tab page with its field at a pose of the morph (`ntp=<pose>`): a blank tab is opened
 * (a private one for a private pose) and, once its page has registered the field with the morph
 * (`fakeboxMorphStore.tabId`), the pose is taken – a scroll of the page's own scroller for the
 * scrubbed poses (as far as the page can scroll: a page that does not overflow does not scrub),
 * the tap for `open`, and the held spring for `morph:<n>`, which no tap reaches on its own. The
 * state is reached once the bar is up for the open poses (the omnibox mounts on the frame after
 * the tap) and a frame later for the rest.
 */
function applyNewTabPose(
  target: Extract<PreviewState, { kind: 'ntp' }>,
  state: UIState,
  finish: () => void
): void {
  const activeId = activeTab(state)?.id ?? null
  const opened = target.private
    ? cmd('tab.newPrivate', {})
    : cmd('tab.create', { url: BLANK_URL, active: true })
  void opened.then((tabId) => {
    if (!tabId) {
      finish()
      return
    }
    if (!target.private) previewNewTab = { tabId, activeId }
    // At the pose: the steps (a tile's hold, its menu's Edit), then the held drag, if any.
    const then = target.then ?? []
    const drag = target.drag
    const afterPose = (): void => {
      const afterSteps = (): void => (drag ? dragTile(drag, finish) : finish())
      if (then.length) setTimeout(() => steps(then, afterSteps), STEP_SETTLE_MS)
      else afterSteps()
    }
    whenMorph(
      () => fakeboxMorphStore.get().tabId === tabId,
      () => afterFrames(2, () => takeNewTabPose(target.pose, afterPose))
    )
  })
}

/** How many moves the held finger's travel is dealt out in, and how long each takes. */
const DRAG_MOVES = 8
const DRAG_MOVE_MS = 40

/**
 * Hold a new tab page tile and carry it (`drag=<tile>:<dx>,<dy>`, NTP-06): the pointer's
 * events as Chromium sends a touch's – down on the tile's button, the long-press time (its
 * timer lifts the tile, `useLongPress` → `useTileReorder`), then the finger's moves in even
 * steps to the destination, where it stays down. The grid is left mid-reorder: the tile in the
 * hand over its neighbours, the draft order drawn and the others glided. `finish` runs once the
 * moves are dealt out and the glide has had its frames.
 */
function dragTile(drag: { text: string; dx: number; dy: number }, finish: () => void): void {
  const button = pressable(drag.text)
  if (!button) {
    finish()
    return
  }
  const box = button.getBoundingClientRect()
  const x0 = box.left + box.width / 2
  const y0 = box.top + box.height / 2
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    pointerId: 1,
    pointerType: 'touch',
    isPrimary: true,
    clientX: x0,
    clientY: y0,
    button: 0,
    buttons: 1
  }
  button.dispatchEvent(new PointerEvent('pointerdown', init))
  let move = 0
  const step = (): void => {
    move += 1
    const k = move / DRAG_MOVES
    button.dispatchEvent(
      new PointerEvent('pointermove', {
        ...init,
        button: -1,
        clientX: x0 + drag.dx * k,
        clientY: y0 + drag.dy * k
      })
    )
    if (move < DRAG_MOVES) setTimeout(step, DRAG_MOVE_MS)
    else afterFrames(3, finish)
  }
  setTimeout(step, PRESS_HOLD_MS)
}

/**
 * Runs `then` once `ready` holds, watching the morph's store and the chrome's (the omnibox
 * mounts on the frame after a tap), or once waiting stops being worth it.
 */
function whenMorph(ready: () => boolean, then: () => void): void {
  if (ready()) {
    then()
    return
  }
  let settled = false
  const finish = (): void => {
    if (settled) return
    settled = true
    for (const unsubscribe of unsubscribes) unsubscribe()
    clearTimeout(timer)
    then()
  }
  const check = (): void => {
    if (ready()) finish()
  }
  const unsubscribes = [fakeboxMorphStore.subscribe(check), uiStore.subscribe(check)]
  const timer = setTimeout(finish, SURFACE_TIMEOUT_MS)
}

function takeNewTabPose(pose: PreviewNtpPose, finish: () => void): void {
  const scroller = document.querySelector<HTMLElement>(NTP_SCROLLER)
  const scrollTo = (px: number): void => {
    if (scroller) scroller.scrollTop = px
  }
  // The omnibox's field is on the frame: the double has its target and the sheet is fading in.
  const opened = (): boolean =>
    uiStore.get().urlbar.open && document.querySelector('.zen-omnibox-field') !== null
  switch (pose.kind) {
    case 'rest':
      afterFrames(2, finish)
      return
    case 'scroll':
      scrollTo(pose.px)
      afterFrames(2, finish)
      return
    case 'scrub':
      scrollTo(pose.t * (fakeboxScrubTravel() ?? 0))
      afterFrames(2, finish)
      return
    case 'docked':
      scrollTo(fakeboxScrubTravel() ?? Number.MAX_SAFE_INTEGER)
      afterFrames(2, finish)
      return
    case 'open':
      tapFakebox()
      whenMorph(
        () => opened() && fakeboxMorphStore.get().phase === 'open',
        () => afterFrames(2, finish)
      )
      return
    case 'morph':
      holdFakeboxMorph(pose.t)
      whenMorph(opened, () => afterFrames(3, finish))
      return
  }
}

/** The page a private tab is put on when the state names none. */
const PRIVATE_PAGE = 'https://example.com/'

/**
 * The pages the session's other private tabs open on (`count=<n>`, in this order, round again
 * past the end): pages of the stand-in site (`PREVIEW_SAMPLE_ORIGIN`), which this host shows
 * itself, so each row reads a page's title without the network, and none is the surface's own
 * page (the root, or a `url=` of the spec's choosing).
 */
const PRIVATE_SITES = [
  `${PREVIEW_SAMPLE_ORIGIN}/berths-on-the-north-quay`,
  `${PREVIEW_SAMPLE_ORIGIN}/fuel-and-water`,
  `${PREVIEW_SAMPLE_ORIGIN}/the-east-light`,
  `${PREVIEW_SAMPLE_ORIGIN}/charts-and-corrections`,
  `${PREVIEW_SAMPLE_ORIGIN}/visiting-boats`
]

/** The device's screen lock as the stand-in host reported it at boot, put back after a `screenlock=` spec. */
let hostScreenLock: boolean | null = null

/** How long the stand-in host gets to picture the private page before the lock goes on without one. */
const LOCK_PICTURE_TIMEOUT_MS = 2500

/**
 * `lock=on`: the private tabs' lock as the host puts it on when the app is left with the switch
 * on and private tabs open (`PrivateLock.kt`). The device takes the pictures of the pages on
 * screen as it leaves (`Host.onPause`, `TabWebView.captureThumbnail`, of a painted document), so
 * a private tab in front has its last picture for the cover to blur: the stand-in host is asked
 * for the same copy once the page has loaded and painted (`overlay.snapshot`, the cover's
 * capture; a site's frame cannot be read and answers nothing, `PREVIEW_SAMPLE_ORIGIN`'s page
 * can), then the lock comes on through the store as `private.lock` would set it. Under the
 * overview no picture is asked for: the pane's cards lie under the veil themselves. `then` runs
 * once the cover is asked for.
 */
function lockPrivateTabs(then: () => void): void {
  const state = browserStore.get().state
  const tab = state ? activeTab(state) : null
  const lock = (): void => {
    applyPrivateLock({ locked: true })
    then()
  }
  if (!tab || !isPrivateTab(tab) || isEmptyTabUrl(tab.url) || overviewIsOpen()) {
    lock()
    return
  }
  const loaded = (s: UIState): boolean => {
    const now = activeTab(s)
    return now !== null && now.id === tab.id && !now.loading
  }
  untilState(loaded, () =>
    afterFrames(2, () => {
      const picture = cmd('overlay.snapshot', { tabId: tab.id }).catch(() => null)
      const late = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), LOCK_PICTURE_TIMEOUT_MS)
      )
      void Promise.race([picture, late]).then((data) => {
        if (typeof data === 'string' && data) rememberThumbnail(tab.id, data)
        lock()
      })
    })
  )
}

/**
 * A private tab and the overview's panes, the way the app reaches them: the tab through
 * `tab.newPrivate` (the app menu's item, the quick menu's, the shortcut's), the overview through
 * the Tabs button, which lands on the active tab's pane; the Private pane over regular tabs is
 * the segment's pick. The theme blends to the private one as the tab becomes active (`useTheme`),
 * so a driver's settle covers the spring. `finish` marks the state reached. With `count` above
 * one the session's other private tabs open first, on PRIVATE_SITES, each active in its turn as
 * a new tab is, so the surface's own tab is the last and the one in view: a surface that lists
 * the session (the tablet sidebar's private pose, the Private pane) has rows to list, in the
 * order they were opened. `empty` opens none: its pane is empty.
 */
function applyPrivate(
  surface: PreviewPrivateSurface,
  url: string,
  state: UIState,
  finish: () => void,
  count = 1
): void {
  const from = activeTab(state)
  const onPrivateTab = (test: (tab: Tab) => boolean, then: () => void): void =>
    whenActiveTabIs((tab) => isPrivateTab(tab) && test(tab), then)
  const overviewUp = (then: () => void): void => {
    const now = browserStore.get().state
    if (now) openOverview(now)
    // The grid mounts on the next render, the pane's fade after it.
    afterFrames(2, then)
  }
  // The others first, in PRIVATE_SITES' order (PREVIEW_PRIVATE_MAX keeps them within the list,
  // so no two wait on the same page); the surface's own tab comes after them.
  const others = surface === 'empty' ? 0 : Math.max(0, count - 1)
  const openOthers = (i: number, then: () => void): void => {
    if (i >= others) {
      then()
      return
    }
    const site = PRIVATE_SITES[i % PRIVATE_SITES.length]
    void run('tab.newPrivate', { url: site })
    onPrivateTab(
      (tab) => tab.url === site,
      () => openOthers(i + 1, then)
    )
  }
  openOthers(0, () => own())

  function own(): void {
    switch (surface) {
      case 'newtab':
        void run('tab.newPrivate', {})
        onPrivateTab(
          (tab) => isEmptyTabUrl(tab.url),
          () => afterFrames(2, finish)
        )
        return
      case 'page':
        void run('tab.newPrivate', { url })
        onPrivateTab(
          (tab) => tab.url === url,
          () => {
            // The page loaded (the host's `stopLoading`, sent as the frame's document is complete)
            // before the state is reached: a `then=` step that covers the page – the tablet's
            // drawer over it – takes its picture first, and the picture of a frame still on its
            // way is blank. Bounded: a page that never lands is still the state.
            const loaded = (s: UIState): boolean => {
              const now = activeTab(s)
              return now !== null && now.url === url && !now.loading
            }
            untilState(loaded, () => afterFrames(2, finish))
          }
        )
        return
      case 'overview':
        void run('tab.newPrivate', { url })
        onPrivateTab(
          (tab) => tab.url === url,
          () => overviewUp(finish)
        )
        return
      case 'tabs':
      case 'behind': {
        // A private tab open, the regular one active again: on `tabs` the overview opens on Tabs,
        // with the segment offering Private and no private card among the regular ones; on
        // `behind` nothing opens – the regular tab in view, the session behind it, so the tablet
        // sidebar stands in its regular pose beside a private session (W4-11).
        const landed = (): void =>
          surface === 'tabs' ? overviewUp(finish) : afterFrames(2, finish)
        void run('tab.newPrivate', { url })
        onPrivateTab(
          (tab) => tab.url === url,
          () => {
            if (!from) {
              landed()
              return
            }
            void run('tab.activate', { tabId: from.id })
            whenActiveTabIs((tab) => tab.id === from.id, landed)
          }
        )
        return
      }
      case 'empty':
        overviewUp(() => {
          pickOverviewPane('private')
          afterFrames(2, finish)
        })
        return
    }
  }
}

/**
 * A finger's worth of pull events, as the host would send them (`lib/pull.ts`): down, one move
 * to the travel that puts the page at `progress` of the threshold, and – released – a lift there.
 */
/**
 * Read aloud's player over the active page: the core's own session (`readAloud.start`, the real
 * `ReadAloudService`), driven to `target.status`. The stand-in host answers the core's
 * extraction with the stand-in article and lists – or withholds – its voices as the status needs
 * (PREVIEW_READ_ALOUD_EVENT: `loading` never lists them, so the session waits in the player's
 * busy state; `error` lists none, so the core lands on `no-voice` after its grace), and the walk
 * is moved on once the first sentence speaks: to sentence 4 for a playing or paused still (a
 * word under way at the engine's pace), to the last for `ended` (the engine ends it at once).
 * `then` runs when the state reads `target.status`. The panel's controls then drive the service
 * as on a device: a pause keeps the place, play speaks through the stand-in engine.
 *
 * The steps hang off the start command's own promise, which settles once the first sentence
 * speaks (or the session has failed): the store still shows the session a previous state left
 * – the reset's `stop` reaches it a tick later – so a wait on "playing" would fire on that one
 * and the seek would find no session. `loading` is the one status the start never settles on
 * (the stand-in withholds its voices), so it is read off the store.
 */
function scriptReadAloud(
  tab: Tab,
  target: Extract<PreviewState, { kind: 'readAloud' }>,
  then: () => void
): void {
  window.dispatchEvent(new CustomEvent(PREVIEW_READ_ALOUD_EVENT, { detail: target.status }))
  // The speed is a setting the session takes on start (the chip shows it at once).
  run('readAloud.setRate', { rate: target.rate })
  const at = (status: ReadAloudStatus, s: UIState): boolean =>
    s.readAloud?.tabId === tab.id && s.readAloud.status === status
  const started = cmd('readAloud.start', { tabId: tab.id }).catch(() => undefined)
  switch (target.status) {
    case 'loading':
      untilState((s) => at('loading', s), then)
      return
    case 'error':
      void started.then(() => untilState((s) => at('error', s), then))
      return
    case 'ended':
      void started.then(() => {
        // The service clamps a seek to the last sentence (the store may not show the count yet).
        run('readAloud.seek', { sentenceIndex: Number.MAX_SAFE_INTEGER })
        untilState((s) => at('ended', s), then)
      })
      return
    case 'playing':
    case 'paused':
      void started.then(() => {
        run('readAloud.seek', { sentenceIndex: 3 })
        // A word under way: the engine's first word event comes a pace after the start.
        untilState(
          (s) => at('playing', s) && s.readAloud?.sentenceIndex === 3 && s.readAloud.word !== null,
          () => {
            if (target.status === 'playing') {
              then()
              return
            }
            run('readAloud.pause', undefined)
            untilState((s) => at('paused', s), then)
          }
        )
      })
      return
  }
}

function pull(tabId: string, progress: number, released: boolean): void {
  const time = performance.now()
  // The inverse mapping lands a hair under the threshold in floating point (71.999… for 1), which
  // reads as unarmed; at the threshold and past it, a hair of extra finger puts the page over it.
  const travel = pullTravelFor(progress * PULL_THRESHOLD) + (progress >= 1 ? 0.5 : 0)
  dispatchPullEvent(tabId, 'start', null)
  dispatchPullEvent(tabId, 'move', { travel, time })
  if (released) {
    dispatchPullEvent(tabId, 'move', { travel, time: time + 16 })
    dispatchPullEvent(tabId, 'release', { travel, time: time + 32 })
  }
}

/**
 * A finger's worth of scroll reports for the bar that hides on scroll, as the host would send
 * them (`lib/barHide.ts`): down, one move of the page by the part of the bar's travel that puts
 * it at `progress`, and – released – a lift there, on which the bar snaps to the nearer end.
 * Sent once the bar's gate is open and the page has loaded, and a frame after either: a spec in
 * the URL at boot is applied before the shell has mounted and told the machine it is there (a
 * scroll the machine hears with its gate shut is dropped, as a real one would be), before the
 * stand-in page has started its load, whose start puts the bar back (`lib/barHide.ts`, as a load
 * on a device does), and the shell's first mount is, in development, followed at once by React's
 * rehearsal unmount, which closes the gate again for the moment – a finger cannot land inside
 * that commit, and neither does this.
 */
function barHide(tabId: string, progress: number, released: boolean, then: () => void): void {
  const ready = (): boolean => {
    const state = browserStore.get().state
    return barHideStore.get().allowed && Boolean(state) && !state?.tabs[tabId]?.loading
  }
  const send = (): void => {
    const time = performance.now()
    const delta = progress * barHideStore.get().travel
    dispatchBarScroll(tabId, 'start', null)
    dispatchBarScroll(tabId, 'move', { delta, time })
    if (released) {
      dispatchBarScroll(tabId, 'move', { delta: 0, time: time + 16 })
      dispatchBarScroll(tabId, 'end', { time: time + 32 })
    }
    then()
  }
  let unsubscribes: Array<() => void> = []
  const check = (): void => {
    if (!ready()) return
    for (const unsubscribe of unsubscribes) unsubscribe()
    unsubscribes = []
    requestAnimationFrame(() => (ready() ? send() : wait()))
  }
  const wait = (): void => {
    unsubscribes = [barHideStore.subscribe(check), browserStore.subscribe(check)]
  }
  if (ready()) check()
  else wait()
}

/** Scroll the first element whose own text reads `text` to the middle of its scroller. */
/**
 * A sheet presents at its peek detent when its body is taller than that. Once the presenting
 * spring has settled, tap the handle so it rests expanded; a sheet already resting expanded
 * (`data-locked="false"`, its body scrolls on its own) is left alone, since a tap would close it.
 */
function expandSheet(then: () => void): void {
  setTimeout(() => {
    const handle = document.querySelector<HTMLButtonElement>(
      '.zen-sheet[data-locked="true"] .zen-sheet-handle-hit'
    )
    handle?.click()
    then()
  }, 900)
}

function show(text: string | undefined): void {
  if (!text) return
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim() === text && node.parentElement) {
      node.parentElement.scrollIntoView({ block: 'center' })
      return
    }
  }
}

const SAMPLE_BANNERS = [
  {
    title: 'Add Zenium to your home screen',
    detail: 'Open pages in a window of their own, without the address bar.',
    icon: Smartphone,
    action: 'Install'
  },
  {
    title: 'Make Zenium your default browser',
    detail: 'Links from other apps will open here.',
    icon: Star,
    action: 'Make default'
  },
  { title: 'Download finished', detail: 'zenium-0.3.7.apk · 84 MB', icon: Download, action: 'Open' }
]

/** Put up the requested messages (all at once: the springs run, the driver waits for them). */
function showMessages(
  target: Extract<ReturnType<typeof parsePreviewSpec>, { kind: 'messages' }>,
  tabId: string | null
): void {
  for (let i = 0; i < target.banners; i++) {
    const sample = SAMPLE_BANNERS[i % SAMPLE_BANNERS.length]
    showBanner({
      title: sample.title,
      detail: sample.detail,
      icon: sample.icon,
      action: { label: sample.action, onPick: () => undefined },
      key: `preview-${i}`
    })
  }
  if (target.toast) {
    pushToast(target.toast.message, target.toast.error ? 'error' : 'info', {
      action: target.toast.action
        ? { label: target.toast.action, onPick: () => undefined }
        : undefined,
      // A screenshot state stays put; the real clock is the unit tests' business.
      duration: 600_000
    })
  }
  if (target.progress !== null && tabId) {
    // Mid-load: the bar shows the tab loading and springs to the reported fraction; no page
    // finishes underneath because the preview host raises no `stopLoading` on its own.
    hostGlobal().viewEvent(tabId, 'startLoading', '')
    hostGlobal().viewEvent(tabId, 'progress', JSON.stringify({ progress: target.progress }))
  }
}

/**
 * Take Screenshot's gallery flow (SH-07, SH-08) on the active tab, the way the menu item runs it:
 * the stand-in host flashes the page and answers with the picture, the core's `screenshot.saved`
 * puts the preview card up. `flash` holds the flash sheet part-way (`holdPreviewScreenshots`) so
 * the still shows the frame mid-flash; `card` holds the card off its clock (a finger's hold) so
 * it stays for the still; `editor` presses the card's Capture more and waits for the editor to
 * come up with the page's picture (the sheet mounts once the stand-in host has answered the
 * long capture, as the real one does), then, with `drag`, presses one handle and moves the
 * pointer `by` px down without letting go – the handle's own drag, held mid-way.
 */
function applyScreenshot(
  target: Extract<ReturnType<typeof parsePreviewSpec>, { kind: 'screenshot' }>,
  tabId: string,
  finish: () => void
): void {
  holdPreviewScreenshots({ flash: target.surface === 'flash' })
  run('page.screenshot', { tabId })
  if (target.surface === 'flash') {
    afterFrames(3, finish)
    return
  }
  untilUi(
    (ui) => ui.screenshotCards.some((c) => !c.leaving),
    () => {
      const card = uiStore.get().screenshotCards.find((c) => !c.leaving)
      if (!card) {
        finish()
        return
      }
      if (target.surface === 'card') {
        holdScreenshotCard(card.id, true)
        // The flash's fade has cleared by then (its 120 ms and the sheet's removal).
        setTimeout(finish, 200)
        return
      }
      pickScreenshotAction(card.id, 'more')
      untilUi(
        (ui) => ui.longScreenshot !== null,
        () => {
          const drag = target.drag
          // The sheet's entrance and the picture's layout settle before a handle is taken.
          setTimeout(() => {
            if (!drag) {
              finish()
              return
            }
            const handle = document.querySelector<HTMLElement>(
              `[data-testid="longshot-handle-${drag.edge}"]`
            )
            if (!handle) {
              finish()
              return
            }
            const box = handle.getBoundingClientRect()
            const x = box.left + box.width / 2
            const y = box.top + box.height / 2
            const pointer = (type: string, clientY: number): void => {
              handle.dispatchEvent(
                new PointerEvent(type, {
                  bubbles: true,
                  cancelable: true,
                  pointerId: 7,
                  pointerType: 'touch',
                  isPrimary: true,
                  button: 0,
                  buttons: 1,
                  clientX: x,
                  clientY
                })
              )
            }
            pointer('pointerdown', y)
            const steps = 6
            for (let i = 1; i <= steps; i++) pointer('pointermove', y + (drag.by * i) / steps)
            afterFrames(2, finish)
          }, STEP_SETTLE_MS)
        }
      )
    }
  )
}

/** Runs `fn` once the ui store satisfies `test`, or once waiting stops being worth it. */
function untilUi(test: (ui: UiState) => boolean, fn: () => void): void {
  if (test(uiStore.get())) {
    fn()
    return
  }
  let settled = false
  const settle = (): void => {
    if (settled) return
    settled = true
    unsubscribe()
    window.clearTimeout(timer)
    fn()
  }
  const unsubscribe = uiStore.subscribe(() => {
    if (test(uiStore.get())) settle()
  })
  const timer = window.setTimeout(() => {
    console.warn('[zen preview] the ui state did not arrive; reporting the spec reached anyway')
    settle()
  }, SETTLE_TIMEOUT_MS)
}

/**
 * Every message off at once, and the load a previous `progress` state left running on
 * `loadingTabId` finished, so the next state starts clean.
 */
function clearMessages(loadingTabId: string | null): void {
  const ui = uiStore.get()
  for (const t of ui.toasts) {
    dismissToast(t.id)
    forgetToast(t.id)
  }
  for (const c of ui.screenshotCards) forgetScreenshotCard(c.id)
  for (const b of ui.banners) {
    dismissBanner(b.id)
    forgetBanner(b.id)
  }
  if (loadingTabId) hostGlobal().viewEvent(loadingTabId, 'stopLoading', '{}')
}

function hostGlobal(): { viewEvent(tabId: string, name: string, json: string): void } {
  return (window as unknown as { __zenHost: ReturnType<typeof hostGlobal> }).__zenHost
}

/** The surface is up once the core's event has landed in the UI store; give up after this long. */
const SURFACE_TIMEOUT_MS = 5000

/**
 * Raise an "Add to Home screen" surface the way the app would: the demo manifest is posted for
 * the tab (or withdrawn, for the plain page's name-edit sheet), then the core is asked to open
 * the sheet or to pin. The banner is presented the way the core's event would be – the core
 * itself raises one only once a day per app, after enough visits – and its "Add" opens the
 * install sheet through the core like the real one.
 */
function applyWebApp(surface: PreviewWebAppSurface, tabId: string, spec: string): void {
  postPreviewManifest(tabId, surface !== 'name')
  const { manifest } = PREVIEW_WEB_APP
  switch (surface) {
    case 'install':
    case 'name':
      void run('webapp.openInstall', { tabId })
      whenStore(() => uiStore.get().install?.tabId === tabId, spec)
      return
    case 'banner':
      presentInstallBanner({
        tabId,
        name: manifest.short_name,
        origin: new URL(manifest.start_url, PREVIEW_WEB_APP.manifestUrl).host,
        icon: manifest.icons[0].src,
        tint: manifest.theme_color
      })
      whenStore(() => installBannerShown(tabId), spec)
      return
    case 'pinned':
      void run('webapp.pin', { tabId, title: manifest.short_name })
      whenStore(() => uiStore.get().toasts.some((t) => t.message.includes('Home screen')), spec)
      return
  }
}

/**
 * The media a `media=<variant>` state seeded: the tab that reported it, whether it was made for
 * it, and the page it stands on when that was made for the state (closed with it; a page the
 * space had stays active – the next state starts on a page, as an idle chrome does).
 */
let previewMedia: { tabId: string; made: boolean; pageMade: string | null } | null = null

/** The page the track of an `elsewhere` state plays in, opened behind the one on screen. */
const PREVIEW_MEDIA_PAGE = 'https://en.wikipedia.org/wiki/Nocturne'

/** The track's artwork: a tile in the album's colour, as a page's 512 square would come in. */
const PREVIEW_MEDIA_ART = ((): string => {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">` +
    `<rect width="512" height="512" fill="#2b3a67"/>` +
    `<circle cx="256" cy="256" r="150" fill="#f7c59f"/>` +
    `<circle cx="256" cy="256" r="46" fill="#2b3a67"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
})()

/**
 * What the page reports for `variant`, as its script would: the track with its Media Session
 * metadata and handlers (the `paused` report follows it, so the session has played once, as
 * the core wants before it shows controls), or a video with neither.
 */
function mediaReport(variant: PreviewMediaVariant): MediaReport {
  if (variant === 'video') {
    return {
      ...EMPTY_MEDIA_REPORT,
      playing: true,
      video: true,
      width: 1920,
      height: 1080,
      position: { duration: 634, position: 128, playbackRate: 1 }
    }
  }
  return {
    ...EMPTY_MEDIA_REPORT,
    playing: true,
    position: { duration: 251, position: 74, playbackRate: 1 },
    metadata: {
      title: 'Nocturne in E-flat major',
      artist: 'Wave Three Ensemble',
      album: 'Sessions',
      artwork: [{ src: PREVIEW_MEDIA_ART, sizes: '512x512', type: 'image/svg+xml' }]
    },
    playbackState: 'playing',
    actions: ['play', 'pause', 'seekto', 'previoustrack', 'nexttrack']
  }
}

/** A page's media report, the way its script posts one through the host. */
function postMedia(tabId: string, media: MediaReport): void {
  hostGlobal().viewEvent(
    tabId,
    'pageMessage',
    JSON.stringify({ type: 'media', playing: media.playing, media })
  )
}

/**
 * The web page a media state stands on – the pill's chips are a page's, so a state that follows
 * a Settings state does not seed the Settings tab: the active tab while it is a page, else the
 * space's first loose page (made active), else a page made for it. Returns the page and whether
 * it was made for the state.
 */
async function mediaPage(
  state: UIState,
  active: Tab
): Promise<{ tabId: string; pageMade: string | null }> {
  if (/^https?:/.test(active.url)) return { tabId: active.id, pageMade: null }
  const page = regularOf(state, activeSpace(state)).find(
    (t) => !t.folderId && /^https?:/.test(t.url)
  )
  const tabId =
    page?.id ??
    (await cmd('tab.create', { url: PREVIEW_MEDIA_PAGE, active: true, afterTabId: active.id }))
  if (page) await cmd('tab.activate', { tabId })
  await new Promise<void>((resolve) => untilState((s) => activeTab(s)?.id === tabId, resolve))
  return { tabId, pageMade: page ? null : tabId }
}

/**
 * The page on screen (or, for `elsewhere`, a page opened behind it) reports its media: the core
 * takes the session and the Now playing chip comes up in the pill; `player` then opens the
 * in-app player on it, the state reached once the store carries it.
 */
async function applyMedia(
  state: UIState,
  active: Tab,
  variant: PreviewMediaVariant,
  player: boolean,
  spec: string
): Promise<void> {
  const page = await mediaPage(state, active)
  let tabId = page.tabId
  let made = false
  if (variant === 'elsewhere') {
    tabId = await cmd('tab.create', {
      url: PREVIEW_MEDIA_PAGE,
      active: false,
      afterTabId: page.tabId
    })
    made = true
  }
  previewMedia = { tabId, made, pageMade: page.pageMade }
  const report = mediaReport(variant)
  postMedia(tabId, report)
  await new Promise<void>((resolve) =>
    untilState((s) => s.media.some((m) => m.tabId === tabId && m.session), resolve)
  )
  if (variant === 'paused') {
    postMedia(tabId, { ...report, playing: false, playbackState: 'paused' })
    await new Promise<void>((resolve) =>
      untilState((s) => s.media.some((m) => m.tabId === tabId && !m.playing), resolve)
    )
  }
  if (player) {
    // Over the page on screen: the media's for audio / paused / video, the page in front of the
    // media's tab for `elsewhere`.
    await openMediaSheet(tabId, page.tabId)
    whenStore(() => uiStore.get().mediaSheet === tabId, spec)
  } else {
    afterFrames(2, () => done(spec))
  }
}

/**
 * The media the last state seeded goes: the sheet closes, the page reports none, the tabs made
 * for the state close.
 */
function unseedMedia(): void {
  const seeded = previewMedia
  previewMedia = null
  closeMediaSheet()
  if (!seeded) return
  postMedia(seeded.tabId, EMPTY_MEDIA_REPORT)
  if (seeded.made) void run('tab.close', { tabId: seeded.tabId, force: true })
  if (seeded.pageMade) void run('tab.close', { tabId: seeded.pageMade, force: true })
}

/**
 * Echo `spec` once `ready` holds (or the wait runs out, so a driver sees the state it got), and
 * `after` more milliseconds when the surface has a script still playing into it.
 */
function whenStore(ready: () => boolean, spec: string, after = 0): void {
  const echo = (): void => {
    if (after > 0) window.setTimeout(() => done(spec), after)
    else done(spec)
  }
  if (ready()) {
    echo()
    return
  }
  let settled = false
  const finish = (): void => {
    if (settled) return
    settled = true
    unsubscribe()
    clearTimeout(timer)
    echo()
  }
  const unsubscribe = uiStore.subscribe(() => {
    if (ready()) finish()
  })
  const timer = setTimeout(finish, SURFACE_TIMEOUT_MS)
}

/**
 * Put the security surfaces back to rest: no dialog waiting, nothing blocked, the site not
 * allowed. Resolves once the cancelled prompts have settled: their promises finish on later
 * microtasks (a cancelled chooser remembers "none" for its host then, and a challenge for the
 * same space raised before the first one is out of flight would join it instead of asking), so
 * the session is forgotten and the next prompt raised after them.
 */
function resetSecurity(browser: Browser, tab: Tab): Promise<void> {
  browser.security.cancelForTab(tab.id)
  browser.popups.dismiss(tab.id)
  browser.permissions.forget('popups', tab.url)
  return new Promise((resolve) =>
    setTimeout(() => {
      browser.security.forgetSession()
      resolve()
    }, 0)
  )
}

/**
 * The answers Settings → Security lists, in the order they are seeded (`rules=<n>` keeps the
 * first n). Sites are the reserved `example` names, so nothing here names a real service.
 */
const DEMO_RULES: ReadonlyArray<
  Parameters<Browser['permissions']['remember']> extends [infer P, infer U, infer D, ...unknown[]]
    ? { permission: P; url: U; decision: D; externalUrl?: string; embedderUrl?: string }
    : never
> = [
  { permission: 'popups', url: 'https://meet.example/room/42', decision: 'allow' },
  {
    permission: 'openExternal',
    url: 'https://calendar.example/week',
    decision: 'allow',
    externalUrl: 'zoommtg://zoom.us/join?confno=42'
  },
  { permission: 'camera', url: 'https://meet.example/room/42', decision: 'deny' },
  { permission: 'fileSystem', url: 'https://docs.example/editor', decision: 'allow' },
  {
    permission: 'storage-access',
    url: 'https://widgets.example/embed',
    decision: 'allow',
    embedderUrl: 'https://news.example/today'
  },
  { permission: 'geolocation', url: 'https://maps.example/', decision: 'deny' },
  { permission: 'notifications', url: 'https://mail.example/inbox', decision: 'allow' },
  { permission: 'idle-detection', url: 'https://chat.example/', decision: 'deny' }
]

function seedRules(browser: Browser, count: number): void {
  browser.permissions.reset()
  for (const rule of DEMO_RULES.slice(0, count)) {
    browser.permissions.remember(rule.permission, rule.url, rule.decision, {
      externalUrl: rule.externalUrl,
      embedderUrl: rule.embedderUrl
    })
  }
}

/**
 * The three lists of Cookies and site data (Chrome's grammar: a host, `[*.]host`, a scheme, a
 * port) as a Settings still shows them, most specific first once the core has sorted them.
 */
const DEMO_SITE_DATA: Record<SiteDataList, readonly string[]> = {
  allow: ['[*.]mail.example', 'https://bank.example', 'docs.example'],
  clearOnExit: ['[*.]news.example', 'shop.example:8443'],
  block: ['[*.]tracker.example', 'ads.example', 'http://legacy.example']
}

/** The on-exit types an `exit` seed turns on: cookies and the cache, as a cautious profile might. */
const DEMO_CLEAR_ON_EXIT: ClearOnExitType[] = ['cookies', 'cache']

/**
 * Cookies and site data as a spec seeds it: the sample patterns on their lists (through the
 * core, as Settings adds them), the active tab's site on the list named, the default and the
 * on-exit types, and the stand-in profile told which sample of stored origins to answer with.
 */
function seedSiteData(browser: Browser, seed: PreviewSiteDataSeed, tab: Tab | null): void {
  for (const list of ['allow', 'clearOnExit', 'block'] as const)
    for (const pattern of DEMO_SITE_DATA[list]) browser.siteData.add(list, pattern)
  if (seed.site && tab) browser.siteData.addSite(seed.site, tab.url)
  if (seed.blockAll) browser.siteData.setDefault('block-all')
  if (seed.exit) {
    const privacy = browserStore.get().state?.settings.privacy
    if (privacy)
      run('settings.update', {
        privacy: { ...privacy, clearOnExit: { types: DEMO_CLEAR_ON_EXIT } }
      })
  }
  window.dispatchEvent(new CustomEvent(PREVIEW_SITE_DATA_EVENT, { detail: seed.origins }))
}

/** The policy back to nothing on any list and Chrome's default, the stand-in profile back to empty. */
function unseedSiteData(browser: Browser): void {
  const status = browser.siteData.status()
  for (const list of ['allow', 'clearOnExit', 'block'] as const)
    for (const pattern of status[list]) browser.siteData.remove(pattern)
  if (status.default !== 'block-third-party') browser.siteData.setDefault('block-third-party')
  const privacy = browserStore.get().state?.settings.privacy
  if (privacy && status.clearOnExitTypes.length > 0)
    run('settings.update', { privacy: { ...privacy, clearOnExit: { types: [] } } })
  window.dispatchEvent(new CustomEvent(PREVIEW_SITE_DATA_EVENT, { detail: 'none' }))
}

/** Pages (and, for the third and every sixth entry, app launches) the blocker refused. */
function seedPopups(
  browser: Browser,
  tab: Tab,
  target: Extract<PreviewState, { kind: 'popups' }>
): void {
  const site = safeHost(tab.url) || 'example.com'
  for (let i = 0; i < target.count; i++) {
    if (i % 6 === 2) {
      browser.popups.record(tab.id, `zoommtg://zoom.us/join?confno=${1000 + i}`, 'external')
    } else {
      const path = [
        'offers/summer-sale',
        'survey',
        'newsletter/signup',
        'promo',
        'chat',
        'ads/interstitial'
      ]
      browser.popups.record(tab.id, `https://${site}/${path[i % path.length]}?ref=${i + 1}`)
    }
  }
  if (target.allowed) browser.permissions.remember('popups', tab.url, 'allow')
}

const DEMO_CERTIFICATES: ClientCertificateInfo[] = [
  {
    fingerprint: 'preview-cert-ada',
    subject: 'Ada Lovelace (work)',
    issuer: 'Zenium Demo CA',
    serialNumber: '01',
    validFrom: Date.UTC(2026, 0, 1),
    validTo: Date.UTC(2027, 0, 1)
  },
  {
    fingerprint: 'preview-cert-client',
    subject: 'Zenium Demo Client',
    issuer: 'Zenium Demo CA',
    serialNumber: '02',
    validFrom: Date.UTC(2026, 0, 1),
    validTo: Date.UTC(2028, 0, 1)
  },
  {
    fingerprint: 'preview-cert-old',
    subject: 'Ada Lovelace (old laptop)',
    issuer: 'Zenium Demo CA',
    serialNumber: '03',
    validFrom: Date.UTC(2023, 0, 1),
    validTo: Date.UTC(2025, 0, 1)
  }
]

/** Raise a security dialog the way a host challenge would; its answer goes nowhere here. */
function showPrompt(
  browser: Browser,
  tab: Tab,
  target: Extract<PreviewState, { kind: 'prompt' }>
): void {
  if (target.prompt === 'certificate') {
    void browser.security.clientCertificate('secure.example', DEMO_CERTIFICATES, tab.id)
    return
  }
  const challenge = target.proxy
    ? {
        host: 'proxy.example',
        port: 3128,
        realm: 'Corporate proxy',
        scheme: 'basic',
        isProxy: true,
        secure: false
      }
    : {
        host: 'intranet.example',
        port: target.secure ? 443 : 80,
        realm: 'Zenium demo area',
        scheme: 'basic',
        isProxy: false,
        secure: target.secure
      }
  if (!target.failed) {
    void browser.security.httpAuth(challenge, tab.id)
    return
  }
  // A refused answer: sign in once, then be challenged again for the same protection space.
  const first = browser.security.httpAuth(challenge, tab.id)
  const pending = browser.security.list().find((p) => p.kind === 'http-auth')
  if (pending) {
    browser.security.respond(pending.id, {
      kind: 'http-auth',
      username: 'ada',
      password: 'wrong',
      remember: false
    })
  }
  void first.then(() => browser.security.httpAuth(challenge, tab.id))
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

/** The spec whose `siteinfo=` steps have been taken (once per applied spec). */
let siteInfoSteps: string | null = null

function done(spec: string): void {
  // `siteinfo` on any spec: the state named is reached, then the site-information sheet goes up
  // on the active tab (the pill's folded chips are listed in it), and the spec is reported
  // reached once the sheet is – a still after the settle catches it risen.
  // `siteinfo=<steps>` takes steps on the sheet (or the desktop's popover) once it is up: `tap:Cookies
  // and site data` drills into a level, a second tap opens the row's picker over it.
  const params = new URLSearchParams(spec.startsWith('#') ? spec.slice(1) : spec)
  if (params.has('siteinfo')) {
    if (!uiStore.get().siteInfoOpen) {
      const state = browserStore.get().state
      const tab = state ? activeTab(state) : null
      if (tab) {
        // The desktop popover a previous spec left plays its exit after `apply`'s
        // `dismissSiteInfo` and, once gone, dismisses whatever the store names by then
        // (`SiteInfoDesktopLayer.onClosed`): a popover opened over it would go with it, so the
        // next one opens once the document has none.
        whenGone('[data-testid="site-info"]', () => {
          void openSiteInfo(tab).then(() => whenStore(() => uiStore.get().siteInfoOpen, spec))
        })
        return
      }
    } else if (siteInfoSteps !== spec) {
      siteInfoSteps = spec
      const then = parsePreviewSteps(params.get('siteinfo'))
      if (then.length > 0) {
        afterFrames(2, () => steps(then, () => done(spec)))
        return
      }
    }
  }
  document.documentElement.dataset.previewState = spec
}

function afterFrames(count: number, fn: () => void): void {
  if (count <= 0) fn()
  else requestAnimationFrame(() => afterFrames(count - 1, fn))
}

/** Runs `fn` once nothing in the document matches `selector`, or after a second either way. */
function whenGone(selector: string, fn: () => void): void {
  const deadline = performance.now() + 1000
  const check = (): void => {
    if (!document.querySelector(selector) || performance.now() > deadline) fn()
    else requestAnimationFrame(check)
  }
  check()
}

/** Runs `fn` once the browser state satisfies `test`, or once waiting stops being worth it. */
function untilState(test: (state: UIState) => boolean, fn: () => void): void {
  const current = browserStore.get().state
  if (current && test(current)) {
    fn()
    return
  }
  let settled = false
  const settle = (): void => {
    if (settled) return
    settled = true
    unsubscribe()
    window.clearTimeout(timer)
    fn()
  }
  const unsubscribe = browserStore.subscribe(() => {
    const state = browserStore.get().state
    if (state && test(state)) settle()
  })
  const timer = window.setTimeout(() => {
    console.warn('[zen preview] the state did not arrive; reporting the spec reached anyway')
    settle()
  }, SETTLE_TIMEOUT_MS)
}

/** Runs `fn` once the browser state has arrived and the chrome has had a frame to render it. */
function whenReady(fn: () => void): void {
  if (browserStore.get().state) {
    requestAnimationFrame(fn)
    return
  }
  const unsubscribe = browserStore.subscribe(() => {
    if (!browserStore.get().state) return
    unsubscribe()
    requestAnimationFrame(fn)
  })
}
