import type {
  CertificateDetails,
  ClientCertificateInfo,
  CommandArgs,
  CommandName,
  CommandResult,
  ExtensionAction,
  ExtensionInfo,
  MenuItemDescriptor,
  Tab,
  UIState
} from '@shared/types'
import { PRIVATE_CONTAINER_ID } from '@shared/types'
import type { Browser } from '@core/browser'
import { isCertificateError } from '@shared/siteInfo'
import { cmd, run } from '@renderer/lib/api'
import { dispatchBackEvent, topBackSurface } from '@renderer/lib/back'
import { dismissOverview, openOverview } from '@renderer/lib/gestures/stage'
import { isPrivateTab, pickOverviewPane } from '@renderer/lib/privateTabs'
import { abortPull, dispatchPullEvent, PULL_THRESHOLD, pullTravelFor } from '@renderer/lib/pull'
import { Download, Smartphone, Star } from 'lucide-react'
import { installBannerShown, presentInstallBanner } from '@renderer/lib/installBanner'
import { isInternalPageUrl } from '@shared/internalPages'
import { isEmptyTabUrl } from '@shared/url'
import { blockedPopupsOf, closeBlockedPopups, openBlockedPopups } from '@renderer/lib/security'
import { BLANK_URL, EXTENSION_SCHEME } from '@shared/url'
import { DEFAULT_FOLDER_ICON } from '@renderer/components/phone/GroupCard'
import { activeSpace, activeTab, regularOf } from '@renderer/lib/selectors'
import {
  browserStore,
  closeMenu,
  closeOverlay,
  closeTabsMenu,
  closeUrlbar,
  dismissBanner,
  dismissToast,
  forgetBanner,
  forgetToast,
  openExtensionsSheet,
  openOverlay,
  openTabsMenu,
  openUrlbar,
  openZoom,
  pushToast,
  showBanner,
  uiStore
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
import { cancelVoiceSearch, startVoiceSearch } from '@renderer/lib/voiceSearch'
import { cancelQrScan, startQrScan } from '@renderer/lib/qrScan'
import type { HostGlobal } from './boot'
import {
  PREVIEW_CLIP_EVENT,
  PREVIEW_EXTENSION_PAGE_EVENT,
  PREVIEW_QR_EVENT,
  PREVIEW_VOICE_EVENT,
  PREVIEW_WEB_APP,
  postPreviewManifest,
  previewQrScript,
  previewVoiceScript,
  type PreviewExtensionPage
} from './preview'
import { clearAutofill, stageAutofill } from './previewAutofill'
import { PREVIEW_DOWNLOAD_EVENT } from './previewDownloads'
import {
  parsePreviewSeed,
  parsePreviewSpec,
  type PreviewPrivateSurface,
  type PreviewState,
  type PreviewStep,
  type PreviewWebAppSurface
} from './previewSpec'

/** A pause between steps for a sheet to mount, slide in and settle before the next tap. */
const STEP_SETTLE_MS = 450

/** The back surfaces a page's sheets register (`settings-options:<row>`, `settings-confirm:<row>`, …). */
const SHEET_SURFACE = /^settings-(options|field|confirm|form|item|detail):/
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
 * sheet on its expanded detent), `menu=app` (the app menu sheet; `show=<text>` scrolls an item
 * into view), `menu=tabs` (the Tabs button's quick menu), `sheet=extensions` (the Extensions
 * sheet the app menu's row opens, over the active page; `then=tap:<row>;hold:<row>` taps a row
 * or long-presses it for its menu), `extension-page=<id>/<path>` (an extension's page open as a
 * tab, the way its options page opens: `chrome-extension://<id>/<path>`, which the stand-in
 * host serves a page for; with `extensions=installed` the chrome knows the extension, so the
 * pill shows its name), `prompt=<permission>` (the active page asks for that permission: the
 * prompt sheet is up), `private=<surface>` (a private tab on its new tab page or on
 * `url=<page>`, and the overview's Tabs and Private panes; see `PREVIEW_PRIVATE_SURFACES`;
 * `private=new` and `private=<url>` still read),
 * `autofill=<surface>` (a save prompt, the passkey chooser, a picker strip or the vault
 * passphrase dialog staged with sample data; see `PREVIEW_AUTOFILL`), `find=<text>` (the find
 * bar with that text typed), `pull=<n>` (the page held pulled down at n percent of the
 * refresh threshold; `pull=refresh` lets go past it), `zoom=<factor>` (the page zoom sheet at
 * that factor), `error=<code>` (the active tab's load failed with that Chromium `net::` code,
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
 * page, its cards with whatever pictures the stand-in host has of the tabs) or
 * `urlbar=<text>` (the pill's editor over the active tab with that text typed; `newtab` opens
 * it over a new tab, `clip=<text>` seeds the stand-in clipboard for the clipboard row, `then=`
 * presses its controls: `tap:Show`, `tap:Edit`, `tap:Refine`). `rules=<n>` on any spec seeds n
 * remembered site permissions for Settings › Security; `blocking=<variant>` may accompany any
 * spec too (see `seedBlocking`).
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
    closeOverlay()
    closeMenu()
    closeTabsMenu()
    closeUrlbar()
    dismissOverview()
    uiStore.set({
      findOpen: false,
      findTabId: null,
      zoomTabId: null,
      install: null,
      extensionsSheetOpen: false
    })
    abortPull()
    cancelVoiceSearch()
    cancelQrScan()
    const state = browserStore.get().state
    const tab = state ? activeTab(state) : null
    clearMessages(tab?.loading ? tab.id : null)
    closeBlockedPopups()
    for (const prompt of state?.permissionPrompts ?? [])
      run('permissions.respond', { id: prompt.id, answer: 'dismiss' })
    const securityAtRest = tab ? resetSecurity(browser, tab) : Promise.resolve()
    const seed = parsePreviewSeed(spec)
    if (seed.rules !== null) seedRules(browser, seed.rules)
    // The autofill surfaces are the core's: cleared before the sheets close, so a staged prompt
    // or picker of the previous state is gone with them – and before the group goes, since
    // they hang from the tab that was active in it. A private tab a previous state opened goes
    // too (its session ends, as when the user closes the last one): the next state starts on
    // the regular tabs, and an "empty" pane is empty.
    void clearAutofill(browser)
      .then(dissolveGroup)
      .then(closeExtensionPage)
      .then(() => closePrivateTabs(() => closeSheets(() => reach(browser, spec, securityAtRest))))
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
 * The group the last `group=<n>` state made and the world before it (the tab that was active,
 * the tabs there were), put back before the next state: a run of stills takes each state from
 * the same loose profile.
 */
