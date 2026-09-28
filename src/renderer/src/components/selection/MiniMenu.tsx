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
 * Translate, Listen, as the page context menu names them), hugging their text at 12 of side
 * padding (`.zen-mini-menu-chip`: no floor), inside the 8 px margin the core leaves around the
 * pill for its shadow (`MINI_MENU_SURFACE_PAD`).
 *
 * Folded (`menu.folded`: the core found the page view narrower than the pill and its margins),
 * the whole row is the 28 icon button per action – the glyph alone, the title as the tooltip
 * and the accessible name – never one chip at a time, centred in the row's 32 control band so
 * the box keeps its 46 and the fold changes the width alone (`.zen-mini-menu`'s `min-height`;
 * the lead's line); the pill measures each pose it draws.
 * The tooltip is the toolkit's `title`, not §9.31's `data-tooltip`: this document mounts no
 * tooltip host (the picker it shares the surface with names its controls the same way), and
 * the surface – the pill and its 8 shadow band – has no room beside the pill for the chrome's
 * panel without a dead band over the page. Registered in `tooltipVocabulary.test.tsx`'s list.
 *
 * The pill sizes itself to its chips and tells the core what it measured, with the pose
 * (`selectionMenu.surfaceSize`); the core places the surface over the selection from it. A chip
 * runs its action through the core (`selectionMenu.run`), which gives the page the keyboard back
 * first; Escape here – the document holds the keyboard only after a press in it – dismisses
 * (`selectionMenu.dismiss`) the same way. Nothing here takes the focus on its own.
 */
export function MiniMenu({ menu }: { menu: SelectionMenuState }): JSX.Element {
  const pillRef = useRef<HTMLDivElement>(null)
  const reported = useRef<{ width: number; height: number } | null>(null)
  const chipKey = menu.actions.map((action) => `${action.id}:${action.title}`).join('\n')
  const folded = menu.folded

  // Measured as it comes and again whenever the chips or the pose change: the core keeps one
  // measurement per pose and forgets both with the chips, so the same size is told again for a
  // new list. The layout box is what is told (`offsetWidth`, the observer's border box), never
  // `getBoundingClientRect`'s: the pop animation scales the pill down for its first frames, and
  // a scaled box would leave the surface short of the pill's last chip.
  useEffect(() => {
    const el = pillRef.current
    if (!el) return
    reported.current = null
    const report = (size: { width: number; height: number }): void => {
      const width = Math.ceil(size.width)
      const height = Math.ceil(size.height)
      if (width <= 0 || height <= 0) return
      const last = reported.current
      if (last && last.width === width && last.height === height) return
      reported.current = { width, height }
      run('selectionMenu.surfaceSize', { tabId: menu.tabId, width, height, folded })
    }
    report({ width: el.offsetWidth, height: el.offsetHeight })
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const border = entries[0]?.borderBoxSize?.[0]
      report(
        border
          ? { width: border.inlineSize, height: border.blockSize }
          : { width: el.offsetWidth, height: el.offsetHeight }
      )
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [menu.tabId, chipKey, folded])

  useEscape(() => run('selectionMenu.dismiss', { tabId: menu.tabId }))

  return (
    <div className="zen-mini-menu-surface" data-surface="page">
      <div
        ref={pillRef}
        role="toolbar"
        aria-label="Selection"
        className="zen-v2 zen-v2-panel zen-mini-menu zen-animate-pop"
        data-mini-menu
        data-folded={folded ? '' : undefined}
      >
        {menu.actions.map((action) => {
          const Glyph = GLYPHS[action.id]
          return folded ? (
            <button
              key={action.id}
              type="button"
              className="zen-v2-icon-button"
              title={action.title}
              aria-label={action.title}
              onClick={() => run('selectionMenu.run', { tabId: menu.tabId, id: action.id })}
              data-mini-menu-chip={action.id}
            >
              <Glyph aria-hidden />
            </button>
          ) : (
            <button
              key={action.id}
              type="button"
              className="zen-v2-button zen-mini-menu-chip"
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
