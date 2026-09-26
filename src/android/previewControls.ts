import type { ExtensionControl, ExtensionInfo, UIState } from '@shared/types'

/*
 * Settings › Fonts under an extension's control, staged for the preview host (`controls=<variant>`
 * in a preview state): the `extensionControls` map the extension host publishes from a
 * `chrome.fontSettings` layer (#500's controlled-setting primitive – the held row drawn disabled
 * at the extension's value, one "Controlled by <name>" row under each run), with the controlling
 * extension installed so that row's press lands on its details sheet in Settings › Extensions,
 * whose Enabled switch is the way to have one's own value back. Nothing on this stand-in host –
 * nor on a device until the WebView `fontSettings` bridge lands – publishes a control on its own,
 * so the page is looked at from here. Variants: `fonts` (Standard font, Font size and Minimum
 * font size all set: three held rows, ONE indicator under the run), `size` (Font size alone),
 * `family` (Standard font alone).
 */

/** The fixture's controlling extension: a stand-in for Chrome's Advanced Font Settings. */
export const PREVIEW_CONTROLS_EXTENSION: Readonly<Pick<ExtensionInfo, 'id' | 'name'>> = {
  id: 'caclkomlalccbpcdllchkeecicepbmbm',
  name: 'Advanced Font Settings'
}

export const PREVIEW_CONTROLS_VARIANTS = ['fonts', 'size', 'family'] as const
export type PreviewControlsVariant = (typeof PREVIEW_CONTROLS_VARIANTS)[number]

/** The `controls=` value of a spec, or null for none or one this host does not stage. */
export function parsePreviewControls(value: string | null): PreviewControlsVariant | null {
  return (PREVIEW_CONTROLS_VARIANTS as readonly string[]).includes(value ?? '')
    ? (value as PreviewControlsVariant)
    : null
}

const HOUR_MS = 60 * 60 * 1000

/**
 * The extension's values, as the bridge would publish them – the keys the Fonts page reads
 * (`fonts.<pref>`), each with the extension and the value in effect. The family is one of
 * Android's own (`ANDROID_FONT_FAMILIES`), so the held row names it as the picker would; the
 * sizes sit apart from the defaults (16 / 0) so the held sliders visibly show the extension's.
 */
export function previewFontControls(
  variant: PreviewControlsVariant
): Record<string, ExtensionControl> {
  const held = (value: string | number): ExtensionControl => ({
    extensionId: PREVIEW_CONTROLS_EXTENSION.id,
    name: PREVIEW_CONTROLS_EXTENSION.name,
    value
  })
  switch (variant) {
    case 'size':
      return { 'fonts.size': held(18) }
    case 'family':
      return { 'fonts.standard': held('sans-serif') }
    case 'fonts':
      return {
        'fonts.standard': held('sans-serif'),
        'fonts.size': held(18),
        'fonts.minimumSize': held(12)
      }
  }
}

function controllingExtension(now: number): ExtensionInfo {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">` +
    `<rect width="48" height="48" rx="10" fill="#5b4bd6"/>` +
    `<text x="24" y="33" text-anchor="middle" font-family="serif" font-size="28" ` +
    `font-weight="600" fill="#fff">A</text></svg>`
  return {
    ...PREVIEW_CONTROLS_EXTENSION,
    version: '0.67',
    description: 'Customize standard, serif, sans-serif and fixed-width fonts and their sizes.',
    path: '',
    enabled: true,
    icon: `data:image/svg+xml,${encodeURIComponent(svg)}`,
    popup: null,
    error: null,
    source: 'chrome-web-store',
    publisher: 'chrome-web-store',
    updateUrl: 'https://clients2.google.com/service/update2/crx',
    installedAt: now - 12 * 24 * HOUR_MS,
    updatedAt: now - 12 * 24 * HOUR_MS,
    pinned: false,
    toolbarPinned: false,
    allowFileAccess: false,
    allowPrivate: false,
    allowUserScripts: false,
    manifestVersion: 3,
    permissions: ['fontSettings', 'storage'],
    hostPermissions: [],
    optionsPage: 'options.html',
    newTabPage: null,
    newTabOverride: false,
    warnings: [],
    pendingWarnings: null,
    updateState: 'up-to-date',
    availableVersion: null,
    updateError: null,
    updateCheckedAt: now - 2 * HOUR_MS,
    errors: []
  }
}

/**
 * The chrome's copy of the browser state with the extension's layer over the fonts: the map in
 * `extensionControls` and the extension among the installed ones (added once; a spec that also
 * seeds `extensions=` keeps its own list, this one joining it), the capability on so Settings has
 * an Extensions category for the indicator row's press to land in.
 */
export function fontControlsFixture(
  state: UIState,
  variant: PreviewControlsVariant,
  now: number
): UIState {
  const installed = state.extensions.some((e) => e.id === PREVIEW_CONTROLS_EXTENSION.id)
  return {
    ...state,
    capabilities: { ...state.capabilities, extensions: true },
    extensions: installed ? state.extensions : [...state.extensions, controllingExtension(now)],
    extensionControls: { ...state.extensionControls, ...previewFontControls(variant) }
  }
}
