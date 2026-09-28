import type { JSX } from 'react'
import { useEffect, useRef } from 'react'
import { AudioLines, BookA, Copy, Languages, Search, type LucideIcon } from 'lucide-react'
import type { MiniMenuRoom, SelectionMenuActionId, SelectionMenuState } from '@shared/types'
import { cmd, run } from '@renderer/lib/api'
import { POPOVER_MARGIN } from '@renderer/lib/portals'
import {
  awaitTooltipRoom,
  measureTooltipSize,
  tooltip,
  TOOLTIP_GAP,
  tooltipStore,
  tooltipTargetOf
} from '@renderer/lib/tooltip'
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
 * the whole row is the 28 icon button per action – the glyph alone, the title as the chrome's
 * tooltip (§9.31's `data-tooltip`, read by the `Tooltip` host `PopupSurface` mounts in this
 * document; no toolkit `title`) and as the accessible name – never one chip at a time, centred
 * in the row's 32 control band so the box keeps its 46 and the fold changes the width alone
 * (`.zen-mini-menu`'s `min-height`; the lead's line); the pill measures each pose it draws.
 * The tooltip needs room the pill's shadow band has not: the folded pill asks the core for it
 * with its box (`MiniMenuRoom`, `tooltipRoom`) – under the pill, where the host places a
 * tooltip first (`TOOLTIP_GAP` under its button, `POPOVER_MARGIN` inside the document), and a
 * least width for the widest title – and the core gives the surface the room around the pill
 * without moving it; the surface's document centres the pill in a widened surface.
 *
 * The room is asked for the tooltip's moment alone (the lead's line: a transparent band under
 * the pill at rest is a dead zone for the page's pointer): it is asked the instant a tooltip
 * arms – the mouse pointer's arrival on a glyph button, the `pointerover` the host starts its
 * `TOOLTIP_DELAY` dwell from, so the surface has grown, transparent, under the still pointer by
 * the time the tooltip paints – or a tooltip's coming up on a glyph any other way (the store:
 * keyboard focus shows at once), and given back (`room: null`) the instant the moment is over:
 * the pointer leaving the pill, a press (the chassis takes the tooltip down on it), the
 * tooltip going with no pointer on the pill (focus leaving; Escape, which takes it down first),
 * the pill moving to a new box or going down. The pointer browsing the pill's own gaps keeps
 * the room: the chassis shows the next glyph's tooltip at once within its browse window, and
 * a surface shrinking and growing again per gap would flicker under it. The core returns the
 * surface to the pill's padded box on the null; a resize of this document is the room's coming
 * and going, which the host places through rather than hiding for (`PopupSurface`).
 *
 * The room is one round trip away when it is asked, and the tooltip must not paint before it
 * lands – its first frames would be cut by the surface's old bounds (§11's stand-in rule): so
 * the ask is §11's paint handshake, the reader cover's (`awaitTooltipRoom`). The core answers
 * the report with the surface's size as set (`MiniMenuSurfaceSize`), and the tooltip host
 * keeps a tooltip hidden (`tooltipRoomStore`) until that word has come and this document's
 * own frame is at the size – or the ceiling (`TOOLTIP_ROOM_CEILING_MS`) for a word that never
 * comes – on keyboard focus as on the pointer's dwell: the hover's dwell usually outlasts the
 * landing and the tooltip shows on time; focus shows at once in the chassis and here waits
 * the round trip. The hold goes with the room: the moment ending releases it at once.
 *
 * The pill sizes itself to its chips and tells the core what it measured, with the pose
 * (`selectionMenu.surfaceSize`); the core places the surface over the selection from it. A chip
 * runs its action through the core (`selectionMenu.run`), which gives the page the keyboard back
 * first; Escape here – the document holds the keyboard only after a press in it – dismisses
 * (`selectionMenu.dismiss`) the same way, the tooltip going first in the one press (the
 * chassis's order: the key is never the tooltip's to consume). Nothing here takes the focus on
 * its own.
 */
