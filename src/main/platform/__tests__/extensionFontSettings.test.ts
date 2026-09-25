import { describe, expect, it } from 'vitest'
import {
  FONT_SETTINGS_PERMISSION_ERROR,
  type FontValues
} from '../../../core/extensions/api/fontSettings'
import { DEFAULT_FONT_SETTINGS, type PageFontSettings } from '../../../shared/fonts'
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
  user: PageFontSettings
  /** The state's broadcast (the page fonts service applies the user's setting on it, as at runtime). */
  broadcast(): Promise<void>
  ctx(extensionId: string): ApiContext
}

function world(options: { fonts?: string[]; attach?: boolean } = {}): World {
  const dispatched: Dispatched[] = []
  const persisted = new Map<string, FontValues>()
  const applied: PageFontSettings[] = []
  const listeners: Array<() => void> = []
  let userApplied = ''
  const state: World = {
    api: undefined as unknown as FontSettingsApi,
    dispatched,
    loaded: new Set([OLD, NEW, NO_PERMISSION]),
    persisted,
    applied,
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
    browser: {
      extensions: {
        list: () => [
          { id: OLD, installedAt: 1000 },
          { id: NEW, installedAt: 2000 },
          { id: NO_PERMISSION, installedAt: 3000 }
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
    platform: 'linux',
    listFonts: async () => options.fonts ?? ['Tinos', 'Arimo', 'Cousine']
  })
  if (options.attach !== false) state.api.attach()
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

  it('answers per-script and slotless families with not_controllable and takes no value for them', () => {
    const w = world()
    call(w, OLD, 'setFont', {
      genericFamily: 'standard',
      script: 'Arab',
      fontId: 'Noto Naskh Arabic'
    })
    call(w, OLD, 'setFont', { genericFamily: 'cursive', fontId: 'Comic Neue' })
    expect(call(w, OLD, 'getFont', { genericFamily: 'standard', script: 'Arab' })).toEqual({
      fontId: '',
      levelOfControl: 'not_controllable'
    })
    expect(call(w, OLD, 'getFont', { genericFamily: 'cursive' })).toEqual({
      fontId: '',
      levelOfControl: 'not_controllable'
    })
    expect(w.applied).toEqual([])
    expect(w.persisted.size).toBe(0)
  })

  it('sets the sizes; the fixed-width size follows the size and is not controllable', () => {
    const w = world()
    expect(call(w, OLD, 'getDefaultFontSize')).toEqual({
      pixelSize: 16,
      levelOfControl: 'controllable_by_this_extension'
    })
    call(w, OLD, 'setDefaultFontSize', { pixelSize: 24 })
    call(w, OLD, 'setMinimumFontSize', { pixelSize: 12 })
    call(w, OLD, 'setDefaultFixedFontSize', { pixelSize: 30 })
    expect(call(w, OLD, 'getDefaultFontSize', {})).toEqual({
      pixelSize: 24,
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(call(w, NEW, 'getMinimumFontSize', {})).toEqual({
      pixelSize: 12,
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(call(w, OLD, 'getDefaultFixedFontSize', {})).toEqual({
      pixelSize: 20,
      levelOfControl: 'not_controllable'
    })
    expect(w.applied.at(-1)).toEqual({ ...DEFAULT_FONT_SETTINGS, size: 24, minimumSize: 12 })
    call(w, OLD, 'clearDefaultFixedFontSize')
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

  it('reports the sizes, the derived fixed-width size among them', () => {
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
        { pixelSize: 14, levelOfControl: 'not_controllable' }
      ],
      [
        NEW,
        'fontSettings.onDefaultFixedFontSizeChanged',
        { pixelSize: 14, levelOfControl: 'not_controllable' }
      ]
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
