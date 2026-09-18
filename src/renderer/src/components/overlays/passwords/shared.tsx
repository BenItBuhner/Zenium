import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  Ref,
  RefObject,
  TextareaHTMLAttributes
} from 'react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, CircleAlert, Search } from 'lucide-react'
import type { Rect } from '@shared/types'
import { useBackSurface } from '@renderer/lib/back'
import {
  ChromePortal,
  FrameDialogPortal,
  POPOVER_WIDTH,
  placePopover,
  popoverStyle,
  toRect,
  useAnchorRect,
  useFrameDialog,
  useLightDismiss,
  viewportSize,
  type PopoverExtent
} from '@renderer/lib/portals'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../../sheet/BottomSheet'
import { focusBack, useEscape, useFocusReach, useOverPage, usePhone } from './lib'

/**
 * The password manager's controls in the v2 vocabulary (`.zen-v2-pw-*` in passwords.css): Firefox
 * Proton buttons, fields, menulists, checkboxes and radios on the neutral page surface, rows that
 * grow with their text, status as ink. Sizes come from the `--v2-*` density tokens, which the
 * root sets per form factor, so no component here asks what it is running on.
 */

type Variant = 'primary' | 'secondary' | 'danger'

/**
 * 32 × radius 4 at 15/500. Primary = accent fill (one per view); secondary = text at 10 %; danger =
 * the danger ink. Disabled is the whole control at .4 (§9.30). `busy` is not disabled: the button
 * keeps its opacity and its width, its label gives way to a 16 px spinner, it is `aria-busy`, and
 * a press does nothing until the work is done.
 */
export function Btn({
  variant = 'secondary',
  busy = false,
  className,
  type = 'button',
  onClick,
  children,
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant
  busy?: boolean
  ref?: Ref<HTMLButtonElement>
}): JSX.Element {
  return (
    <button
      ref={ref}
      type={busy ? 'button' : type}
      data-variant={variant}
      aria-busy={busy || undefined}
      className={cn('zen-v2-pw-btn', className)}
      onClick={busy ? undefined : onClick}
      {...rest}
    >
      <span className="zen-v2-pw-btn-label">{children}</span>
      {busy && <span className="zen-v2-pw-spinner" aria-hidden />}
    </button>
  )
}

/** Icon-only button: a 28 box with a 16 glyph on the desktop, 44 with 20 on a phone. */
export function IconBtn({
  label,
  active = false,
  className,
  type = 'button',
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  active?: boolean
  ref?: Ref<HTMLButtonElement>
}): JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      data-active={active || undefined}
      className={cn('zen-v2-pw-icon-btn', className)}
      {...rest}
    />
  )
}

export function TextField({
  className,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }): JSX.Element {
  return <input ref={ref} className={cn('zen-v2-pw-field', className)} {...rest} />
}

/** A search field: the glyph inside the field's leading padding, in the deemphasised ink. */
export function SearchField({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <div className={cn('relative', className)}>
      <Search
        aria-hidden
        className="zen-v2-pw-deemphasized pointer-events-none absolute left-3 top-1/2 size-[var(--v2-icon)] -translate-y-1/2"
      />
      <input type="search" data-leading="true" className="zen-v2-pw-field" {...rest} />
    </div>
  )
}

export function TextArea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea className={cn('zen-v2-pw-field', className)} {...rest} />
}

interface MenulistOption<T extends string> {
  value: T
  label: string
}

/**
 * A rectangular menulist: the trigger is a field with a chevron. On the desktop the list is a
 * popover in the chrome layer (`ChromePortal`, lib/portals.tsx) placed by `placePopover` (§9.20):
 * flush under the trigger, its start edge on the trigger's – or its end edge, when the trigger
 * sits in the trailing half of its row – kept 8 px inside the window, 320 wide (a list without
 * trailing controls, never fitted to its options or the window), at most 60 % of the window tall
 * before it scrolls. The layer's light dismiss closes it (§9.20 amended: a press anywhere outside
 * is consumed, the trigger's own press closes without reopening, a scroll, a resize or another
 * popover opening closes it too). On a phone it is never a popover (§9.13): the list is a picker
 * sheet on the shared `BottomSheet` in the frame's dialog host – 44 px rows with a radio glyph on
 * the current option, picking one closes it – the top of a depth-two stack over the manager's
 * page (§9.24), which recedes and goes inert under the sheet's own scrim. Either way the open
 * list is the topmost surface and takes the keyboard (§9.22): focus lands on the current option,
 * arrows move, Enter or Space picks, Escape and the system back close it and hand focus back to
 * the trigger, and nothing under it hears the key.
 */
