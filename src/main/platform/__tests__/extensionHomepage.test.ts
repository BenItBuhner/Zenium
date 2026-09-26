import { describe, expect, it } from 'vitest'
import type { ExtensionControl, ExtensionInfo } from '../../../shared/types'
import { ExtensionControls } from '../extensionApi/controls'
import { HomepageApi } from '../extensionApi/homepage'
import type { ApiHost, LoadedExtension } from '../extensionApi/types'

/*
 * `chrome_settings_overrides.homepage` on the desktop (`HomepageApi`, the `StartupPagesApi`
 * sibling): the loaded extension's page published as the `homepage` control, the newest
 * installed of several holding it, a tie answered as the registry orders them, and the control
 * gone with the last holder's unload.
 */

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const NONE = 'cccccccccccccccccccccccccccccccc'

interface World {
  api: HomepageApi
  /** Every `UIState.extensionControls` map the state was handed, in order. */
  published: Array<Record<string, ExtensionControl>>
  /** The registry's records, in its order. */
  records: Array<Pick<ExtensionInfo, 'id' | 'name' | 'installedAt'>>
}

function world(records: World['records']): World {
  const published: World['published'] = []
  const controls = new ExtensionControls({
    setExtensionControls: (map) => {
      published.push(map)
    }
  })
  const host = {
    controls,
    browser: { extensions: { list: () => records } }
  } as unknown as ApiHost
  return { api: new HomepageApi(host), published, records }
}

function loaded(id: string, name: string, homepage?: unknown): LoadedExtension {
  const manifest =
    homepage === undefined ? { name } : { name, chrome_settings_overrides: { homepage } }
  return { id, extension: { id, name }, manifest } as unknown as LoadedExtension
}

describe('HomepageApi', () => {
  it('publishes the loaded extension’s page under `homepage`, named as the registry names it; nothing for a manifest without one', () => {
    const w = world([
      { id: OLD, name: 'Bing Homepage & Search', installedAt: 1_000 },
      { id: NONE, name: 'Plain', installedAt: 3_000 }
    ])
    w.api.load(loaded(NONE, 'Plain (manifest)'))
    expect(w.published).toEqual([])
    w.api.load(loaded(OLD, 'Bing (manifest)', 'https://www.bing.com/?PC=__PARAM__'))
    expect(w.published).toEqual([
      {
        homepage: {
          extensionId: OLD,
          name: 'Bing Homepage & Search',
          value: 'https://www.bing.com/?PC='
        }
      }
    ])
    expect(w.api.current()?.extensionId).toBe(OLD)
    // A page that is not http(s) is no homepage: loading it holds nothing.
    w.api.load(loaded(NONE, 'Plain', 'chrome://newtab'))
    expect(w.published).toHaveLength(1)
    // An unload of an extension that held nothing publishes nothing.
    w.api.unload(NONE)
    expect(w.published).toHaveLength(1)
  })

  it('gives the setting to the newest-installed of several, whatever order they loaded in, and back to the other on its unload', () => {
    const w = world([
      { id: NEW, name: 'Newer', installedAt: 2_000 },
      { id: OLD, name: 'Older', installedAt: 1_000 }
    ])
    w.api.load(loaded(NEW, 'Newer', 'https://newer.example/'))
    w.api.load(loaded(OLD, 'Older', 'https://older.example/'))
    expect(w.published.at(-1)).toEqual({
      homepage: { extensionId: NEW, name: 'Newer', value: 'https://newer.example/' }
    })
    // The older one loading changed nothing the state heard.
    expect(w.published).toHaveLength(1)
    w.api.unload(NEW)
    expect(w.published.at(-1)).toEqual({
      homepage: { extensionId: OLD, name: 'Older', value: 'https://older.example/' }
    })
    w.api.unload(OLD)
    expect(w.published.at(-1)).toEqual({})
    expect(w.api.current()).toBeNull()
  })

  it('answers a tie in install time as the registry orders the records, whichever loaded first', () => {
    const w = world([
      { id: OLD, name: 'First record', installedAt: 1_000 },
      { id: NEW, name: 'Second record', installedAt: 1_000 }
    ])
    w.api.load(loaded(NEW, 'Second record', 'https://second.example/'))
    w.api.load(loaded(OLD, 'First record', 'https://first.example/'))
    expect(w.published.at(-1)?.homepage?.extensionId).toBe(OLD)
  })

  it('falls back to the manifest’s name and the moment for an extension the registry does not list', () => {
    const w = world([])
    w.api.load(loaded(NEW, 'Unpacked', 'https://unpacked.example/'))
    expect(w.published.at(-1)).toEqual({
      homepage: { extensionId: NEW, name: 'Unpacked', value: 'https://unpacked.example/' }
    })
  })
})
