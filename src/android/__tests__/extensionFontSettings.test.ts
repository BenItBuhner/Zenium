import {
  FONT_SETTINGS_PERMISSION_ERROR,
  layerFonts,
  type FontName,
  type FontValues
} from '@core/extensions/api/fontSettings'
import { DEFAULT_FONT_SETTINGS, monospaceFontSize, type PageFontSettings } from '@shared/fonts'
import type { ExtensionControl } from '@shared/types'
import { describe, expect, it } from 'vitest'
import type { AttachedExtension } from '../extensionApi'
import {
  AndroidFontSettings,
  EMPTY_WEBVIEW_FONT_LAYER,
  WEBVIEW_FONT_DEFAULTS,
  installOrderRank,
  webViewFontLayer,
  webViewFontResult,
  fontNameList,
  type FontSettingsHost,
  type WebViewFontLayer
} from '../extensionFontSettings'
import { fontStylesheetScript } from '../extensionFontStylesheet'

/*
 * `chrome.fontSettings` on the phone against a fake host: the per-extension layer over the
 * user's page fonts by install-order precedence, what goes to the WebViews (`ext.fonts.apply`:
 * the WebSettings values and the `:lang()` stylesheet), the controls published for the Fonts
 * page, Chrome's four events with each receiver's level of control, the persistence across an
 * unload, and the permission gate.
 */

const A = 'a'.repeat(32)
const B = 'b'.repeat(32)

/** The layer a stylesheet alone makes: its css and the script that puts it into a document. */
function withCss(css: string): WebViewFontLayer {
  return { ...EMPTY_WEBVIEW_FONT_LAYER, css, script: fontStylesheetScript(css) }
}
const C = 'c'.repeat(32)

function ext(
  id: string,
  installedAt: number,
  permissions: string[] = ['fontSettings']
): AttachedExtension {
  return {
    record: { id, installedAt },
    manifest: { name: `Ext ${id[0].toUpperCase()}`, permissions },
    messages: null
  } as unknown as AttachedExtension
}

class FakeHost implements FontSettingsHost {
  readonly attachedById = new Map<string, AttachedExtension>()
  readonly persisted = new Map<string, FontValues>()
  fonts: PageFontSettings = { ...DEFAULT_FONT_SETTINGS }
  readonly applied: Array<WebViewFontLayer | null> = []
  readonly published: Array<Record<string, ExtensionControl>> = []
  readonly emitted: Array<{ id: string; event: string; details: Record<string, unknown> }> = []
  readonly warnings: string[] = []
  readonly listeners: Array<() => void> = []
  names: FontName[] = [
    { fontId: 'sans-serif', displayName: 'Roboto' },
    { fontId: 'sans-serif-cjk-jp', displayName: 'Noto Sans CJK JP' },
    { fontId: ' sans-serif ', displayName: 'Roboto again' },
    { fontId: '', displayName: 'nameless' },
    { fontId: 'casual', displayName: '' }
  ]
  listReads = 0
  failApply: string | null = null
  failList: string | null = null

  attached(id: string): AttachedExtension | undefined {
    return this.attachedById.get(id)
  }
  allAttached(): Iterable<AttachedExtension> {
    return this.attachedById.values()
  }
  holdsPermission(ext: AttachedExtension): boolean {
    return (ext.manifest as unknown as { permissions: string[] }).permissions.includes(
      'fontSettings'
    )
  }
  persistedValues(id: string): unknown {
    return this.persisted.get(id) ?? {}
  }
  persistValues(id: string, values: FontValues): void {
    if (Object.keys(values).length === 0) this.persisted.delete(id)
    else this.persisted.set(id, JSON.parse(JSON.stringify(values)) as FontValues)
  }
  userFonts(): PageFontSettings {
    return this.fonts
  }
  subscribe(listener: () => void): () => void {
    this.listeners.push(listener)
    return () => {
      const at = this.listeners.indexOf(listener)
      if (at >= 0) this.listeners.splice(at, 1)
    }
  }
  apply(layer: WebViewFontLayer | null): Promise<void> {
    this.applied.push(layer)
    return this.failApply ? Promise.reject(new Error(this.failApply)) : Promise.resolve()
  }
  listFonts(): Promise<FontName[]> {
    this.listReads++
    return this.failList
      ? Promise.reject(new Error(this.failList))
      : Promise.resolve(this.names.map((entry) => ({ ...entry })))
  }
  publish(controls: Record<string, ExtensionControl>): void {
    this.published.push(controls)
  }
  emit(id: string, ns: string, name: string, args: unknown[]): void {
    this.emitted.push({ id, event: `${ns}.${name}`, details: args[0] as Record<string, unknown> })
  }
  warn(message: string): void {
    this.warnings.push(message)
  }

