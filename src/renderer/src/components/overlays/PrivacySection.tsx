import type { JSX, ReactNode } from 'react'
import { useId, useLayoutEffect, useRef, useState } from 'react'
import {
  CircleAlert,
  ExternalLink,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  ShieldOff,
  Trash2
} from 'lucide-react'
import type { Settings, UIState } from '@shared/types'
import {
  customListId,
  normalizeSiteException,
  siteOriginOf,
  TRACKING_LEVEL_LABELS,
  type BlockingSettings,
  type FilterListStatus,
  type TrackingLevel
} from '@shared/blocking'
import { run } from '@renderer/lib/api'
import {
  exceptionHost,
  listDetail,
  listOverrides,
  requests,
  statusCardText
} from '@renderer/lib/blockingUi'
import { activeTab } from '@renderer/lib/selectors'
import { cn, relativeTime } from '@renderer/lib/utils'
import { useViewport } from '@renderer/lib/formFactor'

const LEVELS: TrackingLevel[] = ['off', 'basic', 'balanced', 'strict']

/**
 * Settings > Privacy and Security (design-language-v2-draft §1–§3, §6, §9). The request
 * engine's master switch and tracking-prevention level, the filter lists it runs with their
 * freshness and a manual refresh, the user's own lists and filters, and the sites where nothing
 * is blocked. The master switch and the exceptions are decisions of the `ads` permission, so they
 * go through `blocking.setEnabled` / `blocking.setSiteException` rather than the settings patch;
 * counters come from core state (`blocking.sessionBlocked`, `tab.blockedCount`).
 */
