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
import { createPortal } from 'react-dom'
import { Check, ChevronDown, CircleAlert, type LucideIcon } from 'lucide-react'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import {
  ChromePortal,
  placePopover,
  popoverStyle,
  toRect,
  useLightDismiss,
  viewportSize,
  type PopoverBox
} from '@renderer/lib/portals'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import '@renderer/assets/autofill.css'

export { useScrolled, wrapTab } from '../bookmarks/popover'

/**
 * The autofill surfaces' controls in the v2 vocabulary: the shared classes main.css and #115
 * define (`zen-v2-button`, `zen-v2-field`, `zen-v2-icon-button`, `zen-v2-check`, `zen-v2-radio`)
 * wrapped for React, the sheet chassis' own header, title block and footer (`zen-sheet-title`,
 * `zen-sheet-title-block`, `zen-sheet-footer` in main.css) and the surfaces' own layout classes
 * (`zen-v2-af-*` in autofill.css) for desktop title blocks, rows, footers and the menulist. Sizes
 * come from the `--v2-*` density tokens the root sets per form factor, so nothing here asks what
 * it is running on except the menulist, whose popup is a popover on a mouse and a sheet on a
 * phone (§9.13).
 */

type Variant = 'primary' | 'secondary' | 'danger' | 'quiet'

/**
 * The v2 button (§6): 32 / 40 tall at radius 4 / 6, 15/500, the text at 10% as the secondary;
 * `primary` is the one accent button of a view (`data-primary`), `danger` the secondary in the
 * danger ink, `quiet` a text button with no fill at rest. `busy` keeps the button's size and
 * opacity, hides its label and turns the 16 px spinner (§9.30, `aria-busy`); it is not disabled,
 * but it takes no presses while it turns.
 */
export function Btn({
  variant = 'secondary',
  busy = false,
  className,
  type = 'button',
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
      {...rest}
    >
      {children}
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
 * A prompt sheet's title block (§9.23) on the chassis' own class (`.zen-sheet-title-block`,
 * main.css): first in the sheet's body after the grip strip, in place of the 48 header – the
 * glyph (20 on a phone) on the title's first line, the description 4 below.
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
 * A form sheet's 48 header after the grip strip (§9.16): the title, centred, on the chassis'
 * class; hand it to `BottomSheet`'s `header`, which wraps it in `.zen-sheet-header`.
 */
export function SheetHeader({ id, title }: { id?: string; title: string }): JSX.Element {
  return (
    <h2 id={id} className="zen-sheet-title">
      {title}
    </h2>
  )
}

/**
 * Body copy (§9.23): the paragraph that introduces a form or rows, under a sheet's 48 header or
 * a dialog's title block – 15/20 in the text colour at the 16 sides, 16 to what it introduces.
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
 * A rectangular menulist (§9.13). On a mouse the trigger is a field with a chevron and the menu
 * a panel hung under it through the chrome layer – radius 12, padding 6, 28 px rows, the current
 * option checked – placed by `placePopover` at the trigger's width and put away by the layer's
 * light dismiss. On a phone the trigger opens a sheet of 44 px radio rows (`MenuSheet`); picking
 * one closes it. Never a native `<select>` popup. A `value` no option carries (a required choice
 * not made yet, `''`) shows `placeholder` at 69% and checks nothing.
 */
export function Menulist<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
  disabled,
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
      placeholder={placeholder}
      className={className}
    />
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
  placeholder,
  className
}: {
  value: T
  options: MenuOption<T>[]
  onChange: (value: T) => void
  label: string
  id?: string
  disabled?: boolean
  placeholder?: string
  className?: string
}): JSX.Element {
  const [box, setBox] = useState<PopoverBox | null>(null)
  const open = box !== null
  const trigger = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const listId = useId()
  const current = options.find((o) => o.value === value)

  // Hung from the trigger at its width (§9.13: a panel under the trigger), as tall as its rows,
  // flipped above when the window ends before they do.
  const openList = (): void => {
    const el = trigger.current
    if (!el) return
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

  // The current option takes the keyboard as the list opens (a long list opens scrolled to it).
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
        close(true)
        break
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
        disabled={disabled}
        data-placeholder={current ? undefined : ''}
        className={cn('zen-v2-af-menulist', className)}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
            e.preventDefault()
            openList()
          }
        }}
      >
        <span>{current?.label ?? placeholder ?? ''}</span>
        <ChevronDown aria-hidden />
      </button>
      {box && (
        <ChromePortal>
          <div
            ref={list}
            id={listId}
            role="listbox"
            aria-label={label}
            className="zen-v2-af zen-v2-af-menu zen-animate-pop fixed z-[90]"
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
                className="zen-v2-af-menu-item"
                // One highlight: the pointer moves the focus the way the arrow keys do.
                onPointerMove={(e) => {
                  if (document.activeElement !== e.currentTarget)
                    e.currentTarget.focus({ preventScroll: true })
                }}
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
  placeholder,
  className
}: {
  value: T
  options: MenuOption<T>[]
  onChange: (value: T) => void
  label: string
  id?: string
  disabled?: boolean
  placeholder?: string
  className?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const current = options.find((o) => o.value === value)
  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        data-placeholder={current ? undefined : ''}
        className={cn('zen-v2-af-menulist', className)}
        onClick={() => setOpen(true)}
      >
        <span>{current?.label ?? placeholder ?? ''}</span>
        <ChevronDown aria-hidden />
      </button>
      {open && (
        <MenuSheet
          title={label}
          value={value}
          options={options}
          onChange={onChange}
          onClose={() => {
            setOpen(false)
            trigger.current?.focus({ preventScroll: true })
          }}
        />
      )}
    </>
  )
}

