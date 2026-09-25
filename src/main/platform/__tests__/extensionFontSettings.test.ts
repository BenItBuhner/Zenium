import { describe, expect, it } from 'vitest'
import {
  FONT_SETTINGS_PERMISSION_ERROR,
  type FontValues
} from '../../../core/extensions/api/fontSettings'
import {
  DEFAULT_FONT_SETTINGS,
  type ExtensionFontLayer,
  type PageFontSettings
} from '../../../shared/fonts'
import type { ExtensionControl } from '../../../shared/types'
import { ExtensionControls } from '../extensionApi/controls'
import { FontSettingsApi } from '../extensionApi/fontSettings'
import type { ApiContext, ApiHost } from '../extensionApi/types'

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const NO_PERMISSION = 'cccccccccccccccccccccccccccccccc'

interface Dispatched {
  extensionId: string
  event: string
  details: unknown
}

interface World {
  api: FontSettingsApi
  dispatched: Dispatched[]
  loaded: Set<string>
  persisted: Map<string, FontValues>
  /** What the pages were handed, in order. */
  applied: PageFontSettings[]
  /** What the pages' font hook was handed beside the setting, in order (null: nothing held). */
  layers: Array<ExtensionFontLayer | null>
  /** Every `UIState.extensionControls` map the state was handed, in order. */
  controls: Array<Record<string, ExtensionControl>>
  user: PageFontSettings
  /** The state's broadcast (the page fonts service applies the user's setting on it, as at runtime). */
  broadcast(): Promise<void>
  ctx(extensionId: string): ApiContext
}

function world(options: { fonts?: string[]; attach?: boolean; platform?: string } = {}): World {
  const dispatched: Dispatched[] = []
  const persisted = new Map<string, FontValues>()
  const applied: PageFontSettings[] = []
  const layers: Array<ExtensionFontLayer | null> = []
  const controls: Array<Record<string, ExtensionControl>> = []
  const listeners: Array<() => void> = []
  let userApplied = ''
  const state: World = {
    api: undefined as unknown as FontSettingsApi,
    dispatched,
    loaded: new Set([OLD, NEW, NO_PERMISSION]),
    persisted,
    applied,
    layers,
    controls,
    user: { ...DEFAULT_FONT_SETTINGS },
    broadcast: async () => {
      // The page fonts service's own listener: the user's setting goes out when it moved.
      const key = JSON.stringify(state.user)
      if (key !== userApplied) {
        userApplied = key
        applied.push({ ...state.user })
      }
      for (const listener of listeners) listener()
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    },
    ctx: (extensionId) => ({ extensionId }) as unknown as ApiContext
  }
  const host = {
    grants: (extensionId: string) => ({
      permissions: extensionId === NO_PERMISSION ? ['storage'] : ['fontSettings'],
      origins: []
    }),
    loaded: (extensionId: string) =>
      state.loaded.has(extensionId) ? { id: extensionId } : undefined,
    allLoaded: () => [...state.loaded].map((id) => ({ id })),
    dispatch: (extensionId: string, namespace: string, event: string, args: unknown[]) => {
      dispatched.push({ extensionId, event: `${namespace}.${event}`, details: args[0] })
    },
    store: {
      fontSettingsValues: (extensionId: string) => persisted.get(extensionId) ?? {},
      setFontSettingsValues: (extensionId: string, values: FontValues) => {
        if (Object.keys(values).length === 0) persisted.delete(extensionId)
        else persisted.set(extensionId, values)
      }
    },
    controls: new ExtensionControls({
      setExtensionControls: (map) => {
        controls.push(map)
      }
    }),
    browser: {
      extensions: {
        list: () => [
          { id: OLD, name: 'Older Fonts', installedAt: 1000 },
          { id: NEW, name: 'Advanced Font Settings', installedAt: 2000 },
          { id: NO_PERMISSION, name: 'No Permission', installedAt: 3000 }
        ]
      },
      pageFonts: {
        get fonts(): PageFontSettings {
          return state.user
        }
      },
      platform: {
        pageFonts: { apply: (fonts: PageFontSettings) => applied.push({ ...fonts }) }
      },
      state: {
        subscribe: (listener: () => void) => {
          listeners.push(listener)
          return () => undefined
        }
      }
    }
  } as unknown as ApiHost
  state.api = new FontSettingsApi(host, {
    platform: options.platform ?? 'linux',
    listFonts: async () => options.fonts ?? ['Tinos', 'Arimo', 'Cousine']
  })
  if (options.attach !== false) state.api.attach()
  state.api.attachPages({
    locale: 'en-US',
    applyExtensionFonts: (layer) => {
      layers.push(layer)
    }
  })
  for (const id of state.loaded) state.api.load(id)
  return state
}

