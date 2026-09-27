import type { ReactNode } from 'react'
import { ShieldCheck } from 'lucide-react'
import type {
  DeviceGrant,
  DeviceKind,
  PermissionRule,
  SafetyCheckResult,
  UIState
} from '@shared/types'
import {
  contentSettingId,
  contentSettingsFor,
  isDeviceKind,
  type ContentDefault,
  type ContentSetting
} from '@shared/contentSettings'
import { TOAST_UNDO_MS } from '@shared/toastCard'
import { cmd, run } from '@renderer/lib/api'
import { grantDetail, grantsOf, sitesWithGrants } from '@renderer/lib/devices'
import { headline, safetyRows, worstState, type SafetyAction } from '@renderer/lib/safetyCheck'
import { openOverlay, pushToast } from '@renderer/lib/ui'
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
  type DetailRow,
  type FormSheet,
  type ItemRow,
  type RowGroup,
  type SettingsRow,
  type SwitchRow
} from '../pages/settings/model'
import type { SectionContext } from '../pages/settings/sections'
import { ClearBrowsingDataForm } from './ClearBrowsingDataForm'
import { StatusGlyph } from './pane'

/**
 * The site-controls rows of the phone's Privacy and Security category (design-language-v2-draft
 * §9.2, §9.13, §9.17, §10.3–§10.4): three self-contained blocks the `privacySection` builder
 * (`pages/settings/sections.tsx`) places in the privacy hub cards' order (the #553 lead check's
 * Q6) – Delete browsing data first, Site settings after the cookies and Safe Browsing groups,
 * Safety check after it – each a plain function of the state
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
 * permissions or sending notifications open a sheet listing them – a permission site an item
 * row carrying its plain Reset, a notifying site an action that stops it after a confirmation
 * (Chrome's review pages); the extensions review leaves for that category.
 */
