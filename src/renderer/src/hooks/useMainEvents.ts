import { useEffect } from 'react'
import type { Rect, UIState } from '@shared/types'
import { onEvent, run } from '@renderer/lib/api'
import { remoteDragOver } from '@renderer/lib/drag'
import { isPhone } from '@renderer/lib/formFactor'
import { APP_MENU_EVENT } from '@renderer/lib/shortcuts'
import {
  cancelExternalProtocol,
  closeMenu,
  closeUrlbar,
  openBookmarkChrome,
  openOverlay,
  openUrlbar,
  pushToast,
  showExternalProtocol,
  showMenu,
  uiStore
} from '@renderer/lib/ui'
import { activeTab } from '@renderer/lib/selectors'
import { browserStore } from '@renderer/lib/ui'

function currentActiveTabId(): string | null {
  const state: UIState | null = browserStore.get().state
  return state ? (activeTab(state)?.id ?? null) : null
}

/** Wire main-process events into the renderer UI store. */
export function useMainEvents(): void {
  useEffect(() => {
    const offs = [
      onEvent('urlbar.toggle', ({ mode, text }) => {
        const ui = uiStore.get()
        if (ui.urlbar.open && ui.urlbar.mode === mode && text === undefined) {
          // Zen: pressing Ctrl+T again while the URL bar is open closes it.
          closeUrlbar()
          return
        }
        if (ui.overlay === 'onboarding') return
        const state = browserStore.get().state
        // Phones always anchor the bar to the top: the keyboard owns the bottom half.
        const attached = isPhone() || state?.settings.urlbarBehavior === 'normal'
        void openUrlbar(mode, currentActiveTabId(), { text, attached })
      }),
      onEvent('urlbar.close', () => closeUrlbar()),
      onEvent('overlay.open', ({ kind, folderId, section }) => {
        const ui = uiStore.get()
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
      onEvent('find.open', ({ tabId, again, text }) => {
        uiStore.set({ findOpen: true, findTabId: tabId, findSeed: text ?? null })
        if (again) window.dispatchEvent(new CustomEvent('zen-find-again', { detail: again }))
        if (text !== undefined)
          window.dispatchEvent(new CustomEvent('zen-find-seed', { detail: text }))
      }),
      onEvent('menu.app', () => {
        // The menu button claims the request when it is on screen (it takes the focus and opens
        // the menu from itself, so Escape leaves the keyboard on it); otherwise the menu opens
        // at the pointer, keyboard mode all the same.
        const claimed = !window.dispatchEvent(new CustomEvent(APP_MENU_EVENT, { cancelable: true }))
        if (!claimed) run('app.menu', { keyboard: true })
      }),
      onEvent('toast', ({ message, kind }) => pushToast(message, kind)),
      onEvent('status', ({ text }) => uiStore.set({ statusText: text })),
      onEvent('sidebar.toggle', () => window.dispatchEvent(new CustomEvent('zen-sidebar-toggle'))),
      onEvent('tab.dragOver', (over) => remoteDragOver(over)),
      onEvent('tab.startRename', ({ tabId }) => uiStore.set({ renamingTabId: tabId })),
      onEvent('folder.startRename', ({ folderId }) => uiStore.set({ renamingFolderId: folderId })),
      onEvent('tab.editPinnedUrl', ({ tabId }) => uiStore.set({ editingPinnedUrlTabId: tabId })),
      onEvent('tab.pickIcon', ({ tabId }) => uiStore.set({ iconPickerTabId: tabId })),
      onEvent('bookmark.star', (star) => {
        closeUrlbar()
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
      onEvent('compact.reveal', ({ revealed }) =>
        window.dispatchEvent(new CustomEvent('zen-compact-reveal', { detail: revealed }))
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
      onEvent('insets', (insets) => {
        uiStore.set({ insets })
        const root = document.documentElement.style
        root.setProperty('--zen-inset-top', `${insets.top}px`)
        root.setProperty('--zen-inset-right', `${insets.right}px`)
        root.setProperty('--zen-inset-bottom', `${insets.bottom}px`)
        root.setProperty('--zen-inset-left', `${insets.left}px`)
      })
    ]
    return () => offs.forEach((off) => off())
  }, [])
}
