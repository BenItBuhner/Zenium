import { useEffect } from 'react'
import type { Rect, UIState } from '@shared/types'
import { announce, startAnnouncer, zoomAnnouncement } from '@renderer/lib/announce'
import { installedMessage } from '@shared/webApp'
import { onEvent, run } from '@renderer/lib/api'
import { starredOnPhone } from '@renderer/lib/bookmarkEdit'
import { showBookmarkDeleted } from '@renderer/lib/bookmarkUndo'
import { offerChromeShortcut } from '@renderer/lib/chromeShortcuts'
import { chromeUnderPages } from '@renderer/lib/cover'
import { remoteDragOver } from '@renderer/lib/drag'
import { startDownloadsUi } from '@renderer/lib/downloads'
import { isPhone, isTouchLayout, viewportStore } from '@renderer/lib/formFactor'
import { noteViewSized } from '@renderer/lib/fullscreenLanding'
import { applyHostInsets } from '@renderer/lib/insets'
import { presentInstallBanner, retireInstallBanner } from '@renderer/lib/installBanner'
import { onLayoutApplied, onViewDrawn } from '@renderer/lib/pageView'
import { focusPane, pageTookKeyboard } from '@renderer/lib/panes'
import { dropStalePdfReports, setPdfReport } from '@renderer/lib/pdfViewer'
import { APP_MENU_EVENT } from '@renderer/lib/shortcuts'
import { mediaHubFolded, openMediaHub } from '@renderer/lib/mediaHub'
import { openImportSurface } from '@renderer/lib/pages'
import {
  configureThumbnails,
  rememberCard,
  thumbnailWidthFor,
  trackTabs
} from '@renderer/lib/thumbnails'
import {
  cancelExternalProtocol,
  closeMenu,
  closeUrlbar,
  openBookmarkChrome,
  openExtensionsSheet,
  openFindBar,
  onboardingUp,
  openNewTabPageUrlbar,
  openNewTabShortcutDialog,
  openInstallSheet,
  openOverlay,
  openPrintPreview,
  openReaderPreferences,
  openSendTabSheet,
  openUrlbar,
  openZoom,
  overlayAvailable,
  pushToast,
  showExternalProtocol,
  showMenu,
  showScreenshotCard,
  showZoomBubble,
  uiStore
} from '@renderer/lib/ui'
import { activeTab, isEmptySplitPane } from '@renderer/lib/selectors'
import { openSiteInfo } from '@renderer/lib/siteInfo'
import { openGroupEditor } from '@renderer/lib/groupEditor'
import { openOverview } from '@renderer/lib/gestures/stage'
import { toggleTabSearch } from '@renderer/lib/tabSearch'
import { openTranslateSelection } from '@renderer/lib/translate'
import { browserStore } from '@renderer/lib/ui'
import { voiceEvent } from '@renderer/lib/voiceSearch'
import { qrEvent } from '@renderer/lib/qrScan'
import {
  closeExtensionPopup,
  enqueueExtensionPrompt,
  popupSizeReported
} from '@renderer/lib/extensions/popup'

function currentActiveTabId(): string | null {
  const state: UIState | null = browserStore.get().state
  return state ? (activeTab(state)?.id ?? null) : null
}

function followsCover(): boolean {
  const state: UIState | null = browserStore.get().state
  return state !== null && chromeUnderPages(state.platform)
}

/** How wide the host is to make a card picture for this screen, in device pixels. */
function thumbnailWidth(): number {
  return thumbnailWidthFor(viewportStore.get().width, window.devicePixelRatio)
}

