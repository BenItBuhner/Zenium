/* eslint-disable react-refresh/only-export-components -- the autofill surfaces' control kit: the controls ship with the keyboard helpers they pair with (`useEscape`, and `wrapTab` / `useScrolled` re-exported from the bookmark popovers) and the sheet context the footer and the menulist read */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  JSX,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  Ref,
  TextareaHTMLAttributes
} from 'react'
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import { Check, ChevronDown, CircleAlert, type LucideIcon } from 'lucide-react'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import {
  ChromePortal,
  FrameDialogPortal,
  placePopover,
  popoverStyle,
  toRect,
  useFrameDialog,
  useLightDismiss,
  viewportSize,
  type PopoverBox
} from '@renderer/lib/portals'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import '@renderer/assets/autofill.css'

import { wrapTab } from '../bookmarks/popover'

export { useScrolled, wrapTab } from '../bookmarks/popover'

/**
 * The autofill surfaces' controls in the v2 vocabulary: the chassis' shared classes (main.css
 * and extensions.css: `zen-v2-button`, `zen-v2-field`, `zen-v2-icon-button`, `zen-v2-checkbox`,
 * the `zen-v2-radio` glyph) wrapped for React, the sheet chassis' own header, title block and
 * footer (`zen-sheet-title`, `zen-sheet-title-block`, `zen-sheet-footer` in main.css) and the
 * surfaces' own layout classes (`zen-v2-af-*` in autofill.css) for desktop title blocks, rows,
 * footers and the menulist. Sizes come from the `--v2-*` density tokens the root sets per form
 * factor, so nothing here asks what it is running on except the menulist, whose popup is a
 * popover on a mouse and a sheet on a phone (§9.13).
 */

type Variant = 'primary' | 'secondary' | 'danger' | 'quiet'

/**
 * The v2 button (§6): 32 / 40 tall at radius 4 / 6, 15/500, the text at 10% as the secondary;
 * `primary` is the one accent button of a view (`data-primary`), `danger` the secondary in the
 * danger ink, `quiet` a text button with no fill at rest. `busy` is the chassis' §9.30 form: the
 * button keeps its size, its fill and its opacity, the label stays in the flow at opacity 0 (it
 * still sizes and names the button) under the 16 px `zen-v2-spinner`, `aria-busy` is set, and
 * the button is not disabled but takes no presses while it turns.
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
      type={type}
      data-primary={variant === 'primary' || undefined}
      data-variant={variant === 'danger' || variant === 'quiet' ? variant : undefined}
      aria-busy={busy || undefined}
      className={cn('zen-v2-button', className)}
      onClick={busy ? undefined : onClick}
      {...rest}
    >
      {busy ? (
        <>
          <span className="zen-v2-button-label">{children}</span>
          <span className="zen-v2-spinner" aria-hidden />
        </>
      ) : (
        children
      )}
    </button>
  )
}

/** An icon button (§9.3): 28 / 44 square at radius 6 / 8 around a 16 / 20 glyph; named by `title`. */
export function IconBtn({
  title,
  className,
  type = 'button',
  children,
  ref,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'> & {
  title: string
  ref?: Ref<HTMLButtonElement>
}): JSX.Element {
  return (
    <button
      ref={ref}
      type={type}
      title={title}
      aria-label={title}
      className={cn('zen-v2-icon-button', className)}
      {...rest}
    >
      {children}
    </button>
  )
}

/** The v2 field (§9.12): 32 / 40 tall, bordered, in the page face; `secret` sets the monospace. */
export function Field({
  className,
  secret,
  ref,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  /** A secret string: the platform monospace at one colour (§4). */
  secret?: boolean
  ref?: Ref<HTMLInputElement>
}): JSX.Element {
  return (
    <input
      ref={ref}
      data-secret={secret || undefined}
      className={cn('zen-v2-field', className)}
      {...rest}
    />
  )
}

/** A field of a few lines (a street address): the field's border and type, `rows` tall, no resize grip. */
export function TextArea({
  className,
  rows = 2,
  ref,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }): JSX.Element {
  return <textarea ref={ref} rows={rows} className={cn('zen-v2-field', className)} {...rest} />
}