  /** The state broadcast after a change of the user's setting. */
  changeUserFonts(change: Partial<PageFontSettings>): void {
    this.fonts = { ...this.fonts, ...change }
    for (const listener of [...this.listeners]) listener()
  }
  get lastApplied(): WebViewFontLayer | null | undefined {
    return this.applied[this.applied.length - 1]
  }
  get lastPublished(): Record<string, ExtensionControl> | undefined {
    return this.published[this.published.length - 1]
  }
  events(event: string): Array<{ id: string; details: Record<string, unknown> }> {
    return this.emitted
      .filter((e) => e.event === `fontSettings.${event}`)
      .map(({ id, details }) => ({ id, details }))
  }
}

function setUp(...exts: AttachedExtension[]): { host: FakeHost; fs: AndroidFontSettings } {
  const host = new FakeHost()
  const fs = new AndroidFontSettings(host)
  fs.attach()
  for (const e of exts) {
    host.attachedById.set(e.record.id, e)
    fs.load(e)
  }
  host.emitted.length = 0
  return { host, fs }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('AndroidFontSettings: one extension', () => {
  it('lays a standard family over the user setting: the WebViews get it, the Fonts page is told, the store keeps it, the caller hears onFontChanged', () => {
    const a = ext(A, 1000)
    const { host, fs } = setUp(a)
    expect(host.applied).toEqual([])
    expect(host.lastPublished).toEqual({})

    fs.call(a, 'setFont', [{ genericFamily: 'standard', fontId: 'Roboto' }])
    expect(host.lastApplied).toEqual({ ...EMPTY_WEBVIEW_FONT_LAYER, standard: 'Roboto' })
    expect(host.lastPublished).toEqual({
      'fonts.standard': { extensionId: A, name: 'Ext A', value: 'Roboto' }
    })
    expect(host.persisted.get(A)).toEqual({ families: { standard: 'Roboto' } })
    expect(fs.call(a, 'getFont', [{ genericFamily: 'standard' }])).toEqual({
      fontId: 'Roboto',
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(fs.call(a, 'getFont', [{ script: 'Zyyy', genericFamily: 'standard' }])).toEqual({
      fontId: 'Roboto',
      levelOfControl: 'controlled_by_this_extension'
    })
    // A family nobody set answers the engine's own generic name, controllable.
    expect(fs.call(a, 'getFont', [{ genericFamily: 'serif' }])).toEqual({
      fontId: 'serif',
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(host.events('onFontChanged')).toEqual([
      {
        id: A,
        details: {
          fontId: 'Roboto',
          levelOfControl: 'controlled_by_this_extension',
          script: 'Zyyy',
          genericFamily: 'standard'
        }
      }
    ])
    // The user's own setting was never written.
    expect(host.fonts).toEqual(DEFAULT_FONT_SETTINGS)

    // The same value again moves nothing.
    const applies = host.applied.length
    fs.call(a, 'setFont', [{ genericFamily: 'standard', fontId: 'Roboto' }])
    expect(host.applied).toHaveLength(applies)

    fs.call(a, 'clearFont', [{ genericFamily: 'standard' }])
    expect(host.lastApplied).toBeNull()
    expect(host.lastPublished).toEqual({})
    expect(host.persisted.has(A)).toBe(false)
    expect(fs.call(a, 'getFont', [{ genericFamily: 'standard' }])).toEqual({
      fontId: WEBVIEW_FONT_DEFAULTS.standard,
      levelOfControl: 'controllable_by_this_extension'
    })
  })

  it('carries the three sizes: the default size, the fixed size of its own, the minimum, each with its event', () => {
    const a = ext(A, 1000)
    const { host, fs } = setUp(a)

    fs.call(a, 'setDefaultFontSize', [{ pixelSize: 20 }])
    expect(host.lastApplied).toEqual({ ...EMPTY_WEBVIEW_FONT_LAYER, size: 20 })
    expect(host.lastPublished).toEqual({
      'fonts.size': { extensionId: A, name: 'Ext A', value: 20 }
    })
    expect(host.events('onDefaultFontSizeChanged')).toEqual([
      { id: A, details: { pixelSize: 20, levelOfControl: 'controlled_by_this_extension' } }
    ])
    // Chrome's fixed size is a preference of its own: Zenium's setting derives it from the size until an extension sets it.
    expect(fs.call(a, 'getDefaultFixedFontSize', [{}])).toEqual({
      pixelSize: monospaceFontSize(20),
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(host.events('onDefaultFixedFontSizeChanged')).toEqual([
      {
        id: A,
        details: {
          pixelSize: monospaceFontSize(20),
          levelOfControl: 'controllable_by_this_extension'
        }
      }
    ])

    fs.call(a, 'setDefaultFixedFontSize', [{ pixelSize: 14 }])
    expect(host.lastApplied).toEqual({ ...EMPTY_WEBVIEW_FONT_LAYER, size: 20, fixedSize: 14 })
    expect(host.lastPublished?.['fonts.fixedSize']).toEqual({
      extensionId: A,
      name: 'Ext A',
      value: 14
    })
    expect(fs.call(a, 'getDefaultFixedFontSize', [{}])).toEqual({
      pixelSize: 14,
      levelOfControl: 'controlled_by_this_extension'
    })

    fs.call(a, 'setMinimumFontSize', [{ pixelSize: 12 }])
    expect(host.lastApplied).toEqual({
      ...EMPTY_WEBVIEW_FONT_LAYER,
      size: 20,
      fixedSize: 14,
      minimumSize: 12
    })
    expect(host.events('onMinimumFontSizeChanged')).toEqual([
      { id: A, details: { pixelSize: 12, levelOfControl: 'controlled_by_this_extension' } }
    ])
    expect(fs.call(a, 'getMinimumFontSize', [])).toEqual({
      pixelSize: 12,
      levelOfControl: 'controlled_by_this_extension'
    })

    fs.call(a, 'clearDefaultFontSize', [{}])
    expect(host.lastApplied).toEqual({
      ...EMPTY_WEBVIEW_FONT_LAYER,
      fixedSize: 14,
      minimumSize: 12
    })
    expect(fs.call(a, 'getDefaultFontSize', [{}])).toEqual({
      pixelSize: DEFAULT_FONT_SETTINGS.size,
      levelOfControl: 'controllable_by_this_extension'
    })
    fs.call(a, 'clearDefaultFixedFontSize', [{}])
    fs.call(a, 'clearMinimumFontSize', [{}])
    expect(host.lastApplied).toBeNull()
    expect(host.persisted.has(A)).toBe(false)

    expect(() => fs.call(a, 'setDefaultFontSize', [{ pixelSize: 'big' }])).toThrow()
    expect(() => fs.call(a, 'setDefaultFontSize', [{}])).toThrow()
  })

  it('sends a per-script family and the math family as the stylesheet, the slotless cursive and fantasy as WebSettings values', () => {
    const a = ext(A, 1000)
    const { host, fs } = setUp(a)

    fs.call(a, 'setFont', [{ script: 'Jpan', genericFamily: 'standard', fontId: 'Noto Sans JP' }])
    expect(host.lastApplied).toEqual(
      withCss('@layer zen-ext-fonts {\n  *:lang(ja) { font-family: "Noto Sans JP"; }\n}\n')
    )
    expect(host.lastPublished).toEqual({
      'fonts.standard.Jpan': { extensionId: A, name: 'Ext A', value: 'Noto Sans JP' }
    })
    expect(fs.call(a, 'getFont', [{ script: 'Jpan', genericFamily: 'standard' }])).toEqual({
      fontId: 'Noto Sans JP',
      levelOfControl: 'controlled_by_this_extension'
    })
    // A script nobody set: Chrome's empty name.
    expect(fs.call(a, 'getFont', [{ script: 'Cyrl', genericFamily: 'standard' }])).toEqual({
      fontId: '',
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(host.events('onFontChanged')).toEqual([
      {
        id: A,
        details: {
          fontId: 'Noto Sans JP',
          levelOfControl: 'controlled_by_this_extension',
          script: 'Jpan',
          genericFamily: 'standard'
        }
      }
    ])

    fs.call(a, 'setFont', [{ genericFamily: 'math', fontId: 'STIX Two Math' }])
    expect(host.lastApplied?.css).toBe(
      '@layer zen-ext-fonts {\n  *:lang(ja) { font-family: "Noto Sans JP"; }\n  math { font-family: "STIX Two Math"; }\n}\n'
    )
    expect(host.lastPublished?.['fonts.math']).toEqual({
      extensionId: A,
      name: 'Ext A',
      value: 'STIX Two Math'
    })
    expect(fs.call(a, 'getFont', [{ genericFamily: 'math' }])).toEqual({
      fontId: 'STIX Two Math',
      levelOfControl: 'controlled_by_this_extension'
    })

    fs.call(a, 'setFont', [{ genericFamily: 'cursive', fontId: 'Comic Neue' }])
    expect(host.lastApplied?.cursive).toBe('Comic Neue')
    expect(host.lastPublished?.['fonts.cursive']).toEqual({
      extensionId: A,
      name: 'Ext A',
      value: 'Comic Neue'
    })
    fs.call(a, 'clearFont', [{ genericFamily: 'cursive' }])
    expect(host.lastApplied?.cursive).toBeNull()
    expect(fs.call(a, 'getFont', [{ genericFamily: 'cursive' }])).toEqual({
      fontId: 'cursive',
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(host.persisted.get(A)).toEqual({
      scripts: { Jpan: { standard: 'Noto Sans JP' } },
      extras: { math: 'STIX Two Math' }
    })

    fs.call(a, 'clearFont', [{ script: 'Jpan', genericFamily: 'standard' }])
    fs.call(a, 'clearFont', [{ genericFamily: 'math' }])
    expect(host.lastApplied).toBeNull()
  })

  it('answers the installed families from the host once – by display name, each id once, a nameless id shown as itself; an unreadable list is empty, warned about and read again next time', async () => {
    const a = ext(A, 1000)
    const { host, fs } = setUp(a)
    expect(await fs.call(a, 'getFontList', [])).toEqual([
      { fontId: 'casual', displayName: 'casual' },
      { fontId: 'sans-serif-cjk-jp', displayName: 'Noto Sans CJK JP' },
      { fontId: 'sans-serif', displayName: 'Roboto' }
    ])
    await fs.call(a, 'getFontList', [])
    expect(host.listReads).toBe(1)

    const { host: host2, fs: fs2 } = setUp(a)
    host2.failList = 'no such directory'
    expect(await fs2.call(a, 'getFontList', [])).toEqual([])
    expect(host2.warnings[0]).toContain('no such directory')
    host2.failList = null
    expect(await fs2.call(a, 'getFontList', [])).toHaveLength(3)
    expect(host2.listReads).toBe(2)
    expect(fontNameList([])).toEqual([])
  })

  it('refuses a caller without the permission, and an unknown method by name', () => {
    const c = ext(C, 1000, ['storage'])
    const a = ext(A, 900)
    const { host, fs } = setUp(a, c)
    expect(() => fs.call(c, 'getFont', [{ genericFamily: 'standard' }])).toThrow(
      FONT_SETTINGS_PERMISSION_ERROR
    )
    expect(() => fs.call(a, 'frobnicate', [])).toThrow(
      'chrome.fontSettings.frobnicate is not implemented on Zenium for Android'
    )
    // Persisted values of an extension without the permission (it was revoked) do not apply.
    host.persisted.set(C, { families: { standard: 'Nope' } })
    fs.load(c)
    expect(host.applied).toEqual([])
    // …and one without the permission hears no event.
    fs.call(a, 'setFont', [{ genericFamily: 'standard', fontId: 'Roboto' }])
    expect(host.events('onFontChanged').map((e) => e.id)).toEqual([A])
  })

  it('warns when the WebViews refuse the layer, and keeps going', async () => {
    const a = ext(A, 1000)
    const { host, fs } = setUp(a)
    host.failApply = 'no views'
    fs.call(a, 'setFont', [{ genericFamily: 'standard', fontId: 'Roboto' }])
    await tick()
    expect(host.warnings).toEqual(['fontSettings: the WebViews did not take the layer: no views'])
    expect(fs.call(a, 'getFont', [{ genericFamily: 'standard' }])).toMatchObject({
      fontId: 'Roboto'
    })
  })
})

describe('AndroidFontSettings: two extensions and the user', () => {
  it("ranks the most recently installed first per preference, tells each its own level of control, and falls back to the other's value on a clear", () => {
    const a = ext(A, 1000)
    const b = ext(B, 2000)
    const { host, fs } = setUp(a, b)

    fs.call(a, 'setFont', [{ genericFamily: 'standard', fontId: 'Roboto' }])
    fs.call(a, 'setDefaultFontSize', [{ pixelSize: 18 }])
    fs.call(b, 'setFont', [{ genericFamily: 'standard', fontId: 'Noto Serif' }])
    expect(host.lastApplied).toEqual({
      ...EMPTY_WEBVIEW_FONT_LAYER,
      standard: 'Noto Serif',
      size: 18
    })
    expect(host.lastPublished).toEqual({
      'fonts.standard': { extensionId: B, name: 'Ext B', value: 'Noto Serif' },
      'fonts.size': { extensionId: A, name: 'Ext A', value: 18 }
    })
    expect(fs.call(a, 'getFont', [{ genericFamily: 'standard' }])).toEqual({
      fontId: 'Noto Serif',
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(fs.call(b, 'getFont', [{ genericFamily: 'standard' }])).toEqual({
      fontId: 'Noto Serif',
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(fs.call(b, 'getDefaultFontSize', [{}])).toEqual({
      pixelSize: 18,
      levelOfControl: 'controlled_by_other_extensions'
    })
    // B's set was heard by both, each with its own level.
    const heard = host.events('onFontChanged').filter((e) => e.details.fontId === 'Noto Serif')
    expect(heard.map((e) => [e.id, e.details.levelOfControl])).toEqual([
      [A, 'controlled_by_other_extensions'],
      [B, 'controlled_by_this_extension']
    ])

    host.emitted.length = 0
    fs.call(b, 'clearFont', [{ genericFamily: 'standard' }])
    expect(host.lastApplied).toEqual({ ...EMPTY_WEBVIEW_FONT_LAYER, standard: 'Roboto', size: 18 })
    expect(host.lastPublished?.['fonts.standard']).toEqual({
      extensionId: A,
      name: 'Ext A',
      value: 'Roboto'
    })
    expect(
      host.events('onFontChanged').map((e) => [e.id, e.details.fontId, e.details.levelOfControl])
    ).toEqual([
      [A, 'Roboto', 'controlled_by_this_extension'],
      [B, 'Roboto', 'controlled_by_other_extensions']
    ])
    expect(host.persisted.has(B)).toBe(false)
  })

  it('drops a disabled extension’s layer and lays it again when it returns; an uninstall forgets its values', () => {
    const a = ext(A, 1000)
    const b = ext(B, 2000)
    const { host, fs } = setUp(a, b)
    fs.call(a, 'setFont', [{ genericFamily: 'standard', fontId: 'Roboto' }])
    fs.call(b, 'setFont', [{ genericFamily: 'standard', fontId: 'Noto Serif' }])
    fs.call(b, 'setMinimumFontSize', [{ pixelSize: 10 }])

    fs.unload(B)
    expect(host.lastApplied).toEqual({ ...EMPTY_WEBVIEW_FONT_LAYER, standard: 'Roboto' })
    expect(host.lastPublished).toEqual({
      'fonts.standard': { extensionId: A, name: 'Ext A', value: 'Roboto' }
    })
    expect(host.persisted.get(B)).toEqual({ families: { standard: 'Noto Serif' }, minimumSize: 10 })

    fs.load(b)
    expect(host.lastApplied).toEqual({
      ...EMPTY_WEBVIEW_FONT_LAYER,
      standard: 'Noto Serif',
      minimumSize: 10
    })

    fs.forget(B)
    expect(host.lastApplied).toEqual({ ...EMPTY_WEBVIEW_FONT_LAYER, standard: 'Roboto' })
    expect(host.persisted.has(B)).toBe(false)
    fs.unload(A)
    expect(host.lastApplied).toBeNull()
    expect(host.lastPublished).toEqual({})
    // The store still has A's for its return.
    expect(host.persisted.get(A)).toEqual({ families: { standard: 'Roboto' } })
  })

  it("re-lays the layer over the user's changed setting: the WebViews are not sent an unchanged layer, getFont answers the new value, onFontChanged is heard", async () => {
    const a = ext(A, 1000)
    const { host, fs } = setUp(a)
    fs.call(a, 'setDefaultFontSize', [{ pixelSize: 20 }])
    const applies = host.applied.length
    host.emitted.length = 0

    host.changeUserFonts({ standard: 'Lora' })
    await tick()
    expect(host.applied).toHaveLength(applies)
    expect(fs.call(a, 'getFont', [{ genericFamily: 'standard' }])).toEqual({
      fontId: 'Lora',
      levelOfControl: 'controllable_by_this_extension'
    })
    expect(host.events('onFontChanged')).toEqual([
      {
        id: A,
        details: {
          fontId: 'Lora',
          levelOfControl: 'controllable_by_this_extension',
          script: 'Zyyy',
          genericFamily: 'standard'
        }
      }
    ])
    // The user's size under the extension's: the pages keep the extension's, nothing is announced.
    host.emitted.length = 0
    host.changeUserFonts({ size: 14 })
    await tick()
    expect(host.applied).toHaveLength(applies)
    expect(host.emitted).toEqual([])
    expect(fs.call(a, 'getDefaultFontSize', [{}])).toMatchObject({ pixelSize: 20 })

    fs.detach()
    host.changeUserFonts({ standard: 'Merriweather' })
    await tick()
    expect(fs.call(a, 'getFont', [{ genericFamily: 'standard' }])).toMatchObject({
      fontId: 'Merriweather'
    })
    expect(host.emitted).toEqual([])
  })
})

describe('the pure parts', () => {
  it('webViewFontLayer: null for a layering nothing is held in; the held preferences alone otherwise', () => {
    const rank = installOrderRank([ext(A, 1000), ext(B, 2000)])
    expect(rank(B)).toBe(0)
    expect(rank(A)).toBe(1)
    expect(rank(C)).toBeUndefined()

    const user: PageFontSettings = { ...DEFAULT_FONT_SETTINGS, standard: 'Lora', size: 18 }
    expect(webViewFontLayer(layerFonts(user, new Map(), rank))).toBeNull()
    const layered = layerFonts(
      user,
      new Map<string, FontValues>([
        [A, { families: { serif: 'PT Serif' }, extras: { fantasy: 'Papyrus' }, fixedSize: 13 }],
        [B, { families: { serif: 'Noto Serif' }, scripts: { Cyrl: { serif: 'PT Serif' } } }]
      ]),
      rank
    )
    expect(webViewFontLayer(layered)).toEqual({
      ...EMPTY_WEBVIEW_FONT_LAYER,
      serif: 'Noto Serif',
      fantasy: 'Papyrus',
      fixedSize: 13,
      css: expect.stringContaining('*:lang(ru)') as string,
      script: expect.stringContaining('*:lang(ru)') as string
    })
    expect(webViewFontResult({ script: 'Zyyy', genericFamily: 'serif' }, layered, A)).toEqual({
      fontId: 'Noto Serif',
      levelOfControl: 'controlled_by_other_extensions'
    })
    expect(webViewFontResult({ script: 'Cyrl', genericFamily: 'serif' }, layered, B)).toEqual({
      fontId: 'PT Serif',
      levelOfControl: 'controlled_by_this_extension'
    })
    expect(webViewFontResult({ script: 'Zyyy', genericFamily: 'fantasy' }, layered, B)).toEqual({
      fontId: 'Papyrus',
      levelOfControl: 'controlled_by_other_extensions'
    })
    // The user's standard stands: a layering reads it, the WebView layer leaves it to the setting.
    expect(webViewFontResult({ script: 'Zyyy', genericFamily: 'standard' }, layered, A)).toEqual({
      fontId: 'Lora',
      levelOfControl: 'controllable_by_this_extension'
    })
  })
})
