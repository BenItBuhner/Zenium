import { FONT_SETTINGS_PERMISSION_ERROR } from '@core/extensions/api/fontSettings'
import { DEFAULT_FONT_SETTINGS } from '@shared/fonts'
import { describe, expect, it } from 'vitest'
import { EMPTY_WEBVIEW_FONT_LAYER } from '../extensionFontSettings'
import { fontStylesheetScript } from '../extensionFontStylesheet'
import {
  type Harness,
  ID,
  ID2,
  backgroundUp,
  call,
  events,
  harness,
  manifest,
  record
} from './runtimeHarness'

/*
 * `chrome.fontSettings` through the runtime: Advanced Font Settings' shape (the `fontSettings`
 * permission, a background that lists the fonts, sets a family and a size and listens for the
 * changes) against the fake Kotlin – what `ext.fonts.apply` carries, what the core's controls
 * map gets, what the store keeps across a detach and a restart, and the precedence of two.
 */

const PATH2 = `/data/user/0/app.zen.chromium/files/zen/extensions/${ID2}/1.0.0`
const LISTENERS = [
  'fontSettings.onFontChanged',
  'fontSettings.onDefaultFontSizeChanged',
  'fontSettings.onDefaultFixedFontSizeChanged',
  'fontSettings.onMinimumFontSizeChanged'
]

async function withFontSettings(
  h: Harness,
  overrides: { id?: string; installedAt?: number; permissions?: string[] } = {}
): Promise<string> {
  const id = overrides.id ?? ID
  await h.runtime.attach(
    record(
      h,
      {
        id,
        ...(id === ID ? {} : { path: PATH2 }),
        ...(overrides.installedAt !== undefined ? { installedAt: overrides.installedAt } : {})
      },
      manifest({
        name: id === ID ? 'Advanced Font Settings' : 'Fonts Probe B',
        permissions: overrides.permissions ?? ['fontSettings', 'storage']
      })
    )
  )
  const ep = `bg-${id.slice(0, 4)}`
  if (id === ID) {
    backgroundUp(h, ep, LISTENERS)
    return ep
  }
  // The harness's `hello` names ID; the second extension's background says hello itself.
  const post = (m: Record<string, unknown>): void =>
    h.runtime.onMessage({ ep, tabId: null, top: true, origin: '', message: m })
  h.runtime.onMessage({
    ep,
    tabId: null,
    top: true,
    origin: `https://${id}.ext.zenium.invalid`,
    message: {
      t: 'hello',
      ext: id,
      ctx: 'background',
      url: `https://${id}.ext.zenium.invalid/bg.html`,
      world: false
    }
  })
  for (const event of LISTENERS) post({ t: 'listen', event, on: true })
  post({ t: 'ready' })
  return ep
}

