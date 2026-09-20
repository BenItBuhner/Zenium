import type { Settings, UIState } from '@shared/types'
import {
  HTTPS_ONLY_LABELS,
  HTTPS_ONLY_PERMISSION,
  SECURE_DNS_CUSTOM,
  type HttpsOnlyMode,
  type PrivacySettings,
  type SafeBrowsingFeedStatus,
  type ThirdPartyCookieMode
} from '@shared/privacy'
import { run } from '@renderer/lib/api'
import { commitApiKey, commitCustomResolver } from '@renderer/lib/protectionCommits'
import {
  apiKeyRowText,
  cookieModeOptions,
  feedDetail,
  PROTECTION_TEXT,
  resolverOptions,
  resolverPatch,
  resolverValue,
  secureDnsText,
  updateRowText
} from '@renderer/lib/protectionUi'
import { relativeTime } from '@renderer/lib/utils'
import { choice, type RowGroup, type SettingsRow } from './model'
import { AddSiteForm } from './protectionBlocks'

/**
 * The protection groups of the phone's Settings > Privacy and Security (design language v2
 * §10.3–10.4), as the `privacySection` builder in `sections.tsx` spreads them between its own:
 * Safe Browsing (`safe-browsing-*`), third-party cookies with the related sites (`cookies-*`),
 * HTTPS-only mode with the sites allowed over plaintext (`https-only-*`), secure DNS – the
 * host's resolver, or the system's Private DNS screen where the host has none (`secure-dns-*`) –
 * and the privacy signals (`signals-*`). Every row reads `settings.privacy` and writes it back
 * through `set`, or runs the protection service's commands, exactly as the desktop pane
 * (`overlays/ProtectionSection.tsx`) does with the same words (`lib/protectionUi.ts`), so the
 * two platforms say and do the same thing. Gated as the desktop pane is: the resolver rows
 * behind `capabilities.secureDns`, the Private DNS row where that is off.
 */

type Set = (patch: Partial<Settings>) => void

/** A patch of `settings.privacy` on top of what is there. */
function patcher(state: UIState, set: Set): (patch: Partial<PrivacySettings>) => void {
  return (patch) => set({ privacy: { ...state.settings.privacy, ...patch } })
}

/** A row that only lists something, and the sheet of rows that act on it. */
function listItem(
  id: string,
  label: string,
  description: string,
  rows: SettingsRow[],
  disabled = false
): SettingsRow {
  return {
    kind: 'item',
    id,
    label,
    description,
    disabled,
    sheet: { title: label, description, groups: [{ id: `${id}-actions`, heading: null, rows }] }
  }
}

// ---------------------------------------------------------------------------
// Safe Browsing
// ---------------------------------------------------------------------------

type SafeBrowsingLevel = 'standard' | 'off'

/**
 * The level as Chrome's Safe Browsing screen puts it – standard protection or none – over the
 * one switch the desktop has, a value row under the group's heading (so named "Protection
 * level", not the heading again); the optional Google key as a §9.12 field row that never shows
 * its value; then the feeds under their own heading: Update feeds now and one item per feed with
 * its homepage and its own refresh.
 */
export function safeBrowsingGroups(state: UIState, set: Set): RowGroup[] {
  const p = state.settings.privacy
  const setP = patcher(state, set)
  const status = state.privacy.safeBrowsing
  const on = p.safeBrowsingEnabled
  const text = PROTECTION_TEXT.safeBrowsing
  return [
    {
      id: 'safe-browsing',
      heading: text.heading,
      description: text.description,
      rows: [
        choice<SafeBrowsingLevel>({
          id: 'safe-browsing-level',
          label: text.level,
          keywords: ['safe browsing', 'malware', 'phishing', 'dangerous sites', 'protection'],
          value: on ? 'standard' : 'off',
          options: [
            {
              value: 'standard',
              label: text.standard.label,
              description: text.standard.description
            },
            { value: 'off', label: text.none.label, description: text.none.description }
          ],
          onChange: (level) => setP({ safeBrowsingEnabled: level === 'standard' })
        }),
        {
          kind: 'field',
          id: 'safe-browsing-api-key',
          label: text.apiKey.label,
          description: text.apiKey.description,
          keywords: ['google', 'key', 'remote lookups'],
          value: p.safeBrowsingApiKey,
          display: apiKeyRowText(status, p.safeBrowsingApiKey),
          input: 'text',
          placeholder: text.apiKey.placeholder,
          secret: true,
          disabled: !on,
          // The §9.30 busy form: the key is tried against the API before it is kept.
          onCommit: (value) => commitApiKey(p.safeBrowsingApiKey, value, setP)
        }
      ]
    },
    {
      id: 'safe-browsing-feeds',
      heading: text.feeds.heading,
      description: text.feeds.description,
      rows: [
        {
          kind: 'action',
          id: 'safe-browsing-update',
          label: text.update,
          description: updateRowText(status, relativeTime),
          keywords: ['refresh', 'feeds'],
          busy: status.updating,
          disabled: !on || !status.ready,
          onPress: () => run('protection.updateFeeds', {})
        },
        ...status.feeds.map((feed) => feedItem(feed, !on))
      ]
    }
  ]
}

