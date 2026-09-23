import type { JSX } from 'react'
import { useEffect, useId, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { useEscape } from '@renderer/hooks/useEscape'
import { useFloatingChrome } from '@renderer/hooks/useFloatingChrome'
import { anchorOf, type Anchor } from '@renderer/lib/anchor'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { FrameDialogPortal, useFrameDialog } from '@renderer/lib/portals'
import type { LanguageOption } from '@renderer/lib/translate'
import { cn } from '@renderer/lib/utils'
import { V2Radio } from '../extensions/v2'
import { MenulistPopover } from '../menus/MenulistPopover'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'

interface PopupProps {
  anchor: Anchor
  label: string
  value: string | null
  options: readonly LanguageOption[]
  onPick: (value: string) => void
  onClose: () => void
}

/**
 * The translate surfaces' menulist, on the shared `.zen-v2-menulist` (v2 draft §9.34, §9.13): a
 * bordered trigger with a chevron whose popup is never the platform's `<select>`. On a mouse the
 * options are the shared `MenulistPopover` (components/menus): a `--v2-panel` popover flush under
 * the bar or row the trigger sits in (§9.20, through the chrome layer: 28 rows at radius 6, the
 * current one marked with a trailing check, the chrome layer's placement and its height cap, the
 * §9.22 keyboard – the current option focused, arrows, Home, End, type-ahead, Escape back to the
 * trigger); on a phone they are a bottom sheet of 44 radio rows (§9.14) in the frame's dialog
 * host. Picking one closes either.
 *
 * What the extensions' `V2Menulist` does not carry, and the language lists need: nothing picked
 * yet (`value` null, the `placeholder` in deemphasised ink), a disabled trigger, and an option's
 * second line – a model's size – which the popover's row clamps to one line (§9.13: the anchor's
 * space is borrowed) and the sheet's row keeps to two (§9.2).
 */
export function Menulist({
  value,
  options,
  onChange,
  label,
  placeholder,
  disabled,
  className
}: {
  /** The picked value; null shows `placeholder`. */
  value: string | null
  options: readonly LanguageOption[]
  onChange: (value: string) => void
  /** Accessible name, and the title of the phone's sheet (the visible text is the value). */
  label: string
  placeholder?: string
  disabled?: boolean
  className?: string
}): JSX.Element {
  // A sheet on a phone, a popover everywhere else (§9.13) – a tablet's coarse pointer included,
  // whose dialogs would close the popover a menulist may sit in (the selection popover).
  const phone = useViewport().formFactor === 'phone'
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const current = options.find((o) => o.value === value) ?? null
  const popup: PopupProps | null = anchor && {
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
    <span className={cn('zen-translate-menulist', className)}>
      <button
        type="button"
        className="zen-v2-menulist"
        aria-label={label}
        aria-haspopup={phone ? 'dialog' : 'listbox'}
        aria-expanded={anchor !== null || undefined}
        disabled={disabled}
        data-placeholder={current ? undefined : true}
        onClick={(e) => setAnchor(anchorOf(e.currentTarget))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            setAnchor(anchorOf(e.currentTarget))
          }
        }}
      >
        <span className="min-w-0 flex-1 truncate">{current?.label ?? placeholder ?? ''}</span>
        <ChevronDown aria-hidden />
      </button>
      {popup && (phone ? <MenulistSheet {...popup} /> : <MenulistPopover {...popup} overPage />)}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Phone: a sheet of radio rows
// ---------------------------------------------------------------------------

/**
 * The phone's list: a modal dialog, so it mounts in the frame's dialog host (lib/portals.tsx,
 * `FrameDialogPortal`) on the shared `BottomSheet`, over whatever sheet holds the trigger (the
 * selection sheet: §9.24's depth two, the chassis receding the lower sheet under this one's
 * scrim). It waits for the page's capture before it rises (`useFloatingChrome`), as any surface
 * over the live page does; focus, Tab, the inert chrome and the return of focus to the trigger
 * are the chassis's (#172), Escape and the back gesture this sheet's own.
 */
function MenulistSheet(props: PopupProps): JSX.Element | null {
  const ready = useFloatingChrome()
  if (!ready) return null
  return (
    <FrameDialogPortal>
      <HostedMenulistSheet {...props} />
    </FrameDialogPortal>
  )
}

function HostedMenulistSheet({ label, value, options, onPick, onClose }: PopupProps): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const rows = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const dismiss = (): void => sheet.current?.dismiss()
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useBackSurface({
    name: 'translate-menulist',
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(dismiss)
  // The current option – the chassis's first focus (§9.22) – is in view when the sheet comes up.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      rows.current?.querySelector('[aria-checked="true"]')?.scrollIntoView({ block: 'center' })
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  return (
    <BottomSheet
      ref={sheet}
      hosted
      className="zen-translate-sheet"
      handleLabel="Resize list"
      labelledBy={titleId}
      onDismissed={onClose}
      header={
        <h2 id={titleId} className="zen-sheet-title">
          {label}
        </h2>
      }
    >
      {/*
        Radio rows (§9.13, §9.14) on the shared `.zen-v2-row` and `.zen-v2-radio` (§9.34): the
        row carries `aria-checked`, which draws the glyph inside the radio; an option's second
        line (a model's size) is a §9.2 description under its label.
      */}
      <div ref={rows} className="zen-v2 flex flex-col pb-2" role="radiogroup" aria-label={label}>
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
            <span className="zen-v2-row-text">
              <span className="zen-v2-label">{option.label}</span>
              {option.description && (
                <span className="zen-v2-description">{option.description}</span>
              )}
            </span>
          </button>
        ))}
      </div>
    </BottomSheet>
  )
}
