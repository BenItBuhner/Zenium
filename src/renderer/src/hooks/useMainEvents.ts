import { useEffect } from 'react'
import type { Rect, UIState } from '@shared/types'
import { onEvent, run } from '@renderer/lib/api'
import { starredOnPhone } from '@renderer/lib/bookmarkEdit'
import { offerChromeShortcut } from '@renderer/lib/chromeShortcuts'
import { chromeUnderPages } from '@renderer/lib/cover'
import { remoteDragOver } from '@renderer/lib/drag'
import { startDownloadsUi } from '@renderer/lib/downloads'
import { isPhone, viewportStore } from '@renderer/lib/formFactor'
import { presentInstallBanner, retireInstallBanner } from '@renderer/lib/installBanner'
import { onLayoutApplied, onViewDrawn } from '@renderer/lib/pageView'
import { setPdfReport } from '@renderer/lib/pdfViewer'
import { APP_MENU_EVENT } from '@renderer/lib/shortcuts'
import { openSettings } from '@renderer/lib/pages'
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
  openFindBar,
  openNewTabPageUrlbar,
  openNewTabShortcutDialog,
  openInstallSheet,
  openOverlay,
  openPrintPreview,
  openUrlbar,
  openZoom,
  overlayAvailable,
  pushToast,
  showExternalProtocol,
  showMenu,
  showZoomBubble,
  uiStore
} from '@renderer/lib/ui'
import { activeTab } from '@renderer/lib/selectors'
import { openGroupEditor } from '@renderer/lib/groupEditor'
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
      onEvent('urlbar.toggle', ({ mode, text }) => {
        const ui = uiStore.get()
        if (ui.urlbar.open && ui.urlbar.mode === mode && text === undefined) {
          // Zen: pressing Ctrl+T again while the URL bar is open closes it.
          closeUrlbar()
          return
        }
        if (ui.overlay === 'onboarding') return
        const state = browserStore.get().state
        // A popup's location bar is read-only (Chrome): Ctrl+L and Ctrl+K have nothing to open.
        if (state?.window.chrome === 'popup' && mode !== 'new-tab') return
        // Phones always anchor the bar to the top: the keyboard owns the bottom half.
        const attached = isPhone() || state?.settings.urlbarBehavior === 'normal'
        void openUrlbar(mode, currentActiveTabId(), { text, attached })
      }),
      onEvent('urlbar.close', () => closeUrlbar()),
      onEvent('newtab.opened', ({ tabId, text }) => {
        const state = browserStore.get().state
        openNewTabPageUrlbar(tabId, text, isPhone() || state?.settings.urlbarBehavior === 'normal')
      }),
      onEvent('newtab.shortcutDialog', (request) => {
        closeUrlbar()
        void openNewTabShortcutDialog(request)
      }),
      onEvent('overlay.open', ({ kind, folderId, section, tabId }) => {
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
        // Settings is a tab where the host has page tabs; the Shortcuts and Sync overlays are
        // its sections. The core routes its own callers through `page.open`; a stray request
        // for the overlay goes the same way (`openOverlay` refuses the kind on such a host).
        if (!overlayAvailable(kind)) {
          closeUrlbar()
          openSettings(kind === 'settings' ? (section ?? null) : kind)
          return
        }
        if (ui.overlay === kind && !folderId) {
          // Re-opening the same overlay toggles it, unless a specific section was requested.
          if (section) uiStore.set({ overlaySection: section })
          else uiStore.set({ overlay: 'none', overlayFolderId: null, overlaySection: null })
          return
        }
        closeUrlbar()
        void openOverlay(kind, currentActiveTabId(), null, folderId ?? null, section ?? null)
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
      onEvent('menu.app', () => {
        // The menu button claims the request when it is on screen (it takes the focus and opens
        // the menu from itself, so Escape leaves the keyboard on it); otherwise the menu opens
        // at the pointer, keyboard mode all the same.
        const claimed = !window.dispatchEvent(new CustomEvent(APP_MENU_EVENT, { cancelable: true }))
        if (!claimed) run('app.menu', { keyboard: true })
      }),
      onEvent('zoom.changed', ({ tabId, factor }) => {
        // Chrome's bubble, for the page on screen. The host with the page-controls sheet
        // (Android) shows the zoom there instead.
        const state: UIState | null = browserStore.get().state
        if (!state || state.capabilities.pageControls || tabId !== currentActiveTabId()) return
        void showZoomBubble(tabId, factor)
      }),
      onEvent('zoom.open', ({ tabId }) => {
        closeUrlbar()
        openZoom(tabId)
      }),
      // The PDF viewer document in a tab reported where it stands: the docked bar and the find
      // bar draw from the report (lib/pdfViewer.ts).
      onEvent('pdf.changed', ({ tabId, report }) => setPdfReport(tabId, report)),
      onEvent('toast', ({ message, kind }) => pushToast(message, kind)),
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
        // Inside the manager the request is handled in place; anywhere else it is a dialog.
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
      onEvent('extension.popupClosed', () => closeExtensionPopup(false)),
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
      // NOT-20, with Chrome's "Open" (v2 §9.33: one action): the tab goes to the shortcut's URL.
      onEvent('webapp.pinned', ({ tabId, name, url }) =>
        pushToast(`Added ${name} to Home screen`, 'info', {
          action:
            tabId && url
              ? { label: 'Open', onPick: () => run('tab.navigate', { tabId, input: url }) }
              : undefined
        })
      ),
      onEvent('translate.selection', ({ tabId, text, x, y }) => {
        closeUrlbar()
        openTranslateSelection({ tabId, text, x, y })
      }),
      onEvent('insets', (insets) => {
        uiStore.set({ insets })
        const root = document.documentElement.style
        root.setProperty('--zen-inset-top', `${insets.top}px`)
        root.setProperty('--zen-inset-right', `${insets.right}px`)
        root.setProperty('--zen-inset-bottom', `${insets.bottom}px`)
        root.setProperty('--zen-inset-left', `${insets.left}px`)
      }),
      // Where the chrome lies under the pages, the swap between a live page and its cover is
      // timed from these (lib/pageView.ts); the desktop hosts swap the moment they are asked.
      onEvent('layout.applied', (applied) => {
        if (followsCover()) onLayoutApplied(applied)
      }),
      onEvent('view.drawn', ({ tabId, visible }) => {
        if (followsCover()) onViewDrawn(tabId, visible)
      }),
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
