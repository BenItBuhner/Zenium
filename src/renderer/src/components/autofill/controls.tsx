/* eslint-disable react-refresh/only-export-components -- the autofill surfaces' control kit: the controls ship with the two keyboard helpers (`useEscape`, `wrapTab`), the scroll-shadow hook every surface pairs them with and the sheet context the menulist reads */
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  JSX,
  ReactNode,
  Ref,
  RefObject,
  TextareaHTMLAttributes
} from 'react'
import { createContext, useContext, useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronDown, CircleAlert, type LucideIcon } from 'lucide-react'
import { Select as SelectPrimitive } from 'radix-ui'
import { useBackSurface } from '@renderer/lib/back'
import { useViewport } from '@renderer/lib/formFactor'
import { cn } from '@renderer/lib/utils'
import { BottomSheet, type BottomSheetHandle } from '../sheet/BottomSheet'
import '@renderer/assets/autofill.css'

/**
 * The autofill surfaces' controls in the v2 vocabulary: the shared classes main.css and the
 * Settings sections define (`zen-v2-button`, `zen-v2-field`, `zen-v2-icon-button`, `zen-v2-check`,
 * `zen-v2-radio`) wrapped for React, and the surfaces' own layout classes (`zen-v2-af-*` in
 * autofill.css) for title blocks, sheet headers, rows, footers and the menulist. Sizes come from
 * the `--v2-*` density tokens the root sets per form factor, so nothing here asks what it is
 * running on except the menulist, whose popup is a popover on a mouse and a sheet on a phone
 * (§9.13).
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

/**
 * A title block (§9.23): the 17/600 title on 22 with an optional 16 px glyph 8 px before it –
 * a Lucide icon, or any node such as the site's favicon – and a 15/69% description 4 px under;
 * sticky over the body it heads, with the §9.7 hairline once that body has scrolled
 * (`scrolled`).
 */
export function TitleBlock({
  id,
  icon: Icon,
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
        {glyph ? (
          <span className="zen-v2-af-title-glyph" aria-hidden>
            {glyph}
          </span>
        ) : (
          Icon && (
            <span className="zen-v2-af-title-glyph" aria-hidden>
              <Icon />
            </span>
          )
        )}
        <h2 id={id} className="zen-v2-af-title">
          {title}
        </h2>
      </div>
      {description && <p className="zen-v2-af-description">{description}</p>}
    </div>
  )
}

/** A phone sheet's 48 header after the grip strip (§9.16): the title, centred. */
export function SheetHeader({ id, title }: { id?: string; title: string }): JSX.Element {
  return (
    <div className="zen-v2-af-sheet-header">
      <h2 id={id} className="zen-v2-af-title">
        {title}
      </h2>
    </div>
  )
}

/** A sheet's body copy under its header: 15/20 in the text colour, the sheet's 16 sides. */
export function SheetCopy({ children }: { children: ReactNode }): JSX.Element {
  return <p className="zen-v2-af-copy">{children}</p>
}

/** The footer's actions: hugging on desktop; in a phone sheet full width, stacked past two (§9.11). */
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
  return (
    <div className={cn('zen-v2-af-footer', className)} data-stack={count >= 3 || undefined}>
      {children}
    </div>
  )
}

/**
 * True inside a sheet's body. A menulist opening its own sheet from there marks it stacked, so
 * the chassis draws no second scrim over the sheet already up (v2 sheets keep `--v2-scrim` on
 * their own scrim element and draw none over a chassis sheet).
 */
export const InSheet = createContext(false)

/** Whether `ref`'s scroller has moved off its top: drives a sticky header's hairline (§9.7). */
export function useScrolled(ref: RefObject<HTMLElement | null>): boolean {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = (): void => setScrolled(el.scrollTop > 0)
    onScroll()
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ref])
  return scrolled
}

/**
 * Whether `ref`'s content goes on below its visible end: a footer pinned under a scrolling body
 * draws §9.7's hairline while it does. Follows the scroll and the content's own growth (a
 * validation line appearing).
 */
