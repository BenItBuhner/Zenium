import type { JSX } from 'react'
import { useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown } from 'lucide-react'
import { useEscape } from '@renderer/hooks/useEscape'
import { useFloatingChrome } from '@renderer/hooks/useFloatingChrome'
import { anchorOf, type Anchor } from '@renderer/lib/anchor'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { cn } from '@renderer/lib/utils'
import { MenulistPopover, type MenulistOption } from '../menus/MenulistPopover'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import { V2Radio } from './v2'

export type { MenulistOption }

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
 * are the shared `MenulistPopover` (components/menus): a `--v2-panel` popover flush under the
 * control at radius 12 with 6 padding, 28 rows at radius 6, the current one marked by a trailing
 * 16 check, a row with a description 48 around its two lines, as wide as the control at least
 * and as its longest row at most, flipped above the control near the window's bottom, with the
 * §9.22 keyboard (the current option focused, arrows, Home, End, type-ahead, Escape back to the
 * control) and the chrome layer's light dismiss. On a finger they are a bottom sheet of 44 rows
 * (64 with a description, §9.2) with a radio glyph (§9.14) on the current option. Picking one
 * closes the popup. Down or Up on the control opens it, as a click does.
 */
export function V2Menulist<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  readOnly = false,
  autoFocus = false,
  className
}: {
  /** What the list chooses (the accessible name of the control and the phone sheet's title). */
  label: string
  value: T
  options: readonly MenulistOption<T>[]
  onChange: (value: T) => void
  /** The control at §9.30's .4 (`.zen-v2-menulist:disabled`), opening nothing. */
  disabled?: boolean
  /** A busy form's control (§9.30): full opacity, its value in place, opening nothing. */
  readOnly?: boolean
  /** Takes the keyboard as it mounts: a form's first field (§9.22). */
  autoFocus?: boolean
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
  const open = (el: HTMLElement): void => {
    if (!readOnly) setAnchor(anchorOf(el))
  }
  return (
    <>
      <button
        type="button"
        className={cn('zen-v2-menulist', className)}
        aria-label={label}
        aria-haspopup={viewport.coarse ? 'dialog' : 'listbox'}
        aria-expanded={anchor !== null || undefined}
        aria-readonly={readOnly || undefined}
        disabled={disabled}
        autoFocus={autoFocus}
        onClick={(e) => open(e.currentTarget)}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && anchor === null) {
            e.preventDefault()
            open(e.currentTarget)
          }
        }}
      >
        <span className="min-w-0 flex-1 truncate">{current?.label ?? ''}</span>
        <ChevronDown />
      </button>
      {popup &&
        (viewport.coarse ? <MenulistSheet {...popup} /> : <MenulistPopover {...popup} overPage />)}
    </>
  )
}

/**
 * The menulist's sheet on its own (§9.13 under a finger): a value row that opens its picker as a
 * sheet over the sheet it sits in (the site-information sheet's "Cookies for this site") renders
 * it while open, and takes `onClose` once the sheet has gone – after `onPick` when a pick closed it.
 */
export function V2MenulistSheet<T extends string>(
  props: Omit<PopupProps<T>, 'anchor'>
): JSX.Element | null {
  return <MenulistSheet {...props} />
}

function MenulistSheet<T extends string>({
  label,
  value,
  options,
  onPick,
  onClose
}: Omit<PopupProps<T>, 'anchor'>): JSX.Element | null {
  const ready = useFloatingChrome()
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  useEscape(() => sheet.current?.dismiss())
  // The system back gesture is the sheet's while it is up (§9.24: the top surface answers), the
  // predictive preview pulling it down as the finger goes – not the surface's under it.
  useBackSurface({
    name: 'menulist',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  if (!ready) return null
  return createPortal(
    <BottomSheet
      ref={sheet}
      onDismissed={onClose}
      handleLabel="Resize"
      labelledBy={titleId}
      header={
        <h2 id={titleId} className="zen-sheet-title">
          {label}
        </h2>
      }
    >
      {/*
        Radio rows (§9.13, §9.14), as the Settings sheets' (§9.34): each row is the shared
        `.zen-v2-row` – its `--v2-row-pad` is what seats the flex-start radio on the text line
        (§9.2) – and the radio itself, carrying `aria-checked`, which draws the glyph inside it;
        an option's second line is a §9.2 description under its label.
      */}
      <div className="zen-v2 flex flex-col pb-2" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={option.value === value}
            className="zen-v2-row"
            onClick={() => sheet.current?.dismiss(() => onPick(option.value))}
          >
            <V2Radio />
            {option.description ? (
              <span className="zen-v2-row-text">
                <span className="zen-v2-label">{option.label}</span>
                <span className="zen-v2-description">{option.description}</span>
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate">{option.label}</span>
            )}
          </button>
        ))}
      </div>
    </BottomSheet>,
    document.body
  )
}
