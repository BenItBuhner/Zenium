import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { AudioLines, BookA, Copy, Languages, Search, type LucideIcon } from 'lucide-react'
import type { SelectionMenuActionId, SelectionMenuState } from '@shared/types'
import { run } from '@renderer/lib/api'
import { useEscape } from '../autofill/controls'

/** Each chip's glyph, by the action the core names (`SelectionMenuActionId`). */
const GLYPHS: Record<SelectionMenuActionId, LucideIcon> = {
  copy: Copy,
  search: Search,
  define: BookA,
  translate: Languages,
  readAloud: AudioLines
}

/**
 * The mini menu over a text selection (CT-39; Edge's mini menu) as the popup surface draws it
 * (`PopupSurface`: the transparent document the desktop host floats over the page without
 * taking the keyboard, `ElectronWindow.setPopupSurface`). A §9.20 floating toolbar – a panel of
 * the page family at 6 padding – whose chips are the button primitive with a 16 glyph and the
 * action's short title (`UIState.selectionMenu.actions`: Copy, Search <engine>, Define,
 * Translate, Listen, as the page context menu names them), inside the 8 px margin the core
 * leaves around the pill for its shadow (`MINI_MENU_SURFACE_PAD`).
 *
 * The pill sizes itself to its chips and tells the core what it measured
 * (`selectionMenu.surfaceSize`); the core places the surface over the selection from it. A chip
 * runs its action through the core (`selectionMenu.run`), which gives the page the keyboard back
 * first; Escape here – the document holds the keyboard only after a press in it – dismisses
 * (`selectionMenu.dismiss`) the same way. Nothing here takes the focus on its own.
 */
export function MiniMenu({ menu }: { menu: SelectionMenuState }): JSX.Element {
  const pillRef = useRef<HTMLDivElement>(null)
  const reported = useRef<{ width: number; height: number } | null>(null)
  const chipKey = menu.actions.map((action) => `${action.id}:${action.title}`).join('\n')

  // Measured as it comes and again whenever the chips change: the core forgets its measurement
  // with the chips, so the same size is told again for a new list.
  useEffect(() => {
    const el = pillRef.current
    if (!el) return
    reported.current = null
    const report = (): void => {
      const box = el.getBoundingClientRect()
      const width = Math.ceil(box.width)
      const height = Math.ceil(box.height)
      if (width <= 0 || height <= 0) return
      const last = reported.current
      if (last && last.width === width && last.height === height) return
      reported.current = { width, height }
      run('selectionMenu.surfaceSize', { tabId: menu.tabId, width, height })
    }
    report()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [menu.tabId, chipKey])

  useEscape(() => run('selectionMenu.dismiss', { tabId: menu.tabId }))

  return (
    <div className="zen-mini-menu-surface" data-surface="page">
      <div
        ref={pillRef}
        role="toolbar"
        aria-label="Selection"
        className="zen-v2 zen-v2-panel zen-mini-menu zen-animate-pop"
        data-mini-menu
      >
        {menu.actions.map((action) => {
          const Glyph = GLYPHS[action.id]
          return (
            <button
              key={action.id}
              type="button"
              className="zen-v2-button"
              onClick={() => run('selectionMenu.run', { tabId: menu.tabId, id: action.id })}
              data-mini-menu-chip={action.id}
            >
              <Glyph aria-hidden />
              {action.title}
            </button>
          )
        })}
      </div>
    </div>
  )
}