export function Menulist<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  fill,
  title,
  className
}: {
  value: T
  options: Array<MenulistOption<T>>
  onChange: (value: T) => void
  /** Name for assistive tech (a row label is not associated with the control); a sheet's title. */
  label: string
  disabled?: boolean
  /** Take the row's whole width (a stacked phone row). */
  fill?: boolean
  /** The phone header's category picker: the title itself is the menulist (§6). */
  title?: boolean
  className?: string
}): JSX.Element {
  const phone = usePhone()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const listId = useId()
  // One surface name per instance: with a shared name, the first menulist on the view would
  // claim Escape for a menu that is not its own and the open one would stay open.
  const surface = `passwords-menu-${listId}`
  const close = (): void => setOpen(false)
  /** Closed by a key or a gesture: the trigger takes the focus back (§9.22). */
  const closeToTrigger = (): void => {
    setOpen(false)
    focusBack(trigger.current)
  }
  const current = options.find((o) => o.value === value)
  // A pick applies at once; how the list then leaves is the list's own – the popover is gone on
  // the spot, the sheet plays its leave first (§9.24) – and either hands the focus back after.
  const list = { id: listId, label, surface, options, value, onPick: onChange }
  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup={phone ? 'dialog' : 'listbox'}
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        data-state={open ? 'open' : 'closed'}
        data-fill={fill || undefined}
        data-title={title || undefined}
        disabled={disabled}
        className={cn('zen-v2-pw-menulist', className)}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          e.preventDefault()
          setOpen(true)
        }}
      >
        <span>{current?.label ?? ''}</span>
        <ChevronDown aria-hidden />
      </button>
      {open &&
        (phone ? (
          <MenulistSheet {...list} onClose={closeToTrigger} />
        ) : (
          <MenulistPopover {...list} anchor={trigger} onClose={closeToTrigger} onDismiss={close} />
        ))}
    </>
  )
}

interface OpenList<T extends string> {
  id: string
  label: string
  /** The back-registry name of this list while it is open. */
  surface: string
  options: Array<MenulistOption<T>>
  value: T
  /** Apply a pick; the list closes itself after and hands the focus back through `onClose`. */
  onPick: (value: T) => void
}