/** Wire main-process events into the renderer UI store. */
export function useMainEvents(): void {
  useEffect(() => {
    const offs = [
      // The downloads button and bubble follow the engine's list and the `downloads.reveal` event.
      startDownloadsUi(),
      // The status region hears of the tab that came to the front and of tabs muted or unmuted.
      startAnnouncer(),
      onEvent('urlbar.toggle', ({ mode, text }) => {
        const ui = uiStore.get()
        if (ui.urlbar.open && ui.urlbar.mode === mode && text === undefined) {
          // Zen: pressing Ctrl+T again while the URL bar is open closes it.
          closeUrlbar()
          return
        }
        // Not under the first-run tour (lib/ui.ts `onboardingUp`).
        if (onboardingUp()) return
        const state = browserStore.get().state
        // A popup's location bar is read-only and an app window has none (Chrome): Ctrl+L and
        // Ctrl+K have nothing to open.
        const chrome = state?.window.chrome
        if ((chrome === 'popup' || chrome === 'app') && mode !== 'new-tab') return
        // The touch layouts always anchor the bar: on a phone the keyboard owns the bottom half,
        // and the tablet's bar is its toolbar pill's popup (TB-21).
        const attached = isTouchLayout() || state?.settings.urlbarBehavior === 'normal'
        const tabId = currentActiveTabId()
        // Over the empty pane of a split (Ctrl+Shift+*, split-04) the desktop's bar is the pane's
        // own field: it floats inside the pane and the panes beside it stay live (`EmptyPane`).
        // The touch layouts' bar is the shell's (the phone's band, the tablet's toolbar popup).
        const pane = !isTouchLayout() && state !== null && isEmptySplitPane(state, tabId)
        void openUrlbar(mode, tabId, { text, attached, pane })
      }),
      onEvent('urlbar.close', () => closeUrlbar()),
      onEvent('newtab.opened', ({ tabId, text }) => {
        const state = browserStore.get().state
        openNewTabPageUrlbar(
          tabId,
          text,
          isTouchLayout() || state?.settings.urlbarBehavior === 'normal'
        )
      }),
      onEvent('newtab.shortcutDialog', (request) => {
        closeUrlbar()
        void openNewTabShortcutDialog(request)
      }),
      onEvent('overlay.open', ({ kind, folderId, section, tabId, reveal }) => {
        const ui = uiStore.get()
        // The print preview is a frame dialog over the tab it prints (`zen://print` has no panel
        // of its own): the core opens a session for the tab and asks for its surface here.
        if (kind === 'print') {
          const target = tabId ?? currentActiveTabId()
          if (!target) return
          closeUrlbar()
          void openPrintPreview(target)
          return
        }
        // Settings (with Shortcuts and Sync, its sections) is a tab where the host has page
        // tabs, and History, Bookmarks and Downloads are tabs on the desktop and tablet layouts.
        // The core routes its own callers through `page.open`; a request for the overlay that
        // still arrives goes the same way (`openOverlay` refuses the kind where the page is a
        // tab). The core's `PageService` sends the overlay only where its own reading of the
        // window's layout (`window.formFactor`, what this chrome reported) says the page is no
        // tab, so the two sides can only disagree for the hop until a fresh report lands – sent
        // ahead of any `page.open` on the same ordered channel – and never bounce for good.
        if (!overlayAvailable(kind)) {
          closeUrlbar()
          void openOverlay(kind, currentActiveTabId(), null, folderId ?? null, section ?? null)
          return
        }
        if (ui.overlay === kind && !folderId) {
          // Re-opening the same overlay toggles it, unless a specific section was requested –
          // or the core is revealing it for something that happened (a download began while
          // the phone's Downloads sheet was up: the sheet stays, the new row on top).
          if (section) uiStore.set({ overlaySection: section })
          else if (!reveal)
            uiStore.set({ overlay: 'none', overlayFolderId: null, overlaySection: null })
          return
        }
        closeUrlbar()
        void openOverlay(kind, currentActiveTabId(), null, folderId ?? null, section ?? null)
      }),
      onEvent('import.open', () => {
        // Chrome's chrome://settings/importData: Settings on its Import category, the dialog up
        // over it (the category alone on a phone, whose rows import from files).
        closeUrlbar()
        void openImportSurface(currentActiveTabId())
      }),
      onEvent('theme.open', ({ spaceId }) => {
        closeUrlbar()
        void openOverlay('theme', currentActiveTabId(), spaceId)
      }),
      onEvent('space.new', () => {
        closeUrlbar()
        void openOverlay('space-editor', currentActiveTabId(), null)
      }),
      onEvent('space.edit', ({ spaceId }) => {
        closeUrlbar()
        void openOverlay('space-editor', currentActiveTabId(), spaceId)
      }),
      onEvent('find.open', (find) => {
        // A chrome page tab may take Ctrl+F for its own search (Settings' "Find in Settings")
        // – there is no page text for the find bar to search.
        if (offerChromeShortcut('find.open', find)) return
        openFindBar(find.tabId, find.text, find.again ?? null)
      }),
      onEvent('find.selection', ({ tabId, text }) => {
        // Cmd+E does not open the bar; one open for the tab searches the selection.
        const ui = uiStore.get()
        if (ui.findOpen && ui.findTabId === tabId) openFindBar(tabId, text)
      }),
      onEvent('tabsearch.open', () => {
        // Chrome's tab search (tabs-17): a popover of the sidebar layouts; a phone has the tab
        // switcher's own search.
        if (isPhone()) return
        toggleTabSearch()
      }),
      onEvent('overview.open', () => {
        // The crash page's Show tabs (ERR-15): the phone's tab overview, the switcher the page
        // asks for so other tabs can be closed. The control is drawn on the phone alone
        // (`.zen-error-show-tabs`); a request that still arrives elsewhere has no overview.
        if (!isPhone()) return
        const state = browserStore.get().state
        if (!state) return
        closeUrlbar()
        openOverview(state)
      }),
      onEvent('mediahub.open', () => {
        // The app menu's "Now Playing…" row (§9.29): the hub's popover from the "⋯" button the
        // row's menu hung from (`mediaHubAnchor`: the toolbar button, were it up – but the row
        // is the fold's). A menu command, not a press on the surface: the core focused the
        // chrome for it, so the page has no focus to get back and the popover takes the keyboard
        // as it does when opened from the keyboard.
        if (isPhone()) return
        openMediaHub({ fromKeyboard: true })
      }),
      onEvent('menu.app', () => {
        // The menu button claims the request when it is on screen (it takes the focus and opens
        // the menu from itself, so Escape leaves the keyboard on it); otherwise the menu opens
        // at the pointer, keyboard mode all the same.
        const claimed = !window.dispatchEvent(new CustomEvent(APP_MENU_EVENT, { cancelable: true }))
        if (!claimed) run('app.menu', { keyboard: true, mediaHubFolded: mediaHubFolded() })
      }),
      // F6 / Shift+F6 / Shift+Alt+T / Shift+Alt+B: the keyboard moves between the chrome's panes
      // and the page (lib/panes.ts).
      onEvent('focus.pane', (request) => void focusPane(request)),
      // A page's view took the keyboard: the chrome's stale focused control is let go – but the
      // open URL bar keeps its field and takes the keyboard back (lib/panes.ts).
      onEvent('focus.page', ({ tabId }) => void pageTookKeyboard(tabId)),
      onEvent('zoom.changed', ({ tabId, factor }) => {
        // Chrome's bubble, for the page on screen. The host with the page-controls sheet
        // (Android) shows the zoom there instead. Either way the reader hears the new level.
        const state: UIState | null = browserStore.get().state
        if (!state || tabId !== currentActiveTabId()) return
        announce(zoomAnnouncement(factor))
        if (state.capabilities.pageControls) return
        void showZoomBubble(tabId, factor)
      }),
      onEvent('zoom.open', ({ tabId }) => {
        closeUrlbar()
        openZoom(tabId)
      }),
      onEvent('siteInfo.open', ({ tabId }) => {
        // The app menu's Page info button: the site information sheet for the tab, as the pill's
        // site chip opens it – with no chip to hang from or hand the focus back to, since the
        // menu that asked has left by the time the core answers.
        const state: UIState | null = browserStore.get().state
        const tab = state?.tabs[tabId]
        if (!tab) return
        closeUrlbar()
        void openSiteInfo(tab)
      }),
      onEvent('extensions.open', () => {
        closeUrlbar()
        openExtensionsSheet()
      }),
      // The phone menu's "Send to Your Devices…": the device picker sheet for the tab (ID-27).
      onEvent('sendTab.open', ({ tabId }) => {
        closeUrlbar()
        openSendTabSheet(tabId)
      }),
      // The PDF viewer document in a tab reported where it stands: the docked bar and the find
      // bar draw from the report (lib/pdfViewer.ts).
      onEvent('pdf.changed', ({ tabId, report }) => setPdfReport(tabId, report)),
      // ...and a viewer tab that moved on (a page, another document) has no report until the
      // new document's comes.
      browserStore.subscribe(() => {
        const state: UIState | null = browserStore.get().state
        if (state) dropStalePdfReports(state)
      }),
      onEvent('reader.preferences', ({ tabId }) => {
        // The app menu's "Text Preferences…" (the phone's way in, its pill having no chip): the
        // popover hangs from the pill's chip, which the reader tab never hides (§9.29;
        // `openReaderPreferences` finds it), the sheet on a phone.
        closeUrlbar()
        void openReaderPreferences(tabId)
      }),
      onEvent('toast', ({ message, kind }) => pushToast(message, kind)),
      // A delete's toast with Undo (bookmarks-31). The phone's panels keep their own: the delete
      // itself waits out the toast there (`removeWithUndo`), so the core's word would be a second one.
      onEvent('bookmark.deleted', (removal) => {
        if (!isPhone()) showBookmarkDeleted(removal)
      }),
      // Take Screenshot's picture is in the gallery (SH-07): the preview card in the toast's slot
      // on the layouts with the message layer; the sidebar layout's narrow well takes a toast
      // with Share for its one action.
      onEvent('screenshot.saved', (saved) => {
        if (isTouchLayout()) showScreenshotCard(saved)
        else
          pushToast('Screenshot saved', 'info', {
            action: { label: 'Share', onPick: () => run('screenshot.share', { uri: saved.uri }) }
          })
      }),
      onEvent('status', ({ text }) => uiStore.set({ statusText: text })),
      onEvent('sidebar.toggle', () => window.dispatchEvent(new CustomEvent('zen-sidebar-toggle'))),
      onEvent('tab.dragOver', (over) => remoteDragOver(over)),
      onEvent('tab.startRename', ({ tabId }) => uiStore.set({ renamingTabId: tabId })),
      onEvent('folder.startRename', ({ folderId }) => uiStore.set({ renamingFolderId: folderId })),
      onEvent('folder.edit', ({ folderId }) => {
        // Chrome's group editor bubble (tabs-13) beside the folder's header; the phone's group
        // sheet holds the colours, so a new group there starts its inline rename as before.
        if (isPhone()) uiStore.set({ renamingFolderId: folderId })
        else openGroupEditor(folderId)
      }),
      onEvent('tab.editPinnedUrl', ({ tabId }) => uiStore.set({ editingPinnedUrlTabId: tabId })),
      onEvent('tab.pickIcon', ({ tabId }) => uiStore.set({ iconPickerTabId: tabId })),
      onEvent('bookmark.star', (star) => {
        closeUrlbar()
        // The phone's save flow (HB-19): a toast with Edit, or the editor sheet straight away.
        if (isPhone()) {
          starredOnPhone(star)
          return
        }
        // The bubble hangs from the pill's bottom edge, end-aligned with the star in it (v2
        // draft §9.20); both are measured as the request arrives.
        const chip = document.querySelector('[data-bm-star]')
        const rect = (el: Element | null | undefined): Rect | null => {
          const r = el?.getBoundingClientRect()
          return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null
        }
        void openBookmarkChrome(
          { starDialog: { ...star, anchor: rect(chip), pill: rect(chip?.closest('.zen-pill')) } },
          currentActiveTabId()
        )
      }),
      onEvent('bookmark.edit', (edit) => {
        // Over the phone's bookmarks panel the request is the panel's sheet, with the panel's
        // own picture behind it; anywhere else it is a dialog over the page (the manager page
        // renames a folder in view in place and lets the rest through to it).
        if (uiStore.get().overlay === 'bookmarks') uiStore.set({ bookmarkEdit: edit })
        else void openBookmarkChrome({ bookmarkEdit: edit }, currentActiveTabId())
      }),
      onEvent('bookmark.allTabs', (request) => {
        closeUrlbar()
        void openBookmarkChrome({ bookmarkAllTabs: request }, currentActiveTabId())
      }),
      onEvent('space.switched', ({ fromIndex, toIndex }) => {
        uiStore.set({ spaceSlideDirection: toIndex > fromIndex ? 1 : toIndex < fromIndex ? -1 : 0 })
      }),
      onEvent('compact.reveal', (reveal) =>
        window.dispatchEvent(new CustomEvent('zen-compact-reveal', { detail: reveal }))
      ),
      onEvent('extension.popupSize', ({ id, width, height }) =>
        popupSizeReported(id, width, height)
      ),
      onEvent('extension.popupClosed', ({ reason }) =>
        closeExtensionPopup(false, reason === 'escape' ? 'anchor' : 'page')
      ),
      onEvent(
        'extensionInstallRequest',
        (prompt) => void enqueueExtensionPrompt(prompt, currentActiveTabId())
      ),
      onEvent(
        'extensionPermissionRequest',
        (prompt) => void enqueueExtensionPrompt(prompt, currentActiveTabId())
      ),
      onEvent('extension.installed', ({ id, name, toolbarPinned }) =>
        pushToast(
          `${name} was added to Zenium`,
          'info',
          toolbarPinned
            ? {}
            : {
                action: {
                  label: 'Pin',
                  onPick: () => run('extension.setToolbarPinned', { id, pinned: true })
                }
              }
        )
      ),
      onEvent('menu.show', (menu) => void showMenu(menu, currentActiveTabId())),
      onEvent('menu.hide', ({ menuId }) => {
        if (uiStore.get().menu?.id === menuId) closeMenu(false)
      }),
      onEvent(
        'externalProtocol.request',
        (request) => void showExternalProtocol(request, currentActiveTabId())
      ),
      onEvent('externalProtocol.cancel', ({ requestId }) => cancelExternalProtocol(requestId)),
      onEvent('voice.event', (event) => voiceEvent(event)),
      onEvent('qr.event', (event) => qrEvent(event)),
      onEvent('webapp.install', (prompt) => {
        closeUrlbar()
        retireInstallBanner(prompt.tabId)
        void openInstallSheet(prompt)
      }),
      onEvent('webapp.banner', (banner) => presentInstallBanner(banner)),
      onEvent('webapp.bannerHide', ({ tabId }) => retireInstallBanner(tabId)),
      // NOT-20, with Chrome's "Open" (v2 §9.33: one action): the tab goes to the shortcut's URL;
      // on desktop an installed app opens in its own window instead (a plain shortcut's page
      // came up in the app window already, so its toast has no action).
      onEvent('webapp.pinned', ({ tabId, name, url, surface, appId }) =>
        pushToast(installedMessage(surface, name), 'info', {
          action:
            surface === 'desktop'
              ? appId
                ? { label: 'Open', onPick: () => run('webapp.launch', { appId }) }
                : undefined
              : tabId && url
                ? { label: 'Open', onPick: () => run('tab.navigate', { tabId, input: url }) }
                : undefined
        })
      ),
      onEvent('translate.selection', ({ tabId, text, x, y }) => {
        closeUrlbar()
        openTranslateSelection({ tabId, text, x, y })
      }),
      // The root's `--zen-inset-*` and the store, when the numbers changed (lib/insets.ts).
      onEvent('insets', (insets) => applyHostInsets(insets)),
      // Where the chrome lies under the pages, the swap between a live page and its cover is
      // timed from these (lib/pageView.ts); the desktop hosts swap the moment they are asked.
      onEvent('layout.applied', (applied) => {
        if (followsCover()) onLayoutApplied(applied)
      }),
      onEvent('view.drawn', ({ tabId, visible }) => {
        if (followsCover()) onViewDrawn(tabId, visible)
      }),
      // The host drew a page view at a new size: the return from a fullscreen lands on it.
      onEvent('view.sized', ({ tabId, width, height }) => noteViewSized(tabId, width, height)),
      // Tab card pictures (lib/thumbnails.ts): the host's captures, the tabs' navigations and
      // closes, and the card width the host scales its captures to – on the host that keeps
      // them (the chrome under the pages); the desktop hosts have no pictures to be told about.
      onEvent('thumbnail.captured', ({ tabId, ...picture }) => rememberCard(tabId, picture)),
      browserStore.subscribe(() => {
        if (followsCover()) trackTabs(browserStore.get().state)
      }),
      viewportStore.subscribe(() => {
        if (followsCover()) configureThumbnails(thumbnailWidth())
      })
    ]
    if (followsCover()) {
      trackTabs(browserStore.get().state)
      configureThumbnails(thumbnailWidth())
    }
    return () => offs.forEach((off) => off())
  }, [])
}
