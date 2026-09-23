import { useEffect } from 'react'
import type { UIState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { closeExtensionPopup } from '@renderer/lib/extensions/popup'
import { activeTab } from '@renderer/lib/selectors'
import {
  browserStore,
  clearTabSelection,
  closeFindBar,
  closeOverlay,
  uiStore
} from '@renderer/lib/ui'

/**
 * Keys the renderer handles itself (main handles the shortcut table): the chrome's Escape
 * stack, top to bottom – a popover that already claimed the key, the URL bar, the menu layer,
 * the extension prompt and popup, the dialogs and choosers, the overlay, Glance, the tab
 * selection, the find bar – and, when none of them held the key, Stop.
 */
export function useGlobalKeys(state: UIState): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // A popover that closed itself on this Escape (a Settings menulist, a Radix layer) has
      // claimed the key: it returns focus to its anchor and the overlay under it stays open.
      if (e.defaultPrevented) return
      const ui = uiStore.get()
      if (ui.urlbar.open) return // handled by the URL bar input
      if (ui.menu) return // handled by the menu layer
      if (ui.extensionPrompts.length) return // the prompt dialog answers Escape itself
      if (ui.extensionPopup) {
        e.preventDefault()
        closeExtensionPopup()
        return
      }
      // Dialogs, choosers and overflow menus take Escape first (capture traps).
      if (ui.bookmarkEdit || ui.starDialog || ui.bookmarkAllTabs || ui.barMenuOpen) return
      if (ui.zoomBubble) return
      if (ui.overlay !== 'none') {
        e.preventDefault()
        closeOverlay()
        return
      }
      if (state.glance) {
        e.preventDefault()
        run('glance.close', undefined)
        return
      }
      if (ui.selectedTabIds.length) {
        e.preventDefault()
        clearTabSelection()
        return
      }
      if (ui.findOpen && ui.findTabId) {
        closeFindBar('afterKey')
        return
      }
      // Nothing in the chrome claimed the key: Escape is Stop, as it is in Chrome and Firefox
      // when the focus sits in the toolbar. The page handler (core/keys.ts) stops the load when
      // the page has the focus; this rung covers the chrome, where the keyboard stays while a
      // tab's first navigation has no document yet (window.ts focusContent) or after the URL bar
      // has handed the key back.
      const live = browserStore.get().state
      const tab = live ? activeTab(live) : null
      if (tab?.loading) {
        e.preventDefault()
        run('tab.stop', { tabId: tab.id })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state.glance])

  // A multi-selection belongs to one space; drop it when the space changes. So does the tab
  // strip's roving tab stop: the new space's active row is the stop (lib/tabStrip.ts).
  useEffect(() => {
    clearTabSelection()
    if (uiStore.get().stripFocus !== null) uiStore.set({ stripFocus: null })
  }, [state.activeSpaceId])

  // Sidebar collapse toggle (Zen's "Toggle Sidebar" action).
  useEffect(() => {
    const onToggle = (): void => run('sidebar.toggleExpanded', undefined)
    window.addEventListener('zen-sidebar-toggle', onToggle)
    return () => window.removeEventListener('zen-sidebar-toggle', onToggle)
  }, [])
}