/** The open desktop list: a listbox in the chrome layer, one option focused, hanging under its trigger. */
function MenulistPopover<T extends string>({
  id,
  label,
  surface,
  anchor,
  options,
  value,
  onPick,
  onClose,
  onDismiss
}: OpenList<T> & {
  anchor: RefObject<HTMLButtonElement | null>
  /** Closed by Escape or the system back: the trigger takes the focus back. */
  onClose: () => void
  /** Closed by the light dismiss: focus stays where the press landed. */
  onDismiss: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const items = useRef<Array<HTMLDivElement | null>>([])
  const anchorRect = useAnchorRect(anchor)
  // A menulist's list sizes to its rows (§9.20): its height is measured once, laid out but not
  // yet shown, so `placePopover` keeps a list that fits below the trigger there.
  const [height, setHeight] = useState<number | null>(null)
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.value === value)
    )
  )
  useBackSurface({ name: surface, onCommit: onClose })
  useEscape(surface, onClose)
  useLayoutEffect(() => {
    if (height === null && ref.current) setHeight(ref.current.offsetHeight)
  }, [height])
  // The fixed 320 of §9.20: a list without trailing controls, never fitted.
  const width: PopoverExtent = POPOVER_WIDTH.list
  const box =
    anchorRect && height !== null
      ? placePopover(
          anchorRect,
          menulistBar(anchor.current, anchorRect),
          viewportSize(),
          width,
          height
        )
      : null
  const placed = box !== null
  // The keyboard lands on the current option once the list shows (§9.22), then follows `active`.
  useLayoutEffect(() => {
    if (placed) items.current[active]?.focus({ preventScroll: true })
  }, [active, placed])
  useLightDismiss(
    ref,
    () => {
      // Whatever closed it, focus does not fall to the body: the trigger takes it back when the
      // list held it (an outside press was consumed and moved nothing; a scroll moves nothing).
      const held = ref.current?.contains(document.activeElement) ?? false
      onDismiss()
      if (held) anchor.current?.focus({ preventScroll: true })
    },
    { anchor }
  )
  const move = (index: number): void => {
    const next = (index + options.length) % options.length
    setActive(next)
  }
  /** A pick applies and closes the list; the trigger takes the focus back. */
  const pick = (next: T): void => {
    onPick(next)
    onClose()
  }
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (e.key) {
      case 'ArrowDown':
        move(active + 1)
        break
      case 'ArrowUp':
        move(active - 1)
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(options.length - 1)
        break
      case 'Enter':
      case ' ': {
        const option = options[active]
        if (option) pick(option.value)
        break
      }
      case 'Tab':
        // The list is the topmost surface: Tab stays inside it (§9.22).
        move(active + (e.shiftKey ? -1 : 1))
        break
      default:
        return
    }
    e.preventDefault()
  }
  return (
    <ChromePortal>
      <div
        ref={ref}
        id={id}
        role="listbox"
        aria-label={label}
        tabIndex={-1}
        className="zen-v2-pw-menu zen-animate-pop fixed"
        data-side={box?.side}
        // Until its rows and the anchor have been measured it is laid out but not shown.
        style={box ? popoverStyle(box) : { visibility: 'hidden', width }}
        onKeyDown={onKeyDown}
      >
        {options.map((o, i) => (
          <div
            key={o.value}
            ref={(el) => {
              items.current[i] = el
            }}
            role="option"
            aria-selected={o.value === value}
            tabIndex={-1}
            data-highlighted={i === active || undefined}
            className="zen-v2-pw-menu-item"
            onPointerMove={() => i !== active && setActive(i)}
            onClick={() => pick(o.value)}
          >
            <span>{o.value === value && <Check className="size-4" strokeWidth={2} />}</span>
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
          </div>
        ))}
      </div>
    </ChromePortal>
  )
}

/**
 * The open phone list (§9.13): a picker sheet on the shared `BottomSheet` chassis (main.css
 * `.zen-sheet`, `.zen-sheet-item`), mounted in the frame's dialog host through `FrameDialogPortal`
 * (lib/portals.tsx) – over the manager's page, outside the overlay's stacking context – with the
 * §9.16 48 header naming it under the grabber and 44 px rows edge to edge at the 16 gutter
 * (§9.25), the current option marked by the radio glyph. It draws the stack's one scrim itself
 * (`ownScrim`, §9.24, §9.28) and holds the page under it inert (`useOverPage`); one spring moves
 * the sheet, the scrim and the page's recede together, and a drag, a fling, the scrim, Escape or
 * the back gesture close it and nothing else. A pick applies at once and lets the sheet leave.
 */
function MenulistSheet<T extends string>(
  props: OpenList<T> & {
    /** The sheet has left the screen, whichever way: the trigger takes the focus back. */
    onClose: () => void
  }
): JSX.Element {
  // The sheet registers with the host it renders in (`useFrameDialog` reads the portal's
  // context), so the host takes the pointer for it and the manager's overlay under it does not.
  return (
    <FrameDialogPortal>
      <PickerSheet {...props} />
    </FrameDialogPortal>
  )
}

function PickerSheet<T extends string>({
  id,
  label,
  surface,
  options,
  value,
  onPick,
  onClose
}: OpenList<T> & { onClose: () => void }): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const rows = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const dismiss = (): void => sheet.current?.dismiss()
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useOverPage()
  useBackSurface({
    name: surface,
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(surface, dismiss)
  // Focus lands on the current option as the sheet opens (§9.22); Tab then stays inside it.
  useLayoutEffect(() => {
    rows.current
      ?.querySelector<HTMLElement>('[aria-checked="true"]')
      ?.focus({ preventScroll: true })
  }, [])
  useFocusReach(rows)
  return (
    <div className="zen-v2-pw zen-v2-pw-sheet-layer absolute inset-0" data-surface="page">
      <BottomSheet
        ref={sheet}
        hosted
        labelledBy={titleId}
        className="zen-v2-pw-sheet"
        handleLabel="Dismiss"
        header={
          <h2 id={titleId} className="zen-sheet-title">
            {label}
          </h2>
        }
        onDismissed={onClose}
      >
        <div
          ref={rows}
          id={id}
          role="radiogroup"
          aria-labelledby={titleId}
          className="zen-v2-pw-sheet-rows"
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={o.value === value}
              className="zen-sheet-item"
              onClick={() => {
                onPick(o.value)
                dismiss()
              }}
            >
              <span className="zen-v2-pw-radio" data-checked={o.value === value} aria-hidden />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
            </button>
          ))}
        </div>
      </BottomSheet>
    </div>
  )
}