function feedItem(feed: SafeBrowsingFeedStatus, disabled: boolean): SettingsRow {
  const text = PROTECTION_TEXT.safeBrowsing
  return listItem(
    `safe-browsing-feed:${feed.id}`,
    feed.name,
    feedDetail(feed, relativeTime),
    [
      {
        kind: 'action',
        id: `safe-browsing-feed:${feed.id}:update`,
        label: text.updateFeed,
        busy: feed.updating,
        onPress: () => run('protection.updateFeeds', { id: feed.id })
      },
      {
        kind: 'action',
        id: `safe-browsing-feed:${feed.id}:homepage`,
        label: text.homepage(feed.name),
        description: `${feed.homepage.replace(/^https?:\/\//, '')} · ${feed.licence}`,
        leaves: 'external',
        onPress: () => run('app.openExternal', { url: feed.homepage })
      }
    ],
    disabled
  )
}

// ---------------------------------------------------------------------------
// Third-party cookies
// ---------------------------------------------------------------------------

/**
 * The mode as one choice, then the related sites: each an item whose sheet removes it, and the
 * add form as the last row (§9.12 in a sheet). While third-party cookies are allowed everywhere
 * the list is a dependent group at .4 (§10.4).
 */
export function cookiesGroups(state: UIState, set: Set): RowGroup[] {
  const p = state.settings.privacy
  const setP = patcher(state, set)
  const blocking = p.thirdPartyCookies !== 'allow'
  const exceptions = p.thirdPartyCookieExceptions
  const text = PROTECTION_TEXT.cookies
  const related = PROTECTION_TEXT.relatedSites
  return [
    {
      id: 'cookies',
      heading: text.heading,
      description: text.description,
      rows: [
        choice<ThirdPartyCookieMode>({
          id: 'cookies-mode',
          label: text.heading,
          keywords: ['cookies', 'tracking', 'block'],
          value: p.thirdPartyCookies,
          options: cookieModeOptions(state.capabilities.windows),
          onChange: (thirdPartyCookies) => setP({ thirdPartyCookies })
        })
      ]
    },
    {
      id: 'cookies-related-sites',
      heading: related.heading,
      description: related.description,
      rows: exceptions.map((site) =>
        listItem(
          `cookies-site:${site}`,
          site,
          related.keeps,
          [
            {
              kind: 'action',
              id: `cookies-site:${site}:remove`,
              label: related.remove(site),
              onPress: () =>
                setP({ thirdPartyCookieExceptions: exceptions.filter((s) => s !== site) })
            }
          ],
          !blocking
        )
      ),
      empty: related.empty
    },
    {
      id: 'cookies-add-site',
      heading: null,
      rows: [
        {
          kind: 'action',
          id: 'cookies-add-site',
          label: related.add,
          description: related.addDescription,
          keywords: ['exception', 'related sites'],
          disabled: !blocking,
          form: {
            title: related.add,
            description: related.description,
            render: (close) => (
              <AddSiteForm
                exists={(site) => exceptions.includes(site)}
                onAdd={(site) => setP({ thirdPartyCookieExceptions: [...exceptions, site] })}
                close={close}
              />
            )
          }
        }
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// HTTPS-only mode
// ---------------------------------------------------------------------------

const HTTPS_ONLY_MODES: HttpsOnlyMode[] = ['off', 'ask', 'always']

/**
 * The mode as one choice whose sheet opens on the group's description as its title block, then
 * the sites the warning page was answered "continue" for – for good (the `https-only`
 * permission) or until the browser closes – each an item whose sheet asks again.
 */
export function httpsOnlyGroups(state: UIState, set: Set): RowGroup[] {
  const p = state.settings.privacy
  const setP = patcher(state, set)
  const text = PROTECTION_TEXT.httpsOnly
  const sites = PROTECTION_TEXT.plaintextSites
  const stored = state.privacy.httpsOnlyExceptions
  const session = state.privacy.httpsOnlySessionExceptions.filter((s) => !stored.includes(s))
  return [
    {
      id: 'https-only',
      heading: text.heading,
      description: text.description,
      rows: [
        choice<HttpsOnlyMode>({
          id: 'https-only-mode',
          label: text.heading,
          keywords: ['https', 'secure connections', 'plaintext', 'http'],
          value: p.httpsOnly,
          options: HTTPS_ONLY_MODES.map((mode) => ({ value: mode, ...HTTPS_ONLY_LABELS[mode] })),
          sheetDescription: text.description,
          onChange: (httpsOnly) => setP({ httpsOnly })
        })
      ]
    },
    {
      id: 'https-only-sites',
      heading: sites.heading,
      description: sites.description,
      rows: [
        ...stored.map((site) =>
          listItem(`https-only-site:${site}`, site, sites.stored, [
            {
              kind: 'action',
              id: `https-only-site:${site}:forget`,
              label: sites.askAgain(site),
              onPress: () =>
                run('permissions.set', {
                  origin: `http://${site}`,
                  permission: HTTPS_ONLY_PERMISSION,
                  decision: null
                })
            }
          ])
        ),
        ...session.map((site) =>
          listItem(`https-only-session:${site}`, site, sites.session, [
            {
              kind: 'action',
              id: `https-only-session:${site}:forget`,
              label: sites.askAgain(site),
              onPress: () => run('protection.forgetPlaintext', { host: site })
            }
          ])
        )
      ],
      empty: sites.empty
    }
  ]
}

// ---------------------------------------------------------------------------
// Secure DNS
// ---------------------------------------------------------------------------

/**
 * Where the host has a resolver of its own (`capabilities.secureDns`): the switch, one resolver
 * choice folding the desktop's two radios and the menulist (the system resolver, the providers,
 * the custom entry), and the custom resolver's field when that is the pick – a §9.30 busy form
 * that asks the resolver one question before keeping it. Where it has none (Android), encrypted
 * DNS is the system's Private DNS setting and the one row opens that screen (§10.4).
 */
export function secureDnsGroups(state: UIState, set: Set): RowGroup[] {
  const text = PROTECTION_TEXT.secureDns
  if (!state.capabilities.secureDns) {
    const dns = PROTECTION_TEXT.privateDns
    return [
      {
        id: 'secure-dns',
        heading: text.heading,
        description: dns.description,
        rows: [
          {
            kind: 'action',
            id: 'secure-dns-private-dns',
            label: dns.open.label,
            description: dns.open.description,
            keywords: ['dns', 'private dns', 'encrypted', 'doh', 'dot'],
            leaves: 'external',
            onPress: () => run('protection.openPrivateDnsSettings', undefined)
          }
        ]
      }
    ]
  }
  const p = state.settings.privacy
  const setP = patcher(state, set)
  const on = p.secureDnsMode !== 'off'
  const custom = p.secureDnsMode === 'provider' && p.secureDnsProvider === SECURE_DNS_CUSTOM
  const rows: SettingsRow[] = [
    {
      kind: 'switch',
      id: 'secure-dns-enabled',
      label: text.use,
      description: secureDnsText(p, state.privacy.secureDns),
      keywords: ['dns', 'encrypted', 'doh', 'resolver'],
      checked: on,
      onChange: (v) => setP({ secureDnsMode: v ? 'automatic' : 'off' })
    },
    choice({
      id: 'secure-dns-resolver',
      label: text.resolver.label,
      value: resolverValue(p),
      options: resolverOptions(),
      sheetDescription: text.resolver.description,
      disabled: !on,
      onChange: (value) => setP(resolverPatch(value))
    })
  ]
  if (custom) {
    rows.push({
      kind: 'field',
      id: 'secure-dns-custom',
      label: text.custom.label,
      description: text.custom.description,
      keywords: ['doh', 'template', 'nextdns', 'adguard'],
      value: p.secureDnsCustomUrl,
      display: p.secureDnsCustomUrl || text.custom.unset,
      input: 'text',
      placeholder: text.custom.placeholder,
      disabled: !on,
      // The §9.30 busy form: the resolver is asked one question before it is kept.
      onCommit: (value) => commitCustomResolver(p.secureDnsCustomUrl, value, setP)
    })
  }
  return [{ id: 'secure-dns', heading: text.heading, description: text.description, rows }]
}

// ---------------------------------------------------------------------------
// Privacy signals
// ---------------------------------------------------------------------------

export function signalsGroups(state: UIState, set: Set): RowGroup[] {
  const p = state.settings.privacy
  const setP = patcher(state, set)
  const text = PROTECTION_TEXT.signals
  return [
    {
      id: 'signals',
      heading: text.heading,
      description: text.description,
      rows: [
        {
          kind: 'switch',
          id: 'signals-gpc',
          label: text.gpc.label,
          description: text.gpc.description,
          keywords: ['gpc', 'global privacy control', 'sec-gpc'],
          checked: p.gpc,
          onChange: (gpc) => setP({ gpc })
        },
        {
          kind: 'switch',
          id: 'signals-dnt',
          label: text.dnt.label,
          description: text.dnt.description,
          keywords: ['dnt', 'do not track'],
          checked: p.dnt,
          onChange: (dnt) => setP({ dnt })
        }
      ]
    }
  ]
}
