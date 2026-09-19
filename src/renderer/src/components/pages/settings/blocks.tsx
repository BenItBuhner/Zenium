import type { CSSProperties, JSX, ReactNode } from 'react'
import { useState } from 'react'
import { Check, CircleAlert, Copy } from 'lucide-react'
import type { ContainerColor, ContainerIcon as ContainerIconName, Space } from '@shared/types'
import { APP_ICON_VARIANTS, type AppIconId } from '@shared/appIcon'
import { CONTAINER_COLORS, CONTAINER_ICONS, spaceLabel } from '@shared/defaults'
import { formatZoom } from '@shared/pageControls'
import { inputToUrl } from '@shared/url'
import { cn } from '@renderer/lib/utils'
import { ContainerIcon } from '../../ContainerIcon'
import { ZoomStepper } from '../../ZoomStepper'
import { AppIconImage } from '../../overlays/AppIconPicker'

/**
 * The blocks of the phone Settings page that are not rows (v2 §10.4's image radio cards and the
 * few forms): each sits in the page's 16 px gutter and reads the `--v2-*` tokens through the
 * `zen-settings-*` classes in main.css.
 */

/** Every app-icon colour as the icon itself; the picked one wears the 2 px accent outline. */
export function AppIconGrid({
  value,
  onChange
}: {
  value: AppIconId
  onChange: (id: AppIconId) => void
}): JSX.Element {
  return (
    <div role="radiogroup" aria-label="App icon colour" className="zen-settings-icon-grid">
      {APP_ICON_VARIANTS.map((variant) => (
        <button
          key={variant.id}
          type="button"
          role="radio"
          aria-checked={variant.id === value}
          aria-label={`${variant.name} app icon`}
          className="zen-settings-icon-card zen-v2-card-radio"
          onClick={() => onChange(variant.id)}
        >
          <AppIconImage variant={variant} className="zen-settings-app-icon" />
          <span className="zen-settings-icon-caption">{variant.name}</span>
        </button>
      ))}
    </div>
  )
}

/** A container's colour as a row of swatches. */
export function ColourSwatches({
  value,
  onChange
}: {
  value: ContainerColor
  onChange: (colour: ContainerColor) => void
}): JSX.Element {
  return (
    <div role="radiogroup" aria-label="Colour" className="zen-settings-swatches">
      {(Object.keys(CONTAINER_COLORS) as ContainerColor[]).map((colour) => (
        <button
          key={colour}
          type="button"
          role="radio"
          aria-checked={colour === value}
          aria-label={colour}
          className="zen-settings-swatch zen-v2-card-radio"
          style={{ background: CONTAINER_COLORS[colour] }}
          onClick={() => onChange(colour)}
        />
      ))}
    </div>
  )
}

/** A container's glyph as a grid of glyph tiles in the chosen colour. */
export function IconGrid({
  value,
  colour,
  onChange
}: {
  value: ContainerIconName
  colour: ContainerColor
  onChange: (icon: ContainerIconName) => void
}): JSX.Element {
  return (
    <div role="radiogroup" aria-label="Icon" className="zen-settings-swatches">
      {CONTAINER_ICONS.map((icon) => (
        <button
          key={icon}
          type="button"
          role="radio"
          aria-checked={icon === value}
          aria-label={icon}
          className="zen-settings-glyph-tile zen-v2-card-radio"
          onClick={() => onChange(icon)}
        >
          <ContainerIcon container={{ icon, color: colour }} size={20} />
        </button>
      ))}
    </div>
  )
}

/**
 * Accessibility › Default zoom: the value, the stepper along Chrome's zoom table between its two
 * 44 px step buttons (§10.3), and sample text at the size pages will open at (the system font
 * size folded in when the setting says so) – plain body text scaled whole, its line box with it,
 * no box of its own. The stepper is the §10.4 slider row the page zoom sheet draws – the same
 * v2 icon buttons and the same `zen-zoom-slider` track and thumb – so the two zoom controls
 * are one control.
 */
export function ZoomBlock({
  value,
  previewFactor,
  onChange
}: {
  value: number
  /** `value` times whatever else scales the page (the OS font size), for the sample. */
  previewFactor: number
  onChange: (factor: number) => void
}): JSX.Element {
  return (
    <div className="zen-settings-zoom-block">
      <div className="zen-settings-zoom-head">
        <span className="zen-settings-label">Default zoom</span>
        <span className="zen-settings-zoom-value">{formatZoom(value)}</span>
      </div>
      <span className="zen-settings-description">
        Sites without a zoom of their own open at this size.
      </span>
      <ZoomStepper
        value={value}
        onChange={onChange}
        className="zen-settings-zoom-stepper"
        stepClassName="zen-v2-icon-button"
        sliderClassName="zen-zoom-slider"
      />
      <p
        className="zen-settings-zoom-preview"
        aria-hidden="true"
        style={{ '--zen-settings-zoom-sample': previewFactor } as CSSProperties}
      >
        Text on pages will be this size.
      </p>
    </div>
  )
}

