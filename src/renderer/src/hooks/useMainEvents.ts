import { useEffect } from 'react'
import type { UIState } from '@shared/types'
import { onEvent } from '@renderer/lib/api'
import { closeUrlbar, openOverlay, openUrlbar, pushToast, uiStore } from '@renderer/lib/ui'
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
        const attached = state?.settings.urlbarBehavior === 'normal'
        void openUrlbar(mode, currentActiveTabId(), { text, attached })
      }),
      onEvent('urlbar.close', () => closeUrlbar()),
      onEvent('overlay.open', ({ kind }) => {
        const ui = uiStore.get()
        if (ui.overlay === kind) {
          uiStore.set({ overlay: 'none' })
          return
        }
        closeUrlbar()
        void openOverlay(kind, currentActiveTabId())
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
      onEvent('find.open', ({ tabId, again }) => {
        uiStore.set({ findOpen: true, findTabId: tabId })
        if (again) window.dispatchEvent(new CustomEvent('zen-find-again', { detail: again }))
      }),
      onEvent('toast', ({ message, kind }) => pushToast(message, kind)),
      onEvent('status', ({ text }) => uiStore.set({ statusText: text })),
      onEvent('sidebar.toggle', () => window.dispatchEvent(new CustomEvent('zen-sidebar-toggle'))),
      onEvent('tab.startRename', ({ tabId }) => uiStore.set({ renamingTabId: tabId })),
      onEvent('folder.startRename', ({ folderId }) => uiStore.set({ renamingFolderId: folderId })),
      onEvent('space.switched', ({ fromIndex, toIndex }) => {
        uiStore.set({ spaceSlideDirection: toIndex > fromIndex ? 1 : toIndex < fromIndex ? -1 : 0 })
      }),
      onEvent('compact.reveal', ({ revealed }) => uiStore.set({ compactHover: revealed }))
    ]
    return () => offs.forEach((off) => off())
  }, [])
}
