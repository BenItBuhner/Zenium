import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FIXED_FONT_SIZE_PREF,
  DEFAULT_FONT_SIZE_PREF,
  INVALID_FONT_ID_ERROR,
  MINIMUM_FONT_SIZE_PREF,
  fontPrefKey
} from '../../../core/extensions/api/fontSettings'
import {
  DEFAULT_FONT_SETTINGS,
  type ExtensionFontLayer,
  type PageFontSettings
} from '../../../shared/fonts'
import type { ExtensionControl } from '../../../shared/types'
import { ExtensionControls } from '../extensionApi/controls'
import {
  FONT_SETTINGS_PERMISSION_ERROR,
  FontSettingsApi,
  type FontSettingsPages
} from '../extensionApi/fontSettings'
import { ApiError, type ApiContext, type ApiHost } from '../extensionApi/types'

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
  persisted: Map<string, Record<string, string | number>>
  userFonts: PageFontSettings
  userListeners: Set<(fonts: PageFontSettings) => void>
  layers: Array<ExtensionFontLayer | null>
  families: string[] | null
  familiesAsked: number
  /** What reached the state (`setExtensionControls`), every call in order. */
  controls: Array<Record<string, ExtensionControl>>
  ctx(extensionId: string): ApiContext
  /** The user changed the setting (the Settings page's write reached the views). */
  userChanged(fonts: Partial<PageFontSettings>): void
  lastLayer(): ExtensionFontLayer | null
}

function world(
  options: { platform?: string; locale?: string; attach?: boolean; families?: string[] | null } = {}
): World {
  const dispatched: Dispatched[] = []
  const persisted = new Map<string, Record<string, string | number>>()
  const state: World = {
    api: undefined as unknown as FontSettingsApi,
    dispatched,
    loaded: new Set([OLD, NEW, NO_PERMISSION]),
    persisted,
    userFonts: { ...DEFAULT_FONT_SETTINGS },
    userListeners: new Set(),
    layers: [],
    families: options.families === undefined ? ['Inter', 'Arial'] : options.families,
    familiesAsked: 0,
    controls: [],
    ctx: (extensionId) => ({ extensionId }) as unknown as ApiContext,
    userChanged: (fonts) => {
      state.userFonts = { ...state.userFonts, ...fonts }
      for (const listener of state.userListeners) listener(state.userFonts)
    },
    lastLayer: () => state.layers[state.layers.length - 1] ?? null
  }
  const host = {
    grants: (extensionId: string) => ({
      permissions: extensionId === NO_PERMISSION ? ['storage'] : ['fontSettings'],
      origins: []
    }),
    loaded: (extensionId: string) =>
      state.loaded.has(extensionId) ? { id: extensionId } : undefined,
    allLoaded: () => [...state.loaded].map((id) => ({ id })),
    partitionsOf: () => ['default'],
    dispatch: (extensionId: string, namespace: string, event: string, args: unknown[]) => {
      dispatched.push({ extensionId, event: `${namespace}.${event}`, details: args[0] })
    },
    store: {
      fontSettingsValues: (extensionId: string) => persisted.get(extensionId) ?? {},
      setFontSettingsValues: (extensionId: string, values: Record<string, string | number>) => {
        if (Object.keys(values).length === 0) persisted.delete(extensionId)
        else persisted.set(extensionId, { ...values })
      }
    },
    controls: new ExtensionControls({
      setExtensionControls: (controls) => {
        state.controls.push(controls)
      }
    }),
    browser: {
      extensions: {
        list: () => [
          { id: OLD, installedAt: 1000, name: 'Older Fonts' },
          { id: NEW, installedAt: 2000, name: 'Advanced Font Settings' },
          { id: NO_PERMISSION, installedAt: 3000, name: 'No Permission' }
        ]
      },
      allWindows: () => []
    }
  } as unknown as ApiHost
  const pages: FontSettingsPages = {
    platform: options.platform ?? 'linux',
    locale: options.locale ?? 'en-US',
    userFonts: () => state.userFonts,
    onUserFontsChanged: (listener) => {
      state.userListeners.add(listener)
      return () => void state.userListeners.delete(listener)
    },
    applyExtensionFonts: (layer) => {
      state.layers.push(layer)
    },
    installedFamilies: async () => {
      state.familiesAsked += 1
      return state.families
    }
  }
  state.api = new FontSettingsApi(host)
  if (options.attach !== false) state.api.attach(pages)
  for (const id of state.loaded) state.api.load(id)
  return state
}