/** A form field's label above it (§9.12), 15/400 4 px over the field, with an optional 13/69% hint or the validation under it. */
export function Labelled({
  label,
  hint,
  error,
  htmlFor,
  children
}: {
  label: string
  hint?: string
  error?: string | null
  htmlFor?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="zen-v2-af-label">
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? (
        <span className="zen-v2-af-error" role="alert">
          <CircleAlert aria-hidden />
          {error}
        </span>
      ) : (
        hint && <span className="zen-v2-af-field-hint">{hint}</span>
      )}
    </div>
  )
}

/** The title block's glyph: a Lucide icon, or any node such as the site's favicon in its place. */
function Glyph({
  icon: Icon,
  glyph
}: {
  icon?: LucideIcon
  glyph?: ReactNode
}): JSX.Element | null {
  if (!glyph && !Icon) return null
  return (
    <span className="zen-v2-af-title-glyph" aria-hidden>
      {glyph ?? (Icon && <Icon />)}
    </span>
  )
}

/**
 * A desktop title block (§9.23) for a popover or a frame dialog: the 17/600 title on 22 with an
 * optional 16 px glyph 8 px before it – a Lucide icon, or any node such as the site's favicon –
 * and a 15/69% description 4 px under; sticky over the body it heads, with the §9.7 hairline
 * once that body has scrolled (`scrolled`). A sheet's is `SheetTitleBlock`.
 */
export function TitleBlock({
  id,
  icon,
  glyph,
  title,
  description,
  scrolled
}: {
  id?: string
  icon?: LucideIcon
  /** Takes the glyph's place when set (a favicon `<img>`); `icon` is the fallback. */
  glyph?: ReactNode
  title: string
  description?: ReactNode
  scrolled?: boolean
}): JSX.Element {
  return (
    <div className="zen-v2-af-title-block" data-scrolled={scrolled || undefined}>
      <div className="zen-v2-af-title-row">
        <Glyph icon={icon} glyph={glyph} />
        <h2 id={id} className="zen-v2-af-title">
          {title}
        </h2>
      </div>
      {description && <p className="zen-v2-af-description">{description}</p>}
    </div>
  )
}

/**
 * A sheet's title block (§9.23) on the chassis' own class (`.zen-sheet-title-block`, main.css):
 * first in the sheet's body after the grip strip, in place of the 48 header – the glyph (20 on
 * a phone) on the title's first line, the description 4 below, 16 to what follows. A phone sheet
 * that carries a description opens on it (the prompts, the passphrase ask, the editors, a
 * menulist's picker for a row with a description); one without keeps `SheetHeader`.
 */
export function SheetTitleBlock({
  id,
  icon,
  glyph,
  title,
  description
}: {
  id?: string
  icon?: LucideIcon
  glyph?: ReactNode
  title: string
  description?: ReactNode
}): JSX.Element {
  return (
    <div className="zen-sheet-title-block">
      <h2 id={id}>
        <Glyph icon={icon} glyph={glyph} />
        <span className="zen-v2-af-title">{title}</span>
      </h2>
      {description && <p>{description}</p>}
    </div>
  )
}

/**
 * A sheet's 48 header after the grip strip (§9.16), for a sheet with no description – a
 * menulist's picker for a plain form field: the title, centred, on the chassis' class; hand it
 * to `BottomSheet`'s `header`, which wraps it in `.zen-sheet-header`.
 */
export function SheetHeader({ id, title }: { id?: string; title: string }): JSX.Element {
  return (
    <h2 id={id} className="zen-sheet-title">
      {title}
    </h2>
  )
}

/**
 * Body copy (§9.23): the paragraph that introduces a form or rows under a desktop dialog's title
 * block (the editor) – 15/20 in the text colour at the 16 sides, 16 to what it introduces. Phone
 * sheets carry that text as their title block's description instead (`SheetTitleBlock`).
 */
export function SheetCopy({ children }: { children: ReactNode }): JSX.Element {
  return <p className="zen-v2-af-copy">{children}</p>
}

/**
 * The footer's actions (§9.11): on desktop they hug and right-align, primary last; in a sheet
 * (`InSheet`) the chassis' `.zen-sheet-footer` splits the width between two peers, and three or
 * more stack full-width, the primary first (`data-stack`).
 */
