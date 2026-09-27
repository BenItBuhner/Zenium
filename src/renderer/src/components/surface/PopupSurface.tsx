import type { JSX } from 'react'
import { useEffect } from 'react'
import type { UIState } from '@shared/types'
import { browserStore } from '@renderer/lib/ui'
import { useTheme } from '@renderer/hooks/useTheme'
import { PickerSurface } from '../autofill/PickerSurface'
import { MiniMenu } from '../selection/MiniMenu'

/**
 * The popup surface's document: `index.html?surface=popup`, loaded by the desktop host into a
 * `WebContentsView` it floats over the page without taking the keyboard (`ElectronWindow.
 * setPopupSurface`; `ZenWindow.setPopupSurface` says where, for whichever owner stands in
 * front). It mirrors the window's state like the chrome does and draws one thing on a
 * transparent page: the autofill picker under the focused field (`PickerSurface`,
 * `UIState.autofill.picker`) or, when no picker is up, the mini menu over a text selection
 * (`MiniMenu`, `UIState.selectionMenu`) – the order the core places the surface in
 * (`POPUP_SURFACE_OWNERS`: the picker in front of the pill).
 */
export function PopupSurface(): JSX.Element | null {
  const state = browserStore.use((s) => s.state)
  useEffect(() => {
    document.documentElement.dataset.chromeSurface = 'popup'
  }, [])
  if (!state) return null
  return <Surface state={state} />
}

function Surface({ state }: { state: UIState }): JSX.Element | null {
  useTheme(state)
  const picker = state.autofill.picker
  if (picker) return <PickerSurface key={picker.id} picker={picker} />
  const menu = state.selectionMenu
  if (menu) return <MiniMenu key={menu.tabId} menu={menu} />
  return null
}
