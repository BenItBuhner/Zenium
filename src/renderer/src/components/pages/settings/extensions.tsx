import type { ReactNode } from 'react'
import { CircleAlert, Puzzle, TriangleAlert } from 'lucide-react'
import type { ExtensionErrorEntry, ExtensionInfo, UIState } from '@shared/types'
import {
  distinctHosts,
  parseMatchPattern,
  type MatchPattern
} from '@core/extensions/permissionMessages'
import { run } from '@renderer/lib/api'
import { errorDetail, errorSummary, newestFirst } from '@renderer/lib/extensions/errorText'
import { sourceLabel, storePageUrl } from '@renderer/lib/extensions/storeInput'
import { warningGlyph } from '@renderer/lib/extensions/warningGlyph'
import { relativeTime } from '@renderer/lib/utils'
import { WARNING_GLYPHS } from '../../extensions/warningGlyphs'
import { UrlForm } from './blocks'
import type { DetailRow, InfoRow, ItemRow, RowGroup, SettingsRow } from './model'
import type { SectionContext } from './sections'

/**
 * Settings › Extensions on a phone (design language v2 §10.3–10.4): the installed extensions as
 * item rows, each opening the details sheet – the extension's switches and actions, its
 * permissions and site access and its error console as §10.4 detail rows one level deeper
 * (§9.24: the details sheet is depth one, its levels depth two, nothing opens over those) – then
 * the ways to install one and the update check. Every surface of the desktop management page
 * (`components/extensions/ExtensionsPage.tsx`, `ExtensionDetails.tsx`) is here in its phone
 * form, reading the same `ExtensionInfo` and running the same `extension.*` commands.
 */
export function extensionsGroups({ state }: SectionContext): RowGroup[] {
  const extensions = [...state.extensions].sort((a, b) =>
    (a.name || a.id).localeCompare(b.name || b.id)
  )
  return [
    {
      id: 'extensions',
      heading: 'Extensions',
      aside: extensions.length > 0 ? extensions.length.toLocaleString() : undefined,
      description:
        'Chrome extensions from the Chrome Web Store or a folder with a manifest.json. Extensions run in every container.',
      rows: extensions.map((ext) => extensionRow(ext, state)),
      empty: 'No extensions yet'
    },
    installGroup(),
    updatesGroup(state)
  ]
}

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

/**
 * One installed extension: its 20 px icon in the leading column, its name, and on the second
 * line the one thing the list is scanned for – the load error in the danger ink, "Off" while it
 * is disabled, else its own description (which the details sheet repeats in its title block).
 */
function extensionRow(ext: ExtensionInfo, state: UIState): ItemRow {
  const id = `extension:${ext.id}`
  const name = ext.name || ext.id
  return {
    kind: 'item',
    id,
    label: name,
    description: ext.error ?? (ext.enabled ? ext.description || undefined : 'Off'),
    tone: ext.error ? 'danger' : undefined,
    keywords: ['add-on', ext.id, ext.version],
    leading: extensionIcon(ext),
    sheet: {
      title: name,
      description: ext.error ?? (ext.description || undefined),
      groups: detailsGroups(ext, state)
    }
  }
}

function extensionIcon(ext: ExtensionInfo): ReactNode {
  return ext.icon ? (
    <img src={ext.icon} alt="" className="zen-settings-ext-icon" draggable={false} />
  ) : (
    <Puzzle className="zen-settings-glyph" aria-hidden="true" />
  )
}

// ---------------------------------------------------------------------------
// The details sheet (depth one)
// ---------------------------------------------------------------------------

/**
 * The details sheet's groups: the extension now (on or off, an update to take, its toolbar
 * button, its options page, its errors), what it may do, where it came from, and its removal.
 */