/** §9.12's validation text: 13 in the danger ink with a 16 px glyph, under the field. */
export function ValidationMessage({ message }: { message: string }): JSX.Element {
  return (
    <span className="zen-settings-validation" role="alert">
      <CircleAlert aria-hidden="true" />
      {message}
    </span>
  )
}

/** Updates: what the checker found, as a headline and a detail line, with the download's bar. */
export function UpdateStatusBlock({
  headline,
  detail,
  progress
}: {
  headline: string
  detail: string
  /** Percent while a download runs; null otherwise. */
  progress: number | null
}): JSX.Element {
  return (
    <div className="zen-settings-update-status" role="status">
      <span className="zen-settings-label">{headline}</span>
      <span className="zen-settings-description zen-settings-description-full">{detail}</span>
      {progress !== null && <ProgressBar percent={progress} />}
    </div>
  )
}

/** An update download's progress. */
export function ProgressBar({ percent }: { percent: number }): JSX.Element {
  return (
    <div
      className="zen-settings-progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(percent)}
    >
      <div style={{ width: `${Math.max(2, Math.min(100, percent))}%` }} />
    </div>
  )
}

/**
 * A value to copy (an endpoint, a token): label, the value – a secret in the platform monospace
 * (§4's one use of it), masked until Show; anything else as selectable body text – and the
 * inline Copy, the one place §10.4 keeps a button in a row, because the copy needs its "Copied"
 * state.
 */
export function CopyRow({
  label,
  value,
  secret = false
}: {
  label: string
  value: string
  secret?: boolean
}): JSX.Element {
  const [revealed, setRevealed] = useState(!secret)
  return (
    <div className="zen-settings-copy-row">
      <div className="zen-settings-copy-text">
        <span className="zen-settings-label">{label}</span>
        {secret ? (
          <code className="zen-settings-copy-value zen-settings-mono">
            {revealed ? value : '•'.repeat(Math.min(32, value.length))}
          </code>
        ) : (
          <span className="zen-settings-copy-value">{value}</span>
        )}
      </div>
      <div className="zen-settings-inline-actions">
        {secret && (
          <button type="button" className="zen-v2-button" onClick={() => setRevealed((r) => !r)}>
            {revealed ? 'Hide' : 'Show'}
          </button>
        )}
        <CopyButton value={value} />
      </div>
    </div>
  )
}

