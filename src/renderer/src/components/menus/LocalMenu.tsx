import type { JSX } from 'react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import { useEscape } from '@renderer/hooks/useEscape'
import { useFloatingChrome } from '@renderer/hooks/useFloatingChrome'
import { useArrowKeys, usePopover } from '@renderer/hooks/usePopover'
import { placeUnder, popOrigin, type Anchor } from '@renderer/lib/anchor'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { openedFromKeyboard } from '@renderer/lib/popover'
import {
  ChromePortal,
  intrinsicSize,
  popoverStyle,
  useLightDismiss,
  type PopoverBox
} from '@renderer/lib/portals'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

export interface LocalMenuItem {
  id: string
  /** Title Case, as Zen's menu items are (v2 draft §9.1). */
  label: string
  icon?: LucideIcon
  danger?: boolean
  disabled?: boolean
  /** Keyboard hint at the right (desktop only). */
  hint?: string
  onSelect: () => void
}

export interface LocalMenuSeparator {
  id: string
  type: 'separator'
}

export type LocalMenuEntry = LocalMenuItem | LocalMenuSeparator

interface Props {
  /** The control that opened the menu, in window coordinates, with the bar it sits in. */
  anchor: Anchor
  items: LocalMenuEntry[]
  onClose: () => void
  /** Title of the phone sheet (the thing the menu is about). */
  title?: string
  /** Opened by a right-click rather than from a `···`: a context menu, radius 6 (v2 draft §2). */
  context?: boolean
}

function isSeparator(entry: LocalMenuEntry): entry is LocalMenuSeparator {
  return 'type' in entry && entry.type === 'separator'
}

/**
 * A menu the renderer owns (v2 draft §6 menus, the shared `.zen-v2-menu`): on a mouse a
 * bordered panel at radius 8 flush under its control (6 for a context menu, §2; §9.20 for where
 * it hangs, through the chrome layer, at its own width and height – §5's 232–332, as tall as
 * its rows) with 6 of padding, 31 rows at the 14 px chrome menu size (§4), a 16 glyph slot when
 * any row has an icon, the accelerator at the trailing edge in the deemphasised ink, hairline
 * separators 4 above and below and danger rows in the danger ink; on a finger the same rows at
 * 44 in a bottom sheet. A tablet takes the popover too (v2 §9.36: its menus anchor to their
 * control, a sheet at the foot of the window being a reach away from it), in the vocabulary's
 * tablet pose – 332 wide, the rows at the tablet root's 44 with the 20 glyph slot. Escape closes
 * it, and on the desktop and the tablet the chrome layer's light dismiss (§9.20 amended: a press
 * outside it, consumed; its control's own press; a scroll, a resize, another popover) – there is
 * no scrim there (§9.5); the sheet's own scrim takes the tap on a phone.
 *
 * The page's view composites above the chrome, so while the menu is up the content frame shows
 * the page's capture instead (`useFloatingChrome`), as it does for the main-process menus.
 */
export function LocalMenu(props: Props): JSX.Element | null {
  const viewport = useViewport()
  // Opened from the keyboard (the control shows its focus ring): the first item takes focus
  // rather than the menu, and the page, which did not have focus, does not get it back (§9.22).
  const [fromKeyboard] = useState(openedFromKeyboard)
  const ready = useFloatingChrome({ pageHadFocus: !fromKeyboard })
  if (!ready) return null
  // A sheet is the phone's dialog, not a popover: it stays on the body with the other sheets,
  // whose §9.24 stack is their mount order there.
  if (viewport.formFactor === 'phone') return createPortal(<SheetMenu {...props} />, document.body)
  return (
    <ChromePortal>
      <PopoverMenu {...props} fromKeyboard={fromKeyboard} />
    </ChromePortal>
  )
}

