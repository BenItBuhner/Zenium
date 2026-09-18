import type { JSX } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown } from 'lucide-react'
import { useEscape } from '@renderer/hooks/useEscape'
import { useFloatingChrome } from '@renderer/hooks/useFloatingChrome'
import { useArrowKeys, usePopover } from '@renderer/hooks/usePopover'
import { anchorOf, placeUnder, popOrigin, type Anchor } from '@renderer/lib/anchor'
import { useViewport } from '@renderer/lib/formFactor'
import { openedFromKeyboard } from '@renderer/lib/popover'
import { ChromePortal, popoverStyle, useLightDismiss, type PopoverBox } from '@renderer/lib/portals'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { V2Radio } from './v2'

export interface MenulistOption<T extends string> {
  value: T
  label: string
}

interface PopupProps<T extends string> {
  anchor: Anchor
  label: string
  value: T
  options: readonly MenulistOption<T>[]
  onPick: (value: T) => void
  onClose: () => void
}

/**
 * A menulist (v2 draft §6, §9.13): the rectangular control, 32 tall (40 on a phone) with a 1px
 * border and a 16 chevron, whose popup is never the native `<select>`'s. On a mouse the options
 * are a `--v2-panel` popover under the control at radius 12 with 6 padding: 28 rows at radius 6,
 * the current one marked by a trailing 16 check. On a finger they are a bottom sheet of 44 rows
 * with a radio glyph (§9.14) on the current option. Picking one closes the popup. The popover
 * hangs flush under the control (§9.20, at its own width and height) and takes focus on its
 * current option; the arrow keys move it, Escape gives it back to the control (§9.22); the
 * chrome layer's light dismiss closes it otherwise (§9.20 amended) – the control's own press
 * included, which does not reopen it.
 */
export function V2Menulist<T extends string>({
  label,
  value,
  options,
  onChange,
  className
}: {
  /** What the list chooses (the accessible name of the control and the phone sheet's title). */
  label: string
  value: T
  options: readonly MenulistOption<T>[]
  onChange: (value: T) => void
  className?: string
}): JSX.Element {
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const viewport = useViewport()
  const current = options.find((option) => option.value === value)
  const popup: PopupProps<T> | null = anchor && {
    anchor,
    label,
    value,
    options,
    onPick: (next) => {
      setAnchor(null)
      if (next !== value) onChange(next)
    },
    onClose: () => setAnchor(null)
  }
  return (
    <>
      <button
        type="button"
        className={cn('zen-v2-menulist', className)}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={anchor !== null || undefined}
        onClick={(e) => setAnchor(anchorOf(e.currentTarget))}
      >
        <span className="min-w-0 flex-1 truncate">{current?.label ?? ''}</span>
        <ChevronDown />
      </button>
      {popup && (viewport.coarse ? <MenulistSheet {...popup} /> : <MenulistPopover {...popup} />)}
    </>
  )
}

function MenulistPopover<T extends string>({
  anchor,
  label,
  value,
  options,
  onPick,
  onClose
}: PopupProps<T>): JSX.Element | null {
  // Opened from the keyboard the page did not have focus and does not get it back (§9.22).
  const [fromKeyboard] = useState(openedFromKeyboard)
  const ready = useFloatingChrome({ pageHadFocus: !fromKeyboard })
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<PopoverBox | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // The list keeps its intrinsic width (no less than the control's) and is as tall as its
    // options, measured as layout size, not the client rect, which the pop animation's first
    // frame scales to .94.
    setBox(placeUnder(anchor, { measured: el.offsetWidth }, el.offsetHeight))
  }, [anchor, options.length, ready])
  usePopover(ref, {
    onClose,
    active: ready && box !== null,
    initial: (root) => root.querySelector<HTMLElement>('[aria-selected="true"]')
  })
  useArrowKeys(ref, '.zen-v2-menulist-option')
  useLightDismiss(ref, onClose, { anchor: () => anchor.element ?? null })
  if (!ready) return null
  return (
    <ChromePortal>
      <div
        ref={ref}
        role="listbox"
        aria-label={label}
        className="zen-v2 zen-v2-panel zen-v2-menulist-popup zen-animate-pop fixed select-none"
        style={{
          ...(box ? popoverStyle(box) : { left: anchor.x, top: anchor.y + anchor.height }),
          minWidth: anchor.width,
          visibility: box ? 'visible' : 'hidden',
          transformOrigin: box ? popOrigin(anchor, box) : undefined
        }}
      >
        {options.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={selected}
              className="zen-v2-menulist-option"
              onClick={() => onPick(option.value)}
            >
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
              {selected && <Check />}
            </button>
          )
        })}
      </div>
    </ChromePortal>
  )
}

function MenulistSheet<T extends string>({
  label,
  value,
  options,
  onPick,
  onClose
}: PopupProps<T>): JSX.Element | null {
  const ready = useFloatingChrome()
  const sheet = useRef<BottomSheetHandle>(null)
  useEscape(() => sheet.current?.dismiss())
  if (!ready) return null
  return createPortal(
    <BottomSheet
      ref={sheet}
      onDismissed={onClose}
      handleLabel="Resize"
      header={<span className="zen-sheet-title">{label}</span>}
    >
      <div className="zen-v2 flex flex-col pb-1" role="listbox" aria-label={label}>
        {options.map((option) => {
          const selected = option.value === value
          return (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={selected}
              className="zen-sheet-item"
              onClick={() => sheet.current?.dismiss(() => onPick(option.value))}
            >
              <V2Radio checked={selected} />
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            </button>
          )
        })}
      </div>
    </BottomSheet>,
    document.body
  )
}