export function CopyButton({
  value,
  label = 'Copy'
}: {
  value: string
  label?: string
}): JSX.Element {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="zen-v2-button"
      aria-label={copied ? 'Copied' : label}
      onClick={() => {
        void navigator.clipboard?.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
    >
      {copied ? (
        <Check className="h-4 w-4" strokeWidth={1.75} />
      ) : (
        <Copy className="h-4 w-4" strokeWidth={1.75} />
      )}
      <span className="ml-1.5">{copied ? 'Copied' : label}</span>
    </button>
  )
}

/** A configuration snippet with its copy button. */
export function CodeBlock({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="zen-settings-code">
      <div className="zen-settings-code-head">
        <span className="zen-settings-label">{label}</span>
        <CopyButton value={value} />
      </div>
      <pre className="zen-settings-pre">{value}</pre>
    </div>
  )
}

/** A mod's CSS, edited in place; saved when the field loses focus. */
export function CssEditor({
  value,
  onCommit
}: {
  value: string
  onCommit: (css: string) => void
}): JSX.Element {
  const [css, setCss] = useState(value)
  return (
    <textarea
      value={css}
      spellCheck={false}
      aria-label="CSS"
      className="zen-settings-textarea zen-v2-field"
      onChange={(e) => setCss(e.target.value)}
      onBlur={() => css !== value && onCommit(css)}
    />
  )
}

/** The two footer actions of a sheet (§9.11): peers splitting the width, the primary trailing. */
export function SheetActions({
  cancel,
  action,
  destructive = false,
  disabled = false,
  onCancel,
  onAction
}: {
  cancel?: string
  action: string
  destructive?: boolean
  disabled?: boolean
  onCancel: () => void
  onAction: () => void
}): JSX.Element {
  return (
    <div className="zen-settings-sheet-actions">
      <button type="button" className="zen-v2-button" onClick={onCancel}>
        {cancel ?? 'Cancel'}
      </button>
      <button
        type="button"
        className={cn('zen-v2-button', destructive && 'zen-settings-danger-button')}
        data-primary={destructive ? undefined : true}
        disabled={disabled}
        onClick={onAction}
      >
        {action}
      </button>
    </div>
  )
}

/** A labelled field (§9.12): label above, 4 px, the field, an optional description under it. */
export function Field({
  id,
  label,
  description,
  children
}: {
  id: string
  label: string
  description?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="zen-settings-field-block">
      <label htmlFor={id} className="zen-settings-label">
        {label}
      </label>
      {children}
      {description && <span className="zen-settings-description">{description}</span>}
    </div>
  )
}

/** Space Routing › Add route: a domain and the Space its links open in. */
export function AddRouteForm({
  spaces,
  onAdd,
  close
}: {
  spaces: Space[]
  onAdd: (domain: string, spaceId: string) => void
  close: () => void
}): JSX.Element {
  const [domain, setDomain] = useState('')
  const [spaceId, setSpaceId] = useState(spaces[0]?.id ?? '')
  const cleaned = domain
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
  return (
    <div className="zen-settings-form">
      <Field id="route-domain" label="Domain">
        <input
          id="route-domain"
          className="zen-settings-input zen-v2-field"
          placeholder="example.com"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
        />
      </Field>
      <div role="radiogroup" aria-label="Space" className="zen-settings-radio-list">
        <span className="zen-settings-label">Space</span>
        {spaces.map((space) => (
          <RadioOption
            key={space.id}
            label={spaceLabel(space)}
            checked={space.id === spaceId}
            onSelect={() => setSpaceId(space.id)}
          />
        ))}
      </div>
      <SheetActions
        action="Add route"
        disabled={!cleaned || !spaceId}
        onCancel={close}
        onAction={() => {
          onAdd(cleaned, spaceId)
          close()
        }}
      />
    </div>
  )
}

/** Containers › New container: name, colour and glyph. */
export function NewContainerForm({
  onCreate,
  close
}: {
  onCreate: (name: string, colour: ContainerColor, icon: ContainerIconName) => void
  close: () => void
}): JSX.Element {
  const [name, setName] = useState('')
  const [colour, setColour] = useState<ContainerColor>('blue')
  const [icon, setIcon] = useState<ContainerIconName>('circle')
  return (
    <div className="zen-settings-form">
      <Field id="container-name" label="Name">
        <input
          id="container-name"
          className="zen-settings-input zen-v2-field"
          placeholder="Work"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="zen-settings-field-block">
        <span className="zen-settings-label">Colour</span>
        <ColourSwatches value={colour} onChange={setColour} />
      </div>
      <div className="zen-settings-field-block">
        <span className="zen-settings-label">Icon</span>
        <IconGrid value={icon} colour={colour} onChange={setIcon} />
      </div>
      <SheetActions
        action="Create"
        disabled={!name.trim()}
        onCancel={close}
        onAction={() => {
          onCreate(name.trim(), colour, icon)
          close()
        }}
      />
    </div>
  )
}

/** One §9.14 radio option: a 20 px circle, the label to its right, the whole row the target. */
export function RadioOption({
  label,
  description,
  checked,
  onSelect
}: {
  label: string
  description?: string
  checked: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className="zen-settings-row zen-settings-radio-row zen-v2-row"
      onClick={onSelect}
    >
      <span className="zen-v2-radio" aria-hidden="true" />
      <span className="zen-settings-row-text">
        <span className="zen-settings-label">{label}</span>
        {description && <span className="zen-settings-description">{description}</span>}
      </span>
    </button>
  )
}

/** One URL-shaped field and a primary action (import a Mod, install from the store). */
export function UrlForm({
  id,
  label,
  placeholder,
  action,
  onSubmit,
  close
}: {
  id: string
  label: string
  placeholder?: string
  action: string
  onSubmit: (value: string) => void
  close: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const trimmed = value.trim()
  const submit = (): void => {
    if (!trimmed) return
    onSubmit(trimmed)
    close()
  }
  return (
    <div className="zen-settings-form">
      <Field id={id} label={label}>
        <input
          id={id}
          className="zen-settings-input zen-v2-field"
          placeholder={placeholder}
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
      </Field>
      <SheetActions action={action} disabled={!trimmed} onCancel={close} onAction={submit} />
    </div>
  )
}

/**
 * The §9.12 form of a new tab page shortcut (Settings › New Tab › Add shortcut): a name and an
 * address, the address read as the URL bar reads typed text (`inputToUrl`), the button held
 * until it makes a URL – the desktop's inline form, as a sheet.
 */
export function ShortcutForm({
  onSubmit,
  close
}: {
  onSubmit: (title: string, url: string) => void
  close: () => void
}): JSX.Element {
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const valid = Boolean(inputToUrl(url.trim()))
  const submit = (): void => {
    if (!valid) return
    onSubmit(title.trim(), url.trim())
    close()
  }
  return (
    <div className="zen-settings-form">
      <Field id="shortcut-name" label="Name">
        <input
          id="shortcut-name"
          className="zen-settings-input zen-v2-field"
          placeholder="Name"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </Field>
      <Field id="shortcut-url" label="Address">
        <input
          id="shortcut-url"
          className="zen-settings-input zen-v2-field"
          placeholder="example.com"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
      </Field>
      <SheetActions action="Add" disabled={!valid} onCancel={close} onAction={submit} />
    </div>
  )
}