function call(w: World, extensionId: string, method: string, ...args: unknown[]): unknown {
  return w.api.handlers[method](w.ctx(extensionId), ...args)
}

function events(w: World, event: string, extensionId?: string): unknown[] {
  return w.dispatched
    .filter(
      (d) => d.event === event && (extensionId === undefined || d.extensionId === extensionId)
    )
    .map((d) => d.details)
}

const STANDARD = { genericFamily: 'standard', script: 'Zyyy' }
const CURSIVE = { genericFamily: 'cursive' }
const JPAN_SANS = { genericFamily: 'sansserif', script: 'Jpan' }

describe('FontSettingsApi handlers', () => {
  it('needs the fontSettings permission and Chrome-shaped arguments', () => {
    const w = world()
    expect(() => call(w, NO_PERMISSION, 'getFont', STANDARD)).toThrow(
      new ApiError(FONT_SETTINGS_PERMISSION_ERROR)
    )
    expect(() => call(w, NO_PERMISSION, 'getDefaultFontSize')).toThrow(ApiError)
    expect(() => call(w, OLD, 'getFont', { genericFamily: 'comic' })).toThrow(
      /Invalid value for 'genericFamily'/
    )
    expect(() => call(w, OLD, 'setFont', { ...STANDARD, fontId: 'Bad;Family' })).toThrow(
      new ApiError(INVALID_FONT_ID_ERROR)
    )
    expect(() => call(w, OLD, 'setDefaultFontSize', { pixelSize: 16.5 })).toThrow(
      /Invalid value for 'pixelSize': expected integer/
    )
    expect(() => call(w, OLD, 'setMinimumFontSize', {})).toThrow(
      /Missing required property 'pixelSize'/
    )
    expect(w.dispatched).toEqual([])
  })

  it("answers the user's setting, else the engine's own family, when no extension controls a slot", () => {
    const w = world()
    // The default setting names no family: the engine's default for this OS.
    expect(call(w, OLD, 'getFont', STANDARD)).toEqual({
      fontId: 'Times New Roman',
      levelOfControl: 'controllable_by_this_extension'
    })
    // The slots the setting has no row for: Electron's cursive, Blink's fantasy and math.
    expect(call(w, OLD, 'getFont', CURSIVE)).toEqual({
      fontId: 'Comic Sans MS',
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(call(w, OLD, 'getFont', { genericFamily: 'math' })).toMatchObject({
      fontId: 'Latin Modern Math'
    })
    // The user's choice stands where the setting has the slot.
    w.userChanged({ standard: 'Inter', fixed: 'Fira Code' })
    expect(call(w, OLD, 'getFont', STANDARD)).toMatchObject({ fontId: 'Inter' })
    expect(call(w, OLD, 'getFont', { genericFamily: 'fixed' })).toMatchObject({
      fontId: 'Fira Code'
    })
    // Sizes: the user's size, the minimum, and the fixed-width size that goes with the size.
    expect(call(w, OLD, 'getDefaultFontSize')).toEqual({
      pixelSize: 16,
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(call(w, OLD, 'getDefaultFixedFontSize')).toMatchObject({ pixelSize: 13 })
    expect(call(w, OLD, 'getMinimumFontSize')).toMatchObject({ pixelSize: 0 })
    w.userChanged({ size: 20, minimumSize: 10 })
    expect(call(w, OLD, 'getDefaultFontSize')).toMatchObject({ pixelSize: 20 })
    expect(call(w, OLD, 'getDefaultFixedFontSize')).toMatchObject({ pixelSize: 16 })
    expect(call(w, OLD, 'getMinimumFontSize')).toMatchObject({ pixelSize: 10 })
  })

  it("has Electron's per-script defaults on macOS and Windows, none on Linux, minus the locale's own", () => {
    expect(call(world(), OLD, 'getFont', JPAN_SANS)).toMatchObject({ fontId: '' })
    const mac = world({ platform: 'darwin' })
    expect(call(mac, OLD, 'getFont', JPAN_SANS)).toMatchObject({
      fontId: 'Hiragino Kaku Gothic ProN'
    })
    expect(call(mac, OLD, 'getFont', { genericFamily: 'fixed', script: 'Jpan' })).toMatchObject({
      // A list default resolves to its first family until the installed families are known.
      fontId: 'Osaka'
    })
    const japanese = world({ platform: 'darwin', locale: 'ja' })
    expect(call(japanese, OLD, 'getFont', JPAN_SANS)).toMatchObject({ fontId: '' })
    const win = world({ platform: 'win32', families: ['Meiryo', 'Arial'] })
    expect(call(win, OLD, 'getFont', { genericFamily: 'standard', script: 'Cyrl' })).toMatchObject({
      fontId: 'Times New Roman'
    })
  })

  it('resolves a list default against the installed families once getFontList has them, quietly', async () => {
    const w = world({ platform: 'win32', families: ['Meiryo', 'Arial'] })
    expect(call(w, OLD, 'getFont', JPAN_SANS)).toMatchObject({ fontId: 'Noto Sans JP' })
    await call(w, OLD, 'getFontList')
    expect(call(w, OLD, 'getFont', JPAN_SANS)).toMatchObject({ fontId: 'Meiryo' })
    expect(events(w, 'fontSettings.onFontChanged')).toEqual([])
  })

  it('lays a font over the setting with Chrome levels of control and tells every permitted extension', () => {
    const w = world()
    w.userChanged({ standard: 'Inter' })
    w.dispatched.length = 0
    call(w, OLD, 'setFont', { ...STANDARD, fontId: 'Georgia' })
    expect(call(w, OLD, 'getFont', STANDARD)).toEqual({
      fontId: 'Georgia',
      levelOfControl: 'controlled_by_this_extension'
    })
    // NEW was installed later: it may take the slot over.
    expect(call(w, NEW, 'getFont', STANDARD)).toEqual({
      fontId: 'Georgia',
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(events(w, 'fontSettings.onFontChanged', OLD)).toEqual([
      {
        fontId: 'Georgia',
        script: 'Zyyy',
        genericFamily: 'standard',
        levelOfControl: 'controlled_by_this_extension'
      }
    ])
    expect(events(w, 'fontSettings.onFontChanged', NEW)).toEqual([
      {
        fontId: 'Georgia',
        script: 'Zyyy',
        genericFamily: 'standard',
        levelOfControl: 'controllable_by_this_extension'
      }
    ])
    expect(events(w, 'fontSettings.onFontChanged', NO_PERMISSION)).toEqual([])
    // Setting the same value again changes nothing and says nothing.
    w.dispatched.length = 0
    call(w, OLD, 'setFont', { ...STANDARD, fontId: 'Georgia' })
    expect(w.dispatched).toEqual([])
    // The user's own setting is untouched; the page layer carries the extension's family.
    expect(w.userFonts.standard).toBe('Inter')
    expect(w.lastLayer()).toEqual({ families: { standard: 'Georgia' }, scripts: {}, sizes: {} })
  })

  it('ranks the most recently installed extension first and reports the other as controlled_by_other_extensions', () => {
    const w = world()
    call(w, OLD, 'setFont', { ...STANDARD, fontId: 'Georgia' })
    w.dispatched.length = 0
    call(w, NEW, 'setFont', { ...STANDARD, fontId: 'Verdana' })
    expect(call(w, NEW, 'getFont', STANDARD)).toEqual({
      fontId: 'Verdana',
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(call(w, OLD, 'getFont', STANDARD)).toEqual({
      fontId: 'Verdana',
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(events(w, 'fontSettings.onFontChanged', OLD)).toEqual([
      expect.objectContaining({
        fontId: 'Verdana',
        levelOfControl: 'controlled_by_other_extensions'
      })
    ])
    expect(w.lastLayer()?.families).toEqual({ standard: 'Verdana' })
    // OLD's set under NEW's changes nothing in effect: no event, the layer stays.
    w.dispatched.length = 0
    const layers = w.layers.length
    call(w, OLD, 'setFont', { ...STANDARD, fontId: 'Palatino' })
    expect(w.dispatched).toEqual([])
    expect(w.layers.length).toBe(layers)
    // NEW clears: OLD's latest value comes into effect.
    call(w, NEW, 'clearFont', STANDARD)
    expect(call(w, OLD, 'getFont', STANDARD)).toEqual({
      fontId: 'Palatino',
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(call(w, NEW, 'getFont', STANDARD)).toMatchObject({
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(w.lastLayer()?.families).toEqual({ standard: 'Palatino' })
    // OLD clears too: the user's setting (the engine's default here) and no layer at all.
    w.dispatched.length = 0
    call(w, OLD, 'clearFont', STANDARD)
    expect(call(w, OLD, 'getFont', STANDARD)).toEqual({
      fontId: 'Times New Roman',
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(events(w, 'fontSettings.onFontChanged', NEW)).toEqual([
      expect.objectContaining({
        fontId: 'Times New Roman',
        levelOfControl: 'controllable_by_this_extension'
      })
    ])
    expect(w.lastLayer()).toBeNull()
    expect(w.persisted.size).toBe(0)
  })

  it("keeps the extension's value in effect while the user changes the setting under it", () => {
    const w = world()
    call(w, OLD, 'setFont', { ...STANDARD, fontId: 'Georgia' })
    call(w, OLD, 'setDefaultFontSize', { pixelSize: 24 })
    w.dispatched.length = 0
    w.userChanged({ standard: 'Inter', serif: 'Lora', size: 12 })
    // The controlled prefs do not move; the uncontrolled serif slot did, and says so.
    expect(call(w, NEW, 'getFont', STANDARD)).toMatchObject({ fontId: 'Georgia' })
    expect(call(w, NEW, 'getDefaultFontSize')).toMatchObject({ pixelSize: 24 })
    expect(events(w, 'fontSettings.onFontChanged', NEW)).toEqual([
      {
        fontId: 'Lora',
        script: 'Zyyy',
        genericFamily: 'serif',
        levelOfControl: 'controllable_by_this_extension'
      }
    ])
    expect(events(w, 'fontSettings.onDefaultFontSizeChanged')).toEqual([])
    // The fixed-width size goes with the user's size (Chrome's own pref, which the extension's
    // default size leaves alone), so the user's change moved it: 13 → 10, announced.
    expect(events(w, 'fontSettings.onDefaultFixedFontSizeChanged', NEW)).toEqual([
      { pixelSize: 10, levelOfControl: 'controllable_by_this_extension' }
    ])
    expect(call(w, NEW, 'getDefaultFixedFontSize')).toMatchObject({ pixelSize: 10 })
    // Cleared, the user's new value is what comes back – and is announced.
    w.dispatched.length = 0
    call(w, OLD, 'clearFont', STANDARD)
    expect(events(w, 'fontSettings.onFontChanged', OLD)).toEqual([
      expect.objectContaining({ fontId: 'Inter', genericFamily: 'standard' })
    ])
  })

  it('sets, reports and clears the three sizes with their own events', () => {
    const w = world()
    call(w, NEW, 'setDefaultFontSize', { pixelSize: 20 })
    expect(call(w, NEW, 'getDefaultFontSize')).toEqual({
      pixelSize: 20,
      levelOfControl: 'controlled_by_this_extension'
    })
    // The fixed-width size is Chrome's own pref: the default size an extension sets leaves it.
    expect(call(w, OLD, 'getDefaultFixedFontSize')).toEqual({
      pixelSize: 13,
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(events(w, 'fontSettings.onDefaultFontSizeChanged', OLD)).toEqual([
      { pixelSize: 20, levelOfControl: 'controlled_by_other_extensions' }
    ])
    expect(events(w, 'fontSettings.onDefaultFixedFontSizeChanged')).toEqual([])
    call(w, OLD, 'setDefaultFixedFontSize', { pixelSize: 11 })
    expect(events(w, 'fontSettings.onDefaultFixedFontSizeChanged', OLD)).toEqual([
      { pixelSize: 11, levelOfControl: 'controlled_by_this_extension' }
    ])
    call(w, OLD, 'setMinimumFontSize', { pixelSize: 9 })
    expect(call(w, NEW, 'getDefaultFixedFontSize')).toEqual({
      pixelSize: 11,
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(events(w, 'fontSettings.onMinimumFontSizeChanged', NEW)).toEqual([
      { pixelSize: 9, levelOfControl: 'controllable_by_this_extension' }
    ])
    expect(w.lastLayer()).toEqual({
      families: {},
      scripts: {},
      sizes: { standard: 20, fixed: 11, minimum: 9 }
    })
    expect(w.persisted.get(OLD)).toEqual({
      [DEFAULT_FIXED_FONT_SIZE_PREF]: 11,
      [MINIMUM_FONT_SIZE_PREF]: 9
    })
    expect(w.persisted.get(NEW)).toEqual({ [DEFAULT_FONT_SIZE_PREF]: 20 })
    w.dispatched.length = 0
    call(w, OLD, 'clearDefaultFixedFontSize')
    call(w, OLD, 'clearMinimumFontSize')
    call(w, NEW, 'clearDefaultFontSize')
    expect(call(w, OLD, 'getDefaultFixedFontSize')).toMatchObject({ pixelSize: 13 })
    expect(call(w, OLD, 'getMinimumFontSize')).toMatchObject({ pixelSize: 0 })
    expect(events(w, 'fontSettings.onDefaultFontSizeChanged', NEW)).toEqual([
      { pixelSize: 16, levelOfControl: 'controllable_by_this_extension' }
    ])
    expect(w.lastLayer()).toBeNull()
  })

  it('names a per-script family to the pages and takes it back with the engine default when cleared', () => {
    const w = world()
    call(w, OLD, 'setFont', { ...JPAN_SANS, fontId: 'Noto Sans JP' })
    expect(call(w, NEW, 'getFont', JPAN_SANS)).toEqual({
      fontId: 'Noto Sans JP',
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(events(w, 'fontSettings.onFontChanged', NEW)).toEqual([
      expect.objectContaining({
        fontId: 'Noto Sans JP',
        script: 'Jpan',
        genericFamily: 'sansserif'
      })
    ])
    expect(w.lastLayer()).toEqual({
      families: {},
      scripts: { Jpan: { sansSerif: 'Noto Sans JP' } },
      sizes: {}
    })
    // Cleared: Linux has no per-script default, so the slot goes back to '' (fall back to the
    // common script's family) and stays named, so an open page is taken back too.
    call(w, OLD, 'clearFont', JPAN_SANS)
    expect(call(w, OLD, 'getFont', JPAN_SANS)).toMatchObject({ fontId: '' })
    expect(w.lastLayer()).toEqual({ families: {}, scripts: { Jpan: { sansSerif: '' } }, sizes: {} })
    // On macOS the engine's own per-script family comes back instead.
    const mac = world({ platform: 'darwin' })
    call(mac, OLD, 'setFont', { ...JPAN_SANS, fontId: 'Noto Sans JP' })
    call(mac, OLD, 'clearFont', JPAN_SANS)
    expect(mac.lastLayer()).toEqual({
      families: {},
      scripts: { Jpan: { sansSerif: 'Hiragino Kaku Gothic ProN' } },
      sizes: {}
    })
  })

  it("drops an extension's layer when it unloads, forgets its values when it is uninstalled", () => {
    const w = world()
    call(w, OLD, 'setFont', { ...STANDARD, fontId: 'Georgia' })
    call(w, OLD, 'setFont', { genericFamily: 'cursive', fontId: 'Zapfino' })
    call(w, OLD, 'setMinimumFontSize', { pixelSize: 12 })
    w.dispatched.length = 0
    w.loaded.delete(OLD)
    w.api.unload(OLD)
    expect(call(w, NEW, 'getFont', STANDARD)).toEqual({
      fontId: 'Times New Roman',
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(events(w, 'fontSettings.onFontChanged', NEW)).toEqual([
      expect.objectContaining({ fontId: 'Times New Roman', genericFamily: 'standard' }),
      expect.objectContaining({ fontId: 'Comic Sans MS', genericFamily: 'cursive' })
    ])
    expect(events(w, 'fontSettings.onMinimumFontSizeChanged', NEW)).toEqual([
      { pixelSize: 0, levelOfControl: 'controllable_by_this_extension' }
    ])
    expect(w.lastLayer()).toBeNull()
    // Disabled only: the values wait in the store and apply again once loaded.
    expect(w.persisted.get(OLD)).toEqual({
      [fontPrefKey('standard', 'Zyyy')]: 'Georgia',
      [fontPrefKey('cursive', 'Zyyy')]: 'Zapfino',
      [MINIMUM_FONT_SIZE_PREF]: 12
    })
    w.loaded.add(OLD)
    w.api.load(OLD)
    expect(call(w, NEW, 'getFont', STANDARD)).toMatchObject({ fontId: 'Georgia' })
    expect(w.lastLayer()).toEqual({
      families: { standard: 'Georgia', cursive: 'Zapfino' },
      scripts: {},
      sizes: { minimum: 12 }
    })
    // Uninstalled: gone from the store as well.
    w.loaded.delete(OLD)
    w.api.forget(OLD)
    expect(w.persisted.has(OLD)).toBe(false)
    expect(w.lastLayer()).toBeNull()
  })

  it('loads persisted values, dropping what is not a font pref', () => {
    const w = world({ attach: false })
    w.persisted.set(NEW, {
      [fontPrefKey('serif', 'Zyyy')]: 'Lora',
      [DEFAULT_FONT_SIZE_PREF]: 18,
      'webkit.webprefs.fonts.serif.Nope': 'Bad',
      [MINIMUM_FONT_SIZE_PREF]: 'twelve' as unknown as number
    })
    w.api.load(NEW)
    expect(call(w, OLD, 'getFont', { genericFamily: 'serif' })).toEqual({
      fontId: 'Lora',
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(call(w, OLD, 'getDefaultFontSize')).toMatchObject({ pixelSize: 18 })
    expect(call(w, OLD, 'getMinimumFontSize')).toMatchObject({
      pixelSize: 0,
      levelOfControl: 'controllable_by_this_extension'
    })
  })

  it('lists the installed families once per session as Chrome lists them', async () => {
    const w = world({ families: ['Noto Sans', 'Inter', ' Inter ', '.SF NS', 'Arial'] })
    const list = await call(w, OLD, 'getFontList')
    expect(list).toEqual([
      { fontId: 'Arial', displayName: 'Arial' },
      { fontId: 'Inter', displayName: 'Inter' },
      { fontId: 'Noto Sans', displayName: 'Noto Sans' }
    ])
    await call(w, NEW, 'getFontList')
    expect(w.familiesAsked).toBe(1)
    await expect(call(w, NO_PERMISSION, 'getFontList')).rejects.toThrow(
      FONT_SETTINGS_PERMISSION_ERROR
    )
  })

  it('answers an empty list, uncached, while no chrome document is up to ask', async () => {
    const w = world({ families: null })
    expect(await call(w, OLD, 'getFontList')).toEqual([])
    w.families = ['Inter']
    expect(await call(w, OLD, 'getFontList')).toEqual([{ fontId: 'Inter', displayName: 'Inter' }])
    expect(w.familiesAsked).toBe(2)
  })
})

describe('the Settings rows an extension holds (UIState.extensionControls)', () => {
  it('publishes the controlling extension of each Customise fonts row, named as the Extensions page names it, and nothing for a pref no row sets', () => {
    const w = world()
    // Nothing set: the map is empty and no snapshot was committed for it.
    expect(w.controls).toEqual([])
    call(w, OLD, 'setFont', { ...STANDARD, fontId: 'Georgia' })
    call(w, OLD, 'setDefaultFontSize', { pixelSize: 20 })
    expect(w.controls.at(-1)).toEqual({
      'fonts.standard': { extensionId: OLD, name: 'Older Fonts' },
      'fonts.size': { extensionId: OLD, name: 'Older Fonts' }
    })
    // The fixed-width size, the cursive slot and a per-script family set no row of the page.
    const before = w.controls.length
    call(w, OLD, 'setDefaultFixedFontSize', { pixelSize: 14 })
    call(w, OLD, 'setFont', { ...CURSIVE, fontId: 'Zapfino' })
    call(w, OLD, 'setFont', { ...JPAN_SANS, fontId: 'Noto Sans JP' })
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

  it("names the extension whose value is in effect – the newest install – and follows a clear, a disable and the user's own change as Chrome's indicator does", () => {
    const w = world()
    call(w, OLD, 'setFont', { ...STANDARD, fontId: 'Georgia' })
    call(w, NEW, 'setFont', { ...STANDARD, fontId: 'Inter' })
    expect(w.controls.at(-1)).toEqual({
      'fonts.standard': { extensionId: NEW, name: 'Advanced Font Settings' }
    })
    // The newer extension lets go: the older one's value is in effect, and its name shows.
    call(w, NEW, 'clearFont', STANDARD)
    expect(w.controls.at(-1)).toEqual({
      'fonts.standard': { extensionId: OLD, name: 'Older Fonts' }
    })
    // The user's own change of the setting moves no control: the extension still holds it.
    const before = w.controls.length
    w.userChanged({ standard: 'Verdana' })
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

describe('ExtensionControls', () => {
  it('merges every API’s map, drops a publish that changes nothing and an API’s empty map', () => {
    const published: Array<Record<string, ExtensionControl>> = []
    const controls = new ExtensionControls({
      setExtensionControls: (map) => {
        published.push(map)
      }
    })
    const fonts = { 'fonts.standard': { extensionId: OLD, name: 'Older Fonts' } }
    const privacy = { 'privacy.networkPredictionEnabled': { extensionId: NEW, name: 'Guard' } }
    controls.publish('fontSettings', fonts)
    controls.publish('privacy', privacy)
    expect(published).toEqual([fonts, { ...fonts, ...privacy }])
    // The same map again reaches no one.
    controls.publish('fontSettings', { ...fonts })
    expect(published).toHaveLength(2)
    // One API letting go keeps the other's keys.
    controls.publish('fontSettings', {})
    expect(published.at(-1)).toEqual(privacy)
    expect(controls.current).toEqual(privacy)
    controls.publish('privacy', {})
    expect(published.at(-1)).toEqual({})
    // An empty map published into an empty state is no change.
    controls.publish('proxy', {})
    expect(published).toHaveLength(4)
  })
})