function PopoverMenu({
  anchor,
  items,
  onClose,
  context,
  fromKeyboard
}: Props & { fromKeyboard: boolean }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<PopoverBox | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // A menu keeps its intrinsic width and is as tall as its rows (§5, §9.20's exemption):
    // measured as the used size, not the client rect – the pop animation's first frame is
    // scaled to .94, and an end-aligned menu measured through it would land 6% of its width off
    // – kept to the fraction of a pixel the longest row runs to, so that row ends in no ellipsis.
    // It is exempt from the 60% cap too (§6 "Menus"): it takes the room down to the window's
    // 8 px bottom margin and scrolls only past that.
    const size = intrinsicSize(el)
    setBox(
      placeUnder(anchor, { measured: size.width }, size.height, undefined, undefined, {
        capHeight: false
      })
    )
  }, [anchor, items.length])
  // Opened by pointer the menu itself takes focus, and the arrow keys start at the first item; a
  // letter goes to (or runs) the item it names, as in Chrome's menus (a11y-08).
  usePopover(ref, {
    onClose,
    active: box !== null,
    initial: fromKeyboard ? 'first' : 'container'
  })
  useArrowKeys(ref, '.zen-v2-menu-item', { mnemonics: true })
  useLightDismiss(ref, onClose, { anchor: () => anchor.element ?? null })
  const withIcons = items.some((item) => !isSeparator(item) && item.icon)
  return (
    <div
      ref={ref}
      role="menu"
      tabIndex={-1}
      className="zen-v2 zen-v2-panel zen-v2-menu zen-animate-pop fixed select-none"
      data-context={context || undefined}
      style={{
        ...(box ? popoverStyle(box) : { left: anchor.x, top: anchor.y + anchor.height }),
        visibility: box ? 'visible' : 'hidden',
        transformOrigin: box ? popOrigin(anchor, box) : undefined
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((entry) =>
        isSeparator(entry) ? (
          <div key={entry.id} className="zen-v2-menu-separator" role="separator" />
        ) : (
          <button
            key={entry.id}
            type="button"
            role="menuitem"
            className="zen-v2-menu-item"
            data-danger={entry.danger || undefined}
            disabled={entry.disabled}
            onClick={() => {
              onClose()
              entry.onSelect()
            }}
          >
            {withIcons && (
              <span className="zen-v2-menu-glyph" aria-hidden>
                {entry.icon && <entry.icon />}
              </span>
            )}
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {entry.hint && (
              <span className="zen-v2-menu-hint" aria-hidden>
                {entry.hint}
              </span>
            )}
          </button>
        )
      )}
    </div>
  )
}

function SheetMenu({ items, title, onClose }: Props): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  useEscape(() => sheet.current?.dismiss())
  // The phone's sheets register a back surface of their own (`handleSystemBack`): the system
  // back – and the predictive gesture's pull – goes to the sheet, not past it to the page.
  useBackSurface({
    name: 'local-menu',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  const withIcons = items.some((item) => !isSeparator(item) && item.icon)
  return (
    <BottomSheet
      ref={sheet}
      onDismissed={onClose}
      handleLabel="Resize menu"
      // The dialog is named by its title row; a menu with no title is "Menu" to the tree.
      labelledBy={title ? titleId : undefined}
      label={title ? undefined : 'Menu'}
      header={
        title ? (
          <h2 id={titleId} className="zen-sheet-title">
            {title}
          </h2>
        ) : undefined
      }
    >
      <div className="zen-v2 flex flex-col pb-2">
        {items.map((entry) =>
          isSeparator(entry) ? (
            <div key={entry.id} className="zen-sheet-sep" role="separator" />
          ) : (
            <button
              key={entry.id}
              type="button"
              disabled={entry.disabled}
              className="zen-sheet-item"
              data-danger={entry.danger || undefined}
              onClick={() => sheet.current?.dismiss(() => entry.onSelect())}
            >
              {withIcons && (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center" aria-hidden>
                  {entry.icon && <entry.icon className="h-5 w-5" />}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            </button>
          )
        )}
      </div>
    </BottomSheet>
  )
}
