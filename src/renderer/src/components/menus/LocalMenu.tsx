import type { JSX } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import { useEscape } from '@renderer/hooks/useEscape'
import { useFloatingChrome } from '@renderer/hooks/useFloatingChrome'
import { useArrowKeys, usePopover } from '@renderer/hooks/usePopover'
import type { Anchor } from '@renderer/lib/anchor'
import { anchorBelow } from '@renderer/lib/extensions/popupPlacement'
import { useViewport } from '@renderer/lib/formFactor'
import { openedFromKeyboard } from '@renderer/lib/popover'
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
 * A menu the renderer owns (v2 draft §6 menus): on a mouse a bordered panel at radius 8 flush
 * under its control (6 for a context menu, §2; §9.20 for where it hangs) with 31 rows, a 16 icon
 * each when any has one, hairline separators and danger rows in the danger ink; on a finger the
 * same rows at 44 in a bottom sheet. Escape and an outside click (or a tap on the scrim) close
 * it; there is no scrim on the desktop (§9.5).
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
  return createPortal(
    viewport.coarse ? (
      <SheetMenu {...props} />
    ) : (
      <PopoverMenu {...props} fromKeyboard={fromKeyboard} />
    ),
    document.body
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
  const [pos, setPos] = useState<{ left: number; top: number; side: 'left' | 'right' } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // Layout size, not the client rect: the pop animation's first frame is scaled to .94, and
    // an end-aligned menu measured through it would land 6% of its width off.
    const placed = anchorBelow(
      anchor,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight }
    )
    setPos({ left: placed.x, top: placed.y, side: placed.side })
  }, [anchor, items.length])
  // Opened by pointer the menu itself takes focus, and the arrow keys start at the first item.
  usePopover(ref, {
    onClose,
    active: pos !== null,
    initial: fromKeyboard ? 'first' : 'container'
  })
  useArrowKeys(ref, '.zen-v2-menu-item')
  const withIcons = items.some((item) => !isSeparator(item) && item.icon)
  // The layer is the light dismiss (§9.20): a press outside the menu closes it on pointerdown
  // and goes no further, so the control under the press is not pressed.
  return (
    <div
      className="fixed inset-0 z-[90]"
      onPointerDown={(e) => {
        e.stopPropagation()
        onClose()
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div
        ref={ref}
        role="menu"
        tabIndex={-1}
        className="zen-v2 zen-v2-panel zen-v2-menu zen-animate-pop fixed select-none"
        data-surface="page"
        data-context={context || undefined}
        style={{
          left: pos?.left ?? anchor.x,
          top: pos?.top ?? anchor.y + anchor.height,
          visibility: pos ? 'visible' : 'hidden',
          transformOrigin: pos?.side === 'right' ? '100% 0' : '0 0'
        }}
        onPointerDown={(e) => e.stopPropagation()}
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
                <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                  {entry.icon && <entry.icon />}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {entry.hint && <span className="zen-v2-menu-hint">{entry.hint}</span>}
            </button>
          )
        )}
      </div>
    </div>
  )
}

function SheetMenu({ items, title, onClose }: Props): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  useEscape(() => sheet.current?.dismiss())
  const withIcons = items.some((item) => !isSeparator(item) && item.icon)
  return (
    <BottomSheet
      ref={sheet}
      className="zen-v2-sheet"
      onDismissed={onClose}
      handleLabel="Resize menu"
      header={
        title ? (
          <div className="zen-v2 zen-v2-sheet-title" data-surface="page">
            {title}
          </div>
        ) : undefined
      }
    >
      <div className="zen-v2 flex flex-col pb-2" data-surface="page">
        {items.map((entry) =>
          isSeparator(entry) ? (
            <div key={entry.id} className="zen-v2-sheet-separator" role="separator" />
          ) : (
            <button
              key={entry.id}
              type="button"
              disabled={entry.disabled}
              className="zen-v2-sheet-row"
              data-danger={entry.danger || undefined}
              onClick={() => sheet.current?.dismiss(() => entry.onSelect())}
            >
              {withIcons && (
                <span className="flex h-5 w-5 shrink-0 items-center justify-center">
                  {entry.icon && <entry.icon />}
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
