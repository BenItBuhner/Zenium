import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  JSX,
  ReactNode,
  Ref,
  RefObject,
  TextareaHTMLAttributes
} from 'react'
import { useId, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { Check, ChevronDown, ChevronRight, CircleAlert, ExternalLink, Search } from 'lucide-react'
import type { Rect } from '@shared/types'
import { useEscape } from '@renderer/hooks/useEscape'
import { useArrowKeys, usePopover } from '@renderer/hooks/usePopover'
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
  viewportSize
} from '@renderer/lib/portals'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../../sheet/BottomSheet'
import { usePhone } from './lib'

/**
 * The password manager's controls: thin wrappers over the shared `zen-v2-*` primitives (design
 * language v2 draft §9.34 – `.zen-v2-button`, `.zen-v2-icon-button`, `.zen-v2-field`,
 * `.zen-v2-row`, `.zen-v2-checkbox`, `.zen-v2-radio`, `.zen-v2-switch`, `.zen-v2-menulist`,
 * `.zen-v2-heading`, `.zen-v2-badge`; the form field, the title block, the dialog and the
 * menulist popup of extensions.css; the sheet chassis of main.css). They add behaviour – roles,
 * `aria-*`, the busy state, the keyboard – and carry no styling of their own; what is this
 * surface's (the rows' bleed, the controls inside them, the site tile, the status glyph, the
 * secret) is a `zen-v2-pw-*` modifier in passwords.css. Sizes come from the `--v2-*` density
 * tokens, which the root sets per form factor, so nothing here asks what it is running on
 * except where the vocabulary itself differs (a phone's switch for the desktop's checkbox, §10.4).
 */

type Variant = 'primary' | 'secondary' | 'danger'

/**
 * main.css's `.zen-v2-button`: the secondary at the text's 10 %, `data-primary` for the one
 * accent button of a view, `data-danger` for a secondary in the danger ink. Disabled is the
 * whole control at .4 (§9.30). `busy` is not disabled: the button keeps its opacity and its
 * width, its label gives way to the 16 px spinner, it is `aria-busy`, and a press does nothing
 * until the work is done.
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
      data-primary={variant === 'primary' || undefined}
      data-danger={variant === 'danger' || undefined}
      aria-busy={busy || undefined}
      className={cn('zen-v2-button', className)}
      onClick={busy ? undefined : onClick}
      {...rest}
    >
      {busy ? (
        <>
          {/* Still the button's name and width; only its paint goes. */}
          <span className="zen-v2-button-label">{children}</span>
          <span className="zen-v2-spinner" aria-hidden />
        </>
      ) : (
        children
      )}
    </button>
  )
}

/**
 * main.css's `.zen-v2-icon-button` (§9.3): a 28 box with a 16 glyph on the desktop, 44 with 20
 * on a phone; the label is the tooltip too. `pressed` is a toggle that is on (Delete while its
 * confirmation shows, the generator while it is open): `aria-pressed`, the glyph in the accent.
 */
export function IconBtn({
  label,
  pressed,
  className,
  type = 'button',
  ref,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string
  pressed?: boolean
  ref?: Ref<HTMLButtonElement>
}): JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      aria-pressed={pressed}
      className={cn('zen-v2-icon-button', className)}
      {...rest}
    />
  )
}

/** main.css's `.zen-v2-field` (§9.12): the control height, a hairline, the page behind it. */
export function TextField({
  className,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }): JSX.Element {
  return <input ref={ref} className={cn('zen-v2-field', className)} {...rest} />
}

/** The field with a leading search glyph (`.zen-v2-field-lead`, extensions.css: 16 at 10 in, the text at 34). */
export function SearchField({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  return (
    <span className={cn('relative block min-w-0', className)}>
      <Search aria-hidden className="zen-v2-field-lead" />
      <input type="search" data-lead="" className="zen-v2-field" {...rest} />
    </span>
  )
}

/** The field grown to a text area (passwords.css: two control heights, resizable). */
export function TextArea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea className={cn('zen-v2-field', className)} {...rest} />
}

/** What a `Field` hands its control: the id its label points at and the message's wiring. */
export interface FieldAria {
  id: string
  'aria-describedby': string | undefined
  'aria-invalid': true | undefined
}

/**
 * A form field (§9.12, extensions.css's `.zen-v2-form-field`): the label above the control at
 * 15/400, tied to it with `<label for>` and 4 px away; under it a description at 13 in the
 * deemphasised ink or, while the value is wrong, the validation text at 13 in the danger ink
 * behind a 16 glyph, announced. Actions that belong to the field follow it on a desktop and
 * become a full-width row under the message on a phone (§9.11).
 */