function detailsGroups(ext: ExtensionInfo, state: UIState): RowGroup[] {
  const id = `extension:${ext.id}`
  const broken = ext.error !== null
  const controls: SettingsRow[] = [
    {
      kind: 'switch',
      id: `${id}:enabled`,
      label: 'Enabled',
      checked: ext.enabled,
      onChange: (v) => run('extension.setEnabled', { id: ext.id, enabled: v })
    }
  ]
  if (ext.updateState === 'available' || ext.updateState === 'updating') {
    controls.push({
      kind: 'action',
      id: `${id}:update`,
      label: ext.availableVersion ? `Update to ${ext.availableVersion}` : 'Update',
      description: `Version ${ext.version} is installed.`,
      busy: ext.updateState === 'updating',
      onPress: () => run('extension.update', { id: ext.id })
    })
  }
  // The toolbar with the extensions' buttons is the desktop chrome's, like its downloads button
  // (`windows`, the Downloads builder's gate); the phone shell has no such bar.
  if (state.capabilities.windows) {
    controls.push({
      kind: 'switch',
      id: `${id}:pinned`,
      label: 'Pin to toolbar',
      description: 'Show its button in the toolbar instead of the extensions menu.',
      checked: ext.toolbarPinned,
      disabled: broken,
      onChange: (v) => run('extension.setToolbarPinned', { id: ext.id, pinned: v })
    })
  }
  if (ext.optionsPage) {
    controls.push({
      kind: 'action',
      id: `${id}:options`,
      label: 'Options',
      description: 'The extension’s own settings page.',
      leaves: 'chevron',
      disabled: !ext.enabled || broken,
      onPress: () => run('extension.openOptions', { id: ext.id })
    })
  }
  if (ext.source === 'unpacked') {
    controls.push({
      kind: 'action',
      id: `${id}:reload`,
      label: 'Reload',
      description: 'Load the files again after you change them.',
      disabled: !ext.enabled,
      onPress: () => run('extension.reload', { id: ext.id })
    })
  }
  controls.push(errorsRow(ext))

  const privateLabel = state.capabilities.privateTabs
    ? 'Allow in private tabs'
    : 'Allow in private windows'
  const access: SettingsRow[] = [
    permissionsRow(ext),
    {
      kind: 'switch',
      id: `${id}:file-access`,
      label: 'Allow access to file URLs',
      description: 'The extension can read pages opened from files on this device.',
      checked: ext.allowFileAccess,
      disabled: broken,
      onChange: (v) => run('extension.setAllowFileAccess', { id: ext.id, allow: v })
    },
    {
      kind: 'switch',
      id: `${id}:private`,
      label: privateLabel,
      description: 'Its request rules and scripts apply while browsing privately.',
      checked: ext.allowPrivate,
      disabled: broken,
      onChange: (v) => run('extension.setAllowPrivate', { id: ext.id, allowed: v })
    }
  ]
  if (ext.permissions.includes('userScripts')) {
    access.push({
      kind: 'switch',
      id: `${id}:user-scripts`,
      label: 'Allow user scripts',
      description: 'Scripts you add through the extension run in pages.',
      checked: ext.allowUserScripts,
      disabled: broken,
      onChange: (v) => run('extension.setAllowUserScripts', { id: ext.id, allowed: v })
    })
  }

  return [
    { id: `${id}-controls`, heading: null, rows: controls },
    // "Access", not "Permissions": the group's first row is the Permissions detail row, and a
    // heading that repeats the row under it says nothing (§9.26).
    { id: `${id}-access`, heading: 'Access', rows: access },
    { id: `${id}-source`, heading: 'Source', rows: sourceRows(ext) },
    {
      id: `${id}-remove`,
      heading: null,
      rows: [
        {
          kind: 'action',
          id: `${id}:remove`,
          label: 'Remove extension',
          destructive: true,
          confirm: {
            title: `Remove ${ext.name || ext.id}?`,
            description: 'Its settings and data on this device go with it.',
            action: 'Remove'
          },
          onPress: () => run('extension.remove', { id: ext.id })
        }
      ]
    }
  ]
}