const call = (w: World, extensionId: string, method: string, details?: unknown): unknown =>
  w.api.handlers[method](w.ctx(extensionId), details)

describe('FontSettingsApi handlers', () => {
  it('needs the fontSettings permission and Chrome\u2019s details', () => {
    const w = world()
    expect(() => call(w, NO_PERMISSION, 'getFont', { genericFamily: 'standard' })).toThrow(
      FONT_SETTINGS_PERMISSION_ERROR
    )
    expect(() => call(w, OLD, 'getFont', {})).toThrow("Missing required property 'genericFamily'.")
    expect(() => call(w, OLD, 'setFont', { genericFamily: 'serif' })).toThrow(
      "Missing required property 'fontId'."
    )
    expect(() => call(w, OLD, 'setDefaultFontSize', { pixelSize: 'big' })).toThrow(
      "Invalid value for 'pixelSize': expected an integer."
    )
    expect(() => call(w, OLD, 'getDefaultFontSize', 'details')).toThrow('Invalid details.')
  })

  it('lists the installed families once, sorted, and remembers the list', async () => {
    const w = world({ fonts: ['Tinos', 'Arimo', 'Tinos', 'Cousine'] })
    await expect(call(w, OLD, 'getFontList')).resolves.toEqual([
      { fontId: 'Arimo', displayName: 'Arimo' },
      { fontId: 'Cousine', displayName: 'Cousine' },
      { fontId: 'Tinos', displayName: 'Tinos' }
    ])
    await expect(call(w, NEW, 'getFontList')).resolves.toHaveLength(3)
    await expect(call(w, NO_PERMISSION, 'getFontList')).rejects.toThrow(
      FONT_SETTINGS_PERMISSION_ERROR
    )
  })

  it('answers getFont with the user\u2019s setting until an extension sets one, then lays that over', () => {
    const w = world()
    w.user.serif = 'Georgia'
    expect(call(w, OLD, 'getFont', { genericFamily: 'standard' })).toEqual({
      fontId: 'Times New Roman',
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(call(w, OLD, 'getFont', { genericFamily: 'serif', script: 'Zyyy' })).toEqual({
      fontId: 'Georgia',
      levelOfControl: 'controllable_by_this_extension'
    })
    call(w, OLD, 'setFont', { genericFamily: 'standard', fontId: 'Arimo' })
    expect(call(w, OLD, 'getFont', { genericFamily: 'standard' })).toEqual({
      fontId: 'Arimo',
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(call(w, NEW, 'getFont', { genericFamily: 'standard' })).toEqual({
      fontId: 'Arimo',
      levelOfControl: 'controlled_by_other_extensions'
    })
    // The pages got the layered setting: the user's serif kept, the standard face over it.
    expect(w.applied.at(-1)).toEqual({
      ...DEFAULT_FONT_SETTINGS,
      serif: 'Georgia',
      standard: 'Arimo'
    })
    expect(w.user.standard).toBeNull()
    // Cleared: the user's setting goes back to the pages, once.
    const before = w.applied.length
    call(w, OLD, 'clearFont', { genericFamily: 'standard' })
    expect(w.applied.at(-1)).toEqual({ ...DEFAULT_FONT_SETTINGS, serif: 'Georgia' })
    expect(w.applied.length).toBe(before + 1)
    call(w, OLD, 'clearFont', { genericFamily: 'standard' })
    expect(w.applied.length).toBe(before + 1)
  })

  it('takes per-script and slotless families beside the setting: answered, persisted, and handed to the pages\u2019 hook', () => {
    const w = world()
    call(w, OLD, 'setFont', {
      genericFamily: 'standard',
      script: 'Arab',
      fontId: 'Noto Naskh Arabic'
    })
    call(w, OLD, 'setFont', { genericFamily: 'cursive', fontId: 'Comic Neue' })
    expect(call(w, OLD, 'getFont', { genericFamily: 'standard', script: 'Arab' })).toEqual({
      fontId: 'Noto Naskh Arabic',
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(call(w, NEW, 'getFont', { genericFamily: 'cursive' })).toEqual({
      fontId: 'Comic Neue',
      levelOfControl: 'controlled_by_other_extensions'
    })
    // Nothing of the setting's shape is held: the pages keep the user's setting untouched…
    expect(w.applied).toEqual([])
    // …and the hook has the layer beside it, once per change.
    expect(w.layers).toEqual([
      { families: {}, scripts: { Arab: { standard: 'Noto Naskh Arabic' } }, sizes: {} },
      {
        families: { cursive: 'Comic Neue' },
        scripts: { Arab: { standard: 'Noto Naskh Arabic' } },
        sizes: {}
      }
    ])
    expect(w.persisted.get(OLD)).toEqual({
      extras: { cursive: 'Comic Neue' },
      scripts: { Arab: { standard: 'Noto Naskh Arabic' } }
    })
    // The same value again moves nothing.
    call(w, OLD, 'setFont', { genericFamily: 'cursive', fontId: 'Comic Neue' })
    expect(w.layers).toHaveLength(2)
    // Cleared: the hook is told once, null when nothing is left (the Arabic slot goes with it;
    // Linux has no family of its own for it, so the hook erases it by itself).
    call(w, OLD, 'clearFont', { genericFamily: 'standard', script: 'Arab' })
    expect(w.layers.at(-1)).toEqual({ families: { cursive: 'Comic Neue' }, scripts: {}, sizes: {} })
    call(w, OLD, 'setFont', { genericFamily: 'cursive', fontId: '' })
    expect(w.layers.at(-1)).toBeNull()
    expect(w.layers).toHaveLength(4)
    expect(w.persisted.size).toBe(0)
    expect(call(w, OLD, 'getFont', { genericFamily: 'cursive' })).toEqual({
      fontId: 'Comic Sans MS',
      levelOfControl: 'controllable_by_this_extension'
    })
  })

  it('names the engine\u2019s own face again for a script slot let go where the engine has one (macOS, Windows)', () => {
    const w = world({ platform: 'darwin', fonts: ['Hiragino Kaku Gothic ProN', 'Osaka'] })
    call(w, OLD, 'setFont', { genericFamily: 'standard', script: 'Jpan', fontId: 'Noto Sans JP' })
    expect(w.layers.at(-1)).toEqual({
      families: {},
      scripts: { Jpan: { standard: 'Noto Sans JP' } },
      sizes: {}
    })
    call(w, OLD, 'clearFont', { genericFamily: 'standard', script: 'Jpan' })
    expect(w.layers.at(-1)).toEqual({
      families: {},
      scripts: { Jpan: { standard: 'Hiragino Kaku Gothic ProN' } },
      sizes: {}
    })
    expect(call(w, OLD, 'getFont', { genericFamily: 'standard', script: 'Jpan' })).toEqual({
      fontId: 'Hiragino Kaku Gothic ProN',
      levelOfControl: 'controllable_by_this_extension'
    })
  })

  it('sets the sizes; the fixed-width size is a preference of its own, the size\u2019s companion until set', () => {
    const w = world()
    expect(call(w, OLD, 'getDefaultFontSize')).toEqual({
      pixelSize: 16,
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(call(w, OLD, 'getDefaultFixedFontSize')).toEqual({
      pixelSize: 13,
      levelOfControl: 'controllable_by_this_extension'
    })
    call(w, OLD, 'setDefaultFontSize', { pixelSize: 24 })
    call(w, OLD, 'setMinimumFontSize', { pixelSize: 12 })
    expect(call(w, OLD, 'getDefaultFixedFontSize', {})).toEqual({
      pixelSize: 20,
      levelOfControl: 'controllable_by_this_extension'
    })
    call(w, OLD, 'setDefaultFixedFontSize', { pixelSize: 30 })
    expect(call(w, OLD, 'getDefaultFontSize', {})).toEqual({
      pixelSize: 24,
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(call(w, NEW, 'getMinimumFontSize', {})).toEqual({
      pixelSize: 12,
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(call(w, NEW, 'getDefaultFixedFontSize', {})).toEqual({
      pixelSize: 30,
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(w.applied.at(-1)).toEqual({ ...DEFAULT_FONT_SETTINGS, size: 24, minimumSize: 12 })
    expect(w.layers.at(-1)).toEqual({ families: {}, scripts: {}, sizes: { fixed: 30 } })
    expect(w.persisted.get(OLD)).toEqual({ size: 24, minimumSize: 12, fixedSize: 30 })
    call(w, OLD, 'clearDefaultFixedFontSize')
    expect(w.layers.at(-1)).toBeNull()
    call(w, OLD, 'clearDefaultFontSize')
    call(w, OLD, 'clearMinimumFontSize', {})
    expect(w.applied.at(-1)).toEqual(DEFAULT_FONT_SETTINGS)
    expect(w.api.fonts).toEqual(DEFAULT_FONT_SETTINGS)
  })

  it('lets the most recently installed extension win, per preference, and re-ranks on unload and load', () => {
    const w = world()
    call(w, OLD, 'setFont', { genericFamily: 'standard', fontId: 'Tinos' })
    call(w, OLD, 'setDefaultFontSize', { pixelSize: 20 })
    call(w, NEW, 'setFont', { genericFamily: 'standard', fontId: 'Arimo' })
    expect(w.api.fonts).toMatchObject({ standard: 'Arimo', size: 20 })
    expect(call(w, OLD, 'getFont', { genericFamily: 'standard' })).toEqual({
      fontId: 'Arimo',
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(call(w, NEW, 'getDefaultFontSize')).toEqual({
      pixelSize: 20,
      levelOfControl: 'controlled_by_other_extensions'
    })
    // NEW is disabled: OLD's face applies again; NEW's own value waits for its return.
    w.loaded.delete(NEW)
    w.api.unload(NEW)
    expect(w.api.fonts).toMatchObject({ standard: 'Tinos', size: 20 })
    w.loaded.add(NEW)
    w.api.load(NEW)
    expect(w.api.fonts).toMatchObject({ standard: 'Arimo', size: 20 })
  })

  it('persists the values and reads them back on load; an uninstall takes them out', () => {
    const w = world()
    call(w, OLD, 'setFont', { genericFamily: 'fixed', fontId: 'Cousine' })
    call(w, OLD, 'setMinimumFontSize', { pixelSize: 3 })
    expect(w.persisted.get(OLD)).toEqual({ families: { fixed: 'Cousine' }, minimumSize: 6 })
    // A fresh host over the same store: the values apply from the first load.
    const again = world({ attach: false })
    again.persisted.set(OLD, w.persisted.get(OLD)!)
    again.api.load(OLD)
    expect(again.api.fonts).toMatchObject({ fixed: 'Cousine', minimumSize: 6 })
    expect(again.applied.at(-1)).toMatchObject({ fixed: 'Cousine', minimumSize: 6 })
    again.api.forget(OLD)
    expect(again.persisted.has(OLD)).toBe(false)
    expect(again.api.fonts).toEqual(DEFAULT_FONT_SETTINGS)
    expect(again.applied.at(-1)).toEqual(DEFAULT_FONT_SETTINGS)
  })

  it('leaves the pages to the user\u2019s setting while no extension holds a value', async () => {
    const w = world()
    expect(w.applied).toEqual([])
    w.user.size = 18
    await w.broadcast()
    // The page fonts service applied the user's setting; the layer had nothing to add.
    expect(w.applied).toEqual([{ ...DEFAULT_FONT_SETTINGS, size: 18 }])
  })

  it('re-layers a user change made under an extension\u2019s value', async () => {
    const w = world()
    call(w, NEW, 'setFont', { genericFamily: 'standard', fontId: 'Arimo' })
    w.user.serif = 'Georgia'
    w.user.size = 20
    await w.broadcast()
    // The user's setting went out first (the service's listener), the layer went back over it.
    expect(w.applied.slice(-2)).toEqual([
      { ...DEFAULT_FONT_SETTINGS, serif: 'Georgia', size: 20 },
      { ...DEFAULT_FONT_SETTINGS, serif: 'Georgia', size: 20, standard: 'Arimo' }
    ])
    expect(call(w, OLD, 'getDefaultFontSize')).toEqual({
      pixelSize: 20,
      levelOfControl: 'controllable_by_this_extension'
    })
  })
})

describe('FontSettingsApi events', () => {
  it('tells every permitted extension about a face that moved, with its own level of control', () => {
    const w = world()
    call(w, NEW, 'setFont', { genericFamily: 'sansserif', fontId: 'Arimo' })
    expect(w.dispatched).toEqual([
      {
        extensionId: OLD,
        event: 'fontSettings.onFontChanged',
        details: {
          fontId: 'Arimo',
          script: 'Zyyy',
          genericFamily: 'sansserif',
          levelOfControl: 'controlled_by_other_extensions'
        }
      },
      {
        extensionId: NEW,
        event: 'fontSettings.onFontChanged',
        details: {
          fontId: 'Arimo',
          script: 'Zyyy',
          genericFamily: 'sansserif',
          levelOfControl: 'controlled_by_this_extension'
        }
      }
    ])
    w.dispatched.length = 0
    // The same value again changes nothing.
    call(w, NEW, 'setFont', { genericFamily: 'sansserif', fontId: 'Arimo' })
    expect(w.dispatched).toEqual([])
  })

  it('reports a script\u2019s family and a slotless one the same way, the script named, the empty name once let go where the engine has none', () => {
    const w = world()
    call(w, NEW, 'setFont', { genericFamily: 'serif', script: 'Cyrl', fontId: 'PT Serif' })
    call(w, OLD, 'setFont', { genericFamily: 'fantasy', fontId: 'Papyrus' })
    expect(w.dispatched.map((d) => [d.extensionId, d.details])).toEqual([
      [
        OLD,
        {
          fontId: 'PT Serif',
          script: 'Cyrl',
          genericFamily: 'serif',
          levelOfControl: 'controlled_by_other_extensions'
        }
      ],
      [
        NEW,
        {
          fontId: 'PT Serif',
          script: 'Cyrl',
          genericFamily: 'serif',
          levelOfControl: 'controlled_by_this_extension'
        }
      ],
      [
        OLD,
        {
          fontId: 'Papyrus',
          script: 'Zyyy',
          genericFamily: 'fantasy',
          levelOfControl: 'controlled_by_this_extension'
        }
      ],
      [
        NEW,
        {
          fontId: 'Papyrus',
          script: 'Zyyy',
          genericFamily: 'fantasy',
          levelOfControl: 'controlled_by_other_extensions'
        }
      ]
    ])
    w.dispatched.length = 0
    call(w, NEW, 'clearFont', { genericFamily: 'serif', script: 'Cyrl' })
    expect(w.dispatched.map((d) => d.details)).toEqual([
      {
        fontId: '',
        script: 'Cyrl',
        genericFamily: 'serif',
        levelOfControl: 'controllable_by_this_extension'
      },
      {
        fontId: '',
        script: 'Cyrl',
        genericFamily: 'serif',
        levelOfControl: 'controllable_by_this_extension'
      }
    ])
  })

  it('reports the sizes, the fixed-width size among them while it follows the size, and as its own once set', () => {
    const w = world()
    call(w, OLD, 'setDefaultFontSize', { pixelSize: 17 })
    expect(w.dispatched.map((d) => [d.extensionId, d.event, d.details])).toEqual([
      [
        OLD,
        'fontSettings.onDefaultFontSizeChanged',
        { pixelSize: 17, levelOfControl: 'controlled_by_this_extension' }
      ],
      [
        NEW,
        'fontSettings.onDefaultFontSizeChanged',
        { pixelSize: 17, levelOfControl: 'controlled_by_other_extensions' }
      ],
      [
        OLD,
        'fontSettings.onDefaultFixedFontSizeChanged',
        { pixelSize: 14, levelOfControl: 'controllable_by_this_extension' }
      ],
      [
        NEW,
        'fontSettings.onDefaultFixedFontSizeChanged',
        { pixelSize: 14, levelOfControl: 'controllable_by_this_extension' }
      ]
    ])
    w.dispatched.length = 0
    // Held by an extension, the fixed-width size no longer follows the size.
    call(w, NEW, 'setDefaultFixedFontSize', { pixelSize: 15 })
    expect(w.dispatched.map((d) => [d.extensionId, d.event, d.details])).toEqual([
      [
        OLD,
        'fontSettings.onDefaultFixedFontSizeChanged',
        { pixelSize: 15, levelOfControl: 'controlled_by_other_extensions' }
      ],
      [
        NEW,
        'fontSettings.onDefaultFixedFontSizeChanged',
        { pixelSize: 15, levelOfControl: 'controlled_by_this_extension' }
      ]
    ])
    w.dispatched.length = 0
    call(w, OLD, 'setDefaultFontSize', { pixelSize: 20 })
    expect(w.dispatched.map((d) => d.event)).toEqual([
      'fontSettings.onDefaultFontSizeChanged',
      'fontSettings.onDefaultFontSizeChanged'
    ])
    w.dispatched.length = 0
    call(w, OLD, 'setMinimumFontSize', { pixelSize: 10 })
    expect(w.dispatched.map((d) => d.event)).toEqual([
      'fontSettings.onMinimumFontSizeChanged',
      'fontSettings.onMinimumFontSizeChanged'
    ])
    expect(w.dispatched[1].details).toEqual({
      pixelSize: 10,
      levelOfControl: 'controlled_by_other_extensions'
    })
  })

  it('reports the user\u2019s own change too, as Chrome\u2019s preference observer does', async () => {
    const w = world()
    w.user.fixed = 'Cousine'
    await w.broadcast()
    expect(w.dispatched.map((d) => [d.extensionId, d.event])).toEqual([
      [OLD, 'fontSettings.onFontChanged'],
      [NEW, 'fontSettings.onFontChanged']
    ])
    expect(w.dispatched[0].details).toEqual({
      fontId: 'Cousine',
      script: 'Zyyy',
      genericFamily: 'fixed',
      levelOfControl: 'controllable_by_this_extension'
    })
  })
})

describe('the Settings rows an extension holds (UIState.extensionControls)', () => {
  it('publishes the controlling extension of each Customize fonts row, named as the Extensions page names it, and nothing for a preference no row sets', () => {
    const w = world()
    // Nothing set: the map is empty and no snapshot was committed for it.
    expect(w.controls).toEqual([])
    call(w, OLD, 'setFont', { genericFamily: 'standard', fontId: 'Georgia' })
    call(w, OLD, 'setDefaultFontSize', { pixelSize: 20 })
    expect(w.controls.at(-1)).toEqual({
      'fonts.standard': { extensionId: OLD, name: 'Older Fonts' },
      'fonts.size': { extensionId: OLD, name: 'Older Fonts' }
    })
    // The fixed-width size, the cursive slot and a per-script family set no row of the page.
    const before = w.controls.length
    call(w, OLD, 'setDefaultFixedFontSize', { pixelSize: 14 })
    call(w, OLD, 'setFont', { genericFamily: 'cursive', fontId: 'Zapfino' })
    call(w, OLD, 'setFont', { genericFamily: 'sansserif', script: 'Jpan', fontId: 'Noto Sans JP' })
    expect(w.controls.length).toBe(before)
    // The minimum size and the other three slots each name their row.
    call(w, OLD, 'setMinimumFontSize', { pixelSize: 12 })
    call(w, OLD, 'setFont', { genericFamily: 'serif', fontId: 'Lora' })
    call(w, OLD, 'setFont', { genericFamily: 'sansserif', fontId: 'Inter' })
    call(w, OLD, 'setFont', { genericFamily: 'fixed', fontId: 'Fira Code' })
    expect(Object.keys(w.controls.at(-1)!).sort()).toEqual([
      'fonts.fixed',
      'fonts.minimumSize',
      'fonts.sansSerif',
      'fonts.serif',
      'fonts.size',
      'fonts.standard'
    ])
  })

  it("names the extension whose value is in effect – the newest install – and follows a clear, a disable and the user's own change as Chrome's indicator does", async () => {
    const w = world()
    call(w, OLD, 'setFont', { genericFamily: 'standard', fontId: 'Georgia' })
    call(w, NEW, 'setFont', { genericFamily: 'standard', fontId: 'Inter' })
    expect(w.controls.at(-1)).toEqual({
      'fonts.standard': { extensionId: NEW, name: 'Advanced Font Settings' }
    })
    // The newer extension lets go: the older one's value is in effect, and its name shows.
    call(w, NEW, 'clearFont', { genericFamily: 'standard' })
    expect(w.controls.at(-1)).toEqual({
      'fonts.standard': { extensionId: OLD, name: 'Older Fonts' }
    })
    // The user's own change of the setting moves no control: the extension still holds it.
    const before = w.controls.length
    w.user.standard = 'Verdana'
    await w.broadcast()
    expect(w.controls.length).toBe(before)
    // Disabled: the row is the user's again.
    w.loaded.delete(OLD)
    w.api.unload(OLD)
    expect(w.controls.at(-1)).toEqual({})
    // Loaded again: the persisted value holds the row again.
    w.loaded.add(OLD)
    w.api.load(OLD)
    expect(w.controls.at(-1)).toEqual({
      'fonts.standard': { extensionId: OLD, name: 'Older Fonts' }
    })
  })
})
