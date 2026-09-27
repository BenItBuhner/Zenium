import { describe, expect, it } from 'vitest'
import { extensionEngineId } from '../../../core/extensions/searchProvider'
import type { ExtensionControl, SearchEngine, SearchEngineControl } from '../../../shared/types'
import { ExtensionControls } from '../extensionApi/controls'
import { SEARCH_CONTROL_KEY, SearchProviderApi } from '../extensionApi/searchProvider'
import type { ApiHost, LoadedExtension } from '../extensionApi/types'

const NORTON = 'mpnlkmlkncncpgnnkmkgoobfpnjmblnk'
const BING = 'ddojnmkongaimkdddgmcccldlfhokcfb'
const PLAIN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

interface Applied {
  engines: SearchEngine[]
  control: SearchEngineControl | null
}

interface World {
  api: SearchProviderApi
  applied: Applied[]
  controls: Array<Record<string, ExtensionControl>>
}

function world(): World {
  const applied: Applied[] = []
  const controls: Array<Record<string, ExtensionControl>> = []
  const host = {
    controls: new ExtensionControls({
      setExtensionControls: (map) => {
        controls.push(map)
      }
    }),
    browser: {
      extensions: {
        list: () => [
          { id: NORTON, name: 'Norton Safe Search', installedAt: 1000 },
          { id: BING, name: 'Bing Homepage & Search', installedAt: 2000 },
          { id: PLAIN, name: 'Plain', installedAt: 3000 }
        ]
      },
      state: {
        setExtensionSearch: (engines: SearchEngine[], control: SearchEngineControl | null) => {
          applied.push({ engines, control })
        }
      }
    }
  } as unknown as ApiHost
  return { api: new SearchProviderApi(host), applied, controls }
}

function loaded(id: string, overrides: unknown): LoadedExtension {
  return {
    id,
    extension: { name: 'engine name' },
    manifest: {
      manifest_version: 3,
      name: 'x',
      version: '1',
      ...(overrides ? { chrome_settings_overrides: overrides } : {})
    }
  } as unknown as LoadedExtension
}

const nortonOverrides = {
  search_provider: {
    encoding: 'UTF-8',
    favicon_url: 'https://searchsafe.norton.com/img/logoicon.ico',
    is_default: true,
    keyword: 'nortonsafe',
    name: 'Norton Safe',
    search_url: 'https://searchsafe.norton.com/search?omnisearch=yes&q={searchTerms}'
  }
}

const bingOverrides = {
  search_provider: {
    favicon_url: 'https://www.bing.com/favicon.ico',
    is_default: true,
    prepopulated_id: 3,
    search_url: 'https://www.bing.com/search?form=BGGCMF&q={searchTerms}'
  }
}

/** An engine added without asking for the default. */
const quietOverrides = {
  search_provider: {
    encoding: 'UTF-8',
    favicon_url: 'https://quiet.example/favicon.ico',
    is_default: false,
    keyword: 'quiet',
    name: 'Quiet',
    search_url: 'https://quiet.example/?q={searchTerms}'
  }
}

describe('SearchProviderApi and the Settings page', () => {
  it("publishes the extension holding the default engine as the default-engine row's control, with its engine as the value", () => {
    const w = world()
    w.api.load(loaded(NORTON, nortonOverrides))
    expect(w.applied.at(-1)?.control).toEqual({
      engineId: extensionEngineId(NORTON),
      extensionId: NORTON,
      extensionName: 'Norton Safe Search'
    })
    expect(w.controls.at(-1)).toEqual({
      [SEARCH_CONTROL_KEY]: {
        extensionId: NORTON,
        name: 'Norton Safe Search',
        value: extensionEngineId(NORTON)
      }
    })
    // The more recently installed extension asking for the default takes it, row and all.
    w.api.load(loaded(BING, bingOverrides))
    expect(w.controls.at(-1)).toEqual({
      'search.defaultEngine': {
        extensionId: BING,
        name: 'Bing Homepage & Search',
        value: extensionEngineId(BING)
      }
    })
    // Disabled: the older holder's default surfaces; both gone: the row is the user's again.
    w.api.unload(BING)
    expect(w.controls.at(-1)).toEqual({
      'search.defaultEngine': {
        extensionId: NORTON,
        name: 'Norton Safe Search',
        value: extensionEngineId(NORTON)
      }
    })
    w.api.unload(NORTON)
    expect(w.applied.at(-1)).toEqual({ engines: [], control: null })
    expect(w.controls.at(-1)).toEqual({})
  })

  it('publishes nothing for an engine added without the default, nor for an extension without the key', () => {
    const w = world()
    w.api.load(loaded(PLAIN, quietOverrides))
    expect(w.applied.at(-1)?.engines.map((e) => e.name)).toEqual(['Quiet'])
    expect(w.applied.at(-1)?.control).toBeNull()
    expect(w.controls).toEqual([])
    w.api.load(loaded(NORTON, undefined))
    expect(w.controls).toEqual([])
  })
})