// ---------------------------------------------------------------------------
// Permissions (depth two)
// ---------------------------------------------------------------------------

/**
 * The §10.4 detail row into the permissions sheet: Chrome's warning lines as info rows with
 * their glyphs, then the sites it may act on (`permission_message_util::GetDistinctHosts`, the
 * form Chrome's "Site access" takes); the summary counts both.
 */
function permissionsRow(ext: ExtensionInfo): DetailRow {
  const id = `extension:${ext.id}`
  const hosts = siteAccess(ext.hostPermissions)
  const total = ext.warnings.length + hosts.length
  const permissions: InfoRow[] = ext.warnings.map((warning, index) => {
    const Glyph = WARNING_GLYPHS[warningGlyph(warning)]
    return {
      kind: 'info',
      id: `${id}:permission:${index}`,
      label: warning,
      leading: <Glyph className="zen-settings-glyph" aria-hidden="true" />
    }
  })
  const sites: InfoRow[] = hosts.map((host) => ({
    kind: 'info',
    id: `${id}:host:${host}`,
    label: host === '*' ? 'All sites' : host
  }))
  return {
    kind: 'detail',
    id: `${id}:permissions`,
    label: 'Permissions',
    summary:
      total === 0
        ? 'None'
        : `${total.toLocaleString()} ${total === 1 ? 'permission' : 'permissions'}`,
    sheet: {
      title: 'Permissions',
      description: ext.name || ext.id,
      groups: [
        {
          id: `${id}-permissions-list`,
          heading: null,
          rows: permissions,
          empty: 'This extension requires no special permissions'
        },
        {
          id: `${id}-site-access`,
          heading: 'Site access',
          rows: sites,
          empty: 'No sites'
        }
      ]
    }
  }
}

/** The hosts a manifest's host permissions reach, one line each; `*` stands for every site. */
function siteAccess(hostPermissions: readonly string[]): string[] {
  const patterns: MatchPattern[] = []
  for (const text of hostPermissions) {
    const pattern = parseMatchPattern(text)
    if (!pattern) continue
    if (pattern.matchAllUrls) return ['*']
    patterns.push(pattern)
  }
  return distinctHosts(patterns)
}

// ---------------------------------------------------------------------------
// The error console (depth two)
// ---------------------------------------------------------------------------

/**
 * The §10.4 detail row into the error console: the lines newest first, each a 20 px status
 * glyph in the §1 ink, the message as the label (two lines, then an ellipsis) and where and
 * when it happened under it; "Clear errors" last, in the danger ink but without a confirmation –
 * the sheet is depth two already (§9.24), and a cleared log is not lost data.
 */
function errorsRow(ext: ExtensionInfo): DetailRow {
  const id = `extension:${ext.id}`
  const entries = newestFirst(ext.errors)
  const groups: RowGroup[] = [
    {
      id: `${id}-errors-list`,
      heading: null,
      rows: entries.map((entry) => errorRow(ext, entry)),
      empty: 'No errors'
    }
  ]
  if (entries.length > 0) {
    groups.push({
      id: `${id}-errors-clear`,
      heading: null,
      rows: [
        {
          kind: 'action',
          id: `${id}:clear-errors`,
          label: 'Clear errors',
          destructive: true,
          onPress: () => run('extension.clearErrors', { id: ext.id })
        }
      ]
    })
  }
  return {
    kind: 'detail',
    id: `${id}:errors`,
    label: 'Errors',
    summary: errorSummary(ext.errors),
    sheet: { title: 'Errors', description: ext.name || ext.id, groups }
  }
}

