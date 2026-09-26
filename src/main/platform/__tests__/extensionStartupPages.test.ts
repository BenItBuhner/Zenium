import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../shared/defaults'
import type { ExtensionControl, Settings } from '../../../shared/types'
import {
  newRecord,
  startupOverrideOf,
  type ExtensionRecord
} from '../../../core/extensions/registry'
import { effectiveStartup } from '../../../core/startup'
import { ExtensionControls } from '../extensionApi/controls'
import { StartupPagesApi } from '../extensionApi/startupPages'
import type { ApiHost } from '../extensionApi/types'

const OLDER = 'a'.repeat(32)
const NEWER = 'b'.repeat(32)
const PLAIN = 'c'.repeat(32)

/**
 * The registry as the Electron host keeps it (`ExtensionManager.registry.extensions`): what the
 * boot reads before any extension loads (`startupPagesOverride` → `startupOverrideOf`) and what
 * the API reads through the same method once they have.
 */
interface World {
  api: StartupPagesApi
  /** Every `UIState.extensionControls` map the state was handed, in order. */
  published: Array<Record<string, ExtensionControl>>
  controls: ExtensionControls
  settings: Settings
  records: ExtensionRecord[]
  /** What the boot opens, read as `Browser.startupPlan` reads it: the registry's answer. */
  boot: () => { extensionId: string | null; pages: string[] }
}

function holder(id: string, installedAt: number, pages: string[] | null): ExtensionRecord {
  return newRecord({
    id,
    source: 'chrome-web-store',
    path: `/root/${id}/1.0`,
    manifest: {
      manifest_version: 3,
      name: `Ext ${id[0]}`,
      version: '1.0',
      ...(pages ? { chrome_settings_overrides: { startup_pages: pages } } : {})
    },
    now: installedAt
  })
}

function world(records: ExtensionRecord[], withOverride = true): World {
  const published: Array<Record<string, ExtensionControl>> = []
  const controls = new ExtensionControls({
    setExtensionControls: (map) => {
      published.push(map)
    }
  })
  const settings: Settings = structuredClone(DEFAULT_SETTINGS)
  const host = {
    browser: {
      state: { settings },
      extensions: withOverride ? { startupPagesOverride: () => startupOverrideOf(records) } : {}
    },
    controls
  } as unknown as ApiHost
  const boot = (): { extensionId: string | null; pages: string[] } => {
    const plan = effectiveStartup(settings, startupOverrideOf(records))
    return { extensionId: plan.control?.extensionId ?? null, pages: plan.pages }
  }
  return { api: new StartupPagesApi(host), published, controls, settings, records, boot }
}

/** What the Settings page shows as holding the setting, from the published map. */
function shown(w: World): { extensionId: string | null; pages: string[] } {
  const control = w.controls.current['startup.pages']
  return {
    extensionId: control?.extensionId ?? null,
    pages: Array.isArray(control?.value) ? control.value : []
  }
}

/** The extensions come up in `order` (`ExtensionApi.onLoaded` refreshes per load). */
function loadInOrder(w: World, order: readonly string[]): void {
  for (const id of order) {
    expect(w.records.some((r) => r.id === id)).toBe(true)
    w.api.refresh()
  }
}

/** `ExtensionManager.setEnabled`: the record flips, the unload/load follows, the event is emitted. */
function setEnabled(w: World, id: string, enabled: boolean): void {
  w.records.find((r) => r.id === id)!.enabled = enabled
  w.api.refresh()
  w.api.refresh()
}

