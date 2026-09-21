import type { ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import type { PermissionRule, SafetyCheckResult, UIState } from '@shared/types'
import {
  contentSettingId,
  contentSettingsFor,
  type ContentDefault,
  type ContentSetting
} from '@shared/contentSettings'
import { run } from '@renderer/lib/api'
import { headline, safetyRows, worstState, type SafetyAction } from '@renderer/lib/safetyCheck'
import { openOverlay } from '@renderer/lib/ui'
import {
  DEFAULT_WORDS,
  SITE_SETTINGS_GROUPS,
  bySite,
  count,
  defaultDescription,
  describeRule,
  hostOf,
  permissionName
} from '@renderer/lib/siteSettings'
import { cn, relativeTime } from '@renderer/lib/utils'
import { V2_GLYPH } from '../v2/controls'
import {
  choice,
  type ActionRow,
  type ItemRow,
  type RowGroup,
  type SettingsRow
} from '../pages/settings/model'
import type { SectionContext } from '../pages/settings/sections'
import { ClearBrowsingDataForm } from './ClearBrowsingDataForm'
import { StatusGlyph } from './pane'

/**
 * The site-controls rows of the phone's Privacy and Security category (design-language-v2-draft
 * §9.2, §9.13, §9.17, §10.3–§10.4): three self-contained blocks the `privacySection` builder
 * (`pages/settings/sections.tsx`) places in Chrome's order – Safety check first, Clear browsing
 * data after the tracking groups, Site settings after it – each a plain function of the state
 * and the commands it runs, the way every builder row is. They are the desktop panes
 * (`overlays/SafetyCheckSection`, `ClearBrowsingDataSection`, `SiteSettingsSection`) row for
 * row: a card becomes rows under a 15/600 heading, a menulist a value row, a button an action
 * row, a list a group of item rows with a sheet each (§10.4: no cards, no inline buttons).
 *
 * Row ids are prefixed `safety-check`, `clear-data` and `sites` so they stay unique beside the
 * other programs' groups in the same category.
 */

// ---------------------------------------------------------------------------
// Safety check
// ---------------------------------------------------------------------------

const SAFETY_CHECK_INTRO =
  'Zenium looks for an update, checks Safe Browsing, your saved passwords, the permissions and notifications sites hold, and your extensions.'

/**
 * Safety check as rows: the standing (how the last run went and when, a status glyph in the §1
 * ink), one row per area with its glyph and the engine's sentence – the rows that have an
 * answer are the action themselves, a chevron on those that open something – and Check now.
 * The result is the state's `lastSafetyCheck`, kept by the core until the next run; before the
 * first run the results group shows its one-line empty state. Reviews of the sites holding
 * permissions or sending notifications open a sheet listing them, each site an action that
 * resets or stops it (Chrome's review pages); the extensions review leaves for that category.
 */
export function safetyCheckGroups({ state, tab, navigate }: SectionContext): RowGroup[] {
  const result = state.lastSafetyCheck
  const worst = result ? worstState(result) : null
  const check = (): void => run('privacy.safetyCheck', undefined)
  const act = (action: SafetyAction): void => {
    switch (action.kind) {
      case 'command':
        run(action.command, undefined)
        return
      case 'passwords-checkup':
        run('passwords.checkupRun', undefined)
        // The checkup reports through the passwords status; read the check again once it has.
        setTimeout(check, 1500)
        return
      case 'passwords-review':
        // The manager's checkup view lists the compromised logins (Chrome's Review).
        void openOverlay('passwords', tab.id, null, null, 'checkup')
        return
      case 'section':
        // The site-settings reviews are item sheets here (below); only Extensions leaves.
        if (action.section === 'extensions') navigate('extensions')
    }
  }
  const glyph: ReactNode = worst ? (
    <StatusGlyph state={worst} />
  ) : (
    <ShieldCheck className={cn(V2_GLYPH, 'text-[var(--v2-text-deemphasized)]')} aria-hidden />
  )
  const results: SettingsRow[] = result
    ? safetyRows(result, state).map((row): SettingsRow => {
        const id = `safety-check:${row.id}`
        const leading = <StatusGlyph state={row.state} />
        if (row.id === 'permissions' && row.action)
          return permissionsReview(id, row.label, row.summary, leading, result, state, check)
        if (row.id === 'notifications' && row.action)
          return notificationsReview(id, row.label, row.summary, leading, result, check)
        if (!row.action) {
          return { kind: 'info', id, label: row.label, description: row.summary, leading }
        }
        const action = row.action.act
        return {
          kind: 'action',
          id,
          label: row.label,
          description: row.summary,
          // The Passwords row's description is the status sentence ("2 compromised passwords
          // found; change them now"), so it takes the glyph's ink with it (§9.33, one `data-tone`
          // on the row – pr-261's contract); the list's other rows are their owner's pass.
          tone: row.id === 'passwords' && row.state === 'warning' ? 'warn' : undefined,
          keywords: [row.action.label],
          leading,
          leaves:
            action.kind === 'section' || action.kind === 'passwords-review'
              ? 'chevron'
              : action.kind === 'command' && action.command === 'updates.openRelease'
                ? 'external'
                : undefined,
          onPress: () => act(action)
        }
      })
    : []
  return [
    {
      id: 'safety-check',
      heading: 'Safety check',
      description: SAFETY_CHECK_INTRO,
      rows: [
        {
          kind: 'info',
          id: 'safety-check-standing',
          label: headline(result, false, null, worst),
          description: result
            ? `Checked ${relativeTime(result.checkedAt).toLowerCase()}`
            : 'Not checked yet',
          keywords: ['safety', 'check', 'security'],
          leading: glyph
        }
      ]
    },
    {
      id: 'safety-check-results',
      heading: 'Results',
      description: 'Each row is one area; a row with something to do opens or does it.',
      rows: results,
      empty: 'Run the check to see results'
    },
    {
      id: 'safety-check-actions',
      heading: null,
      rows: [
        {
          kind: 'action',
          id: 'safety-check-now',
          label: 'Check now',
          keywords: ['safety check', 'run'],
          button: 'Check now',
          onPress: check
        }
      ]
    }
  ]
}

/**
 * The permissions review (Chrome's "Review site permissions"): every site holding a granted
 * permission, the ones the check flagged first with why, each an action that forgets the site's
 * answers after a confirmation.
 */
function permissionsReview(
  id: string,
  label: string,
  summary: string,
  leading: ReactNode,
  result: SafetyCheckResult,
  state: UIState,
  recheck: () => void
): ItemRow {
  const flagged = new Map(result.permissions.review.map((r) => [r.origin, r]))
  const granted = bySite(state.permissionRules.filter((r) => r.decision === 'allow'))
  const sites = [...granted].sort((a, b) => {
    const fa = flagged.has(a.origin) ? 0 : 1
    const fb = flagged.has(b.origin) ? 0 : 1
    return fa - fb
  })
  return {
    kind: 'item',
    id,
    label,
    description: summary,
    leading,
    sheet: {
      title: 'Site permissions',
      description: 'Sites allowed to use something. Resetting a site makes it ask again.',
      groups: [
        {
          id: `${id}:sites`,
          heading: null,
          rows: sites.map((site): ActionRow => {
            const host = hostOf(site.origin)
            const flag = flagged.get(site.origin)
            const names = site.rules.map((r) => permissionName(r.permission)).join(', ')
            return {
              kind: 'action',
              id: `${id}:${site.origin}`,
              label: host,
              description: flag
                ? `${names} · ${flag.reason === 'unused' ? 'Not used for weeks' : 'Several at once'}`
                : names,
              button: 'Reset…',
              confirm: {
                title: `Reset ${host}?`,
                description: 'The site asks again the next time it needs a permission.',
                action: 'Reset'
              },
              onPress: () => {
                run('permissions.resetOrigin', { origin: site.origin })
                recheck()
              }
            }
          }),
          empty: 'No site holds a permission'
        }
      ]
    }
  }
}

/**
 * The notifications review (Chrome's "Review notification permissions"): the sites allowed to
 * send notifications, busiest first, each an action that blocks them after a confirmation.
 */
function notificationsReview(
  id: string,
  label: string,
  summary: string,
  leading: ReactNode,
  result: SafetyCheckResult,
  recheck: () => void
): ItemRow {
  return {
    kind: 'item',
    id,
    label,
    description: summary,
    leading,
    sheet: {
      title: 'Notifications',
      description: 'Sites allowed to send notifications. Stopping a site blocks them.',
      groups: [
        {
          id: `${id}:sites`,
          heading: null,
          rows: result.notifications.sites.map((site): ActionRow => {
            const host = hostOf(site.origin)
            return {
              kind: 'action',
              id: `${id}:${site.origin}`,
              label: host,
              description:
                site.shown > 0
                  ? `${count(site.shown, 'notification')} since Zenium started`
                  : 'None since Zenium started',
              button: 'Stop…',
              confirm: {
                title: `Stop notifications from ${host}?`,
                description: 'The site is blocked from sending notifications.',
                action: 'Stop'
              },
              onPress: () => {
                run('permissions.set', {
                  origin: site.origin,
                  permission: 'notifications',
                  decision: 'deny'
                })
                recheck()
              }
            }
          }),
          empty: 'No site sends notifications'
        }
      ]
    }
  }
}

// ---------------------------------------------------------------------------
// Clear browsing data
// ---------------------------------------------------------------------------

/**
 * Clear browsing data as one action row whose sheet is the form (`ClearBrowsingDataForm`, the
 * dialog's state under a finger): the group names what goes, the sheet's title block what to
 * choose.
 */
export function clearDataGroups({ state }: SectionContext): RowGroup[] {
  const containers = state.containers.length
  return [
    {
      id: 'clear-data',
      heading: 'Clear browsing data',
      description:
        'Remove what Zenium kept while you browsed: history, cookies and site data, the cache, and more. Bookmarks, settings and your Spaces stay.',
      rows: [
        {
          kind: 'action',
          id: 'clear-data-open',
          label: 'Clear browsing data',
          description:
            containers > 1
              ? `History, cookies, cache and more, across ${containers} containers and the private session`
              : 'History, cookies, cache and more, including the private session',
          keywords: ['history', 'cookies', 'cache', 'site data', 'delete', 'passwords'],
          button: 'Clear…',
          form: {
            title: 'Clear browsing data',
            description:
              'Choose a time range and what to remove. Cookies and site data go from every container.',
            render: (close) => <ClearBrowsingDataForm close={close} />
          }
        }
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// Site settings
// ---------------------------------------------------------------------------

const SITE_SETTINGS_INTRO =
  'What sites may use and do. Sites ask first unless you decide for all of them here; a site you answered keeps that answer.'

/**
 * Site settings as rows: the catalogue's content types this host honours, grouped as Chrome
 * groups them, each an item row (its default's meaning under it) whose sheet holds the default
 * as a value row – the §9.13 picker over it – and the sites with an answer of their own for
 * that type, each an action that forgets the answer after a confirmation (Chrome's per-type
 * pages); a type with one possible default is a fact. Then the sites with settings of their
 * own, each a sheet of its answers with a Reset, and Reset all.
 */
export function siteSettingsGroups({ state }: SectionContext): RowGroup[] {
  const platform = state.platform === 'android' ? 'android' : 'desktop'
  const catalogue = contentSettingsFor(platform)
  const groups: RowGroup[] = []
  for (const group of SITE_SETTINGS_GROUPS) {
    const own = catalogue.filter((setting) => setting.group === group.id)
    if (own.length === 0) continue
    const first = group.id === SITE_SETTINGS_GROUPS[0].id
    groups.push({
      id: `sites-${group.id}`,
      heading: first ? 'Site settings' : group.heading,
      description: first ? SITE_SETTINGS_INTRO : group.description,
      rows: own.map((setting) =>
        contentTypeRow(
          setting,
          state.permissionDefaults[setting.id] ?? setting.builtInDefault,
          state
        )
      )
    })
  }
  const sites = bySite(state.permissionRules)
  const siteRows: SettingsRow[] = sites.map((site): ItemRow => {
    const host = hostOf(site.origin)
    return {
      kind: 'item',
      id: `sites:site:${site.origin}`,
      label: host,
      description: site.rules.map(describeRule).join(' · '),
      sheet: {
        title: host,
        description: 'The answers this site keeps. Resetting them makes it ask again.',
        groups: [
          {
            id: `sites:site:${site.origin}:rules`,
            heading: null,
            rows: [
              ...site.rules.map((rule): SettingsRow => ({
                kind: 'info',
                id: `sites:site:${site.origin}:${rule.permission}`,
                label: permissionName(rule.permission),
                description: rule.decision === 'allow' ? 'Allowed' : 'Blocked'
              })),
              {
                kind: 'action',
                id: `sites:site:${site.origin}:reset`,
                label: 'Reset site settings',
                description:
                  'The site follows the defaults again and asks when it needs something.',
                button: 'Reset…',
                confirm: {
                  title: `Reset ${host}?`,
                  description: 'Every answer the site keeps is forgotten.',
                  action: 'Reset'
                },
                onPress: () => run('permissions.resetOrigin', { origin: site.origin })
              }
            ]
          }
        ]
      }
    }
  })
  if (sites.length > 0) {
    siteRows.push({
      kind: 'action',
      id: 'sites-reset-all',
      label: 'Reset all sites',
      description: 'Every site follows the defaults again.',
      destructive: true,
      button: 'Reset all…',
      confirm: {
        title: 'Reset the settings of every site?',
        description: 'Every site asks again the next time it needs a permission.',
        action: 'Reset all'
      },
      onPress: () => run('permissions.reset', undefined)
    })
  }
  groups.push({
    id: 'sites-own',
    heading: 'Sites with their own settings',
    description:
      'Answers you gave to a site’s questions, and decisions made for a site in its information panel.',
    rows: siteRows,
    empty: 'No site has settings of its own yet'
  })
  return groups
}

/**
 * One content type: an item row with the default's meaning under it, opening a sheet with the
 * default as a value row and the type's per-site answers; a type whose only default is the
 * built-in one (USB, serial: never handed to sites) is an info row, nothing to choose.
 */
function contentTypeRow(
  setting: ContentSetting,
  value: ContentDefault,
  state: UIState
): SettingsRow {
  const id = `sites:${setting.id}`
  const meaning = defaultDescription(setting, value)
  if (setting.choices.length < 2) {
    return { kind: 'info', id, label: setting.label, description: meaning }
  }
  const rules = state.permissionRules
    .filter((rule) => contentSettingId(rule.permission) === setting.id)
    .sort((a, b) => hostOf(a.origin).localeCompare(hostOf(b.origin)))
  return {
    kind: 'item',
    id,
    label: setting.label,
    description: meaning,
    keywords: ['permission', 'site settings'],
    sheet: {
      title: setting.label,
      description: meaning,
      groups: [
        {
          id: `${id}:default`,
          heading: null,
          rows: [
            choice<ContentDefault>({
              id: `${id}:default`,
              label: 'Default behaviour',
              value,
              options: setting.choices.map((choiceValue) => ({
                value: choiceValue,
                label: DEFAULT_WORDS[choiceValue],
                description: choiceValue === setting.builtInDefault ? 'Default' : undefined
              })),
              onChange: (decision) =>
                run('permissions.setDefault', { permission: setting.id, decision })
            })
          ]
        },
        {
          id: `${id}:sites`,
          heading: 'Sites with their own answer',
          rows: rules.map((rule) => ruleRow(id, rule)),
          empty: 'No site has its own answer'
        }
      ]
    }
  }
}

/** A site's answer for one type: forgotten, after a confirmation, so the site asks again. */
function ruleRow(typeId: string, rule: PermissionRule): ActionRow {
  const host = hostOf(rule.origin)
  const qualified = rule.permission.includes(':')
  return {
    kind: 'action',
    id: `${typeId}:${rule.origin}:${rule.permission}`,
    label: host,
    description: qualified ? describeRule(rule) : rule.decision === 'allow' ? 'Allowed' : 'Blocked',
    button: 'Forget…',
    confirm: {
      title: `Forget the answer for ${host}?`,
      description: 'The site asks again the next time it needs it.',
      action: 'Forget'
    },
    onPress: () => run('permissions.forget', { origin: rule.origin, permission: rule.permission })
  }
}