export function MiniMenu({ menu }: { menu: SelectionMenuState }): JSX.Element {
  const pillRef = useRef<HTMLDivElement>(null)
  const reported = useRef<{ width: number; height: number; room: MiniMenuRoom | null } | null>(null)
  const chipKey = menu.actions.map((action) => `${action.id}:${action.title}`).join('\n')
  const folded = menu.folded
  const rect = menu.rect
  const rectKey = rect ? `${rect.x},${rect.y},${rect.width},${rect.height}` : ''
  // The chips as last rendered, for the measuring effect and its observer: the list is keyed
  // by `chipKey`, so the effect need not run for every mirror of the window's state.
  const actions = useRef(menu.actions)
  useEffect(() => {
    actions.current = menu.actions
  })
  // Whether the mouse pointer is on the pill, come by a glyph button: a tooltip armed or
  // browsing. Set by the folded row's listeners, read by the report.
  const hovering = useRef(false)
  // Tells the core the box last measured again, with the room as it is now (or nothing while
  // the same report stands); the measuring effect's, for the room's listeners.
  const tell = useRef<() => void>(() => undefined)
  // The hold on the tooltip's show while a room asked is on its way (`awaitTooltipRoom`'s
  // release); null while none is asked.
  const roomWait = useRef<(() => void) | null>(null)

  // Measured as it comes and again whenever the chips or the pose change: the core keeps one
  // measurement per pose and forgets both with the chips, so the same size is told again for a
  // new list. The layout box is what is told (`offsetWidth`, the observer's border box), never
  // `getBoundingClientRect`'s: the pop animation scales the pill down for its first frames, and
  // a scaled box would leave the surface short of the pill's last chip. The folded row's report
  // carries the room its tooltips need while one is armed or up, and null at rest; a report
  // with a room holds the tooltip's show until the core's word and this document's frame at
  // the size it says (the handshake), one without lets any hold go.
  useEffect(() => {
    const el = pillRef.current
    if (!el) return
    reported.current = null
    const wanted = (): boolean => {
      if (!folded) return false
      if (hovering.current) return true
      const up = tooltipStore.get().target
      return up !== null && el.contains(up)
    }
    const release = (): void => {
      roomWait.current?.()
      roomWait.current = null
    }
    const report = (size: { width: number; height: number } | null): void => {
      const last = reported.current
      const width = size ? Math.ceil(size.width) : (last?.width ?? 0)
      const height = size ? Math.ceil(size.height) : (last?.height ?? 0)
      if (width <= 0 || height <= 0) return
      const room = wanted()
        ? tooltipRoom(
            el,
            actions.current.map((action) => action.title)
          )
        : null
      if (last && last.width === width && last.height === height && sameRoom(last.room, room))
        return
      reported.current = { width, height, room }
      const answer = cmd('selectionMenu.surfaceSize', {
        tabId: menu.tabId,
        width,
        height,
        folded,
        ...(folded ? { room } : {})
      })
      if (room) {
        roomWait.current = awaitTooltipRoom(answer)
        return
      }
      release()
      void answer.catch(() => undefined)
    }
    tell.current = () => report(null)
    report({ width: el.offsetWidth, height: el.offsetHeight })
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver((entries) => {
            const border = entries[0]?.borderBoxSize?.[0]
            report(
              border
                ? { width: border.inlineSize, height: border.blockSize }
                : { width: el.offsetWidth, height: el.offsetHeight }
            )
          })
    observer?.observe(el)
    return () => {
      observer?.disconnect()
      tell.current = () => undefined
      release()
    }
  }, [menu.tabId, chipKey, folded])

  // The tooltip's moment, for the folded row: the room is told as it comes and goes (see the
  // component's note). The pill's own listeners, not the host's: the host knows nothing of the
  // surface. Only a mouse pointer arms a tooltip (§9.31; the host's test). A pill moved to a
  // new box (`rectKey`) starts over – the pointer it stood under may be elsewhere now, and no
  // `pointerout` says so; one still on it comes by a glyph again.
  useEffect(() => {
    const el = pillRef.current
    if (!el || !folded) return
    const mouse = (e: PointerEvent): boolean => e.pointerType === 'mouse' || e.pointerType === ''
    const onOver = (e: PointerEvent): void => {
      if (hovering.current || !mouse(e) || !tooltipTargetOf(e.target)) return
      hovering.current = true
      tell.current()
    }
    const onOut = (e: PointerEvent): void => {
      if (!hovering.current || !mouse(e)) return
      if (e.relatedTarget instanceof Node && el.contains(e.relatedTarget)) return
      hovering.current = false
      tell.current()
    }
    const onDown = (): void => {
      if (!hovering.current) return
      hovering.current = false
      tell.current()
    }
    el.addEventListener('pointerover', onOver)
    el.addEventListener('pointerout', onOut)
    el.addEventListener('pointerdown', onDown)
    const unsubscribe = tooltipStore.subscribe(() => tell.current())
    return () => {
      el.removeEventListener('pointerover', onOver)
      el.removeEventListener('pointerout', onOut)
      el.removeEventListener('pointerdown', onDown)
      unsubscribe()
      if (!hovering.current) return
      hovering.current = false
      tell.current()
    }
  }, [menu.tabId, chipKey, folded, rectKey])

  useEscape(() => {
    tooltip.dismiss()
    run('selectionMenu.dismiss', { tabId: menu.tabId })
  })

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
              data-tooltip={action.title}
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

/**
 * The room the surface needs beyond the pill's padded box for the folded glyph buttons'
 * tooltips (`MiniMenuRoom`): `below`, so a tooltip the host places `TOOLTIP_GAP` under a button
 * ends `POPOVER_MARGIN` inside the document, and `width`, the widest title's tooltip
 * (`measureTooltipSize`: the chassis's own box for the text) with the margin each side. Read
 * off the layout, never a client rect (the pop animation's scale): the pill stands at the
 * surface's padding (its offset in the document, the same under it as over it), its glyph
 * buttons centred in its band (`.zen-mini-menu`'s `align-items`). Null when nothing is laid
 * out – a DOM without layout – so a report carries no room rather than a wrong one.
 */
function tooltipRoom(pill: HTMLElement, titles: readonly string[]): MiniMenuRoom | null {
  const button = pill.querySelector<HTMLElement>('[data-mini-menu-chip]')
  if (!button) return null
  const tip = measureTooltipSize(titles)
  if (tip.width <= 0 || tip.height <= 0) return null
  const pad = pill.offsetTop
  const bottom = pad + (pill.offsetHeight + button.offsetHeight) / 2
  const need = bottom + TOOLTIP_GAP + tip.height + POPOVER_MARGIN
  const box = pad + pill.offsetHeight + pad
  return {
    below: Math.max(0, Math.ceil(need - box)),
    width: Math.ceil(tip.width) + 2 * POPOVER_MARGIN
  }
}

function sameRoom(a: MiniMenuRoom | null, b: MiniMenuRoom | null): boolean {
  if (!a || !b) return a === b
  return a.below === b.below && a.width === b.width
}