describe('StartupPagesApi – chrome_settings_overrides.startup_pages holds On startup', () => {
  it('an enabled extension with pages publishes the mode and its list under its name', () => {
    const w = world([holder(OLDER, 1_000, ['https://older.example/', 'https://older.example/two'])])
    w.api.refresh()
    expect(w.controls.current).toEqual({
      'startup.mode': { extensionId: OLDER, name: 'Ext a', value: 'pages' },
      'startup.pages': {
        extensionId: OLDER,
        name: 'Ext a',
        value: ['https://older.example/', 'https://older.example/two']
      }
    })
    expect(w.published).toHaveLength(1)
  })

  it('an extension without startup pages holds nothing, and neither does a host without the override (the phone)', () => {
    const w = world([holder(PLAIN, 3_000, null)])
    w.api.refresh()
    w.api.refresh()
    expect(w.published).toEqual([])
    expect(w.controls.current).toEqual({})
    const phone = world([holder(OLDER, 1_000, ['https://older.example/'])], false)
    phone.api.refresh()
    expect(phone.published).toEqual([])
  })

  it('the boot and the Settings indicator name the same extension: the newest-installed of two enabled startup_pages extensions under every load order; disabling the newest hands both to the other, enabling it again hands both back', () => {
    const orders: ReadonlyArray<readonly string[]> = [
      [OLDER, NEWER, PLAIN],
      [NEWER, OLDER, PLAIN],
      [PLAIN, NEWER, OLDER],
      [OLDER, PLAIN, NEWER]
    ]
    for (const order of orders) {
      const w = world([
        holder(OLDER, 1_000, ['https://older.example/']),
        holder(NEWER, 2_000, ['https://newer.example/']),
        holder(PLAIN, 3_000, null)
      ])
      loadInOrder(w, order)
      expect(w.boot().extensionId).toBe(NEWER)
      expect(shown(w)).toEqual(w.boot())
      expect(shown(w).pages).toEqual(['https://newer.example/'])
      // The indicator changed once: the older one coming up under the newer added nothing.
      expect(w.published).toHaveLength(1)

      setEnabled(w, NEWER, false)
      expect(w.boot().extensionId).toBe(OLDER)
      expect(shown(w)).toEqual(w.boot())
      expect(w.controls.current['startup.mode']?.name).toBe('Ext a')

      setEnabled(w, NEWER, true)
      expect(w.boot().extensionId).toBe(NEWER)
      expect(shown(w)).toEqual(w.boot())

      setEnabled(w, OLDER, false)
      setEnabled(w, NEWER, false)
      expect(w.boot().extensionId).toBeNull()
      expect(shown(w)).toEqual(w.boot())
      expect(w.controls.current).toEqual({})
    }
  })

  it('an installedAt tie (records a migration stamped at one time) goes to the first record for both halves, whatever order the extensions loaded or reloaded in', () => {
    const w = world([
      holder(OLDER, 1_000, ['https://first.example/']),
      holder(NEWER, 1_000, ['https://second.example/'])
    ])
    loadInOrder(w, [NEWER, OLDER])
    expect(w.boot().extensionId).toBe(OLDER)
    expect(shown(w)).toEqual(w.boot())
    // A disable-and-enable of the first record reloads it after the second: a set kept in load
    // order would have named the second one here while the boot kept following the first.
    setEnabled(w, OLDER, false)
    expect(shown(w).extensionId).toBe(NEWER)
    setEnabled(w, OLDER, true)
    expect(w.boot().extensionId).toBe(OLDER)
    expect(shown(w)).toEqual(w.boot())
  })

  it('with every holder disabled the rows are the user\u2019s again – the setting itself untouched', () => {
    const w = world([holder(OLDER, 1_000, ['https://older.example/'])])
    w.settings.startup = { mode: 'newTab', pages: ['https://mine.example/'] }
    w.api.refresh()
    expect(Object.keys(w.controls.current).sort()).toEqual(['startup.mode', 'startup.pages'])
    setEnabled(w, OLDER, false)
    expect(w.controls.current).toEqual({})
    expect(w.published.at(-1)).toEqual({})
    expect(w.settings.startup).toEqual({ mode: 'newTab', pages: ['https://mine.example/'] })
  })

  it('an update that changes the record\u2019s list republishes; the same list again does not; one that drops the pages lets go of the setting', () => {
    const w = world([holder(OLDER, 1_000, ['https://older.example/'])])
    const record = w.records[0]!
    w.api.refresh()
    w.api.refresh()
    expect(w.published).toHaveLength(1)
    // `withManifest` rewrote the record at the update; the `updated` registry event refreshes.
    record.startupPages = ['https://older.example/', 'https://older.example/two']
    w.api.refresh()
    expect(w.published).toHaveLength(2)
    expect(w.controls.current['startup.pages']?.value).toEqual([
      'https://older.example/',
      'https://older.example/two'
    ])
    record.startupPages = null
    w.api.refresh()
    expect(w.controls.current).toEqual({})
  })

  it('shares the map with the other APIs\u2019 keys', () => {
    const w = world([holder(OLDER, 1_000, ['https://older.example/'])])
    const fonts = { 'fonts.standard': { extensionId: PLAIN, name: 'Plain' } }
    w.controls.publish('fontSettings', fonts)
    w.api.refresh()
    expect(Object.keys(w.controls.current).sort()).toEqual([
      'fonts.standard',
      'startup.mode',
      'startup.pages'
    ])
    setEnabled(w, OLDER, false)
    expect(w.controls.current).toEqual(fonts)
  })
})
