import type { JSX, ReactNode } from 'react'
import { useId, useRef, useState } from 'react'
import { ExternalLink, Plus, RefreshCw, Shield, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import type { Settings, UIState } from '@shared/types'
import {
  HTTPS_ONLY_LABELS,
  HTTPS_ONLY_PERMISSION,
  normalizePrivacySite,
  SECURE_DNS_CUSTOM,
  type HttpsOnlyMode,
  type PrivacySettings,
  type SafeBrowsingFeedStatus,
  type SafeBrowsingStatus
} from '@shared/privacy'
import { run } from '@renderer/lib/api'
import { commitApiKey, commitCustomResolver, type Commit } from '@renderer/lib/protectionCommits'
import {
  cookieModeOptions,
  customResolverProblem,
  feedDetail,
  isValidApiKey,
  PROTECTION_TEXT,
  providerOptions,
  remoteLookupsText,
  safeBrowsingCardText,
  secureDnsText
} from '@renderer/lib/protectionUi'
import { cn, relativeTime } from '@renderer/lib/utils'
import { Menulist } from '../translate/Menulist'
import {
  ActionRow,
  BoolRow,
  BusyButton,
  CardTitle,
  Choice,
  Group,
  IconButton,
  Invalid,
  List,
  Part,
  RadioGroup,
  RadioRow,
  Row
} from './protection/controls'

const HTTPS_ONLY_MODES: HttpsOnlyMode[] = ['off', 'ask', 'always']

type SetPrivacy = (patch: Partial<PrivacySettings>) => void

/**
 * The protection groups of the desktop Settings > Privacy and Security pane (design-language-
 * v2-draft §1–§3, §6, §9, §10.5): Safe Browsing with its feeds and the optional Google key,
 * HTTPS-only mode with the sites allowed over plaintext, secure DNS (the host's resolver, or the
 * system's Private DNS screen where the host has none), third-party cookies with the
 * related-sites exceptions, and the Global Privacy Control and Do Not Track signals. Everything
 * is a `settings.privacy` patch except the feed refresh and the plaintext exceptions, which are
 * the protection service's and the `https-only` permission's. Registered beside the blocking
 * groups (#115's `PrivacySection`); the two share the pane and its `.zen-privacy-*` vocabulary.
 *
 * Zen's about:preferences: two 22/600 sections, checkboxes left of their labels, plain radios, a
 * menulist, and a card only where a group carries its own actions. The phone shows the same
 * groups as rows of the Settings tab, built by `pages/settings/protectionRows.tsx` with the
 * same words (`lib/protectionUi.ts`) and the same commits (`lib/protectionCommits.ts`).
 */
export function ProtectionSection({
  state,
  set
}: {
  state: UIState
  set: (patch: Partial<Settings>) => void
}): JSX.Element {
  const p = state.settings.privacy
  const setP: SetPrivacy = (patch) => set({ privacy: { ...p, ...patch } })
  return (
    <div className="zen-privacy zen-protection">
      <Part
        title="Security"
        description="Zenium stops known dangerous sites before they load and prefers secure connections everywhere."
      >
        <SafeBrowsingGroup state={state} setP={setP} />
        <HttpsOnlyGroup state={state} setP={setP} />
        <PlaintextSitesGroup state={state} />
        {state.capabilities.secureDns ? (
          <SecureDnsGroup state={state} setP={setP} />
        ) : (
          <PrivateDnsGroup />
        )}
      </Part>
      <Part
        title="Cookies and tracking signals"
        description="What sites embedded in other sites may store, and what every site is told about your preferences."
      >
        <CookiesGroup state={state} setP={setP} />
        <RelatedSitesGroup settings={p} setP={setP} />
        <SignalsGroup settings={p} setP={setP} />
      </Part>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Safe Browsing
// ---------------------------------------------------------------------------

/**
 * One card (§6: the group has its own actions) named by its status inside it (§9.27, as #115's
 * status card): the 17/600 headline with the shield, the size and freshness of the feeds as its
 * description and Update now trailing; then the switch, the feeds with their refresh and the key
 * field as its rows.
 */
function SafeBrowsingGroup({ state, setP }: { state: UIState; setP: SetPrivacy }): JSX.Element {
  const p = state.settings.privacy
  const status = state.privacy.safeBrowsing
  const on = p.safeBrowsingEnabled
  const words = PROTECTION_TEXT.safeBrowsing
  const text = safeBrowsingCardText(status, relativeTime)
  const StatusIcon = !on ? ShieldOff : status.ready ? ShieldCheck : Shield
  return (
    <List label={words.heading}>
      <CardTitle
        icon={<StatusIcon className={cn(!on && 'zen-privacy-muted')} aria-hidden />}
        title={text.headline}
        description={text.detail}
        action={
          <BusyButton
            busy={status.updating}
            disabled={!on || !status.ready}
            onClick={() => run('protection.updateFeeds', {})}
          >
            Update now
          </BusyButton>
        }
      />
      <BoolRow
        label={words.warn.label}
        description={words.warn.description}
        checked={on}
        onChange={(safeBrowsingEnabled) => setP({ safeBrowsingEnabled })}
      />
      {status.feeds.map((feed) => (
        <FeedRow key={feed.id} feed={feed} disabled={!on} />
      ))}
      <ApiKeyField value={p.safeBrowsingApiKey} status={status} disabled={!on} setP={setP} />
    </List>
  )
}

/** One feed: its name, size, freshness and last failure; its homepage and a refresh trailing. */
function FeedRow({
  feed,
  disabled
}: {
  feed: SafeBrowsingFeedStatus
  disabled: boolean
}): JSX.Element {
  const words = PROTECTION_TEXT.safeBrowsing
  return (
    <Row label={feed.name} description={feedDetail(feed, relativeTime)} disabled={disabled}>
      <IconButton
        title={`${words.homepage(feed.name)} (${feed.licence})`}
        onClick={() => run('app.openExternal', { url: feed.homepage })}
      >
        <ExternalLink aria-hidden />
      </IconButton>
      <IconButton
        title={`Update ${feed.name} now`}
        disabled={disabled}
        busy={feed.updating}
        onClick={() => run('protection.updateFeeds', { id: feed.id })}
      >
        <RefreshCw className={cn(feed.updating && 'zen-spin')} aria-hidden />
      </IconButton>
    </Row>
  )
}

/**
 * A text field on §9.12's terms – its label above, Save beside it, the description and the
 * validation under it – that is a §9.30 busy form while its value is checked: the field
 * read-only at full opacity with the typed value in place, Save busy with the spinner in place of
 * its label and `aria-busy`, no press taken; a refusal clears the field, gives it the focus and
 * says why under it (`role="alert"`); acceptance leaves the saved value in the field. Save waits
 * at .4 while the draft is the stored value or malformed (§9.30); Enter in the field is Save.
 */
function TextField({
  label,
  value,
  placeholder,
  type = 'text',
  secret = false,
  disabled = false,
  problem,
  description,
  commit
}: {
  label: string
  value: string
  placeholder: string
  type?: 'text' | 'url'
  /** A key or token: the platform monospace with no ligatures (§4). */
  secret?: boolean
  disabled?: boolean
  /** The validation text for `text` before it is sent anywhere, or null while it is valid. */
  problem: (text: string) => string | null
  description: ReactNode
  /** Keep `text`: a message refuses it, a promise is the check it waits on (`lib/protectionCommits`). */
  commit: (text: string) => Commit
}): JSX.Element {
  const [draft, setDraft] = useState({ base: value, text: value })
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const text = draft.base === value ? draft.text : value
  const invalid = refused ?? problem(text)
  const unchanged = text.trim() === value
  const fieldId = useId()
  const noteId = useId()
  const save = (): void => {
    if (busy || disabled || invalid || unchanged) return
    const outcome = commit(text)
    if (!(outcome instanceof Promise)) {
      if (outcome) setRefused(outcome)
      return
    }
    setBusy(true)
    outcome
      .catch((e: unknown) => (e instanceof Error && e.message) || 'The check did not finish')
      .then((message) => {
        setBusy(false)
        if (!message) return
        setRefused(message)
        setDraft({ base: value, text: '' })
        input.current?.focus()
      })
  }
  return (
    <div
      className="zen-privacy-field zen-protection-field"
      data-disabled={disabled || undefined}
      aria-busy={busy || undefined}
    >
      <label htmlFor={fieldId}>{label}</label>
      <div className="zen-privacy-add-row">
        <input
          ref={input}
          id={fieldId}
          type={type}
          className={cn('zen-v2-field', secret && 'zen-settings-secret')}
          aria-describedby={noteId}
          aria-invalid={invalid !== null || undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          readOnly={busy}
          onChange={(e) => {
            setRefused(null)
            setDraft({ base: value, text: e.target.value })
          }}
          onKeyDown={(e) => e.key === 'Enter' && save()}
        />
        <BusyButton
          primary
          busy={busy}
          disabled={disabled || (!busy && (invalid !== null || unchanged))}
          className="shrink-0"
          onClick={save}
        >
          Save
        </BusyButton>
      </div>
      {invalid && <Invalid>{invalid}</Invalid>}
      <p id={noteId} className="zen-privacy-field-desc">
        {description}
      </p>
    </div>
  )
}

/** The optional Google Safe Browsing key: what a key does, and whether the lookups run. */
function ApiKeyField({
  value,
  status,
  disabled,
  setP
}: {
  value: string
  status: SafeBrowsingStatus
  disabled: boolean
  setP: SetPrivacy
}): JSX.Element {
  const words = PROTECTION_TEXT.safeBrowsing.apiKey
  return (
    <TextField
      label={words.label}
      value={value}
      placeholder={words.placeholder}
      secret
      disabled={disabled}
      problem={(text) => (isValidApiKey(text) ? null : words.invalid)}
      description={remoteLookupsText(status, value)}
      commit={(text) => commitApiKey(value, text, setP)}
    />
  )
}

// ---------------------------------------------------------------------------
// HTTPS-only mode
// ---------------------------------------------------------------------------

function HttpsOnlyGroup({ state, setP }: { state: UIState; setP: SetPrivacy }): JSX.Element {
  const p = state.settings.privacy
  const words = PROTECTION_TEXT.httpsOnly
  return (
    <Group heading={words.heading} description={words.description}>
      <Choice
        label={words.heading}
        value={p.httpsOnly}
        options={HTTPS_ONLY_MODES.map((mode) => ({ value: mode, ...HTTPS_ONLY_LABELS[mode] }))}
        onChange={(httpsOnly) => setP({ httpsOnly })}
      />
    </Group>
  )
}

/**
 * The sites the warning page was answered "continue" for: allowed for good (the `https-only`
 * permission) or until the browser closes (the protection service's session list). Removing one
 * asks again next time. A card: its rows carry an action.
 */
function PlaintextSitesGroup({ state }: { state: UIState }): JSX.Element {
  const stored = state.privacy.httpsOnlyExceptions
  const session = state.privacy.httpsOnlySessionExceptions.filter((s) => !stored.includes(s))
  const words = PROTECTION_TEXT.plaintextSites
  return (
    <Group heading={words.heading} description={words.description}>
      <List label={words.heading}>
        {stored.length === 0 && session.length === 0 && (
          <div className="zen-privacy-empty">{words.empty}</div>
        )}
        {stored.map((site) => (
          <Row key={site} label={site} description={words.stored}>
            <IconButton
              title={words.askAgain(site)}
              onClick={() =>
                run('permissions.set', {
                  origin: `http://${site}`,
                  permission: HTTPS_ONLY_PERMISSION,
                  decision: null
                })
              }
            >
              <Trash2 aria-hidden />
            </IconButton>
          </Row>
        ))}
        {session.map((site) => (
          <Row key={site} label={site} description={words.session}>
            <IconButton
              title={words.askAgain(site)}
              onClick={() => run('protection.forgetPlaintext', { host: site })}
            >
              <Trash2 aria-hidden />
            </IconButton>
          </Row>
        ))}
      </List>
    </Group>
  )
}

// ---------------------------------------------------------------------------
// Secure DNS
// ---------------------------------------------------------------------------

/**
 * The switch, then two plain radios (§9.14) – the system resolver, or a provider with the
 * menulist trailing its row (§9.18, §9.21) – and the custom resolver's field when that is the
 * provider; the dependent rows dim at .4 while the switch is off (§10.4).
 */
function SecureDnsGroup({ state, setP }: { state: UIState; setP: SetPrivacy }): JSX.Element {
  const p = state.settings.privacy
  const on = p.secureDnsMode !== 'off'
  const custom = p.secureDnsMode === 'provider' && p.secureDnsProvider === SECURE_DNS_CUSTOM
  const words = PROTECTION_TEXT.secureDns
  return (
    <Group heading={words.heading} description={words.description}>
      <div className="zen-privacy-rows">
        <BoolRow
          label={words.use}
          description={secureDnsText(p, state.privacy.secureDns)}
          checked={on}
          onChange={(v) => setP({ secureDnsMode: v ? 'automatic' : 'off' })}
        />
        <RadioGroup label={words.resolver.label}>
          <RadioRow
            label={words.automatic.label}
            description={words.automatic.description}
            checked={p.secureDnsMode === 'automatic'}
            disabled={!on}
            onPick={() => setP({ secureDnsMode: 'automatic' })}
          />
          <RadioRow
            label={words.provider.label}
            description={words.provider.description}
            checked={p.secureDnsMode === 'provider'}
            disabled={!on}
            onPick={() => setP({ secureDnsMode: 'provider' })}
          >
            <Menulist
              className="zen-protection-menulist"
              label="Secure DNS provider"
              value={p.secureDnsProvider}
              // The list is one line per provider (§9.13); the notes are the phone picker's.
              options={providerOptions().map(({ value, label }) => ({ value, label }))}
              disabled={!on || p.secureDnsMode !== 'provider'}
              onChange={(secureDnsProvider) => setP({ secureDnsProvider })}
            />
          </RadioRow>
        </RadioGroup>
      </div>
      {custom && (
        <TextField
          label={words.custom.label}
          value={p.secureDnsCustomUrl}
          type="url"
          placeholder={words.custom.placeholder}
          disabled={!on}
          problem={customResolverProblem}
          description={words.custom.description}
          commit={(text) => commitCustomResolver(p.secureDnsCustomUrl, text, setP)}
        />
      )}
    </Group>
  )
}

/**
 * A host without a resolver of its own (Android, in the tablet's two-pane): secure DNS is the
 * system's Private DNS setting; the row opens that screen (§10.4).
 */
function PrivateDnsGroup(): JSX.Element {
  const words = PROTECTION_TEXT.privateDns
  return (
    <Group heading={PROTECTION_TEXT.secureDns.heading} description={words.description}>
      <div className="zen-privacy-rows">
        <ActionRow
          label={words.open.label}
          description={words.open.description}
          external
          onClick={() => run('protection.openPrivateDnsSettings', undefined)}
        />
      </div>
    </Group>
  )
}

// ---------------------------------------------------------------------------
// Third-party cookies
// ---------------------------------------------------------------------------

function CookiesGroup({ state, setP }: { state: UIState; setP: SetPrivacy }): JSX.Element {
  const words = PROTECTION_TEXT.cookies
  return (
    <Group heading={words.heading} description={words.description}>
      <Choice
        label={words.heading}
        value={state.settings.privacy.thirdPartyCookies}
        options={cookieModeOptions(state.capabilities.windows)}
        onChange={(thirdPartyCookies) => setP({ thirdPartyCookies })}
      />
    </Group>
  )
}

/**
 * The related-sites exceptions: sites that keep third-party cookies whatever the mode, each with
 * a remove, and the add field (§9.12) as the last row. Dependent on the mode: while third-party
 * cookies are allowed everywhere the list dims at .4 (§10.4).
 */
function RelatedSitesGroup({
  settings: p,
  setP
}: {
  settings: PrivacySettings
  setP: SetPrivacy
}): JSX.Element {
  const blocking = p.thirdPartyCookies !== 'allow'
  const exceptions = p.thirdPartyCookieExceptions
  const words = PROTECTION_TEXT.relatedSites
  return (
    <Group heading={words.heading} description={words.description}>
      <List label={words.heading}>
        {exceptions.length === 0 && <div className="zen-privacy-empty">{words.empty}</div>}
        {exceptions.map((site) => (
          <Row key={site} label={site} disabled={!blocking}>
            <IconButton
              title={words.remove(site)}
              disabled={!blocking}
              onClick={() =>
                setP({ thirdPartyCookieExceptions: exceptions.filter((s) => s !== site) })
              }
            >
              <Trash2 aria-hidden />
            </IconButton>
          </Row>
        ))}
        <AddSite
          disabled={!blocking}
          exists={(site) => exceptions.includes(site)}
          onAdd={(site) => setP({ thirdPartyCookieExceptions: [...exceptions, site] })}
        />
      </List>
    </Group>
  )
}

/** The add row (§9.12, §9.21): its label above, the field with the button beside it, validation under. */
function AddSite({
  disabled,
  exists,
  onAdd
}: {
  disabled: boolean
  exists: (site: string) => boolean
  onAdd: (site: string) => void
}): JSX.Element {
  const [value, setValue] = useState('')
  const fieldId = useId()
  const site = normalizePrivacySite(value)
  const duplicate = site !== null && exists(site)
  const words = PROTECTION_TEXT.relatedSites
  const add = (): void => {
    if (!site || duplicate) return
    onAdd(site)
    setValue('')
  }
  return (
    <div className="zen-privacy-add" data-disabled={disabled || undefined}>
      <label htmlFor={fieldId}>{words.add}</label>
      <div className="zen-privacy-add-row">
        <input
          id={fieldId}
          type="text"
          className="zen-v2-field"
          placeholder="example.com"
          aria-invalid={duplicate || undefined}
          autoComplete="off"
          spellCheck={false}
          value={value}
          disabled={disabled}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button
          type="button"
          className="zen-v2-button inline-flex shrink-0 items-center gap-2"
          disabled={disabled || !site || duplicate}
          onClick={add}
        >
          <Plus className="h-4 w-4" aria-hidden />
          Add site
        </button>
      </div>
      {duplicate && <Invalid>{words.duplicate}</Invalid>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Privacy signals
// ---------------------------------------------------------------------------

function SignalsGroup({
  settings: p,
  setP
}: {
  settings: PrivacySettings
  setP: SetPrivacy
}): JSX.Element {
  const words = PROTECTION_TEXT.signals
  return (
    <Group heading={words.heading} description={words.description}>
      <div className="zen-privacy-rows">
        <BoolRow
          label={words.gpc.label}
          description={words.gpc.description}
          checked={p.gpc}
          onChange={(gpc) => setP({ gpc })}
        />
        <BoolRow
          label={words.dnt.label}
          description={words.dnt.description}
          checked={p.dnt}
          onChange={(dnt) => setP({ dnt })}
        />
      </div>
    </Group>
  )
}