/**
 * The bar a menulist hangs from, for `placePopover`: horizontally the row or header it sits in
 * – its end edge aligns when the trigger is in that row's trailing half (§9.20) – and vertically
 * the trigger itself, so the list is flush under the control at gap 0, not under the row's padding.
 */
function menulistBar(trigger: HTMLElement | null, anchor: Rect): Rect {
  const row = trigger?.closest('.zen-v2-pw-row, .zen-v2-pw-header-row') ?? trigger?.parentElement
  if (!row) return anchor
  const r = toRect(row.getBoundingClientRect())
  return { x: r.x, width: r.width, y: anchor.y, height: anchor.height }
}

/** The Proton checkbox glyph: a 16 square (20 on a phone) at radius 2, accent when checked. */
function CheckBox({ checked }: { checked: boolean }): JSX.Element {
  return (
    <span className="zen-v2-pw-check" data-checked={checked} aria-hidden>
      <Check />
    </span>
  )
}

/**
 * A checkbox row: the whole row is the control; the box sits on the first text line with the
 * label to its right and the description under the label, as Firefox lays out its checkboxes.
 */
export function CheckRow({
  checked,
  onChange,
  label,
  description,
  disabled,
  className
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  className?: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      disabled={disabled}
      className={cn('zen-v2-pw-row w-full text-left', className)}
      data-lead="true"
      onClick={() => onChange(!checked)}
    >
      <CheckBox checked={checked} />
      <span className="zen-v2-pw-row-text">
        <span className="zen-v2-pw-row-label block">{label}</span>
        {description && (
          <span className="zen-v2-pw-row-description" data-clamp="false">
            {description}
          </span>
        )}
      </span>
    </button>
  )
}

/** A radio row inside a `role="radiogroup"`: the ring on the first line, the label beside it. */
export function RadioRow({
  checked,
  onSelect,
  label,
  description,
  className
}: {
  checked: boolean
  onSelect: () => void
  label: ReactNode
  description?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={cn('zen-v2-pw-row w-full text-left', className)}
      data-lead="true"
      onClick={onSelect}
    >
      <span className="zen-v2-pw-radio" data-checked={checked} aria-hidden />
      <span className="zen-v2-pw-row-text">
        <span className="zen-v2-pw-row-label block">{label}</span>
        {description && (
          <span className="zen-v2-pw-row-description" data-clamp="false">
            {description}
          </span>
        )}
      </span>
    </button>
  )
}

/**
 * A settings row: label and description to the left, the control to the right. `stack` drops the
 * control under the text (a phone with a wide menulist or a pair of buttons).
 */
export function SettingRow({
  label,
  description,
  stack = false,
  clamp = true,
  children,
  className
}: {
  label: ReactNode
  description?: ReactNode
  stack?: boolean
  /** Descriptions clamp at two lines unless the row is the explanation itself. */
  clamp?: boolean
  children?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('zen-v2-pw-row', className)} data-stack={stack || undefined}>
      <div className="zen-v2-pw-row-text">
        <div className="zen-v2-pw-row-label">{label}</div>
        {description && (
          <div className="zen-v2-pw-row-description" data-clamp={clamp ? undefined : 'false'}>
            {description}
          </div>
        )}
      </div>
      {children && <div className="zen-v2-pw-row-control">{children}</div>}
    </div>
  )
}

/** A list row on the surface: a fill on hover or press, the accent bar when it is the open one. */
export function ListRow({
  selected = false,
  className,
  children,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected?: boolean }): JSX.Element {
  if (!onClick) {
    return (
      <div className={cn('zen-v2-pw-list-row', className)} aria-current={selected || undefined}>
        {children}
      </div>
    )
  }
  return (
    <button
      type="button"
      className={cn('zen-v2-pw-list-row', className)}
      aria-current={selected || undefined}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  )
}