export function Field({
  id,
  label,
  description,
  error,
  actions,
  className,
  children
}: {
  id: string
  label: string
  description?: string
  error?: string | null
  actions?: ReactNode
  className?: string
  children: (field: FieldAria) => ReactNode
}): JSX.Element {
  const message = error ?? description
  const messageId = message ? `${id}-message` : undefined
  return (
    <div className={cn('zen-v2-form-field', className)}>
      <label htmlFor={id} className="zen-v2-field-label">
        {label}
      </label>
      <div className="zen-v2-form-control">
        {children({ id, 'aria-describedby': messageId, 'aria-invalid': error ? true : undefined })}
      </div>
      {actions && <div className="zen-v2-form-actions">{actions}</div>}
      {message && (
        <p
          id={messageId}
          className="zen-v2-field-message"
          data-tone={error ? 'danger' : undefined}
          role={error ? 'alert' : undefined}
        >
          {error && <CircleAlert />}
          {message}
        </p>
      )}
    </div>
  )
}

/** A validation line on its own (§9.12), for what is not one field's: glyph plus text in the danger ink. */
export function ErrorNote({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <p role="alert" className={cn('zen-v2-field-message', className)} data-tone="danger">
      <CircleAlert />
      <span>{children}</span>
    </p>
  )
}

interface MenulistOption<T extends string> {
  value: T
  label: string
}

/**
 * The menulist (§6, §9.13): main.css's `.zen-v2-menulist` trigger, a field with a chevron. On the
 * desktop its list is a popover in the chrome layer (`ChromePortal`, lib/portals.tsx) placed by
 * `placePopover` (§9.20): flush under the trigger, its start edge on the trigger's – or its end
 * edge, when the trigger sits in the trailing half of its row – kept 8 px inside the window, 320
 * wide (a list without trailing controls, never fitted to its options or the window), at most
 * 60 % of the window tall before it scrolls. The layer's light dismiss closes it (a press
 * anywhere outside is consumed, the trigger's own press closes without reopening, a scroll, a
 * resize or another popover opening closes it too). On a phone it is never a popover: the list
 * is a picker sheet on the shared `BottomSheet` in the frame's dialog host – 44 px rows with a
 * radio glyph on the current option, picking one closes it – the top of a depth-two stack over
 * the manager's page (§9.24); a menulist whose row has a `description` makes it the sheet's
 * title block (§9.13). Either way the open list is the topmost surface and takes the keyboard
 * (§9.22): focus lands on the current option, arrows move, Enter or Space picks, Escape and the
 * system back close it and hand focus back to the trigger, and nothing under it hears the key
 * – the popover through `usePopover`, the sheet through its chassis. On a phone settings view
 * the trigger itself is not drawn (§10.4): `ChoiceRow` opens the same sheet from a value row.
 */
export function Menulist<T extends string>({
  value,
  options,
  onChange,
  label,
  description,
  disabled,
  title,
  className
}: {
  value: T
  options: Array<MenulistOption<T>>
  onChange: (value: T) => void
  /** Name for assistive tech (a row label is not associated with the control); a sheet's title. */
  label: string
  /** What the row explained beside the control: the picker sheet's description (§9.13). */
  description?: string
  disabled?: boolean
  /** The phone header's category picker: the title itself is the menulist (§6). */
  title?: boolean
  className?: string
}): JSX.Element {
  const phone = usePhone()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const listId = useId()
  // One surface name per instance: with a shared name, the first menulist on the view would
  // claim the back gesture for a list that is not its own.
  const surface = `passwords-menu-${listId}`
  const close = (): void => setOpen(false)
  const current = options.find((o) => o.value === value)
  const list = {
    id: listId,
    label,
    description,
    surface,
    options,
    value,
    onPick: onChange,
    onClose: close
  }
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
        disabled={disabled}
        className={cn(
          'zen-v2-menulist',
          title ? 'zen-v2-pw-menulist-title' : 'zen-v2-pw-menulist-inline',
          className
        )}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
          e.preventDefault()
          setOpen(true)
        }}
      >
        <span className="min-w-0 flex-1 truncate">{current?.label ?? ''}</span>
        <ChevronDown aria-hidden />
      </button>
      {open &&
        (phone ? <MenulistSheet {...list} /> : <MenulistPopover {...list} anchor={trigger} />)}
    </>
  )
}

