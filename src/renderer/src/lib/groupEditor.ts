import { run } from './api'
import { openedFromKeyboard } from './popover'
import { uiStore } from './ui'

/*
 * The group editor bubble's request (tabs-13): a folder header's double-click, the folder
 * menu's "Edit Folder…" (the header's context menu, so Shift+F10 on the header reaches it) and a
 * folder just made from the tab menu (the core's `folder.edit`) all land here. The bubble itself
 * (components/sidebar/GroupEditorBubble.tsx) holds the page's capture and the keyboard while it
 * is up, so the request is all the store keeps.
 */

/**
 * Open the bubble for the folder (moving it there from another folder's header when one is up).
 * `keyboard` is whether a chrome control had the focus – the header, a focused row – so the
 * page does not take the keyboard back when the bubble closes (§9.22).
 */
export function openGroupEditor(folderId: string): void {
  const keyboard = openedFromKeyboard()
  run('focus.chrome', undefined)
  uiStore.set({ groupEditor: { folderId, keyboard }, drawerOpen: false })
}

export function closeGroupEditor(): void {
  if (!uiStore.get().groupEditor) return
  uiStore.set({ groupEditor: null })
}

const flags = globalThis as unknown as { __zenGroupEditorWired?: boolean }
if (!flags.__zenGroupEditorWired) {
  flags.__zenGroupEditorWired = true
  // Another chrome surface (URL bar, panel, drawer, site information, a menu, the stage, a
  // drag from the sidebar) replaces it.
  uiStore.subscribe(() => {
    const ui = uiStore.get()
    if (
      ui.groupEditor &&
      (ui.urlbar.open ||
        ui.overlay !== 'none' ||
        ui.drawerOpen ||
        ui.siteInfoOpen ||
        ui.menu !== null ||
        ui.drag !== null ||
        ui.stageActive)
    )
      closeGroupEditor()
  })
}