let previewGroup: { folderId: string; activeId: string; tabIds: ReadonlySet<string> } | null = null

/**
 * Put the active tab in a group of `members`: the space's loose pages join first, then tabs made
 * for the purpose, each filed after the last member so it lands in the group – the way the plus
 * chip's tab does. The strip enters on its spring as the group forms.
 */
async function makeGroup(activeId: string, members: number): Promise<void> {
  const state = browserStore.get().state
  if (!state) return
  const space = activeSpace(state)
  const folderId = await cmd('folder.create', {
    spaceId: space.id,
    name: PREVIEW_GROUP_NAME,
    icon: DEFAULT_FOLDER_ICON,
    color: 'blue',
    rename: false
  })
  previewGroup = { folderId, activeId, tabIds: new Set(Object.keys(state.tabs)) }
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
 * The group a previous state made goes and the world before it comes back: the tab that was
 * active then is active again (first, so closing the others never has the core pick a
 * neighbour), the tabs made since – for the group, or in it by its plus chip – close, and the
 * folder is deleted with its tabs unpacked, so the next state starts loose.
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
  if (state.folders[made.folderId])
    await cmd('folder.delete', { folderId: made.folderId, unpack: true }).catch(quiet)
  // A command's answer comes before the state it changed does: the next state reads the store,
  // so the store is waited for (bounded) to show the folder gone and the tab back.
  await new Promise<void>((resolve) =>
    untilState(
      (s) =>
        !s.folders[made.folderId] &&
        (restored === null || activeTab(s)?.id === restored) &&
        Object.keys(s.tabs).every((id) => made.tabIds.has(id)),
      resolve
    )
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
    then()
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
  const extensions = params.get('extensions')
  const seed = (): void => {
    if (blocking) seedBlocking(blocking)
    if (extensions) seedExtensions(extensions)
  }
  const finish = (): void => {
    seed()
    done(spec)
  }

  if (target.kind === 'autofill') {
    void stageAutofill(browser, target.surface, tab).then((page) => {
      // A manager state is the Settings tab on its Autofill section (staged vault behind it):
      // reached the way a page state is. Any other surface mounts on the next render; the
      // sheets take a moment to rise.
      if (page) settlePage(target, seed, finish)
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
    // mid-slide captures at once); the steps wait for the entrance to settle.
    void makeGroup(tab.id, target.members).then(() => {
      const then = target.then ?? []
      if (then.length === 0) finish()
      else setTimeout(() => steps(then, finish), STEP_SETTLE_MS)
    })
  } else if (target.kind === 'overlay') {
    void openOverlay(target.overlay, tab?.id ?? null, null, null, target.section ?? null).then(
      () => {
        if (target.show) requestAnimationFrame(() => show(target.show))
        if (target.expand) expandSheet(finish)
        else finish()
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
  } else if (target.kind === 'sheet') {
    // The Extensions sheet lists what the seed put in the state, so the seed goes first; the
    // sheet mounts on the next render and slides in, and the steps wait for it to settle.
    seed()
    openExtensionsSheet()
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
  } else if (target.kind === 'private' && state) {
    const surface = (): void => {
      const now = browserStore.get().state ?? state
      applyPrivate(target.surface, target.url ?? PRIVATE_PAGE, now, finish)
    }
    // The cookie setting first, through the settings command as the Settings page writes it,
    // and the surface once the core says so: the new tab page's switch reads the state.
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
  } else if (target.kind === 'find' && tab) {
    uiStore.set({ findOpen: true, findTabId: tab.id })
    // The bar mounts on the next render; type into it the way a keyboard would.
    requestAnimationFrame(() => {
      if (target.text) type('input[aria-label="Find in page"]', target.text)
      finish()
    })
  } else if (target.kind === 'pull' && tab) {
    pull(tab.id, target.progress, target.released)
    requestAnimationFrame(finish)
  } else if (target.kind === 'error' && tab) {
    failLoad(tab.id, target.code, target.url ?? tab.url)
    requestAnimationFrame(finish)
  } else if (target.kind === 'messages') {
    showMessages(target, tab?.id ?? null)
    finish()
  } else if (target.kind === 'webapp' && tab) {
    seed()
    applyWebApp(target.surface, tab.id, spec)
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
    // The grid mounts on the next render and its cards read their pictures then.
    openOverview(state)
    requestAnimationFrame(() => done(spec))
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
let blockingSeed: (() => void) | null = null

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
function seedBlocking(variant: string): void {
  unseedBlocking()
  let seeded: UIState | null = null
  const patch = (): void => {
    const state = browserStore.get().state
    if (!state || state === seeded) return
    seeded = blockingFixture(state, variant, Date.now())
    browserStore.set({ state: seeded })
  }
  patch()
  blockingSeed = browserStore.subscribe(patch)
}

/** Stop holding a seeded request state over the core's pushes. */
function unseedBlocking(): void {
  blockingSeed?.()
  blockingSeed = null
}

export function blockingFixture(state: UIState, variant: string, now: number): UIState {
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
  if (tab) tabs[tab.id] = { ...tab, blockedCount: blocks ? 12 : 0 }
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
  let seeded: UIState | null = null
  const patch = (): void => {
    const state = browserStore.get().state
    if (!state || state === seeded) return
    seeded = extensionsFixture(state, variant, Date.now())
    browserStore.set({ state: seeded })
  }
  patch()
  const unpatch = browserStore.subscribe(patch)
  const unanswer = answerActionMenus(variant)
  extensionsSeed = () => {
    unpatch()
    unanswer()
  }
}

/** Stop holding a seeded extension state over the core's pushes. */
function unseedExtensions(): void {
  extensionsSeed?.()
  extensionsSeed = null
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

const URLBAR_FIELD = 'input[aria-label="Search or enter address"]'

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
  whenActiveTabIs(isInternalPageUrl, () => {
    whenPageRendered(() => {
      setTimeout(() => {
        seed()
        // The landing keeps its query between states unless it is retyped: an empty one clears it.
        type('input[aria-label="Find in Settings"]', target.search ?? '')
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
  })
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

/** Type `text` into the first element matching `selector` the way a keyboard would. */
function type(selector: string, text: string): void {
  const input = document.querySelector<HTMLInputElement>(selector)
  if (!input || input.value === text) return
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
  setTimeout(() => steps(rest, then), STEP_SETTLE_MS)
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

/** The first button a finger could press whose accessible label or own text reads `text`. */
function pressable(text: string): HTMLElement | null {
  const wanted = text.trim()
  const reachable = (el: Element | null | undefined): el is HTMLElement =>
    el instanceof HTMLElement && !el.closest('[inert]') && el.getAttribute('aria-hidden') !== 'true'
  for (const el of document.querySelectorAll<HTMLElement>('button, [role="button"]')) {
    if (!reachable(el)) continue
    if (el.getAttribute('aria-label')?.trim() === wanted || el.textContent?.trim() === wanted)
      return el
  }
  // A row draws its label in a child beside its description: the nearest button up from the
  // text node that reads the label.
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent?.trim() !== wanted) continue
    const button = node.parentElement?.closest('button, [role="button"]')
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

/** The page a private tab is put on when the state names none. */
const PRIVATE_PAGE = 'https://example.com/'

/**
 * A private tab and the overview's panes, the way the app reaches them: the tab through
 * `tab.newPrivate` (the app menu's item, the quick menu's, the shortcut's), the overview through
 * the Tabs button, which lands on the active tab's pane; the Private pane over regular tabs is
 * the segment's pick. The theme blends to the private one as the tab becomes active (`useTheme`),
 * so a driver's settle covers the spring. `finish` marks the state reached.
 */
function applyPrivate(
  surface: PreviewPrivateSurface,
  url: string,
  state: UIState,
  finish: () => void
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
        () => afterFrames(2, finish)
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
      // A private tab open, the regular one active again: the overview opens on Tabs, with the
      // segment offering Private and no private card among the regular ones.
      void run('tab.newPrivate', { url })
      onPrivateTab(
        (tab) => tab.url === url,
        () => {
          if (!from) {
            overviewUp(finish)
            return
          }
          void run('tab.activate', { tabId: from.id })
          whenActiveTabIs(
            (tab) => tab.id === from.id,
            () => overviewUp(finish)
          )
        }
      )
      return
    case 'empty':
      overviewUp(() => {
        pickOverviewPane('private')
        afterFrames(2, finish)
      })
      return
  }
}

/**
 * A finger's worth of pull events, as the host would send them (`lib/pull.ts`): down, one move
 * to the travel that puts the page at `progress` of the threshold, and – released – a lift there.
 */
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
 * Every message off at once, and the load a previous `progress` state left running on
 * `loadingTabId` finished, so the next state starts clean.
 */
function clearMessages(loadingTabId: string | null): void {
  const ui = uiStore.get()
  for (const t of ui.toasts) {
    dismissToast(t.id)
    forgetToast(t.id)
  }
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

function done(spec: string): void {
  document.documentElement.dataset.previewState = spec
}

function afterFrames(count: number, fn: () => void): void {
  if (count <= 0) fn()
  else requestAnimationFrame(() => afterFrames(count - 1, fn))
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