/** A page or pane title: 22/600. */
export function Title({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return <h2 className={cn('zen-v2-pw-title min-w-0 truncate', className)}>{children}</h2>
}

/**
 * A title block (§9.23): what heads a desktop dialog or popover instead of a bar – no control and
 * no X, since Escape, a click outside and the footer close it. Padding 16, an optional 16 px
 * glyph 8 px before the 17/600 title, an optional description 4 px under it, 16 px to the body;
 * 54 tall on its own, 78 with a one-line description. `id` and `descriptionId` are for the
 * dialog's `aria-labelledby` and `aria-describedby`.
 */
export function TitleBlock({
  id,
  glyph,
  description,
  descriptionId,
  children,
  className
}: {
  id: string
  glyph?: ReactNode
  description?: ReactNode
  descriptionId?: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('zen-v2-pw-title-block shrink-0', className)}>
      <div className="flex items-center gap-2">
        {glyph}
        <h3 id={id} className="zen-v2-pw-block-title min-w-0 flex-1">
          {children}
        </h3>
      </div>
      {description && (
        <p id={descriptionId} className="zen-v2-pw-description">
          {description}
        </p>
      )}
    </div>
  )
}

/** A sub-heading over a group of rows: 15/600, sentence case, an optional count trailing. */
export function Heading({
  children,
  trailing,
  description,
  className
}: {
  children: ReactNode
  trailing?: ReactNode
  /** The group's description, 15 at 69 %, 4 px under the heading (§9.27). */
  description?: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('zen-v2-pw-heading-block flex flex-col', className)}>
      <h3 className="zen-v2-pw-heading flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {trailing}
      </h3>
      {description && <Description>{description}</Description>}
    </div>
  )
}

/** Deemphasised copy: the body size on its own, 13/18 inside a row, a meta block or a field label. */
export function Description({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return <p className={cn('zen-v2-pw-description', className)}>{children}</p>
}

/** A secret string: the platform monospace at the row-value size, no ligatures, one colour. */
export function Secret({ value, className }: { value: string; className?: string }): JSX.Element {
  return <span className={cn('zen-v2-pw-secret', className)}>{value}</span>
}

/** The site's favicon when history knows one, otherwise its initial on a text-alpha tile. */
export function SiteIcon({
  domain,
  favicon,
  size,
  className
}: {
  domain: string
  favicon: string | null
  size?: 'hero'
  className?: string
}): JSX.Element {
  const letter = (domain.replace(/^www\./, '')[0] ?? '?').toUpperCase()
  return (
    <span className={cn('zen-v2-pw-site', className)} data-size={size} aria-hidden>
      {favicon ? <img src={favicon} alt="" referrerPolicy="no-referrer" /> : letter}
    </span>
  )
}

export type Tone = 'accent' | 'ok' | 'warn' | 'danger' | 'muted'

/** A status glyph in its ink – never on a filled surface. `hero` is the 40 px empty-state glyph. */
export function StatusGlyph({
  tone,
  hero = false,
  children,
  className
}: {
  tone: Tone
  hero?: boolean
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <span
      className={cn('zen-v2-pw-status', className)}
      data-tone={tone}
      data-size={hero ? 'hero' : undefined}
      aria-hidden
    >
      {children}
    </span>
  )
}

/** An error under a control: glyph plus text in the danger ink, never bare red text. */
export function ErrorNote({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <p role="alert" className={cn('zen-v2-pw-error', className)}>
      <CircleAlert />
      <span>{children}</span>
    </p>
  )
}

/** A count in a pill – the pill's one use. */
export function Badge({
  children,
  tone,
  className
}: {
  children: ReactNode
  tone?: 'danger'
  className?: string
}): JSX.Element {
  return (
    <span className={cn('zen-v2-pw-badge', className)} data-tone={tone}>
      {children}
    </span>
  )
}

/** A form field: a sentence-case caption over the control. */
export function Field({
  label,
  htmlFor,
  children,
  className
}: {
  label: string
  htmlFor: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="zen-v2-pw-description">
        {label}
      </label>
      {children}
    </div>
  )
}

/** A determinate progress bar; the bar moves on `transform`, never `width`. */
export function Progress({
  value,
  max,
  className
}: {
  value: number
  max: number
  className?: string
}): JSX.Element {
  const share = max > 0 ? value / max : 0
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      className={cn('zen-v2-pw-progress', className)}
    >
      <div style={{ transform: `scaleX(${Math.max(0.03, Math.min(1, share))})` }} />
    </div>
  )
}