/**
 * A phone's menulist popup (§9.13): a sheet with the 48 header naming the choice and one §9.14
 * radio row of 44 per option; picking one changes the value and dismisses the sheet. Opened by
 * the menulist's own trigger or by a Settings value row (§10.4), whose explanatory text comes
 * along as a `description`: the sheet then opens on a §9.23 title block in place of the 48
 * header. Inside another sheet it stacks (§9.24, the chassis' own registry): the sheet below
 * recedes under it, inert, and keeps the one scrim.
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
  const sheet = useRef<BottomSheetHandle>(null)
  const name = useId()
  const titleId = useId()
  useBackSurface({
    name: `autofill-menu-${name}`,
    onProgress: (p) => sheet.current?.backProgress(p),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(() => sheet.current?.dismiss())
  // The current option takes the focus (§9.22) and a long list (countries) opens on it, the way
  // a menulist's popup does.
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const checked = list.current?.querySelector<HTMLInputElement>('input:checked')
    checked?.focus({ preventScroll: true })
    checked?.closest('label')?.scrollIntoView({ block: 'center' })
  }, [])
  // In the body like every sheet: a layer inside another sheet's transformed box would not be
  // fixed to the viewport.
  return createPortal(
    <BottomSheet
      ref={sheet}
      onDismissed={onClose}
      handleLabel="Dismiss"
      className="zen-v2-af zen-v2-af-sheet"
      header={description ? undefined : <SheetHeader id={titleId} title={title} />}
    >
      <div className="zen-v2-af zen-v2-af-choices" data-surface="page">
        {description && <SheetTitleBlock id={titleId} title={title} description={description} />}
        <div ref={list} role="radiogroup" aria-labelledby={titleId} className="zen-v2-af-list">
          {options.map((o) => (
            <label key={o.value} className="zen-v2-af-row">
              <input
                type="radio"
                className="zen-v2-radio"
                name={name}
                value={o.value}
                checked={o.value === value}
                onChange={() => {
                  onChange(o.value)
                  sheet.current?.dismiss()
                }}
                // A radio that is checked already fires no change: the tap still leaves.
                onClick={() => {
                  if (o.value === value) sheet.current?.dismiss()
                }}
              />
              <span className="zen-v2-af-row-text">
                <span className="zen-v2-af-row-title">{o.label}</span>
              </span>
            </label>
          ))}
        </div>
      </div>
    </BottomSheet>,
    document.body
  )
}