interface OpenList<T extends string> {
  id: string
  label: string
  /** The sheet's title-block description (§9.13); the desktop popover has no place for it. */
  description?: string
  /** The back-registry name of this list while it is open. */
  surface: string
  options: Array<MenulistOption<T>>
  value: T
  /** Apply a pick; the list closes itself after. */
  onPick: (value: T) => void
  /** The list is gone (a pick, Escape, the back gesture, a dismiss); unmount it. */
  onClose: () => void
}

/**
 * The open desktop list: a listbox in the chrome layer on the shared panel and popup classes
 * (`.zen-v2-panel`, `.zen-v2-menulist-popup`, `.zen-v2-menulist-option` in extensions.css),
 * hanging under its trigger. The keyboard is `usePopover`'s (focus on the current option, Tab
 * wraps, Escape closes and returns focus to the trigger) and `useArrowKeys`'.
 */
function MenulistPopover<T extends string>({
  id,
  label,
  surface,
  anchor,
  options,
  value,
  onPick,
  onClose
}: OpenList<T> & { anchor: RefObject<HTMLButtonElement | null> }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const anchorRect = useAnchorRect(anchor)
  // A menulist's list sizes to its rows (§9.20): its height is measured once, laid out but not
  // yet shown, so `placePopover` keeps a list that fits below the trigger there.
  const [height, setHeight] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (height === null && ref.current) setHeight(ref.current.offsetHeight)
  }, [height])
  // The fixed 320 of §9.20: a list without trailing controls, never fitted.
  const width = POPOVER_WIDTH.list
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
  usePopover(ref, {
    onClose,
    active: box !== null,
    initial: (root) => root.querySelector<HTMLElement>('[aria-selected="true"]'),
    returnTo: anchor
  })
  useArrowKeys(ref, '.zen-v2-menulist-option')
  useLightDismiss(ref, onClose, { anchor })
  useBackSurface({ name: surface, onCommit: onClose })
  const pick = (next: T): void => {
    onPick(next)
    onClose()
  }
  return (
    <ChromePortal>
      <div
        ref={ref}
        id={id}
        role="listbox"
        aria-label={label}
        className="zen-v2-pw zen-v2-panel zen-v2-menulist-popup zen-animate-pop fixed select-none"
        data-side={box?.side}
        // Until its rows and the anchor have been measured it is laid out but not shown.
        style={box ? popoverStyle(box) : { visibility: 'hidden', width }}
      >
        {options.map((o) => {
          const selected = o.value === value
          return (
            <button
              key={o.value}
              type="button"
              role="option"
              aria-selected={selected}
              className="zen-v2-menulist-option"
              onClick={() => pick(o.value)}
            >
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
              {selected && <Check />}
            </button>
          )
        })}
      </div>
    </ChromePortal>
  )
}

/**
 * The open phone list (§9.13): a picker sheet on the shared `BottomSheet` chassis, mounted in
 * the frame's dialog host through `FrameDialogPortal` (lib/portals.tsx) – over the manager's
 * page, outside the overlay's stacking context – with the §9.16 48 header naming it under the
 * grabber, or the §9.23 title block when the row it came from has a description, and 44 px
 * radio rows (the shared row and radio) edge to edge at the 16 gutter (§9.25). It draws the
 * stack's one scrim itself (`ownScrim`, §9.24, §9.28); the chassis focuses the current option as
 * it opens, wraps Tab, holds the page under it inert and hands the focus back to the trigger
 * when it has gone. A drag, a fling, the scrim, Escape or the back gesture close it; a pick
 * applies at once and lets the sheet leave.
 */
function MenulistSheet<T extends string>(props: OpenList<T>): JSX.Element {
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
  description,
  surface,
  options,
  value,
  onPick,
  onClose
}: OpenList<T>): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  const dismiss = (): void => sheet.current?.dismiss()
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useBackSurface({
    name: surface,
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(dismiss)
  return (
    <div
      className="zen-v2-pw zen-v2-pw-sheet-layer absolute inset-0"
      data-surface="page"
      data-sheet-layer=""
    >
      <BottomSheet
        ref={sheet}
        hosted
        labelledBy={titleId}
        handleLabel="Dismiss"
        // #134's `.zen-settings-sheet` (main.css): the chassis border drawn as an inset hairline,
        // so the rows' 16 is 16 from the sheet's outer edge (§9.25).
        className="zen-settings-sheet"
        header={
          description ? undefined : (
            <h2 id={titleId} className="zen-sheet-title">
              {label}
            </h2>
          )
        }
        onDismissed={onClose}
      >
        {description && (
          <div className="zen-sheet-title-block">
            <h2 id={titleId}>{label}</h2>
            <p>{description}</p>
          </div>
        )}
        <div id={id} role="radiogroup" aria-labelledby={titleId} className="zen-v2-pw-sheet-rows">
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={o.value === value}
              className="zen-v2-row"
              onClick={() => {
                onPick(o.value)
                dismiss()
              }}
            >
              <span className="zen-v2-radio" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{o.label}</span>
            </button>
          ))}
        </div>
      </BottomSheet>
    </div>
  )
}

