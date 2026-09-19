import type { CSSProperties, JSX, KeyboardEvent } from 'react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { useEscape } from '@renderer/hooks/useEscape'
import { useFloatingChrome } from '@renderer/hooks/useFloatingChrome'
import { useArrowKeys, usePopover } from '@renderer/hooks/usePopover'
import { anchorOf, placeUnder, popOrigin, type Anchor } from '@renderer/lib/anchor'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { openedFromKeyboard } from '@renderer/lib/popover'
import {
  ChromePortal,
  FrameDialogPortal,
  popoverStyle,
  useFrameDialog,
  useLightDismiss,
  type PopoverBox
} from '@renderer/lib/portals'
import type { LanguageOption } from '@renderer/lib/translate'
import { cn } from '@renderer/lib/utils'
import { V2Radio } from '../extensions/v2'
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
 * options are a `--v2-panel` popover flush under the bar or row the trigger sits in (§9.20, through
 * the chrome layer: 28 rows at radius 6, the current one marked with a trailing check, the
 * chrome layer's placement and its height cap); on a phone they are a bottom sheet of 44 radio
 * rows (§9.14) in the frame's dialog host. Picking one closes either.
 *
 * What the extensions' `V2Menulist` does not carry, and the language lists need: nothing picked
 * yet (`value` null, the `placeholder` in deemphasised ink), a disabled trigger, and an option's
 * second line – a model's size – which the popover's row clamps to one line (§9.13: the anchor's
 * space is borrowed) and the sheet's row keeps to two (§9.2). The popover takes focus on the
 * current option (§9.22); arrows, Home and End move it, a letter jumps to the next option that
 * starts with it, Enter picks, Escape hands focus back to the trigger; the chrome layer's light
 * dismiss closes it otherwise (§9.20 amended), the trigger's own press included.
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
      {popup && (phone ? <MenulistSheet {...popup} /> : <MenulistPopover {...popup} />)}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Desktop and tablet: a popover under the trigger's bar
// ---------------------------------------------------------------------------

function MenulistPopover({
  anchor,
  label,
  value,
  options,
  onPick,
  onClose
}: PopupProps): JSX.Element | null {
  // Opened from the keyboard the page did not have focus and does not get it back (§9.22).
  const [fromKeyboard] = useState(openedFromKeyboard)
  const ready = useFloatingChrome({ pageHadFocus: !fromKeyboard })
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState<PopoverBox | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    // The list keeps its intrinsic width (§5's 232–332, no less than the trigger's) and is as
    // tall as its options – measured as layout size, not the client rect, which the pop
    // animation's first frame scales to .94; the chrome layer caps the height (§9.20).
    setBox(placeUnder(anchor, { measured: el.offsetWidth }, el.offsetHeight))
  }, [anchor, options.length, ready])
  usePopover(ref, {
    onClose,
    active: ready && box !== null,
    initial: (root) => root.querySelector<HTMLElement>('[aria-selected="true"]')
  })
  useArrowKeys(ref, '.zen-v2-menulist-option')
  useLightDismiss(ref, onClose, { anchor: () => anchor.element ?? null })
  // The current option is in view when the list comes up.
  useEffect(() => {
    if (box)
      ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [box])

  // Type-ahead on a letter: the next option after the focused one that starts with it, wrapping.
  const typeAhead = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.key.length !== 1 || e.altKey || e.ctrlKey || e.metaKey || e.key === ' ') return
    const root = ref.current
    if (!root) return
    const items = [...root.querySelectorAll<HTMLElement>('.zen-v2-menulist-option')]
    const from = items.indexOf(document.activeElement as HTMLElement) + 1
    const letter = e.key.toLowerCase()
    const starts = (i: number): boolean =>
      (options[i]?.label ?? '').toLowerCase().startsWith(letter)
    let next = -1
    for (let i = from; i < items.length && next < 0; i++) if (starts(i)) next = i
    for (let i = 0; i < from && next < 0; i++) if (starts(i)) next = i
    if (next < 0) return
    e.preventDefault()
    items[next]?.focus()
  }

  if (!ready) return null
  return (
    <ChromePortal>
      <div
        ref={ref}
        role="listbox"
        aria-label={label}
        className="zen-v2 zen-v2-panel zen-v2-menulist-popup zen-animate-pop fixed select-none"
        style={
          {
            ...(box ? popoverStyle(box) : { left: anchor.x, top: anchor.y + anchor.height }),
            // The trigger's width, a floor under the list's own (main.css: never narrower than
            // the trigger, nor than §5's 232).
            '--zen-anchor-width': `${anchor.width}px`,
            visibility: box ? 'visible' : 'hidden',
            transformOrigin: box ? popOrigin(anchor, box) : undefined
          } as CSSProperties
        }
        onKeyDown={typeAhead}
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
              <span className="zen-v2-menulist-option-text">
                <span className="truncate">{option.label}</span>
                {option.description && (
                  <span className="zen-v2-menulist-option-description">{option.description}</span>
                )}
              </span>
              {selected && <Check aria-hidden />}
            </button>
          )
        })}
      </div>
    </ChromePortal>
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
      <div ref={rows} className="zen-v2 flex flex-col pb-1" role="radiogroup" aria-label={label}>
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
