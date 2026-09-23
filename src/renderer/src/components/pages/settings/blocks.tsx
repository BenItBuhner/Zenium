import type { CSSProperties, JSX, KeyboardEvent, ReactNode } from 'react'
import { useContext, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, CircleAlert, Copy, Globe } from 'lucide-react'
import type {
  ContainerColor,
  ContainerIcon as ContainerIconName,
  ResourceGauge,
  SearchEngine,
  Space
} from '@shared/types'
import {
  APP_ICON_DESKTOP,
  APP_ICON_INK,
  APP_ICON_MARK,
  APP_ICON_VARIANTS,
  squirclePath,
  type AppIconId,
  type AppIconVariant
} from '@shared/appIcon'
import { CONTAINER_COLORS, CONTAINER_ICONS, spaceLabel } from '@shared/defaults'
import { formatZoom } from '@shared/pageControls'
import { engineKeywordProblem, searchTemplateProblem } from '@shared/search'
import { inputToUrl } from '@shared/url'
import { cn } from '@renderer/lib/utils'
import { ContainerIcon } from '../../ContainerIcon'
import { ZoomStepper } from '../../ZoomStepper'
import { SheetFooterContext } from './sheetContext'

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

const ICON_VIEW = 100
const ICON_RING_OUTER = ICON_VIEW * APP_ICON_DESKTOP.ringOuter

