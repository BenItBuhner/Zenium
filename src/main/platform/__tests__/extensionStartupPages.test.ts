import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '../../../shared/defaults'
import type { ExtensionControl, ExtensionInfo, Settings } from '../../../shared/types'
import { ExtensionControls } from '../extensionApi/controls'
import { StartupPagesApi } from '../extensionApi/startupPages'
import type { ApiHost, LoadedExtension } from '../extensionApi/types'

const OLDER = 'a'.repeat(32)
const NEWER = 'b'.repeat(32)
const PLAIN = 'c'.repeat(32)

interface World {
  api: StartupPagesApi
  /** Every `UIState.extensionControls` map the state was handed, in order. */
  published: Array<Record<string, ExtensionControl>>
  controls: ExtensionControls
  settings: Settings
  /** The Extensions page's records, as `browser.extensions.list()` hands them out. */
  infos: ExtensionInfo[]
}

function world(): World {
  const published: Array<Record<string, ExtensionControl>> = []
  const controls = new ExtensionControls({
    setExtensionControls: (map) => {
      published.push(map)
    }
  })
  const settings: Settings = structuredClone(DEFAULT_SETTINGS)
  const infos: ExtensionInfo[] = [
    { id: OLDER, name: 'Older Pages', installedAt: 1_000 },
    { id: NEWER, name: 'Newer Pages', installedAt: 2_000 },
    { id: PLAIN, name: 'Plain', installedAt: 3_000 }
  ] as ExtensionInfo[]
  const host = {
    browser: { state: { settings }, extensions: { list: () => infos } },
    controls
  } as unknown as ApiHost
  return { api: new StartupPagesApi(host), published, controls, settings, infos }
}

function loaded(id: string, startupPages?: unknown, name = 'Manifest Name'): LoadedExtension {
  return {
    id,
    extension: { name },
    manifest:
      startupPages === undefined
        ? {}
        : { chrome_settings_overrides: { startup_pages: startupPages } }
  } as unknown as LoadedExtension
}

describe('StartupPagesApi – chrome_settings_overrides.startup_pages holds On startup', () => {
  it('a loaded extension with pages publishes the mode and its list under its name', () => {
    const w = world()
    w.api.load(loaded(OLDER, ['https://older.example/', 'older.example/two', 'zenium://x']))
    expect(w.controls.current).toEqual({
      'startup.mode': { extensionId: OLDER, name: 'Older Pages', value: 'pages' },
      'startup.pages': {
        extensionId: OLDER,
        name: 'Older Pages',
        value: ['https://older.example/', 'https://older.example/two']
      }
    })
    expect(w.published).toHaveLength(1)
  })

  it('an extension without startup pages, or with none valid, holds nothing', () => {
    const w = world()
    w.api.load(loaded(PLAIN))
    w.api.load(loaded(PLAIN, ['zenium://settings', 'not a url']))
    w.api.load(loaded(PLAIN, []))
    expect(w.published).toEqual([])
    expect(w.controls.current).toEqual({})
    // Unloading what never held anything publishes nothing either.
    w.api.unload(PLAIN)
    expect(w.published).toEqual([])
  })

  it('the newest-installed of several wins; unloading it hands the setting to the next', () => {
    const w = world()
    w.api.load(loaded(NEWER, ['https://newer.example/']))
    w.api.load(loaded(OLDER, ['https://older.example/']))
    expect(w.controls.current['startup.pages']).toEqual({
      extensionId: NEWER,
      name: 'Newer Pages',
      value: ['https://newer.example/']
    })
    // The older one loading under the newer changed nothing on the page: no new snapshot.
    expect(w.published).toHaveLength(1)
    w.api.unload(NEWER)
    expect(w.controls.current['startup.pages']).toEqual({
      extensionId: OLDER,
      name: 'Older Pages',
      value: ['https://older.example/']
    })
    expect(w.controls.current['startup.mode']?.name).toBe('Older Pages')
  })

  it('with every holder unloaded the rows are the user\u2019s again – the setting itself untouched', () => {
    const w = world()
    w.settings.startup = { mode: 'newTab', pages: ['https://mine.example/'] }
    w.api.load(loaded(OLDER, ['https://older.example/']))
    expect(Object.keys(w.controls.current).sort()).toEqual(['startup.mode', 'startup.pages'])
    w.api.unload(OLDER)
    expect(w.controls.current).toEqual({})
    expect(w.published.at(-1)).toEqual({})
    expect(w.settings.startup).toEqual({ mode: 'newTab', pages: ['https://mine.example/'] })
  })

  it('a reload with a changed list republishes; the same list again does not', () => {
    const w = world()
    w.api.load(loaded(OLDER, ['https://older.example/']))
    w.api.load(loaded(OLDER, ['https://older.example/']))
    expect(w.published).toHaveLength(1)
    w.api.load(loaded(OLDER, ['https://older.example/', 'https://older.example/two']))
    expect(w.published).toHaveLength(2)
    expect(w.controls.current['startup.pages']?.value).toEqual([
      'https://older.example/',
      'https://older.example/two'
    ])
    // An update that drops the pages lets go of the setting.
    w.api.load(loaded(OLDER))
    expect(w.controls.current).toEqual({})
  })

  it('names the extension from the engine\u2019s record when the Extensions page has none yet', () => {
    const w = world()
    w.infos.length = 0
    w.api.load(loaded(OLDER, ['https://older.example/'], 'From Manifest'))
    expect(w.controls.current['startup.mode']?.name).toBe('From Manifest')
  })

  it('shares the map with the other APIs\u2019 keys', () => {
    const w = world()
    const fonts = { 'fonts.standard': { extensionId: PLAIN, name: 'Plain' } }
    w.controls.publish('fontSettings', fonts)
    w.api.load(loaded(OLDER, ['https://older.example/']))
    expect(Object.keys(w.controls.current).sort()).toEqual([
      'fonts.standard',
      'startup.mode',
      'startup.pages'
    ])
    w.api.unload(OLDER)
    expect(w.controls.current).toEqual(fonts)
  })
})