export function Footer({
  children,
  count,
  className
}: {
  children: ReactNode
  /** How many actions the footer holds (three or more stack on a phone). */
  count: number
  className?: string
}): JSX.Element {
  const sheet = useContext(InSheet)
  return (
    <div
      className={cn(sheet ? 'zen-sheet-footer' : 'zen-v2-af-footer', className)}
      data-stack={count >= 3 || undefined}
    >
      {children}
    </div>
  )
}

/**
 * True inside a sheet's body: the footer takes the chassis' sheet footer. (A menulist opening
 * its own sheet from there needs no flag: `BottomSheet` keeps the stack itself – §9.24, the
 * sheet beneath recedes, goes inert and keeps the one scrim.)
 */
export const InSheet = createContext(false)

/** Escape while the surface is up runs `close`, before anything under it hears the key. */
export function useEscape(close: () => void, active = true): void {
  const latest = useRef(close)
  useEffect(() => {
    latest.current = close
  })
  useEffect(() => {
    if (!active) return
    escapeStack.push(latest)
    if (escapeStack.length === 1) window.addEventListener('keydown', onEscapeKey, true)
    return () => {
      const i = escapeStack.lastIndexOf(latest)
      if (i >= 0) escapeStack.splice(i, 1)
      if (escapeStack.length === 0) window.removeEventListener('keydown', onEscapeKey, true)
    }
  }, [active])
}

/**
 * The surfaces listening for Escape, in the order they came up: only the top one closes (§9.22,
 * §9.24 – a menu sheet over an editor sheet takes the key, the editor stays), and the key goes no
 * further, so the overlay beneath does not close with it.
 */
const escapeStack: { current: () => void }[] = []

function onEscapeKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  const top = escapeStack[escapeStack.length - 1]
  if (!top) return
  e.preventDefault()
  e.stopImmediatePropagation()
  top.current()
}

// ---------------------------------------------------------------------------
// Menulist
// ---------------------------------------------------------------------------

export interface MenuOption<T extends string> {
  value: T
  label: string
}

/**
 * A rectangular menulist (§9.13) on the chassis' shared control (`.zen-v2-menulist`,
 * extensions.css: 32 / 40 tall, a hairline, the 16 chevron). On a mouse the popup is the
 * chassis' `.zen-v2-menulist-popup` – a `--v2-panel` hung under the trigger through the chrome
 * layer at radius 12, padding 6, 28 px `.zen-v2-menulist-option` rows, the current one checked
 * – placed by `placePopover` at the trigger's width and put away by the layer's light dismiss.
 * On a phone the trigger opens a sheet of 44 px radio rows (`MenuSheet`); picking one closes it.
 * Never a native `<select>` popup. A `value` no option carries (a required choice not made yet,
 * `''`) shows `placeholder` at 69% and checks nothing. `readOnly` is a busy form's (§9.30): the
 * control keeps its ink and its value and opens nothing.
 */
export function Menulist<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
  disabled,
  readOnly,
  placeholder,
  className
}: {
  value: T
  options: MenuOption<T>[]
  onChange: (value: T) => void
  /** Name for assistive tech (a form label may point at `id` instead). */
  label: string
  id?: string
  disabled?: boolean
  readOnly?: boolean
  placeholder?: string
  className?: string
}): JSX.Element {
  const phone = useViewport().formFactor === 'phone'
  return phone ? (
    <SheetMenulist
      id={id}
      value={value}
      options={options}
      onChange={onChange}
      label={label}
      disabled={disabled}
      readOnly={readOnly}
      placeholder={placeholder}
      className={className}
    />
  ) : (
    <PopoverMenulist
      id={id}
      value={value}
      options={options}
      onChange={onChange}
      label={label}
      disabled={disabled}
      readOnly={readOnly}
      placeholder={placeholder}
      className={className}
    />
  )
}

interface MenulistProps<T extends string> {
  value: T
  options: MenuOption<T>[]
  onChange: (value: T) => void
  label: string
  id?: string
  disabled?: boolean
  readOnly?: boolean
  placeholder?: string
  className?: string
}

/** The trigger's text: the current option's label, or the placeholder at 69%. */
function MenulistValue<T extends string>({
  current,
  placeholder
}: {
  current: MenuOption<T> | undefined
  placeholder?: string
}): JSX.Element {
  return (
    <span className={cn('min-w-0 flex-1 truncate', !current && 'zen-v2-af-muted')}>
      {current?.label ?? placeholder ?? ''}
    </span>
  )
}