describe('AndroidExtensionRuntime: chrome.fontSettings', () => {
  it("lists the phone's fonts, lays a family and the sizes over the WebViews, publishes the controls, keeps the values, and tells the listener", async () => {
    const h = harness()
    const ep = await withFontSettings(h)
    expect(h.kt.fontLayer).toBeUndefined()

    // Kotlin's `{ id, name }` per named family of fonts.xml, as Chrome's FontNames by display name.
    expect((await call(h, ep, 'fontSettings', 'getFontList', [])).result).toEqual([
      { fontId: 'casual', displayName: 'Coming Soon' },
      { fontId: 'cursive', displayName: 'Dancing Script' },
      { fontId: 'monospace', displayName: 'Droid Sans Mono' },
      { fontId: 'serif', displayName: 'Noto Serif' },
      { fontId: 'sans-serif', displayName: 'Roboto' }
    ])
    expect(h.kt.calledWith('ext.fonts.list')).toHaveLength(1)

    expect(
      await call(h, ep, 'fontSettings', 'setFont', [
        { genericFamily: 'standard', fontId: 'Roboto' }
      ])
    ).toMatchObject({ ok: true })
    expect(h.kt.fontLayer).toEqual({ ...EMPTY_WEBVIEW_FONT_LAYER, standard: 'Roboto' })
    expect(h.controls).toEqual([
      { 'fonts.standard': { extensionId: ID, name: 'Advanced Font Settings', value: 'Roboto' } }
    ])
    expect(
      (await call(h, ep, 'fontSettings', 'getFont', [{ genericFamily: 'standard' }])).result
    ).toEqual({ fontId: 'Roboto', levelOfControl: 'controlled_by_this_extension' })
    expect(events(h, ep, 'fontSettings.onFontChanged')).toHaveLength(1)
    expect((events(h, ep, 'fontSettings.onFontChanged')[0].args as unknown[])[0]).toEqual({
      fontId: 'Roboto',
      levelOfControl: 'controlled_by_this_extension',
      script: 'Zyyy',
      genericFamily: 'standard'
    })

    await call(h, ep, 'fontSettings', 'setDefaultFontSize', [{ pixelSize: 20 }])
    await call(h, ep, 'fontSettings', 'setMinimumFontSize', [{ pixelSize: 10 }])
    await call(h, ep, 'fontSettings', 'setFont', [
      { script: 'Jpan', genericFamily: 'standard', fontId: 'Noto Sans JP' }
    ])
    const css = '@layer zen-ext-fonts {\n  *:lang(ja) { font-family: "Noto Sans JP"; }\n}\n'
    expect(h.kt.fontLayer).toEqual({
      ...EMPTY_WEBVIEW_FONT_LAYER,
      standard: 'Roboto',
      size: 20,
      minimumSize: 10,
      css,
      script: fontStylesheetScript(css)
    })
    expect(h.controls[h.controls.length - 1]).toEqual({
      'fonts.standard': { extensionId: ID, name: 'Advanced Font Settings', value: 'Roboto' },
      'fonts.size': { extensionId: ID, name: 'Advanced Font Settings', value: 20 },
      'fonts.minimumSize': { extensionId: ID, name: 'Advanced Font Settings', value: 10 },
      'fonts.standard.Jpan': {
        extensionId: ID,
        name: 'Advanced Font Settings',
        value: 'Noto Sans JP'
      }
    })
    expect(events(h, ep, 'fontSettings.onDefaultFontSizeChanged')).toHaveLength(1)
    expect(events(h, ep, 'fontSettings.onMinimumFontSizeChanged')).toHaveLength(1)
    // The fixed size follows the size until an extension sets it: its event fires with the size's.
    expect(events(h, ep, 'fontSettings.onDefaultFixedFontSizeChanged')).toHaveLength(1)

    // The user's own setting was never written; the values are the runtime's store's.
    expect(h.fonts).toEqual(DEFAULT_FONT_SETTINGS)
    expect(
      (h.saved('extensions-runtime.json').fontSettings as Record<string, unknown>)[ID]
    ).toEqual({
      families: { standard: 'Roboto' },
      size: 20,
      minimumSize: 10,
      scripts: { Jpan: { standard: 'Noto Sans JP' } }
    })

    // Disabled: the layer goes, the controls empty; the store keeps the values.
    await h.runtime.detach(ID)
    expect(h.kt.fontLayer).toEqual(EMPTY_WEBVIEW_FONT_LAYER)
    expect(h.controls[h.controls.length - 1]).toEqual({})
    expect(
      (h.saved('extensions-runtime.json').fontSettings as Record<string, unknown>)[ID]
    ).toBeDefined()

    // Enabled again: the values apply at attach, before any page of the extension runs.
    await h.runtime.attach(record(h, {}, manifest({ permissions: ['fontSettings', 'storage'] })))
    expect(h.kt.fontLayer).toMatchObject({ standard: 'Roboto', size: 20, minimumSize: 10 })

    // Uninstalled: the values go with it.
    await h.runtime.forget(ID)
    expect(h.kt.fontLayer).toEqual(EMPTY_WEBVIEW_FONT_LAYER)
    expect(h.saved('extensions-runtime.json').fontSettings).toEqual({})
  })

  it('lays the persisted values again in a new session', async () => {
    const first = harness()
    const ep = await withFontSettings(first)
    await call(first, ep, 'fontSettings', 'setFont', [
      { genericFamily: 'fixed', fontId: 'Droid Sans Mono' }
    ])
    await call(first, ep, 'fontSettings', 'setDefaultFixedFontSize', [{ pixelSize: 13 }])
    first.runtime.flushSync()

    const h = harness({ files: first.files })
    await withFontSettings(h)
    expect(h.kt.fontLayer).toEqual({
      ...EMPTY_WEBVIEW_FONT_LAYER,
      fixed: 'Droid Sans Mono',
      fixedSize: 13
    })
    expect(h.controls).toEqual([
      {
        'fonts.fixed': {
          extensionId: ID,
          name: 'Advanced Font Settings',
          value: 'Droid Sans Mono'
        },
        'fonts.fixedSize': { extensionId: ID, name: 'Advanced Font Settings', value: 13 }
      }
    ])
  })

  it('ranks the most recently installed extension first and answers each its level of control', async () => {
    const h = harness()
    const a = await withFontSettings(h, { installedAt: 1_000 })
    const b = await withFontSettings(h, { id: ID2, installedAt: 2_000 })
    await call(h, a, 'fontSettings', 'setFont', [{ genericFamily: 'standard', fontId: 'Roboto' }])
    await call(h, b, 'fontSettings', 'setFont', [
      { genericFamily: 'standard', fontId: 'Noto Serif' }
    ])
    expect(h.kt.fontLayer).toMatchObject({ standard: 'Noto Serif' })
    expect(h.controls[h.controls.length - 1]).toEqual({
      'fonts.standard': { extensionId: ID2, name: 'Fonts Probe B', value: 'Noto Serif' }
    })
    expect(
      (await call(h, a, 'fontSettings', 'getFont', [{ genericFamily: 'standard' }])).result
    ).toEqual({ fontId: 'Noto Serif', levelOfControl: 'controlled_by_other_extensions' })
    // Both heard B's change, each with its own level.
    expect(
      (events(h, a, 'fontSettings.onFontChanged').at(-1)?.args as Array<Record<string, unknown>>)[0]
    ).toMatchObject({ fontId: 'Noto Serif', levelOfControl: 'controlled_by_other_extensions' })
    expect(
      (events(h, b, 'fontSettings.onFontChanged').at(-1)?.args as Array<Record<string, unknown>>)[0]
    ).toMatchObject({ fontId: 'Noto Serif', levelOfControl: 'controlled_by_this_extension' })

    await call(h, b, 'fontSettings', 'clearFont', [{ genericFamily: 'standard' }])
    expect(h.kt.fontLayer).toMatchObject({ standard: 'Roboto' })
    expect(
      (await call(h, b, 'fontSettings', 'getFont', [{ genericFamily: 'standard' }])).result
    ).toEqual({ fontId: 'Roboto', levelOfControl: 'controlled_by_other_extensions' })
  })

  it('refuses the calls of an extension without the permission with Chrome’s message', async () => {
    const h = harness()
    const ep = await withFontSettings(h, { permissions: ['storage'] })
    expect(await call(h, ep, 'fontSettings', 'getFontList', [])).toMatchObject({
      ok: false,
      error: expect.stringContaining(FONT_SETTINGS_PERMISSION_ERROR) as string
    })
    expect(h.kt.fontLayer).toBeUndefined()
  })
})
