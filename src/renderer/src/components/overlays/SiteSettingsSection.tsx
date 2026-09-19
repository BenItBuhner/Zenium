import type { JSX } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { PermissionRule, UIState } from '@shared/types'
import {
  contentSettingsFor,
  type ContentDefault,
  type ContentGroup,
  type ContentSetting
} from '@shared/contentSettings'
import { cmd, run } from '@renderer/lib/api'
import {
  bySite,
  defaultDescription,
  defaultOptions,
  describeRule,
  hostOf,
  type SiteRules
} from '@renderer/lib/siteSettings'
import { usePhone } from '@renderer/lib/surfaces'
import { V2Button } from '../v2/controls'
import { Card, EmptyRow, Group, Pane, Rows } from '../siteControls/pane'
import { ChoiceRow, ConfirmSheet, ListRow } from '../siteControls/primitives'

const GROUPS: Array<{ id: ContentGroup; heading: string; description: string }> = [
  {
    id: 'permissions',
    heading: 'Permissions',
    description:
      'What sites may ask to use. A site that asked keeps your answer until you reset it.'
  },
  {
    id: 'content',
    heading: 'Content',
    description: 'What sites may show and run without asking.'
  },
  {
    id: 'additional',
    heading: 'Additional permissions',
    description: 'Less common capabilities, off or asked about unless a site needs them.'
  }
]

/**
 * Settings > Site Settings (design-language-v2-draft §9.13, §9.26, §9.27, §10.4): every content
 * type of the catalogue (`shared/contentSettings`) as a row with its default in a menulist – on
 * a phone a value row that opens the picker sheet – grouped as Chrome groups them, and the sites
 * that have answers of their own, each with a Reset that forgets them (`permissions.resetOrigin`),
 * and Reset all. Defaults come from `permissions.defaults` and go back through
 * `permissions.setDefault`; the per-site list is the core's `permissionRules`.
 */
export function SiteSettingsSection({ state }: { state: UIState }): JSX.Element {
  const platform = state.platform === 'android' ? 'android' : 'desktop'
  const rows = useMemo(() => contentSettingsFor(platform), [platform])
  const { defaults, choose } = useDefaults(state.permissionRules)
  const sites = useMemo(() => bySite(state.permissionRules), [state.permissionRules])
  const phone = usePhone()
  return (
    <Pane
      title="Site Settings"
      description="What sites may use and do. Sites ask first unless you decide for all of them here; a site you answered keeps that answer."
      data-testid="site-settings"
    >
      {GROUPS.map((group) => {
        const own = rows.filter((r) => r.group === group.id)
        if (own.length === 0) return null
        return (
          <Group key={group.id} heading={group.heading} description={group.description}>
            <Rows>
              {own.map((setting) => (
                <ContentRow
                  key={setting.id}
                  setting={setting}
                  value={defaults[setting.id] ?? setting.builtInDefault}
                  onChange={(value) => choose(setting.id, value)}
                />
              ))}
            </Rows>
          </Group>
        )
      })}

      {phone ? <PhoneSites sites={sites} /> : <DesktopSites sites={sites} />}
    </Pane>
  )
}

const SITES_HEADING = 'Sites with their own settings'
const SITES_DESCRIPTION =
  "Answers you gave to a site's questions, and decisions made for a site in its information panel."

/**
 * The site list on desktop (§10.5): a card, since the group has actions of its own – Reset all
 * on the heading's line and a hugging Reset trailing each site.
 */