/** The popup's height before it is on screen: 6 px padding around 28 px rows (§9.13). */
const MENU_ROW = 28
const MENU_PADDING = 6

function PopoverMenulist<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
  disabled,
  readOnly,
  placeholder,
  className
}: MenulistProps<T>): JSX.Element {
  const [box, setBox] = useState<PopoverBox | null>(null)
  const open = box !== null
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = options.find((o) => o.value === value)

  // Hung from the trigger at its width (§9.13: a panel under the trigger), as tall as its rows –
  // `placePopover` holds every chassis popover to 60% of the window (§9.20), so a longer list
  // scrolls – and flipped above when the window ends before they do.
  const openList = (): void => {
    const el = trigger.current
    if (!el || readOnly) return
    const anchor = toRect(el.getBoundingClientRect())
    const height = MENU_PADDING * 2 + options.length * MENU_ROW
    setBox(placePopover(anchor, anchor, viewportSize(), { measured: anchor.width }, height))
  }
  const close = (focusTrigger: boolean): void => {
    setBox(null)
    if (focusTrigger) trigger.current?.focus({ preventScroll: true })
  }
  const pick = (v: T): void => {
    close(true)
    if (v !== value) onChange(v)
  }

  // The current option takes the keyboard as the list opens (a long list opens scrolled to it):
  // a desktop popover's own focus rule (§9.22).
  useEffect(() => {
    if (!open) return
    const rows = list.current?.querySelectorAll<HTMLElement>('[role="option"]')
    const chosen = list.current?.querySelector<HTMLElement>('[aria-selected="true"]')
    const target = chosen ?? rows?.[0]
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: 'nearest' })
  }, [open])

  // The chrome layer's light dismiss puts the list away – a press anywhere else, a scroll, a
  // resize – with the focus back on the menulist, unless what closed it was another popover or
  // a dialog opening, which has the focus now.
  useLightDismiss(list, (reason) => close(reason !== 'replaced' && reason !== 'all'), {
    anchor: trigger,
    disabled: !open
  })
  useEscape(() => close(true), open)
  useBackSurface(open ? { name: `autofill-menu-${listId}`, onCommit: () => close(false) } : null)

  const onListKeyDown = (e: ReactKeyboardEvent): void => {
    const rows = [...(list.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
    const at = rows.indexOf(document.activeElement as HTMLElement)
    switch (e.key) {
      case 'ArrowDown':
        rows[(at + 1) % rows.length]?.focus()
        break
      case 'ArrowUp':
        rows[(at - 1 + rows.length) % rows.length]?.focus()
        break
      case 'Home':
        rows[0]?.focus()
        break
      case 'End':
        rows[rows.length - 1]?.focus()
        break
      case 'Tab':
        // Tab stays inside the open list and wraps at its ends (§9.22); Escape is the way out.
        wrapTab(e, list.current)
        e.stopPropagation()
        return
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        // The select-only combobox pattern: the trigger names the choice, the list is its popup.
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-readonly={readOnly || undefined}
        disabled={disabled}
        className={cn('zen-v2-menulist', className)}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
            e.preventDefault()
            openList()
          }
        }}
      >
        <MenulistValue current={current} placeholder={placeholder} />
        <ChevronDown aria-hidden />
      </button>
      {box && (
        <ChromePortal>
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label={label}
            className="zen-v2 zen-v2-panel zen-v2-menulist-popup zen-v2-af-menu-popup zen-animate-pop fixed z-[90] select-none"
            data-surface="page"
            style={popoverStyle(box)}
            onKeyDown={onListKeyDown}
          >
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                role="option"
                aria-selected={o.value === value}
                className="zen-v2-menulist-option"
                onClick={() => pick(o.value)}
              >
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.value === value && <Check aria-hidden />}
              </button>
            ))}
          </div>
        </ChromePortal>
      )}
    </>
  )
}