function errorRow(ext: ExtensionInfo, entry: ExtensionErrorEntry): InfoRow {
  return {
    kind: 'info',
    id: `extension:${ext.id}:error:${entry.id}`,
    label: entry.message,
    description: errorDetail(entry, ext.id, relativeTime),
    clamp: true,
    leading:
      entry.level === 'error' ? (
        <CircleAlert className="zen-settings-glyph zen-settings-danger" aria-hidden="true" />
      ) : (
        <TriangleAlert className="zen-settings-glyph zen-settings-warn" aria-hidden="true" />
      )
  }
}

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/** Where the extension came from and what it is: the desktop Source card's rows as info rows. */
function sourceRows(ext: ExtensionInfo): SettingsRow[] {
  const id = `extension:${ext.id}`
  const store = storePageUrl(ext.source, ext.id)
  const rows: SettingsRow[] = [
    store
      ? {
          kind: 'action',
          id: `${id}:source`,
          label: 'Source',
          description: sourceLabel(ext.source),
          leaves: 'external',
          onPress: () => run('tab.create', { url: store, active: true })
        }
      : { kind: 'info', id: `${id}:source`, label: 'Source', description: sourceLabel(ext.source) },
    { kind: 'info', id: `${id}:id`, label: 'ID', description: ext.id },
    { kind: 'info', id: `${id}:version`, label: 'Version', description: ext.version },
    {
      kind: 'info',
      id: `${id}:installed`,
      label: 'Installed',
      description: relativeTime(ext.installedAt)
    }
  ]
  if (ext.updatedAt > ext.installedAt) {
    rows.push({
      kind: 'info',
      id: `${id}:updated`,
      label: 'Updated',
      description: relativeTime(ext.updatedAt)
    })
  }
  if (ext.manifestVersion === 2) {
    rows.push({
      kind: 'info',
      id: `${id}:mv2`,
      label: 'Manifest V2',
      description: 'Manifest V2 extensions are being retired; check the store for a newer version.',
      tone: 'warn'
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// Install and updates
// ---------------------------------------------------------------------------

/**
 * The ways in, as the desktop's header offers them (the store field, its menu's two file
 * items): ungated, as the desktop is – both hosts pick a package or a folder through the
 * `extension.installFromFile` and `extension.add` commands.
 */
function installGroup(): RowGroup {
  return {
    id: 'install-extension',
    heading: 'Install an extension',
    rows: [
      {
        kind: 'action',
        id: 'install-from-store',
        label: 'From the Chrome Web Store',
        description: 'Paste an extension id, or a Chrome Web Store or Edge Add-ons link.',
        form: {
          title: 'Install from the Chrome Web Store',
          render: (close) => (
            <UrlForm
              id="store-ref"
              label="Extension id or store link"
              placeholder="https://chromewebstore.google.com/detail/…"
              action="Install"
              onSubmit={(ref) => run('extension.installFromStore', { ref })}
              close={close}
            />
          )
        }
      },
      {
        kind: 'action',
        id: 'install-from-file',
        label: 'From a file',
        description: 'A packed .crx or .zip.',
        onPress: () => run('extension.installFromFile', undefined)
      },
      {
        kind: 'action',
        id: 'load-unpacked',
        label: 'Load unpacked',
        description: 'A folder with a manifest.json.',
        onPress: () => run('extension.add', undefined)
      }
    ]
  }
}

/**
 * The update check (§9.30 while it runs): the desktop caption's words on the row, disabled with
 * nothing installed as the desktop's menu item is.
 */
function updatesGroup(state: UIState): RowGroup {
  const check = state.extensionUpdates
  const latest = state.extensions.reduce<number | null>((acc, e) => {
    const t = e.updateCheckedAt
    return t !== null && (acc === null || t > acc) ? t : acc
  }, check.lastCheckedAt)
  return {
    id: 'extension-updates',
    heading: 'Updates',
    rows: [
      {
        kind: 'action',
        id: 'extensions-check-updates',
        label: 'Check for updates',
        description: check.checking
          ? 'Checking for updates…'
          : latest !== null
            ? `Last checked ${relativeTime(latest).toLowerCase()}`
            : 'Not checked yet',
        busy: check.checking,
        disabled: state.extensions.length === 0,
        onPress: () => run('extension.checkForUpdates', undefined)
      }
    ]
  }
}