export function PrivacySection({
  state,
  set
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
}): JSX.Element {
  const b = state.settings.blocking
  const status = state.blocking
  const setB = (patch: Partial<BlockingSettings>): void => set({ blocking: { ...b, ...patch } })
  const active = status.enabled && b.level !== 'off'
  const tab = activeTab(state)
  const origin = tab ? siteOriginOf(tab.url) : null
  const page = tab && origin ? { blocked: tab.blockedCount, site: exceptionHost(origin) } : null
  const text = statusCardText(status, active, page, relativeTime)
  const defaults = status.lists.filter((l) => l.tier !== null)
  const custom = status.lists.filter((l) => l.tier === null)
  const StatusIcon = !active ? ShieldOff : status.ready ? ShieldCheck : Shield

  return (
    <div className="zen-privacy">
      <div className="flex flex-col gap-2">
        <h2 className="zen-privacy-title">Privacy and Security</h2>
        <p className="zen-privacy-muted">
          Zenium blocks ads, trackers and malware hosts before a page can load them, with the same
          open filter lists uBlock Origin uses. Blocking runs on every page, in private windows and
          in containers, and pages load faster for it.
        </p>
      </div>

      <section className="zen-privacy-card zen-privacy-status" aria-live="polite">
        <StatusIcon className={cn(!active && 'zen-privacy-muted')} aria-hidden />
        <div className="zen-privacy-status-text min-w-0 flex-1">
          <div className="zen-privacy-card-title">{text.headline}</div>
          <div className="zen-privacy-muted">{text.detail}</div>
        </div>
        <button
          type="button"
          className="zen-v2-button zen-privacy-status-action inline-flex shrink-0 items-center gap-2"
          disabled={!active || status.updating}
          onClick={() => run('blocking.updateLists', {})}
        >
          <RefreshCw className={cn('h-4 w-4', status.updating && 'zen-spin')} aria-hidden />
          Update lists
        </button>
      </section>

      <Section heading="Tracking prevention">
        <div className="zen-privacy-rows">
          <CheckRow
            label="Block ads and trackers"
            description="The master switch. Off lets every request through and keeps your lists and sites."
            checked={status.enabled}
            onChange={(enabled) => run('blocking.setEnabled', { enabled })}
          />
          <CheckRow
            label="Update lists automatically"
            description="Refreshes the lists from their canonical URLs about every four days, as uBlock Origin does."
            checked={b.autoUpdate}
            disabled={!status.enabled}
            onChange={(autoUpdate) => setB({ autoUpdate })}
          />
        </div>
      </Section>

      <Section heading="Level">
        <div className="zen-privacy-rows" role="radiogroup" aria-label="Tracking prevention level">
          {LEVELS.map((id) => (
            <LevelRow
              key={id}
              level={id}
              checked={b.level === id}
              disabled={!status.enabled}
              onPick={() => setB({ level: id })}
            />
          ))}
        </div>
        {b.level === 'strict' && status.enabled && (
          <p className="zen-privacy-warn">
            Strict blocks the most, and some sites, videos or logins may stop working. When one
            does, add it to the sites below.
          </p>
        )}
      </Section>

      <Section heading="Filter lists">
        <div className="zen-privacy-card">
          {defaults.map((l) => (
            <ListRow
              key={l.id}
              list={l}
              disabled={!active}
              onToggle={(on) => setB({ lists: listOverrides(b, l.id, on) })}
            />
          ))}
        </div>
      </Section>

      <CustomLists lists={custom} settings={b} disabled={!active} setB={setB} />

      <UserFilters settings={b} errors={status.userFilterErrors} setB={setB} />

      <Section heading="Sites without blocking">
        <div className="zen-privacy-card">
          {tab && origin && (
            <CheckRow
              label={`Block on ${exceptionHost(origin)}`}
              description={
                status.siteExceptions.includes(origin)
                  ? 'The site in the current tab. Nothing is blocked here until you turn this back on.'
                  : `The site in the current tab. ${requests(tab.blockedCount)} blocked on this page.`
              }
              checked={!status.siteExceptions.includes(origin)}
              disabled={!active}
              onChange={(on) => run('blocking.setSiteException', { site: origin, excepted: !on })}
            />
          )}
          {status.siteExceptions.length === 0 && (
            <div className="zen-privacy-empty">No sites are excepted</div>
          )}
          {status.siteExceptions.map((site) => (
            <Row key={site} label={exceptionHost(site)}>
              <IconButton
                title={`Block on ${exceptionHost(site)} again`}
                onClick={() => run('blocking.setSiteException', { site, excepted: false })}
              >
                <Trash2 aria-hidden />
              </IconButton>
            </Row>
          ))}
          <AddSite disabled={!active} />
        </div>
      </Section>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Building blocks (v2 §6, §9.2–9.3)
// ---------------------------------------------------------------------------

function Section({
  heading,
  headingId,
  children
}: {
  heading: string
  /** Set when a field below is labelled by the heading (`aria-labelledby`). */
  headingId?: string
  children: ReactNode
}): JSX.Element {
  return (
    <section className="zen-privacy-section">
      <h3 id={headingId} className="zen-privacy-heading">
        {heading}
      </h3>
      {children}
    </section>
  )
}

/** A row that is one checkbox: the whole row toggles it. */
function CheckRow({
  label,
  description,
  checked,
  disabled,
  onChange
}: {
  label: string
  description?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}): JSX.Element {
  return (
    <label className="zen-privacy-row">
      <input
        type="checkbox"
        className="zen-v2-check"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="zen-privacy-row-text">
        <span className="zen-privacy-row-label block">{label}</span>
        {description && <span className="zen-privacy-row-desc">{description}</span>}
      </span>
    </label>
  )
}

/**
 * A row with a label, a description and trailing controls (§9.2, §9.18). The controls centre on
 * the row until the description wraps: on three text lines they centre on the label's line
 * instead, which the row learns by measuring its text block.
 */
function Row({
  label,
  description,
  leading,
  children
}: {
  label: ReactNode
  description?: string
  leading?: ReactNode
  children?: ReactNode
}): JSX.Element {
  const text = useRef<HTMLDivElement>(null)
  const [wrapped, setWrapped] = useState(false)
  useLayoutEffect(() => {
    const el = text.current
    if (!el) return
    // Two 20 px lines are the row's own; anything taller is a wrapped description.
    const measure = (): void => setWrapped(el.getBoundingClientRect().height > 50)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return (
    <div className="zen-privacy-row" data-wrapped={wrapped || undefined}>
      {leading}
      <div ref={text} className="zen-privacy-row-text">
        <div className="zen-privacy-row-label">{label}</div>
        {description && <div className="zen-privacy-row-desc">{description}</div>}
      </div>
      {children && <div className="zen-privacy-row-actions">{children}</div>}
    </div>
  )
}

/** Validation text (§9.12): 13 px in the danger ink with a 16 px glyph, under the field it is about. */
function Invalid({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="zen-privacy-invalid" role="alert">
      <CircleAlert aria-hidden />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function IconButton({
  title,
  disabled,
  onClick,
  children
}: {
  title: string
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}): JSX.Element {
  return (
    <button
      type="button"
      className="zen-v2-icon-button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  )
}

/** One of the four levels as a plain radio row (§9.14): the circle, the name, what it blocks. */
function LevelRow({
  level,
  checked,
  disabled,
  onPick
}: {
  level: TrackingLevel
  checked: boolean
  disabled: boolean
  onPick: () => void
}): JSX.Element {
  const meta = TRACKING_LEVEL_LABELS[level]
  return (
    <label className="zen-privacy-row">
      <input
        type="radio"
        className="zen-v2-radio"
        name="zen-tracking-level"
        value={level}
        checked={checked}
        disabled={disabled}
        onChange={onPick}
      />
      <span className="zen-privacy-row-text">
        <span className="zen-privacy-row-label block">{meta.label}</span>
        <span className="zen-privacy-row-desc">{meta.description}</span>
      </span>
    </label>
  )
}

function ListRow({
  list: l,
  disabled,
  onToggle,
  onRemove
}: {
  list: FilterListStatus
  disabled: boolean
  onToggle: (enabled: boolean) => void
  onRemove?: () => void
}): JSX.Element {
  const id = useId()
  // A phone's row has room for its name, the count and the freshness beside one 44 px button:
  // the blurb and the homepage link are desktop's.
  const phone = useViewport().formFactor === 'phone'
  return (
    <Row
      label={<label htmlFor={id}>{l.name}</label>}
      description={listDetail(l, relativeTime, { blurb: !phone })}
      leading={
        <input
          id={id}
          type="checkbox"
          className="zen-v2-check"
          checked={l.enabled}
          disabled={disabled}
          onChange={(e) => onToggle(e.target.checked)}
        />
      }
    >
      {!phone && (
        <IconButton
          title={`Open the homepage of ${l.name} (${l.licence})`}
          onClick={() => run('app.openExternal', { url: l.homepage })}
        >
          <ExternalLink aria-hidden />
        </IconButton>
      )}
      <IconButton
        title="Update this list now"
        disabled={disabled || !l.enabled || l.updating}
        onClick={() => run('blocking.updateLists', { id: l.id })}
      >
        <RefreshCw className={cn(l.updating && 'zen-spin')} aria-hidden />
      </IconButton>
      {onRemove && (
        <IconButton title={`Remove ${l.name}`} onClick={onRemove}>
          <Trash2 aria-hidden />
        </IconButton>
      )}
    </Row>
  )
}

function CustomLists({
  lists,
  settings: b,
  disabled,
  setB
}: {
  lists: FilterListStatus[]
  settings: BlockingSettings
  disabled: boolean
  setB: (patch: Partial<BlockingSettings>) => void
}): JSX.Element {
  const [url, setUrl] = useState('')
  const fieldId = useId()
  const trimmed = url.trim()
  const valid = /^https?:\/\/\S+$/i.test(trimmed)
  const duplicate = b.customLists.some((l) => l.url === trimmed)
  const add = (): void => {
    if (!valid || duplicate) return
    setB({
      customLists: [
        ...b.customLists,
        { id: customListId(trimmed), url: trimmed, name: trimmed, enabled: true }
      ]
    })
    setUrl('')
  }
  return (
    <Section heading="Your lists">
      <div className="zen-privacy-card">
        {lists.length === 0 && <div className="zen-privacy-empty">No lists of your own yet</div>}
        {lists.map((l) => (
          <ListRow
            key={l.id}
            list={l}
            disabled={disabled}
            onToggle={(on) =>
              setB({
                customLists: b.customLists.map((c) => (c.id === l.id ? { ...c, enabled: on } : c))
              })
            }
            onRemove={() => setB({ customLists: b.customLists.filter((c) => c.id !== l.id) })}
          />
        ))}
        <div className="zen-privacy-add">
          <label htmlFor={fieldId}>Add a list by its URL</label>
          <div className="zen-privacy-add-row">
            <input
              id={fieldId}
              type="url"
              className="zen-v2-field"
              placeholder="https://example.com/filters.txt"
              aria-invalid={duplicate || undefined}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && add()}
            />
            <button
              type="button"
              className="zen-v2-button inline-flex shrink-0 items-center gap-2"
              disabled={!valid || duplicate}
              onClick={add}
            >
              <Plus className="h-4 w-4" aria-hidden />
              Add list
            </button>
          </div>
        </div>
        {duplicate && <Invalid>That list is already here</Invalid>}
      </div>
    </Section>
  )
}

function UserFilters({
  settings: b,
  errors,
  setB
}: {
  settings: BlockingSettings
  errors: UIState['blocking']['userFilterErrors']
  setB: (patch: Partial<BlockingSettings>) => void
}): JSX.Element {
  // The draft and the stored text it was started from: when another window (or sync) changes
  // the stored filters while this panel is open, the draft follows them.
  const [draft, setDraft] = useState({ base: b.userFilters, text: b.userFilters })
  if (draft.base !== b.userFilters) setDraft({ base: b.userFilters, text: b.userFilters })
  const text = draft.base === b.userFilters ? draft.text : b.userFilters
  const setText = (value: string): void => setDraft({ base: b.userFilters, text: value })
  const dirty = text !== b.userFilters
  const headingId = useId()
  const noteId = useId()
  return (
    <Section heading="Your filters" headingId={headingId}>
      <div className="zen-privacy-field">
        <textarea
          className="zen-v2-textarea"
          aria-labelledby={headingId}
          aria-describedby={noteId}
          spellCheck={false}
          placeholder={'||ads.example.com^\n@@||news.example.com^$document'}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => dirty && setB({ userFilters: text })}
        />
        {errors.length > 0 && (
          <Invalid>
            <ul>
              {errors.slice(0, 8).map((e) => (
                <li key={`${e.line}:${e.message}`}>
                  Line {e.line}: {e.message}
                </li>
              ))}
              {errors.length > 8 && <li>{errors.length - 8} more…</li>}
            </ul>
          </Invalid>
        )}
        <p id={noteId} className="zen-privacy-field-desc">
          One filter per line in uBlock Origin syntax. They apply at every level, even Off.
        </p>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          className="zen-v2-button zen-privacy-hug"
          disabled={!dirty}
          onClick={() => setB({ userFilters: text })}
        >
          Apply
        </button>
      </div>
    </Section>
  )
}

function AddSite({ disabled }: { disabled: boolean }): JSX.Element {
  const [value, setValue] = useState('')
  const fieldId = useId()
  const site = normalizeSiteException(value)
  const add = (): void => {
    if (!site) return
    run('blocking.setSiteException', { site, excepted: true })
    setValue('')
  }
  return (
    <div className="zen-privacy-add">
      <label htmlFor={fieldId}>Add a site</label>
      <div className="zen-privacy-add-row">
        <input
          id={fieldId}
          type="text"
          className="zen-v2-field"
          placeholder="example.com"
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button
          type="button"
          className="zen-v2-button inline-flex shrink-0 items-center gap-2"
          disabled={disabled || !site}
          onClick={add}
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add site
        </button>
      </div>
    </div>
  )
}