export function useMoreBelow(ref: RefObject<HTMLElement | null>): boolean {
  const [more, setMore] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const check = (): void => setMore(el.scrollHeight - el.scrollTop - el.clientHeight > 1)
    check()
    el.addEventListener('scroll', check, { passive: true })
    const observer = new ResizeObserver(check)
    observer.observe(el)
    if (el.firstElementChild) observer.observe(el.firstElementChild)
    return () => {
      el.removeEventListener('scroll', check)
      observer.disconnect()
    }
  }, [ref])
  return more
}

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

/** Tab and Shift+Tab stay inside `root` (§9.22): the last focusable wraps to the first. */
export function wrapTab(e: React.KeyboardEvent, root: HTMLElement | null): void {
  if (e.key !== 'Tab' || !root) return
  const focusable = [
    ...root.querySelectorAll<HTMLElement>(
      'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
    )
  ].filter((el) => el.offsetParent !== null || el === document.activeElement)
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
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
 * a panel anchored under it – radius 12, padding 6, 28 px rows, the current option checked. On a
 * phone the trigger opens a sheet of 44 px radio rows (`MenuSheet`); picking one closes it.
 * Never a native `<select>` popup. A `value` no option carries (a required choice not made yet,
 * `''`) shows `placeholder` at 69% and checks nothing.
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
  const [open, setOpen] = useState(false)
  const surface = `autofill-menu-${useId()}`
  useBackSurface(open ? { name: surface, onCommit: () => setOpen(false) } : null)
  // Radix shows the placeholder for '' and never lists it: an unmade choice is exactly that.
  const chosen = options.some((o) => o.value === value) ? value : ''
  return (
    <SelectPrimitive.Root
      value={chosen}
      open={open}
      onOpenChange={setOpen}
      onValueChange={(v) => onChange(v as T)}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        id={id}
        aria-label={label}
        className={cn('zen-v2-af-menulist', className)}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon asChild>
          <ChevronDown aria-hidden />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          side="bottom"
          align="start"
          sideOffset={0}
          collisionPadding={8}
          className="zen-v2-af zen-v2-af-menu zen-animate-pop"
          data-surface="page"
        >
          <SelectPrimitive.Viewport>
            {options.map((o) => (
              <SelectPrimitive.Item key={o.value} value={o.value} className="zen-v2-af-menu-item">
                <SelectPrimitive.ItemText>{o.label}</SelectPrimitive.ItemText>
                <SelectPrimitive.ItemIndicator>
                  <Check aria-hidden />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
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
 * along as a `description`: the sheet then opens with a §9.23 title block in place of the 48
 * header. Inside another sheet it is stacked: its scrim is transparent and the sheet below keeps
 * the one it has.
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
  const stacked = useContext(InSheet)
  const name = useId()
  const titleId = useId()
  useBackSurface({
    name: `autofill-menu-${name}`,
    onProgress: (p) => sheet.current?.backProgress(p),
    onCommit: () => sheet.current?.commitBack(),
    onCancel: () => sheet.current?.cancelBack()
  })
  useEscape(() => sheet.current?.dismiss())
  // A long list (countries) opens on the current option, the way a menulist's popup does.
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    list.current
      ?.querySelector<HTMLInputElement>('input:checked')
      ?.closest('label')
      ?.scrollIntoView({ block: 'center' })
  }, [])
  // In the body like every sheet: a layer inside another sheet's transformed box would not be
  // fixed to the viewport, and the stacked recede reads the layers as siblings (main.css).
  return createPortal(
    <BottomSheet
      ref={sheet}
      onDismissed={onClose}
      handleLabel="Dismiss"
      className={cn('zen-v2-af zen-v2-af-sheet', stacked && 'zen-v2-af-sheet-stacked')}
      header={
        description ? (
          <TitleBlock id={titleId} title={title} description={description} />
        ) : (
          <SheetHeader id={titleId} title={title} />
        )
      }
    >
      <div className="zen-v2-af zen-v2-af-choices" data-surface="page">
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