/** What a `PromptSheet` hands its opener: a way to close it from inside (a Cancel, a pick). */
export interface PromptSheetHandle {
  dismiss(): void
}

/**
 * A prompt sheet (§9.23, §9.24): what a dialog is on a phone – a title block (an optional glyph,
 * the 17/600 title, a description), the body, a footer – on the shared `BottomSheet` chassis in
 * the frame's dialog host, the top of a depth-two stack over the manager's page. It draws the
 * stack's one scrim itself (`ownScrim`, §9.28) and mounts the chassis's title block, the one
 * every prompt sheet opens on. The chassis moves the focus in (§9.22), wraps Tab, holds the page
 * under it inert and hands the focus back once the sheet has gone; a drag, a fling, the scrim,
 * Escape (the shared LIFO hook, so a pane under it keeps its own turn) and the back gesture
 * close it, `dismiss` on the handle closes it from inside, and `onClosed` runs once it has left.
 */
export function PromptSheet({
  ref,
  name,
  title,
  description,
  glyph,
  children,
  onClosed
}: {
  ref?: Ref<PromptSheetHandle>
  /** The back-registry name of this sheet while it is open. */
  name: string
  title: string
  description?: string
  glyph?: ReactNode
  children: ReactNode
  onClosed: () => void
}): JSX.Element {
  return (
    <FrameDialogPortal>
      <HostedPromptSheet
        ref={ref}
        name={name}
        title={title}
        description={description}
        glyph={glyph}
        onClosed={onClosed}
      >
        {children}
      </HostedPromptSheet>
    </FrameDialogPortal>
  )
}

function HostedPromptSheet({
  ref,
  name,
  title,
  description,
  glyph,
  children,
  onClosed
}: {
  ref?: Ref<PromptSheetHandle>
  name: string
  title: string
  description?: string
  glyph?: ReactNode
  children: ReactNode
  onClosed: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const titleId = useId()
  const dismiss = (): void => sheet.current?.dismiss()
  useImperativeHandle(ref, () => ({ dismiss }), [])
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useBackSurface({
    name,
    onProgress: (progress) => sheet.current?.backProgress(progress),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(dismiss)
  return (
    <div
      className="zen-v2-pw zen-v2-pw-sheet-layer absolute inset-0"
      data-surface="page"
      data-sheet-layer=""
    >
      <BottomSheet
        ref={sheet}
        hosted
        labelledBy={titleId}
        handleLabel="Dismiss"
        className="zen-settings-sheet"
        onDismissed={onClosed}
      >
        <TitleBlock id={titleId} glyph={glyph} description={description}>
          {title}
        </TitleBlock>
        {children}
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
  const row = trigger?.closest('.zen-v2-row, .zen-v2-pw-header-row') ?? trigger?.parentElement
  if (!row) return anchor
  const r = toRect(row.getBoundingClientRect())
  return { x: r.x, width: r.width, y: anchor.y, height: anchor.height }
}

/** A list of rows: the shared rows bleeding 16 into the gutter, so their text sits on it (passwords.css). */
export function Rows({ className, ...rest }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div className={cn('zen-v2-pw-rows', className)} {...rest} />
}

/**
 * A row's text: the label on the first line at the row's 15/20, the description under it the
 * shared `.zen-v2-description` (13/20), which wraps to two lines then an ellipsis (§9.2) unless
 * it is the explanation itself (`full`, passwords.css lifts the clamp).
 */
export function RowText({
  label,
  description,
  full = false
}: {
  label: ReactNode
  description?: ReactNode
  /** The description is the explanation itself and does not clamp at two lines. */
  full?: boolean
}): JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 flex-col">
      <span className="block [overflow-wrap:anywhere]">{label}</span>
      {description && (
        <span className={cn('zen-v2-description', full && 'zen-v2-pw-full')}>{description}</span>
      )}
    </span>
  )
}

/**
 * A boolean row: the whole row is the control. On the desktop a checkbox row (§6: the shared
 * `.zen-v2-checkbox` on the first text line, the label to its right, the description under it,
 * as Firefox lays out its checkboxes); on a phone a switch row (§10.4: the shared 36 × 20
 * `.zen-v2-switch` trailing the text, the row `role="switch"`). Disabled, the row says so
 * (`aria-disabled`), which keeps the shared row's fill off it (§9.30).
 */
export function CheckRow({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  className
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label: ReactNode
  description?: ReactNode
  disabled?: boolean
  className?: string
}): JSX.Element {
  const phone = usePhone()
  if (phone) {
    return (
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-disabled={disabled || undefined}
        className={cn('zen-v2-row zen-v2-pw-row', className)}
        onClick={() => !disabled && onChange(!checked)}
      >
        <RowText label={label} description={description} full />
        <span className="zen-v2-switch" aria-hidden />
      </button>
    )
  }
  return (
    <label
      className={cn('zen-v2-row zen-v2-check-row zen-v2-pw-row items-start', className)}
      aria-disabled={disabled || undefined}
    >
      <input
        type="checkbox"
        className="zen-v2-checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <RowText label={label} description={description} full />
    </label>
  )
}

/** A radio row inside a `role="radiogroup"`: the shared `.zen-v2-radio` on the first line, the label beside it. */
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
      className={cn('zen-v2-row zen-v2-pw-row', className)}
      onClick={onSelect}
    >
      <span className="zen-v2-radio" aria-hidden />
      <RowText label={label} description={description} full />
    </button>
  )
}