function SheetMenulist<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
  disabled,
  readOnly,
  placeholder,
  className
}: MenulistProps<T>): JSX.Element {
  const [open, setOpen] = useState(false)
  const current = options.find((o) => o.value === value)
  return (
    <>
      <button
        id={id}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-readonly={readOnly || undefined}
        disabled={disabled}
        className={cn('zen-v2-menulist', className)}
        onClick={() => {
          if (!readOnly) setOpen(true)
        }}
      >
        <MenulistValue current={current} placeholder={placeholder} />
        <ChevronDown aria-hidden />
      </button>
      {open && (
        <MenuSheet
          title={label}
          value={value}
          options={options}
          onChange={onChange}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

/**
 * A phone's menulist popup (§9.13): a sheet with the 48 header naming the choice and one §9.14
 * radio row of 44 per option on the chassis' `.zen-v2-radio`; picking one changes the value and
 * dismisses the sheet. A `description` (the explanatory text of a row that opened it) makes the
 * header a §9.23 title block. A modal dialog, so it mounts in the frame's dialog host
 * (`FrameDialogPortal`, lib/portals.tsx) – over the editor sheet it is opened from, never inside
 * that sheet's transformed box – and stacks on it by the chassis' own registry (§9.24: the sheet
 * below recedes, inert, under the one scrim). The chassis moves the focus to the checked option
 * as the sheet opens, wraps Tab and returns the focus to the trigger when it has gone; here is
 * only what is the surface's: the arrow keys walk the radio group, Escape and back dismiss.
 */
export function MenuSheet<T extends string>({
  title,
  description,
  value,
  options,
  onChange,
  onClose
}: {
  title: string
  description?: string
  value: T
  options: MenuOption<T>[]
  onChange: (value: T) => void
  onClose: () => void
}): JSX.Element {
  return (
    <FrameDialogPortal>
      <HostedMenuSheet
        title={title}
        description={description}
        value={value}
        options={options}
        onChange={onChange}
        onClose={onClose}
      />
    </FrameDialogPortal>
  )
}

function HostedMenuSheet<T extends string>({
  title,
  description,
  value,
  options,
  onChange,
  onClose
}: {
  title: string
  description?: string
  value: T
  options: MenuOption<T>[]
  onChange: (value: T) => void
  onClose: () => void
}): JSX.Element {
  const sheet = useRef<BottomSheetHandle>(null)
  const name = useId()
  const titleId = useId()
  const dismiss = (): void => sheet.current?.dismiss()
  useFrameDialog({ onScrimPress: dismiss, ownScrim: true })
  useBackSurface({
    name: `autofill-menu-${name}`,
    onProgress: (p) => sheet.current?.backProgress(p),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(dismiss)
  // A long list (countries) opens scrolled to its current option, the way a menulist's popup does.
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current
      ?.querySelector<HTMLButtonElement>('[aria-checked="true"]')
      ?.scrollIntoView({ block: 'center' })
  }, [])
  // The rows are buttons in the radio role around the chassis' radio glyph, so the arrow keys
  // walk them as a radio group would, wrapping at the ends.
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
    const rows = Array.from(
      list.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? []
    )
    if (rows.length === 0) return
    e.preventDefault()
    const at = rows.findIndex((row) => row === document.activeElement)
    const step = e.key === 'ArrowDown' ? 1 : -1
    rows[(at + step + rows.length) % rows.length]?.focus()
  }
  const pick = (v: T): void => {
    if (v !== value) onChange(v)
    dismiss()
  }
  // The sheet's layer is the host slot's child itself (`data-sheet-layer`).
  return (
    <BottomSheet
      ref={sheet}
      hosted
      onDismissed={onClose}
      handleLabel="Dismiss"
      labelledBy={titleId}
      className="zen-v2-af zen-v2-af-sheet"
      header={description ? undefined : <SheetHeader id={titleId} title={title} />}
    >
      <div className="zen-v2-af zen-v2-af-choices" data-surface="page">
        {description && <SheetTitleBlock id={titleId} title={title} description={description} />}
        <div
          ref={list}
          role="radiogroup"
          aria-labelledby={titleId}
          className="zen-v2-af-list"
          onKeyDown={onKeyDown}
        >
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={o.value === value}
              className="zen-v2-row zen-v2-af-row"
              onClick={() => pick(o.value)}
            >
              <span className="zen-v2-radio" aria-hidden />
              <span className="zen-v2-af-row-text">
                <span className="zen-v2-af-row-title">{o.label}</span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </BottomSheet>
  )
}
