import type { JSX, ReactNode } from 'react'
import { useId, useState } from 'react'
import { ExternalLink, Plus, RefreshCw, Shield, ShieldCheck, ShieldOff, Trash2 } from 'lucide-react'
import type { Settings, UIState } from '@shared/types'
import {
  HTTPS_ONLY_LABELS,
  HTTPS_ONLY_PERMISSION,
  normalizePrivacySite,
  SECURE_DNS_CUSTOM,
  THIRD_PARTY_COOKIE_LABELS,
  type HttpsOnlyMode,
  type PrivacySettings,
  type SafeBrowsingFeedStatus,
  type SafeBrowsingStatus,
  type ThirdPartyCookieMode
} from '@shared/privacy'
import { run } from '@renderer/lib/api'
import { usePhone } from '@renderer/lib/formFactor'
import {
  customResolverProblem,
  feedDetail,
  isValidApiKey,
  providerOptions,
  remoteLookupsText,
  resolverOptions,
  resolverPatch,
  resolverValue,
  safeBrowsingCardText,
  secureDnsText,
  updateRowText
} from '@renderer/lib/protectionUi'
import { cn, relativeTime } from '@renderer/lib/utils'
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
  RadioRow,
  Row
} from './protection/controls'
import { Menulist } from './protection/Menulist'

const HTTPS_ONLY_MODES: HttpsOnlyMode[] = ['off', 'ask', 'always']
const COOKIE_MODES: ThirdPartyCookieMode[] = ['allow', 'block-private', 'block']

type SetPrivacy = (patch: Partial<PrivacySettings>) => void

/**
 * The protection groups of Settings > Privacy and Security (design-language-v2-draft §1–§3, §6,
 * §9, §10.3–10.4): Safe Browsing with its feeds and the optional Google key, HTTPS-only mode
 * with the sites allowed over plaintext, secure DNS (the host's resolver on desktop, the system's
 * Private DNS screen on Android), third-party cookies with the related-sites exceptions, and the
 * Global Privacy Control and Do Not Track signals. Everything is a `settings.privacy` patch
 * except the feed refresh and the plaintext exceptions, which are the protection service's and
 * the `https-only` permission's. Registered beside the blocking groups (#115's
 * `PrivacySection`); the two share the pane and its `.zen-privacy-*` vocabulary.
 *
 * Desktop is Zen's about:preferences (§10.5): two 22/600 sections, checkboxes left of their
 * labels, plain radios, a menulist, and a card only where a group carries its own actions. A
 * phone is §10's rows under 15/600 headings and nothing else: switch rows, value rows that open
 * a picker sheet, action rows, no cards.
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
        <CookiesGroup settings={p} setP={setP} />
        <RelatedSitesGroup settings={p} setP={setP} />
        <SignalsGroup settings={p} setP={setP} />
      </Part>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Safe Browsing
// ---------------------------------------------------------------------------

const SAFE_BROWSING_HEADING = 'Safe Browsing'
const SAFE_BROWSING_DESCRIPTION =
  'Sites are checked against open feeds of malware and phishing hosts (URLhaus, Phishing.Database, malware-filter) before they load. The feeds are refreshed while the browser runs.'

/**
 * On a desktop one card (§6: the group has its own actions) named by its status inside it
 * (§9.27, as #115's status card): the 17/600 headline with the shield, the size and freshness of
 * the feeds as its description and Update now trailing; then the switch, the feeds with their
 * refresh and the key field as its rows. On a phone the same under a 15/600 heading: a switch
 * row, the Update feeds now action row, the feed rows and the field (§10.4).
 */