export function safetyCheckGroups({ state, tab, navigate }: SectionContext): RowGroup[] {
  const result = state.lastSafetyCheck
  const worst = result ? worstState(result) : null
  // Settled once the result has landed in the state (the reviews' acts wait on it; errors are
  // the command layer's to log, never a row's).
  const check = (): Promise<void> =>
    cmd('privacy.safetyCheck', undefined).then(
      () => undefined,
      () => undefined
    )
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
 * permission, the ones the check flagged first with why, each an item row in the grant rows'
 * shape (`ruleRow`) whose one action, Reset, forgets the site's answers at once – "Reset <host>"
 * to a reader, plain ink, no confirmation – and runs the check again. The lead's #431 Q1 ruling:
 * a per-site reset is the same plain act as one Forget and costs nothing but that site asking
 * again; §10.5's bulk is the list emptied, which Reset all sites is and confirms.
 *
 * Before them, while the check's revoked list holds anything, Chrome's Safety Hub module row
 * for row (PS-41; `unused_site_permissions_module.html`, `SafetyHubPermissionsFragment`): the
 * sites the sweep removed permissions from – each an item row in the same shape whose one
 * action, Allow again, grants them back at once (`permissions.regrantRevoked`; the site is
 * kept from the sweep after) with Chrome's toast and its Undo (`undoRegrantRevoked`) – and Got
 * it, which takes the list as reviewed (`acknowledgeRevoked`: the permissions stay removed)
 * with the bulk toast and its Undo (`restoreRevokedList`). Each act runs the check again, so
 * the row's sentence and the sheet follow. The sheet's description covers both lists.
 */
function permissionsReview(
  id: string,
  label: string,
  summary: string,
  leading: ReactNode,
  result: SafetyCheckResult,
  state: UIState,
  recheck: () => Promise<void>
): ItemRow {
  const flagged = new Map(result.permissions.review.map((r) => [r.origin, r]))
  const granted = bySite(state.permissionRules.filter((r) => r.decision === 'allow'))
  const sites = [...granted].sort((a, b) => {
    const fa = flagged.has(a.origin) ? 0 : 1
    const fb = flagged.has(b.origin) ? 0 : 1
    return fa - fb
  })
  const revoked = result.permissions.revoked
  const revokedGroups: RowGroup[] =
    revoked.length > 0 ? [revokedReview(id, summary, revoked, recheck)] : []
  return {
    kind: 'item',
    id,
    label,
    description: summary,
    leading,
    sheet: {
      title: 'Site permissions',
      description:
        'Sites allowed to use something, and permissions taken back from unused sites. Resetting a site makes it ask again.',
      groups: [
        ...revokedGroups,
        {
          id: `${id}:sites`,
          // Alone the list needs no heading; under the removed permissions it names itself.
          heading: revoked.length > 0 ? 'Sites with permissions you granted' : null,
          rows: sites.map((site): ItemRow => {
            const host = hostOf(site.origin)
            const flag = flagged.get(site.origin)
            const names = site.rules.map((r) => permissionName(r.permission)).join(', ')
            const description = flag
              ? `${names} · ${flag.reason === 'unused' ? 'Not used for weeks' : 'Several at once'}`
              : names
            const rowId = `${id}:${site.origin}`
            const onPress = (): void => {
              run('permissions.resetOrigin', { origin: site.origin })
              recheck()
            }
            const reset: ActionRow = {
              kind: 'action',
              id: `${rowId}:reset`,
              label: 'Reset',
              description: 'The site asks again the next time it needs a permission.',
              button: 'Reset',
              onPress
            }
            return {
              kind: 'item',
              id: rowId,
              label: host,
              description,
              action: { label: 'Reset', onPress },
              sheet: {
                title: host,
                description,
                groups: [{ id: `${rowId}:actions`, heading: null, rows: [reset] }]
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
 * The sites whose Allow again is on its way: pressed, and the check not yet back with the list
 * that no longer holds them. A second press meanwhile is the engine's no-op and would only
 * double the toast (the desktop's column keeps every toast), so it does nothing. Module state,
 * since the rows are rebuilt from the state on every render and the press outlives the build.
 */
const regranting = new Set<string>()

/**
 * The removed-permissions block of the permissions review, Chrome's Safety Hub module as a
 * group: its heading the row's own sentence ("Permissions removed from N sites"), its
 * description Chrome's subheader – which says once why they went – one item row per site, the
 * permissions alone under the host ("Camera, Microphone"), Allow again its one action, and Got
 * it closing the block. Allow again and Got it each raise Chrome's toast with Undo on §9.33's
 * Undo clock (`TOAST_UNDO_MS`); the check runs again after each act and each undo. Got it
 * leaves the review sheet with its press (`closesSheet`): its act ends the list the sheet was
 * opened for, and the toast then stands over the page on the phone, where a message sits under
 * an open sheet. Allow again keeps the sheet open for the sites left.
 */
function revokedReview(
  id: string,
  summary: string,
  revoked: SafetyCheckResult['permissions']['revoked'],
  recheck: () => Promise<void>
): RowGroup {
  const groupId = `${id}:revoked`
  const allowAgain = (origin: string): void => {
    if (regranting.has(origin)) return
    regranting.add(origin)
    run('permissions.regrantRevoked', { origin })
    void recheck().finally(() => regranting.delete(origin))
    pushToast(`Permissions allowed again for ${hostOf(origin)}`, 'info', {
      duration: TOAST_UNDO_MS,
      action: {
        label: 'Undo',
        onPick: () => {
          run('permissions.undoRegrantRevoked', { origin })
          void recheck()
        }
      }
    })
  }
  const acknowledge = (): void => {
    void cmd('permissions.acknowledgeRevoked', undefined)
      .then((records) => {
        void recheck()
        if (records.length === 0) return
        pushToast(`Review complete for ${count(records.length, 'site')}`, 'info', {
          duration: TOAST_UNDO_MS,
          action: {
            label: 'Undo',
            onPick: () => {
              run('permissions.restoreRevokedList', { records })
              void recheck()
            }
          }
        })
      })
      .catch(() => undefined)
  }
  const rows: SettingsRow[] = revoked.map((record): ItemRow => {
    const host = hostOf(record.origin)
    const description = record.permissions.map(permissionName).join(', ')
    const rowId = `${groupId}:${record.origin}`
    const onPress = (): void => allowAgain(record.origin)
    const regrant: ActionRow = {
      kind: 'action',
      id: `${rowId}:allow-again`,
      label: 'Allow again',
      button: 'Allow again',
      onPress
    }
    return {
      kind: 'item',
      id: rowId,
      label: host,
      description,
      action: {
        label: 'Allow again',
        // Chrome's reader name for the button (`settings_strings.grdp`: "Allow permissions
        // again for $1"); the label then the host would read "Allow again meet.example".
        ariaLabel: `Allow permissions again for ${host}`,
        onPress
      },
      sheet: {
        title: host,
        description,
        groups: [{ id: `${rowId}:actions`, heading: null, rows: [regrant] }]
      }
    }
  })
  rows.push({
    kind: 'action',
    id: `${groupId}:acknowledge`,
    label: 'Got it',
    description: 'Clears this list. Sites ask again when they need a permission.',
    button: 'Got it',
    closesSheet: true,
    onPress: acknowledge
  })
  return {
    id: groupId,
    heading: summary,
    description:
      revoked.length === 1
        ? "To protect your data, permissions were removed from a site you haven't visited recently."
        : "To protect your data, permissions were removed from sites you haven't visited recently.",
    rows
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
// Delete browsing data
// ---------------------------------------------------------------------------

/**
 * The Delete browsing data sheet (PS-13, `ClearBrowsingDataForm`): the group's row opens it, and
 * so does the Privacy and security hub's "Delete browsing data…" card (W7-6), the one dialog.
 * Chrome's words since M124 (`IDS_CLEAR_BROWSING_DATA_TITLE` "Delete browsing data"); the
 * identifiers keep Chrome's own `clear` names, as Chrome's string ids do.
 */
const CLEAR_BROWSING_DATA_DESCRIPTION =
  'Choose a time range and what to delete. Cookies and site data go from every container.'

export const CLEAR_BROWSING_DATA_FORM: FormSheet = {
  title: 'Delete browsing data',
  description: CLEAR_BROWSING_DATA_DESCRIPTION,
  render: (close) => <ClearBrowsingDataForm close={close} />
}

/**
 * The same sheet on the phone layout, where the form is Chrome Android's Quick Delete (HB-07,
 * `QUICK_DELETE_FORM`) and carries a Tabs row: the description says what that row does, since
 * nothing else on the sheet does before the switch is on (the reviewer's N5). The form itself
 * decides the layout by `usePhone()`; this block is the builder's, so it reads the same
 * `formFactor` the page laid the rows out for.
 */
export const QUICK_DELETE_SHEET: FormSheet = {
  ...CLEAR_BROWSING_DATA_FORM,
  description: `${CLEAR_BROWSING_DATA_DESCRIPTION} Turn on Tabs to close the tabs you used in that time as well.`
}

/**
 * Delete browsing data as one action row whose sheet is the form (`ClearBrowsingDataForm`, the
 * dialog's state under a finger): the group names what goes, the sheet's title block what to
 * choose. The row is Chrome's Settings › Privacy and security row
 * (`IDS_SETTINGS_CLEAR_BROWSING_DATA` "Delete browsing data"). On the phone layout the sheet is
 * `QUICK_DELETE_SHEET`, whose description names the Tabs row.
 */
export function clearDataGroups({ state, formFactor }: SectionContext): RowGroup[] {
  const containers = state.containers.length
  const form = formFactor === 'phone' ? QUICK_DELETE_SHEET : CLEAR_BROWSING_DATA_FORM
  return [
    {
      id: 'clear-data',
      heading: 'Delete browsing data',
      description:
        'Delete what Zenium kept while you browsed: history, cookies and site data, the cache, and more. Bookmarks, settings and your Spaces stay.',
      rows: [
        {
          kind: 'action',
          id: 'clear-data-open',
          label: 'Delete browsing data',
          description:
            containers > 1
              ? `History, cookies, cache and more, across ${containers} containers and the private session`
              : 'History, cookies, cache and more, including the private session',
          keywords: ['history', 'cookies', 'cache', 'site data', 'clear', 'delete', 'passwords'],
          button: 'Delete…',
          form
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
 * that type, each an item row whose one action, Forget, runs at once (the lead's #418 ruling 5;
 * Chrome's per-type pages); a type with one possible default is a fact. Then the sites with
 * settings of their own, each a sheet of its answers with a Reset that runs at once (the lead's
 * #431 Q1 ruling), and Reset all, the one confirmed act: the list emptied. Last, as on both
 * Chromes' Site settings pages, the switch of the sweep that removes unused sites' permissions.
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
                // Plain and at once, no ellipsis and no confirmation (the lead's #431 Q1
                // ruling): a site's answers forgotten together cost that site asking again,
                // one Forget's recovery; the bulk Reset all sites below is the list emptied.
                kind: 'action',
                id: `sites:site:${site.origin}:reset`,
                label: 'Reset site settings',
                description:
                  'The site follows the defaults again and asks when it needs something.',
                button: 'Reset',
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
  // A heading of its own: after the danger-ink Reset all sites, a headingless switch would read
  // as that list's tail (the lead's #637 ruling 6).
  groups.push({
    id: 'sites-unused',
    heading: 'Unused sites',
    rows: [autoRevokeRow(state, platform)]
  })
  return groups
}

/**
 * The unused-site-permissions sweep's switch (PS-41; `Settings.autoRevokeUnusedPermissions`),
 * where both Chromes keep it – the last thing on the Site settings page (desktop
 * `site_settings_page.html`'s `unusedSitePermissionsRevocationToggle`; Android's
 * `IDS_SAFETY_HUB_AUTOREVOCATION_TOGGLE_*`, "a setting located in the 'Site settings' page") –
 * in each host's own words: the desktop's two sentences, and on the phone the one that fits
 * the sublabel's two lines with "recently" kept (a clamp that drops it changes the meaning,
 * §10.5). Off, nothing more is removed; what the sweep removed stays listed in the Safety
 * check until it is reviewed or a month passes.
 */
function autoRevokeRow(state: UIState, platform: 'android' | 'desktop'): SwitchRow {
  const phone = platform === 'android'
  return {
    kind: 'switch',
    id: 'sites-auto-revoke',
    label: phone
      ? 'Automatically remove permissions'
      : 'Automatically remove permissions from unused sites',
    description: phone
      ? "Let Zenium remove permissions from sites that you haven't visited recently."
      : "To protect your data, let Zenium remove permissions from sites you haven't visited recently. Notifications are not removed.",
    keywords: ['unused sites', 'revoke', 'remove permissions', 'safety check', 'safety hub'],
    checked: state.settings.autoRevokeUnusedPermissions,
    onChange: (checked) => run('settings.update', { autoRevokeUnusedPermissions: checked })
  }
}

/**
 * One content type: an item row with the default's meaning under it, opening a sheet with the
 * default as a value row and the type's per-site answers; a type whose only default is the
 * built-in one (VR, local fonts: never handed to sites) is an info row, nothing to choose. A device
 * kind's answers are its blocks – a pick grants one device, never an allow – so the sites
 * connected to devices of the kind stand among them as detail rows into their device lists
 * (MW-32..35), the whole list alphabetical by host.
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
  const own: Array<{ host: string; row: SettingsRow }> = state.permissionRules
    .filter((rule) => contentSettingId(rule.permission) === setting.id)
    .map((rule) => ({ host: hostOf(rule.origin), row: ruleRow(id, rule) }))
  if (isDeviceKind(setting.id)) {
    const kind: DeviceKind = setting.id
    for (const site of sitesWithGrants(state.deviceGrants, kind)) {
      own.push({
        host: hostOf(site.origin),
        row: grantedSiteRow(id, kind, site.origin, grantsOf(state.deviceGrants, site.origin, kind))
      })
    }
  }
  const exceptions = own.sort((a, b) => a.host.localeCompare(b.host)).map((entry) => entry.row)
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
          rows: exceptions,
          empty: 'No site has its own answer'
        }
      ]
    }
  }
}

/**
 * A site connected to devices of one kind (its `DeviceGrant`s, the setting's data): a §10.4
 * detail row with the count, opening the depth-two sheet of the devices – each an item row
 * (its name, its vendor:product or serial under it) whose one action is Revoke: the trailing
 * 32 button named for its device (§10.5), plain ink – a grant is the site's permission, not the
 * user's data (§6, §10.4) – and no confirmation (the sheet is depth two already, §9.24, and a
 * revoked device is asked for again, not lost). The site-information panel's device level
 * (`SiteInfoPopover`) is the same list for one site.
 */
function grantedSiteRow(
  typeId: string,
  kind: DeviceKind,
  origin: string,
  grants: readonly DeviceGrant[]
): DetailRow {
  const host = hostOf(origin)
  const id = `${typeId}:${origin}:devices`
  return {
    kind: 'detail',
    id,
    label: host,
    summary: count(grants.length, 'device'),
    sheet: {
      title: host,
      description: 'What this site may connect to. Revoking a device makes the site ask again.',
      groups: [
        {
          id: `${id}:list`,
          heading: null,
          rows: grants.map((grant) => grantRow(id, kind, origin, grant)),
          empty: 'No devices'
        }
      ]
    }
  }
}

/** One granted device as an item row: Revoke trailing, named for the device, running at once. */
function grantRow(listId: string, kind: DeviceKind, origin: string, grant: DeviceGrant): ItemRow {
  const id = `${listId}:${grant.deviceId}`
  const detail = grantDetail(grant) || undefined
  const onPress = (): void => void run('devices.forget', { origin, kind, deviceId: grant.deviceId })
  const revoke: ActionRow = {
    kind: 'action',
    id: `${id}:revoke`,
    label: 'Revoke',
    description: 'The site asks again the next time it needs the device.',
    button: 'Revoke',
    onPress
  }
  return {
    kind: 'item',
    id,
    label: grant.name,
    description: detail,
    action: { label: 'Revoke', onPress },
    sheet: {
      title: grant.name,
      description: detail,
      groups: [{ id: `${id}:actions`, heading: null, rows: [revoke] }]
    }
  }
}

/**
 * A site's answer for one type, the grant rows' shape (§10.4; the lead's #418 ruling 5): an item
 * row named for its host with Forget trailing – "Forget <host>" to a reader – running at once,
 * no confirmation, as the grant rows' Revoke does; the answer is one the site asks for again the
 * next time it needs it, not the user's own data.
 */
function ruleRow(typeId: string, rule: PermissionRule): ItemRow {
  const host = hostOf(rule.origin)
  const id = `${typeId}:${rule.origin}:${rule.permission}`
  const qualified = rule.permission.includes(':')
  const description = qualified
    ? describeRule(rule)
    : rule.decision === 'allow'
      ? 'Allowed'
      : 'Blocked'
  const onPress = (): void =>
    void run('permissions.forget', { origin: rule.origin, permission: rule.permission })
  const forget: ActionRow = {
    kind: 'action',
    id: `${id}:forget`,
    label: 'Forget',
    description: 'The site asks again the next time it needs it.',
    button: 'Forget',
    onPress
  }
  return {
    kind: 'item',
    id,
    label: host,
    description,
    action: { label: 'Forget', onPress },
    sheet: {
      title: host,
      description,
      groups: [{ id: `${id}:actions`, heading: null, rows: [forget] }]
    }
  }
}