/**
 * A settings row: label and description to the left, the control to the right, centred on the
 * row (§9.18); the row itself is not a target (`data-static`, §9.34), its control is. `stack`
 * drops the control under the text (a phone with a wide menulist or a pair of buttons).
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
    <div
      className={cn('zen-v2-row zen-v2-pw-row', className)}
      data-static=""
      data-stack={stack || undefined}
    >
      <RowText label={label} description={description} full={!clamp} />
      {children && <div className="zen-v2-pw-row-control">{children}</div>}
    </div>
  )
}

/**
 * A list row on the surface: the shared row as a target when it opens something (the fill on
 * hover and press), its static form when its controls are the targets (a never-saved site with
 * its Allow button, a checkup finding with Change).
 */
export function ListRow({
  className,
  children,
  onClick,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  if (!onClick) {
    return (
      <div className={cn('zen-v2-row zen-v2-pw-list-row', className)} data-static="">
        {children}
      </div>
    )
  }
  return (
    <button
      type="button"
      className={cn('zen-v2-row zen-v2-pw-list-row', className)}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  )
}

/**
 * A choice among a few options (§9.13): on the desktop a settings row with the shared menulist
 * trailing its text; on a phone §10.4's value row – the whole row the target, the label on the
 * first line, the current option as its description, no control and no chevron – opening the
 * same picker sheet, which takes a title block with the row's description when it has one.
 */
export function ChoiceRow<T extends string>({
  label,
  description,
  value,
  options,
  onChange,
  disabled = false,
  className
}: {
  label: string
  /** The explanation beside the desktop menulist; on a phone the picker sheet's description. */
  description?: string
  value: T
  options: Array<MenulistOption<T>>
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
}): JSX.Element {
  const phone = usePhone()
  const [open, setOpen] = useState(false)
  const listId = useId()
  const current = options.find((o) => o.value === value)
  if (!phone) {
    return (
      <SettingRow label={label} description={description} className={className}>
        <Menulist
          label={label}
          description={description}
          value={value}
          options={options}
          onChange={onChange}
          disabled={disabled}
        />
      </SettingRow>
    )
  }
  return (
    <>
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-disabled={disabled || undefined}
        className={cn('zen-v2-row zen-v2-pw-row', className)}
        onClick={() => !disabled && setOpen(true)}
      >
        <RowText label={label} description={current?.label ?? ''} />
      </button>
      {open && (
        <MenulistSheet
          id={listId}
          label={label}
          description={description}
          surface={`passwords-choice-${listId}`}
          options={options}
          value={value}
          onPick={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/**
 * A phone action row (§10.4): the whole row does the thing – label and description, a trailing
 * 16 px glyph only when it leaves the page – a destructive one in the danger ink and confirmed
 * in a sheet, never by an inline button. Disabled is the row at .4, laid out and not pressable
 * (§9.30); busy keeps its ink, trails the spinner in place of its glyph and takes no press.
 */
export function ActionRow({
  label,
  description,
  leaves,
  destructive = false,
  disabled = false,
  busy = false,
  onPress,
  className
}: {
  label: ReactNode
  description?: ReactNode
  leaves?: 'chevron' | 'external'
  destructive?: boolean
  disabled?: boolean
  busy?: boolean
  onPress: () => void
  className?: string
}): JSX.Element {
  return (
    <button
      type="button"
      aria-disabled={disabled || undefined}
      aria-busy={busy || undefined}
      data-danger={destructive || undefined}
      className={cn('zen-v2-row zen-v2-pw-row', className)}
      onClick={() => !disabled && !busy && onPress()}
    >
      <RowText label={label} description={description} />
      {busy ? (
        <span className="zen-v2-spinner" aria-hidden />
      ) : leaves === 'chevron' ? (
        <ChevronRight className="zen-v2-pw-deemphasized" />
      ) : leaves === 'external' ? (
        <ExternalLink className="zen-v2-pw-deemphasized" />
      ) : null}
    </button>
  )
}

/**
 * An empty state (§9.17): one sentence, sentence case, no full stop, 15/400 at 69 %, centred in
 * a 32 gutter, top-anchored with its first line 32 below the header on the desktop and 48 on a
 * phone (passwords.css counts the scroller's 16), and one optional follow-up 16 under it where
 * there is one obvious next step – a secondary button, never primary. No glyph, no title.
 */
export function EmptyState({
  action,
  children,
  className
}: {
  action?: { label: ReactNode; onPress: () => void }
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={cn('zen-v2-pw-empty', className)}>
      <p>{children}</p>
      {action && <Btn onClick={action.onPress}>{action.label}</Btn>}
    </div>
  )
}

/** A group's empty state on a page (§9.17): one plain static row at the group's gutter, one sentence. */
export function EmptyRow({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="zen-v2-row zen-v2-pw-row" data-static="">
      <span className="zen-v2-pw-deemphasized min-w-0 flex-1">{children}</span>
    </div>
  )
}

/**
 * The actions of a form on the page (§9.11): on the desktop hugging the end, 8 apart; on a
 * phone two peers splitting the width at an 8 gap, the primary trailing. `children` are the
 * buttons, the primary last.
 */
export function FormActions({
  className,
  children
}: {
  className?: string
  children: ReactNode
}): JSX.Element {
  return <div className={cn('zen-v2-pw-form-actions', className)}>{children}</div>
}

/** A page or pane title: 22/600 on 28 (§9.26). */
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
 * A title block (§9.23): what heads a dialog or a prompt sheet instead of a bar – no control
 * and no X, since Escape, a press outside and the footer close it. Padding 16, an optional glyph
 * (16 on the desktop, 20 on a phone) 8 px before the 17/600 title on 22, an optional description
 * 4 px under it, 16 px to the body; 54 tall on its own, 78 with a one-line description. On the
 * desktop it is extensions.css's `.zen-v2-title-block`; on a phone the sheet chassis's
 * `.zen-sheet-title-block` (main.css), the one every prompt sheet opens on. `id` and
 * `descriptionId` are for the dialog's `aria-labelledby` and `aria-describedby`.
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
  const phone = usePhone()
  if (phone) {
    return (
      <div className={cn('zen-sheet-title-block', className)}>
        <h2 id={id}>
          {glyph}
          <span className="min-w-0 flex-1">{children}</span>
        </h2>
        {description && <p id={descriptionId}>{description}</p>}
      </div>
    )
  }
  return (
    <div className={cn('zen-v2-title-block', className)}>
      <h2 id={id} className="zen-v2-title-block-title">
        {glyph}
        <span className="min-w-0 flex-1">{children}</span>
      </h2>
      {description && (
        <p id={descriptionId} className="zen-v2-title-block-description">
          {description}
        </p>
      )}
    </div>
  )
}

/** A sub-heading over a group of rows: the shared `.zen-v2-heading` (15/600), sentence case, an optional count trailing. */
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
      <h3 className="zen-v2-heading flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {trailing}
      </h3>
      {description && <Description>{description}</Description>}
    </div>
  )
}

/** Standalone deemphasised copy at the body size (§4): a hero's text, a group's description, a footnote. */
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