function SafeBrowsingGroup({ state, setP }: { state: UIState; setP: SetPrivacy }): JSX.Element {
  const p = state.settings.privacy
  const status = state.privacy.safeBrowsing
  const phone = usePhone()
  const on = p.safeBrowsingEnabled
  const rows = (
    <>
      <BoolRow
        label="Warn about dangerous sites"
        description="Deceptive and malware sites are stopped before they load. You can still go on from the warning."
        checked={on}
        onChange={(safeBrowsingEnabled) => setP({ safeBrowsingEnabled })}
      />
      {phone && (
        <ActionRow
          label="Update feeds now"
          description={updateRowText(status, relativeTime)}
          busy={status.updating}
          disabled={!on || !status.ready}
          onClick={() => run('protection.updateFeeds', {})}
        />
      )}
      {status.feeds.map((feed) => (
        <FeedRow key={feed.id} feed={feed} disabled={!on} />
      ))}
      <ApiKeyField value={p.safeBrowsingApiKey} status={status} disabled={!on} setP={setP} />
    </>
  )
  if (phone) {
    return (
      <Group heading={SAFE_BROWSING_HEADING} description={SAFE_BROWSING_DESCRIPTION}>
        <List>{rows}</List>
      </Group>
    )
  }
  const text = safeBrowsingCardText(status, relativeTime)
  const StatusIcon = !on ? ShieldOff : status.ready ? ShieldCheck : Shield
  return (
    <List label={SAFE_BROWSING_HEADING}>
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
      {rows}
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
  return (
    <Row label={feed.name} description={feedDetail(feed, relativeTime)} disabled={disabled}>
      <IconButton
        title={`Open the homepage of ${feed.name} (${feed.licence})`}
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
 * A text field on §9.12's terms: its label above, the description and the validation under it.
 * The draft is the stored value until it is edited; blur or Enter stores a valid one.
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
  onSave
}: {
  label: string
  value: string
  placeholder: string
  type?: 'text' | 'url'
  /** A key or token: the platform monospace with no ligatures (§4). */
  secret?: boolean
  disabled?: boolean
  /** The validation text for `text`, or null while it is valid. */
  problem: (text: string) => string | null
  description: ReactNode
  onSave: (text: string) => void
}): JSX.Element {
  const [draft, setDraft] = useState({ base: value, text: value })
  const text = draft.base === value ? draft.text : value
  const invalid = problem(text)
  const fieldId = useId()
  const noteId = useId()
  const save = (): void => {
    const next = text.trim()
    if (invalid || next === value) return
    onSave(next)
  }
  return (
    <div className="zen-privacy-field zen-protection-field" data-disabled={disabled || undefined}>
      <label htmlFor={fieldId}>{label}</label>
      <input
        id={fieldId}
        type={type}
        className={cn('zen-v2-field', secret && 'zen-protection-secret')}
        aria-describedby={noteId}
        aria-invalid={invalid !== null || undefined}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={text}
        disabled={disabled}
        onChange={(e) => setDraft({ base: value, text: e.target.value })}
        onBlur={save}
        onKeyDown={(e) => e.key === 'Enter' && save()}
      />
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
  return (
    <TextField
      label="Google Safe Browsing API key"
      value={value}
      placeholder="AIza…"
      secret
      disabled={disabled}
      problem={(text) =>
        isValidApiKey(text)
          ? null
          : 'A key is letters, digits, dashes and underscores, up to 128 of them'
      }
      description={remoteLookupsText(status, value)}
      onSave={(safeBrowsingApiKey) => setP({ safeBrowsingApiKey })}
    />
  )
}

// ---------------------------------------------------------------------------
// HTTPS-only mode
// ---------------------------------------------------------------------------

function HttpsOnlyGroup({ state, setP }: { state: UIState; setP: SetPrivacy }): JSX.Element {
  const p = state.settings.privacy
  const description =
    'Pages are asked for over https first, so what you send and receive stays encrypted on the way.'
  return (
    <Group heading="HTTPS-only mode" description={description}>
      <Choice
        name="zen-https-only"
        label="HTTPS-only mode"
        description={description}
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
 * asks again next time. A card on a desktop (rows with an action), rows on a phone.
 */
function PlaintextSitesGroup({ state }: { state: UIState }): JSX.Element {
  const stored = state.privacy.httpsOnlyExceptions
  const session = state.privacy.httpsOnlySessionExceptions.filter((s) => !stored.includes(s))
  const heading = 'Sites allowed over http'
  return (
    <Group
      heading={heading}
      description="Sites you chose to load over plaintext from the warning page. Remove one to be asked again."
    >
      <List label={heading}>
        {stored.length === 0 && session.length === 0 && (
          <div className="zen-privacy-empty">No sites allowed over http yet</div>
        )}
        {stored.map((site) => (
          <Row key={site} label={site} description="Allowed over http for good">
            <IconButton
              title={`Ask again before loading ${site} over http`}
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
          <Row key={site} label={site} description="Allowed over http until the browser closes">
            <IconButton
              title={`Ask again before loading ${site} over http`}
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
 * Desktop: the switch, then two plain radios (§9.14) – the system resolver, or a provider with
 * the menulist trailing its row (§9.18, §9.21) – and the custom resolver's field when that is
 * the provider; the dependent rows dim at .4 while the switch is off (§10.4). Phone: a switch
 * row and one resolver value row whose picker holds the system resolver, the providers and the
 * custom entry.
 */
function SecureDnsGroup({ state, setP }: { state: UIState; setP: SetPrivacy }): JSX.Element {
  const p = state.settings.privacy
  const on = p.secureDnsMode !== 'off'
  const phone = usePhone()
  const custom = p.secureDnsMode === 'provider' && p.secureDnsProvider === SECURE_DNS_CUSTOM
  return (
    <Group
      heading="Secure DNS"
      description="Encrypt the lookups that turn a site's name into an address, so the network cannot read or change them."
    >
      <div className="zen-privacy-rows">
        <BoolRow
          label="Use secure DNS"
          description={secureDnsText(p, state.privacy.secureDns)}
          checked={on}
          onChange={(v) => setP({ secureDnsMode: v ? 'automatic' : 'off' })}
        />
        {phone ? (
          <Choice
            name="zen-secure-dns-resolver"
            label="Resolver"
            description="Where the encrypted lookups go."
            value={resolverValue(p)}
            options={resolverOptions()}
            disabled={!on}
            onChange={(value) => setP(resolverPatch(value))}
          />
        ) : (
          <div role="radiogroup" aria-label="Secure DNS resolver" className="zen-privacy-rows">
            <RadioRow
              name="zen-secure-dns"
              value="automatic"
              label="With your current service provider"
              description="Encrypted when the system resolver offers it, plaintext otherwise."
              checked={p.secureDnsMode === 'automatic'}
              disabled={!on}
              onPick={() => setP({ secureDnsMode: 'automatic' })}
            />
            <RadioRow
              name="zen-secure-dns"
              value="provider"
              label="With a provider of your choice"
              description="Every lookup is encrypted and goes to this resolver, never to the system's."
              checked={p.secureDnsMode === 'provider'}
              disabled={!on}
              onPick={() => setP({ secureDnsMode: 'provider' })}
            >
              <Menulist
                label="Secure DNS provider"
                value={p.secureDnsProvider}
                options={providerOptions()}
                disabled={!on || p.secureDnsMode !== 'provider'}
                onChange={(secureDnsProvider) => setP({ secureDnsProvider })}
              />
            </RadioRow>
          </div>
        )}
      </div>
      {custom && (
        <TextField
          label="Custom resolver"
          value={p.secureDnsCustomUrl}
          type="url"
          placeholder="https://dns.example/dns-query"
          disabled={!on}
          problem={customResolverProblem}
          description="The DNS-over-HTTPS address your resolver publishes; a personal NextDNS or AdGuard profile has one of its own."
          onSave={(secureDnsCustomUrl) => setP({ secureDnsCustomUrl })}
        />
      )}
    </Group>
  )
}

/** Android: secure DNS is the system's Private DNS setting; the row opens that screen (§10.4). */
function PrivateDnsGroup(): JSX.Element {
  return (
    <Group
      heading="Secure DNS"
      description="On Android, encrypted DNS is a system setting that applies to every app."
    >
      <div className="zen-privacy-rows">
        <ActionRow
          label="Open Private DNS settings"
          description="Choose Automatic, or a private DNS provider by hostname, in Network and internet."
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

function CookiesGroup({
  settings: p,
  setP
}: {
  settings: PrivacySettings
  setP: SetPrivacy
}): JSX.Element {
  const description =
    'Cookies set by a site embedded in another site, which is how most cross-site tracking works.'
  return (
    <Group heading="Third-party cookies" description={description}>
      <Choice
        name="zen-third-party-cookies"
        label="Third-party cookies"
        description={description}
        value={p.thirdPartyCookies}
        options={COOKIE_MODES.map((mode) => ({ value: mode, ...THIRD_PARTY_COOKIE_LABELS[mode] }))}
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
  const heading = 'Related sites'
  return (
    <Group
      heading={heading}
      description="Sites that may keep using third-party cookies whatever the setting: a sign-in provider, or a company's other domains. A site covers its subdomains."
    >
      <List label={heading}>
        {exceptions.length === 0 && <div className="zen-privacy-empty">No related sites yet</div>}
        {exceptions.map((site) => (
          <Row key={site} label={site} disabled={!blocking}>
            <IconButton
              title={`Remove ${site}`}
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
  const add = (): void => {
    if (!site || duplicate) return
    onAdd(site)
    setValue('')
  }
  return (
    <>
      <div className="zen-privacy-add" data-disabled={disabled || undefined}>
        <label htmlFor={fieldId}>Add a site</label>
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
            className="zen-v2-button zen-privacy-hug inline-flex shrink-0 items-center gap-2"
            disabled={disabled || !site || duplicate}
            onClick={add}
          >
            <Plus className="h-4 w-4" aria-hidden />
            Add site
          </button>
        </div>
      </div>
      {duplicate && <Invalid>That site is already here</Invalid>}
    </>
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
  return (
    <Group
      heading="Privacy signals"
      description="Preferences sent with every request. Sites decide whether to honour them; the Global Privacy Control signal is binding under some privacy laws."
    >
      <div className="zen-privacy-rows">
        <BoolRow
          label="Send a Global Privacy Control signal"
          description="Tells sites not to sell or share your data (Sec-GPC: 1 and navigator.globalPrivacyControl)."
          checked={p.gpc}
          onChange={(gpc) => setP({ gpc })}
        />
        <BoolRow
          label="Send a Do Not Track request"
          description="Asks sites not to track you (DNT: 1 and navigator.doNotTrack). Many sites ignore it."
          checked={p.dnt}
          onChange={(dnt) => setP({ dnt })}
        />
      </div>
    </Group>
  )
}