function DesktopSites({ sites }: { sites: SiteRules[] }): JSX.Element {
  return (
    <Group
      heading={SITES_HEADING}
      description={SITES_DESCRIPTION}
      trailing={
        sites.length > 0 ? (
          <V2Button
            onClick={() => run('permissions.reset', undefined)}
            aria-label="Reset the settings of every site"
          >
            Reset all
          </V2Button>
        ) : undefined
      }
      data-testid="site-settings-sites"
    >
      <Card className="px-0 py-1">
        {sites.length === 0 ? (
          <EmptyRow className="px-[var(--v2-card-padding)]">
            No site has settings of its own yet
          </EmptyRow>
        ) : (
          sites.map((site) => (
            <ListRow
              key={site.origin}
              label={hostOf(site.origin)}
              description={site.rules.map(describeRule).join(' · ')}
              control
              className="px-[var(--v2-card-padding)]"
              trailing={
                <V2Button
                  className="min-w-[88px]"
                  onClick={() => run('permissions.resetOrigin', { origin: site.origin })}
                  aria-label={`Reset the settings of ${hostOf(site.origin)}`}
                >
                  Reset
                </V2Button>
              }
            />
          ))
        )}
      </Card>
    </Group>
  )
}

/**
 * The site list on a phone (§10.3, §10.4): rows under the heading, no card and no inline
 * buttons – a site's row is the action and asks in a sheet before it forgets the site's
 * answers, and a destructive row in danger ink at the end resets every site the same way.
 */
function PhoneSites({ sites }: { sites: SiteRules[] }): JSX.Element {
  const [confirm, setConfirm] = useState<{ origin: string } | 'all' | null>(null)
  return (
    <Group
      heading={SITES_HEADING}
      description={SITES_DESCRIPTION}
      data-testid="site-settings-sites"
    >
      <Rows>
        {sites.length === 0 ? (
          <EmptyRow>No site has settings of its own yet</EmptyRow>
        ) : (
          sites.map((site) => (
            <ListRow
              key={site.origin}
              label={hostOf(site.origin)}
              description={site.rules.map(describeRule).join(' · ')}
              onClick={() => setConfirm({ origin: site.origin })}
              aria-label={`Reset the settings of ${hostOf(site.origin)}`}
            />
          ))
        )}
        {sites.length > 0 && (
          <ListRow label="Reset all sites" danger onClick={() => setConfirm('all')} />
        )}
      </Rows>
      {confirm !== null && (
        <ConfirmSheet
          name="site-settings-reset"
          title={
            confirm === 'all'
              ? 'Reset the settings of every site?'
              : `Reset the settings of ${hostOf(confirm.origin)}?`
          }
          description={
            confirm === 'all'
              ? 'Every site goes back to asking, or to the defaults above.'
              : sites
                  .find((s) => s.origin === confirm.origin)
                  ?.rules.map(describeRule)
                  .join(' · ')
          }
          action="Reset"
          onConfirm={() =>
            confirm === 'all'
              ? run('permissions.reset', undefined)
              : run('permissions.resetOrigin', { origin: confirm.origin })
          }
          onDismissed={() => setConfirm(null)}
          data-testid="site-settings-reset"
        />
      )}
    </Group>
  )
}

/** The user's defaults per catalogue row; read on mount and again after every decision. */
function useDefaults(rules: PermissionRule[]): {
  defaults: Record<string, ContentDefault>
  choose: (permission: string, decision: ContentDefault) => void
} {
  const [defaults, setDefaults] = useState<Record<string, ContentDefault>>({})
  const read = useCallback((): void => {
    void cmd('permissions.defaults', undefined).then(setDefaults, () => undefined)
  }, [])
  // Rules are the same store as defaults: a change to either is a reason to read again.
  useEffect(read, [read, rules])
  const choose = useCallback(
    (permission: string, decision: ContentDefault): void => {
      setDefaults((d) => ({ ...d, [permission]: decision }))
      void cmd('permissions.setDefault', { permission, decision }).then(read, read)
    },
    [read]
  )
  return { defaults, choose }
}

function ContentRow({
  setting,
  value,
  onChange
}: {
  setting: ContentSetting
  value: ContentDefault
  onChange: (value: ContentDefault) => void
}): JSX.Element {
  return (
    <div data-content-setting={setting.id}>
      <ChoiceRow<ContentDefault>
        label={setting.label}
        description={defaultDescription(setting, value)}
        value={value}
        options={defaultOptions(setting)}
        onChange={onChange}
        sheetName={`site-setting-${setting.id}`}
      />
    </div>
  )
}