/** The desktop icon as vector art, from the same geometry the generated assets come from. */
export function AppIconImage({
  variant,
  className
}: {
  variant: AppIconVariant
  className?: string
}): JSX.Element {
  return (
    <svg
      viewBox={`0 0 ${ICON_VIEW} ${ICON_VIEW}`}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path d={squirclePath(ICON_VIEW)} fill={variant.fill} />
      <circle
        cx={ICON_VIEW / 2}
        cy={ICON_VIEW / 2}
        r={ICON_RING_OUTER * APP_ICON_MARK.ring}
        fill="none"
        stroke={APP_ICON_INK}
        strokeWidth={ICON_RING_OUTER * APP_ICON_MARK.stroke}
      />
      <circle
        cx={ICON_VIEW / 2}
        cy={ICON_VIEW / 2}
        r={ICON_RING_OUTER * APP_ICON_MARK.dot}
        fill={APP_ICON_INK}
      />
    </svg>
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

/**
 * §9.12's validation text: 13 in the danger ink with a 16 px glyph, under the field. `id` lets
 * the field it belongs to name it (`aria-describedby`), so a reader on the field hears the error.
 */
export function ValidationMessage({ message, id }: { message: string; id?: string }): JSX.Element {
  return (
    <span className="zen-settings-validation" role="alert" id={id}>
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

/**
 * The two footer actions of a sheet (§9.11): peers splitting the width, the primary trailing.
 * While the form is busy (§9.30) the primary is the shared busy button – full opacity, its
 * label kept in the flow unpainted under the 16 px `.zen-v2-spinner`, `aria-busy` – the
 * secondary waits at .4, and neither takes a press.
 */
export function SheetActions({
  cancel,
  action,
  destructive = false,
  disabled = false,
  busy = false,
  onCancel,
  onAction
}: {
  cancel?: string
  action: string
  destructive?: boolean
  disabled?: boolean
  busy?: boolean
  onCancel: () => void
  onAction: () => void
}): JSX.Element {
  return (
    <div className="zen-settings-sheet-actions" data-busy={busy || undefined}>
      <button type="button" className="zen-v2-button" onClick={busy ? undefined : () => onCancel()}>
        {cancel ?? 'Cancel'}
      </button>
      <button
        type="button"
        className={cn('zen-v2-button', destructive && 'zen-settings-danger-button')}
        data-primary={destructive ? undefined : true}
        disabled={disabled}
        aria-busy={busy || undefined}
        onClick={busy ? undefined : onAction}
      >
        {busy ? (
          <>
            <span className="zen-v2-button-label">{action}</span>
            <span className="zen-v2-spinner" aria-hidden="true" />
          </>
        ) : (
          action
        )}
      </button>
    </div>
  )
}

/**
 * A form's actions in the sheet's footer (§9.11), outside the body that scrolls: claims the
 * chassis's footer slot (`SheetFooterContext`) and portals its children there – the phone's
 * `.zen-sheet-footer` under the body, the dialog's last block – so the site-data viewer's Clear
 * all stays in reach at the foot of a thousand rows. Outside a Settings sheet or dialog the
 * actions draw in place, as `SheetActions` do.
 */
export function SheetFooter({ children }: { children: ReactNode }): JSX.Element | null {
  const slot = useContext(SheetFooterContext)
  const claim = slot?.claim
  useEffect(() => claim?.(), [claim])
  if (!slot) return <div className="zen-settings-sheet-actions">{children}</div>
  if (!slot.element) return null
  return createPortal(children, slot.element)
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

/**
 * One §9.14 radio option: a 20 px circle, the label to its right, the whole row the target. A
 * `leading` glyph (an engine's favicon) sits between the circle and the label. `font` – a CSS
 * `font-family` value – draws the label in that face (a font picker's row is its own sample).
 */
export function RadioOption({
  label,
  description,
  leading,
  font,
  checked,
  onSelect
}: {
  label: string
  description?: string
  leading?: ReactNode
  font?: string
  checked: boolean
  onSelect: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={cn(
        'zen-settings-row zen-settings-radio-row zen-v2-row',
        font && 'zen-settings-font-option'
      )}
      style={font ? ({ '--zen-settings-option-font': font } as CSSProperties) : undefined}
      onClick={onSelect}
    >
      <span className="zen-v2-radio" aria-hidden="true" />
      {leading && (
        <span className="zen-settings-leading" aria-hidden="true">
          {leading}
        </span>
      )}
      <span className="zen-settings-row-text">
        <span className="zen-settings-label">{label}</span>
        {description && <span className="zen-settings-description">{description}</span>}
      </span>
    </button>
  )
}

/**
 * A search engine's mark in a row's 16 px glyph slot: its favicon where a page offered one (an
 * OpenSearch engine), else the letter the URL bar shows for it, in a small disc.
 */
export function EngineGlyph({ engine }: { engine: SearchEngine }): JSX.Element {
  const [broken, setBroken] = useState(false)
  if (engine.favicon && !broken) {
    return (
      <img
        src={engine.favicon}
        alt=""
        className="zen-settings-glyph zen-settings-engine-favicon"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    )
  }
  return <span className="zen-settings-engine-glyph">{engine.glyph}</span>
}

/**
 * A page's favicon in a row's 16 px glyph slot (Tabs from other devices), the engine glyph's
 * frame; the globe the history rows fall back to when the page offered none or it failed to load.
 * Remembering *which* address failed makes a new one try again without an effect.
 */
export function FaviconGlyph({ src }: { src: string | null | undefined }): JSX.Element {
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null)
  if (!src || brokenSrc === src) return <Globe className="zen-settings-glyph" aria-hidden="true" />
  return (
    <img
      src={src}
      alt=""
      className="zen-settings-glyph zen-settings-engine-favicon"
      referrerPolicy="no-referrer"
      draggable={false}
      onError={() => setBrokenSrc(src)}
    />
  )
}

/** What the search-engine form submits: the three fields, trimmed, the shortcut as typed. */
export interface SearchEngineFormValues {
  name: string
  /** The template, `%s` where the terms go (`searchTemplateProblem` has passed it). */
  url: string
  /**
   * The shortcut as typed, `@` or not; the engine keeps it as `@word`, lower case. Empty when
   * an engine is added without one: the engine derives its keyword from the name
   * (`customSearchEngine`), as the core does today for every engine it adds.
   */
  shortcut: string
}

/**
 * Search › Add search engine and › Edit search engine, one form (Chrome's, W4-10): a name, the
 * shortcut typed in the address bar before a space (Chrome's Shortcut column) and the search URL
 * with `%s` where the terms go, each checked once it is left or on Enter (§9.12's leave-then-
 * check) by the engine's own rules in `shared/search.ts` – the shortcut through
 * `engineKeywordProblem` against `engines`, the list the caller holds (one word, `@` or not,
 * at most 64 characters as `normalizeEngineKeyword` keeps it, not one of Zenium's own scopes,
 * not a word another engine answers to – the engine being edited, `engineId`, excepted, its
 * own word being its own), the template through `searchTemplateProblem` – each field by its
 * own leaving, so leaving the shortcut does not set the URL speaking as it is typed – the
 * button held until the name and the template are in. The line a field shows is its
 * description (`aria-describedby`) for a reader on the field, the sheet's own pattern
 * (`FieldSheet`). `initial` fills the fields from the engine being edited; the verb is the
 * caller's – "Add" for a new engine, "Save" for an edit – as the sheet's title is. The
 * shortcut is the one field that may be left empty, and only when adding: the engine derives a
 * keyword from the name then, and the core's `search.addEngine` takes none yet, so a word the
 * form insisted on would be typed to be dropped; a typed word is checked whichever the form
 * is. Editing, the engine's own word stands in the field and an empty one is refused – an
 * engine never holds one (#409's edit path, where the word is kept): "Give the engine a
 * shortcut" once the field is left or the form is submitted, and on submit the focus goes to
 * the field (§9.12's line on submit – a held button that answers Enter with nothing is the
 * failure the section names; the #419 lead check's ruling 1). The caller adds or saves, and
 * the sheet closes; what it refuses shows as the form's validation line.
 */
export function SearchEngineForm({
  initial,
  action,
  engines,
  engineId,
  onSubmit,
  close
}: {
  /** The engine being edited, as the fields start; absent, the form adds one. */
  initial?: SearchEngineFormValues
  /** The primary button's verb: "Add" for a new engine, "Save" for an edit. */
  action: string
  /** Every engine of the profile, for the shortcut's uniqueness (`engineKeywordProblem`). */
  engines: readonly SearchEngine[]
  /**
   * The id of the engine being edited, whose own word is no collision; absent when adding –
   * the engine has no id yet, and every engine's word is another's.
   */
  engineId?: string
  onSubmit: (values: SearchEngineFormValues) => Promise<unknown> | void
  close: () => void
}): JSX.Element {
  const [name, setName] = useState(initial?.name ?? '')
  const [shortcut, setShortcut] = useState(initial?.shortcut ?? '')
  const [url, setUrl] = useState(initial?.url ?? '')
  const [error, setError] = useState<string | null>(null)
  // One flag a field: the shortcut's leaving speaks for the shortcut alone, the URL's for the URL
  // (§9.12 – a field is checked once it is left, not as the next one is typed); Enter sets both.
  const [touchedShortcut, setTouchedShortcut] = useState(false)
  const [touchedUrl, setTouchedUrl] = useState(false)
  const shortcutInput = useRef<HTMLInputElement>(null)
  // Adding, the engine has no id: the helper is given one no engine has (`sanitizeSearchEngine`
  // keeps none empty), and every engine's word is another's.
  const shortcutProblem = engineKeywordProblem(shortcut, engineId ?? '', engines)
  const urlProblem = searchTemplateProblem(url)
  // Adding, an empty shortcut is the engine's to derive; editing, the engine's word stays a word.
  const shortcutMissing = initial !== undefined && !shortcut.trim()
  const ready = Boolean(name.trim()) && !shortcutMissing && !shortcutProblem && !urlProblem
  const submit = (): void => {
    if (!ready) {
      setTouchedShortcut(true)
      setTouchedUrl(true)
      // The emptied shortcut of an edit speaks on submit and takes the focus (§9.12; ruling 1).
      if (shortcutMissing) shortcutInput.current?.focus()
      return
    }
    void Promise.resolve(
      onSubmit({ name: name.trim(), url: url.trim(), shortcut: shortcut.trim() })
    )
      .then(close)
      .catch((e: unknown) =>
        setError(e instanceof Error ? e.message : `Could not ${action.toLowerCase()} the engine`)
      )
  }
  const onEnter = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') submit()
  }
  // The shortcut's line once the field is left or the form submitted: the word's problem while
  // there is a word (`engineKeywordProblem` has none for an empty field); editing, "Give the
  // engine a shortcut" for none – the one empty that speaks.
  const shortcutLine = shortcutMissing ? 'Give the engine a shortcut' : shortcutProblem
  const shownShortcut = touchedShortcut ? shortcutLine : null
  const shownUrl = error ?? (touchedUrl && url.trim() ? urlProblem : null)
  return (
    <div className="zen-settings-form" data-testid="search-engine-form">
      <Field id="search-engine-name" label="Name">
        <input
          id="search-engine-name"
          className="zen-settings-input zen-v2-field"
          placeholder="Wikipedia"
          autoCapitalize="words"
          autoCorrect="off"
          spellCheck={false}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
          onKeyDown={onEnter}
        />
      </Field>
      <Field
        id="search-engine-shortcut"
        label="Shortcut"
        description={
          shownShortcut
            ? undefined
            : 'Type it in the address bar, then a space, to search with this engine.'
        }
      >
        <input
          ref={shortcutInput}
          id="search-engine-shortcut"
          className="zen-settings-input zen-v2-field"
          placeholder="@wikipedia"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={shownShortcut ? true : undefined}
          aria-describedby={shownShortcut ? 'search-engine-shortcut-error' : undefined}
          value={shortcut}
          onChange={(e) => {
            setShortcut(e.target.value)
            setError(null)
          }}
          onBlur={() => setTouchedShortcut(true)}
          onKeyDown={onEnter}
        />
        {shownShortcut && (
          <ValidationMessage id="search-engine-shortcut-error" message={shownShortcut} />
        )}
      </Field>
      <Field
        id="search-engine-url"
        label="URL with %s in place of query"
        description={
          shownUrl ? undefined : 'Example: https://en.wikipedia.org/w/index.php?search=%s'
        }
      >
        <input
          id="search-engine-url"
          className="zen-settings-input zen-v2-field"
          placeholder="https://example.com/search?q=%s"
          inputMode="url"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={shownUrl ? true : undefined}
          aria-describedby={shownUrl ? 'search-engine-url-error' : undefined}
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setError(null)
          }}
          onBlur={() => setTouchedUrl(true)}
          onKeyDown={onEnter}
        />
        {shownUrl && <ValidationMessage id="search-engine-url-error" message={shownUrl} />}
      </Field>
      <SheetActions action={action} disabled={!ready} onCancel={close} onAction={submit} />
    </div>
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
 * Languages › Spell check › Custom dictionary › Add a new word (Chrome's "Customize spell
 * check"): one word without spaces, refused with the field's own message otherwise, when it is
 * there already, or when the host declines it; the sheet closes once the word is in.
 */
export function WordForm({
  problem,
  onAdd,
  close
}: {
  /** Why the typed word cannot go in yet, or nothing (`wordProblem`). */
  problem: (word: string) => string | undefined
  onAdd: (word: string) => Promise<string | undefined>
  close: () => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const word = value.trim()
  const shown = error ?? (word ? (problem(word) ?? null) : null)
  const ready = Boolean(word) && !shown && !busy
  const submit = (): void => {
    if (!ready) return
    setBusy(true)
    void onAdd(word)
      .then((refusal) => {
        if (refusal) setError(refusal)
        else close()
      })
      .catch(() => setError('This word could not be added'))
      .finally(() => setBusy(false))
  }
  return (
    <div className="zen-settings-form" data-testid="word-form">
      <Field
        id="dictionary-word"
        label="Add a new word"
        description={shown ? undefined : 'The checker never marks it.'}
      >
        <input
          id="dictionary-word"
          className="zen-settings-input zen-v2-field"
          placeholder="colour"
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={shown ? true : undefined}
          readOnly={busy}
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        {shown && <ValidationMessage message={shown} />}
      </Field>
      <SheetActions action="Add" disabled={!ready} busy={busy} onCancel={close} onAction={submit} />
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

/**
 * Resources › Live usage: a gauge as a 4 px bar at radius 2 in --v2-fill, the used part in the
 * accent – the warning ink from 85 % of a budget, the danger ink at 100 % – with the label and
 * the numbers on the line above it and a note under. No budget draws the bar against `fallbackMax`
 * at half strength; a fallback of 0 draws no bar.
 */
export function ResourceMeter({
  label,
  gauge,
  fallbackMax,
  format,
  note
}: {
  label: string
  gauge: ResourceGauge
  /** Scale for the bar when there is no budget (0 = no bar). */
  fallbackMax: number
  format: (v: number) => string
  note?: string
}): JSX.Element {
  const max = gauge.budget > 0 ? gauge.budget : fallbackMax
  const pct = max > 0 ? (gauge.used / max) * 100 : 0
  const tone =
    gauge.budget === 0 ? 'unbudgeted' : pct >= 100 ? 'over' : pct >= 85 ? 'near' : undefined
  return (
    <div className="zen-settings-meter" data-tone={tone}>
      <div className="zen-settings-meter-head">
        <span className="zen-settings-label">{label}</span>
        <span className="zen-settings-meter-value">
          {format(gauge.used)}
          {gauge.budget > 0 ? ` / ${format(gauge.budget)}` : ' · no limit'}
          {gauge.budget > 0 && gauge.budget !== gauge.configured
            ? ` (${format(gauge.configured)} on mains)`
            : ''}
        </span>
      </div>
      {max > 0 && (
        <div
          className="zen-settings-progress zen-settings-meter-bar"
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(Math.max(0, Math.min(100, pct)))}
        >
          <div style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
        </div>
      )}
      {note && (
        <span className="zen-settings-description zen-settings-description-full">{note}</span>
      )}
    </div>
  )
}
