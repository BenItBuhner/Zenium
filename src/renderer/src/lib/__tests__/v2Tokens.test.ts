import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HINT_PALETTE } from '@shared/fullscreenHint'
import { REDUCED_FADE_MS, TOAST_CARD, TOAST_SHOW_MS } from '@shared/toastCard'
import { MESSAGE_INSET } from '../../components/messages/stack'
import { FULLSCREEN_RETURN_MS } from '../../components/phone/useFullscreenReturn'
import { TOOLBAR_STROKE } from '../../components/v2/controls'
import { TOAST_DURATION } from '../ui'

/**
 * The design-language v2 tokens live in one block of main.css (docs/design-language-v2-draft.md).
 * These tests pin the set so surfaces cannot fork their own copies, and check that nothing reads
 * the tokens except the surfaces deliberately moved to v2, listed below.
 */
const css = readFileSync(fileURLToPath(new URL('../../assets/main.css', import.meta.url)), 'utf8')

/**
 * Surfaces built on v2, each as the pair of markers that brackets its rules in main.css (the
 * first is the start of its block, the second the first text after it). Add a surface here when
 * it is moved to v2 on purpose; anything else reading a v2 token fails the last test.
 */
const V2_SURFACES: ReadonlyArray<readonly [start: string, end: string]> = [
  // The frame dialog host's scrim (lib/portals.tsx), which dims only the content frame (§9.5).
  ['.zen-frame-dialogs {', '.zen-chrome-layer {'],
  // Site information (components/siteinfo/SiteInfoSheet.tsx, #39): the sheet's row values, glyphs,
  // headings, empty state and level track after the chassis rows, then the desktop popover's own
  // rows, header and footer. Cut out before the chassis, whose span encloses them.
  ['.zen-sheet-item-value {', '/*\n   * Bookmarks, built to the v2 draft'],
  // The phone sheet chassis (components/sheet/BottomSheet.tsx): surface, header, grabber, rows
  // and separators shared by every phone sheet (v2 §6, §9.16, §9.25) – the shell pass.
  ['.zen-sheet {', '/*\n   * Bookmarks, built to the v2 draft'],
  // The pull-to-refresh disc (components/content/PullIndicator.tsx).
  ['.zen-ptr-disc {', '.zen-space-strip {'],
  // The v2 badge (§9.19): site information's Private badge (components/siteinfo/SiteInfoSheet.tsx).
  ['.zen-v2-badge {', '/* Safe-area insets pushed by mobile hosts'],
  // The v2 button, shared by every v2 surface (the Settings > Look and Feel > Navigation bar button,
  // components/overlays/SettingsPanel.tsx; the first run, overlays/PhoneOnboarding.tsx; the
  // default-browser prompts, defaultbrowser/*), with the first run's unlayered override beside it;
  // its layering is pinned by the tests below.
  ['.zen-v2-button {', '/*\n * The v2 badge (§9.19)'],
  // The Tabs button's hold menu (components/phone/TabsQuickMenu.tsx).
  ['.zen-quick-menu {', '/* The chassis sheet is the v2 surface (§6)'],
  // The tab group strip in the phone bar (components/phone/GroupStrip.tsx, TAB-14): a window
  // surface (§9.29) – the tray in the window fill, the chips in the theme's ink and accent.
  ['.zen-group-strip {', "/* Titles of the phone's overview, drawer and sheets. */"],
  // The navigation bar's editor (components/phone/BarEditorSheet.tsx, BarPreview.tsx).
  ['.zen-bar-row {', '/* The editor draws a hairline when its rows scroll under the header'],
  // The zen://error page (shared/zenPages.ts cuts this block, the token block and the v2 button
  // out of the stylesheet's text and writes them into the page, which cannot link main.css).
  ['.zen-error-document {', '@layer base {'],
  // The chrome's focus ring (§1, a11y-10): the base-layer floor under every control of the chrome
  // document, reading the ring token; it ends where the first components layer begins.
  [" * The chrome's focus ring (v2 §1, a11y-10)", '@layer components {'],
  // The sidebar tab drag – drop-into targets, the audio indicator, ghost, caret and tear-off card
  // (lib/drag.ts, components/DragLayer.tsx, components/sidebar/TabItem.tsx).
  ['[data-drop-into] {', '.zen-panel {'],
  // The downloads bubble, toolbar button and zen://downloads page (components/downloads,
  // overlays/DownloadsPanel.tsx). Its block sits between the bookmark chrome's rules and the
  // comment that ends them, so it is taken out first.
  ['.zen-dl-surface {', '@keyframes zen-dl-pop-out {'],
  // The bookmark chrome: bar, panels, star bubble, dialogs, manager (components/bookmarks/*).
  ['.zen-bm-bar {', '/*\n   * The first run on a phone'],
  // The Android downloads sheet (components/downloads/DownloadsSheet.tsx): what its rows hold on
  // the chassis and the shared row – glyph, name, status, progress track, the Keep / Delete
  // footer – then its unlayered modifiers on the primitives. It follows the first run's block,
  // whose span would enclose it, so it is cut out first.
  ['.zen-downloads-main {', ' * Fading scroll edges'],
  // The phone first run (overlays/PhoneOnboarding.tsx, a window surface reading the §9.29
  // control roles). The gesture hint (phone/useGestureHint.ts) is a toast on the message cards
  // and the default-browser prompts (defaultbrowser/*) are the chassis' prompt composition:
  // neither has rules of its own.
  [' * The first run on a phone', ' * Fading scroll edges'],
  // Settings > Privacy and Security, the protection groups of the desktop pane (components/
  // overlays/ProtectionSection.tsx, overlays/protection/*): what they add under their own
  // `.zen-protection-*` names to the pane's vocabulary above them. The block sits between the
  // pane's and the Default Browser range, so it is cut out before the pane's, which ends there.
  ['.zen-privacy + .zen-privacy.zen-protection {', '/*\n * Settings → Default Browser and the'],
  // Settings > Privacy and Security (components/overlays/PrivacySection.tsx) and the URL bar's
  // blocked-count chip (components/urlbar/BlockedChip.tsx). Its block sits between the find
  // bar's and the Default Browser range, so it is cut out before the find bar's, which ends there.
  ['.zen-privacy {', '/*\n * Settings → Default Browser and the'],
  // Find in page, zoom and fullscreen: the docked find bar (components/content/FindBar.tsx).
  ['.zen-find-bar {', '/*\n * Settings → Default Browser and the'],
  // The phone page zoom sheet, docked under the live page, and its own instance of the stepper
  // (components/content/ZoomSheet.tsx, components/ZoomStepper.tsx). The last block before the
  // reduced-motion rules, so it is cut out before the Default Browser range that ends there.
  ['.zen-zoom-sheet {', '\n@media (prefers-reduced-motion: reduce) {'],
  // Settings → Default Browser and the default-browser strip (components/overlays/
  // DefaultBrowserSection.tsx, content/DefaultBrowserBanner.tsx): the flat card and its inks.
  ['.zen-default-browser-card {', '\n@media (prefers-reduced-motion: reduce) {'],
  // The message cards: toast and banner, their action button, glyph and close (components/messages/*).
  ['.zen-message {', '.zen-suggestion {'],
  // The zen-v2-* controls inside the chassis (components/newtab/CustomizeSheet.tsx): the
  // description and the control row; the rows, heading, switch and card radio are the shared
  // primitives below (§9.34, the Settings tab's block).
  ['.zen-v2-description {', '.zen-ntp-field {'],
  // The new tab page, one .zen-ntp-* block for both platforms (§9.29): the shared vocabulary –
  // search field, .zen-v2-shortcut tiles, captions, fallbacks, scrim – that shared/newTabPage.ts
  // cuts out for the desktop's zen://newtab document, then the phone page's gated additions:
  // wallpaper, stagger, the customise sheet's presets grid and previews, the grow surface
  // (components/newtab/NewTabPage.tsx, CustomizeSheet.tsx, NewTabGrowLayer.tsx).
  ['.zen-ntp-field {', '/*\n * A sheet coming up pushes the page back'],
  // The phone omnibox's search-ready header, chips, Refine arrow and clipboard Show
  // (components/urlbar/Urlbar.tsx; a window surface reading the §9.29 control roles).
  ['.zen-omnibox-header {', ' * Settings as a tab (design language v2 draft'],
  // The Settings tab (components/pages/settings): the page host, the shared v2 rows, fields,
  // icon buttons and image radio cards it introduces, its sheets and its overview thumbnail.
  ['.zen-page-host {', ' * History page (design language v2 draft'],
  // The desktop's install dialog (components/install/InstallDialog.tsx, MW-22): its scrolling
  // body and §9.11 footer on the `--v2-dialog`; it shares the phone sheet's tile, name, origin,
  // field and screenshot strip above it, whose span would enclose it, so it is cut out first.
  ['.zen-install-dialog-body {', "/*\n   * The desktop's share popover"],
  // The desktop's share popover (components/share/SharePopover.tsx, MW-21): the preview, the QR
  // card, the targets' hairline, and its unlayered two-line modifier on the shared row (§9.34).
  ['.zen-share-body {', '@layer components {\n  /*\n   * The screen-capture picker'],
  // The screen-capture picker (components/screenCapture/ScreenPicker.tsx, MW-19): the panes'
  // hairline, the fixed list box with its spinner and empty line, the source cards, the footer,
  // and its unlayered centring of the shared checkbox (§9.34).
  ['.zen-scpick-panes {', "@layer components {\n  /*\n   * The desktop's media hub"],
  // The desktop's media hub (components/media/MediaHubPopover.tsx, MediaHubButton.tsx, MW-16):
  // the players (the artwork tile is the media sheet's `.zen-media-art`, below), the title
  // pair's press fill, the seek row's times, the transport, the toolbar button's dot.
  ['.zen-mhub-body {', '@layer components {\n  /*\n   * The media sheet'],
  // "Add to Home screen": what the install and name-edit sheets add to the chassis – app tile,
  // name and origin, the name field's label, the screenshot strip (components/phone/InstallSheet.tsx).
  ['.zen-install-body {', '/*\n * A sheet coming up pushes the page back'],
  // A web app's standalone window's title bar (components/app/AppTitleBar.tsx, MW-23): a window
  // surface (§9.29) in the chassis' first components layer – the theme's ink, the title's weight
  // and line from the scale.
  ['.zen-app-titlebar {', '.zen-tab {']
]

/**
 * Files outside main.css built on v2 (a surface's own stylesheet, a component with inline values),
 * as paths under src/renderer/src. Add a file here when its surface is moved to v2 on purpose; any
 * other renderer file reading a v2 token fails the last test.
 */
const V2_FILES: ReadonlyArray<string> = [
  // The phone history and bookmarks panels, their sheets and the bookmark editor.
  'components/phone/phonePanels.css',
  // The extensions UI's own stylesheet, imported by main.css (components/extensions/*, #68):
  // management page and details, toolbar actions and the puzzle panel, popup frame, prompts.
  'assets/extensions.css',
  // The password manager's own stylesheet, imported by main.css (components/overlays/passwords/*,
  // #92): the manager's page, panes, rows, dialog, prompt sheet, popover and picker sheet.
  'assets/passwords.css',
  // The translate surfaces' stylesheet, imported by main.css (components/translate/*, #106):
  // the translation bar, the selection popover and sheet, the language menulist's list and
  // picker sheet, the desktop Languages pane.
  'assets/translate.css',
  // The autofill surfaces' own stylesheet, imported by components/autofill/controls.tsx (#145):
  // the save / update prompts, the pickers, the passkey and passphrase dialogs, the editors and
  // Settings > Autofill with its managers.
  'assets/autofill.css',
  // The desktop bookmark manager's selection count pill (components/bookmarks/*, #90).
  'components/bookmarks/BookmarkManager.tsx',
  // The window prompts' checkbox accent (§9.5 modals, #129).
  'components/dialogs/WindowPromptDialog.tsx',
  // The extension details page's error line in the danger ink (#68).
  'components/extensions/ExtensionDetails.tsx',
  // The new tab page's shortcut dialog: its validation line in the danger ink (#148).
  'components/newtab/NewTabShortcutDialog.tsx',
  // Settings → Security on desktop (#62): the status ink of a remembered answer, the pane title.
  'components/overlays/SecuritySection.tsx',
  // The external-protocol sheet on the v2 sheet chassis (#140): its deemphasised host line.
  'components/protocol/ExternalProtocolSheet.tsx',
  // The blocked pop-ups popover, sheet and phone bar, and the sign-in and certificate dialogs
  // (#62): the glyph's size and stroke, the title block's glyph offset, the notice's warn ink,
  // the ink of an expired certificate; `glyph.ts` is the row glyph they share.
  'components/security/BlockedPopupsPanel.tsx',
  'components/security/SecurityPromptDialog.tsx',
  'components/security/glyph.ts',
  // The address pill's blocked pop-ups chip and its count (#62) and the sidebar's tab count
  // badge, drawn in their surface's family through the §9.29 control roles.
  'components/sidebar/SidebarTop.tsx',
  'components/sidebar/SpacePanel.tsx',
  // Site information (#39): the connection state's ok / warn / danger ink on its glyphs and values.
  'components/siteinfo/SiteInfoSheet.tsx',
  // Site controls (#135), a v2 surface: the shared glyph size and stroke (`V2_GLYPH`); the
  // desktop popover, dialog and pane primitives' metrics and inks; the Settings panes' card
  // padding and deemphasised ink; the builder rows' glyph ink. (The pill carries no private
  // badge – §9.19 keeps badges for mixed lists – so PhoneShell reads no token of its own.)
  'components/v2/controls.tsx',
  'components/siteControls/primitives.tsx',
  'components/siteControls/pane.tsx',
  'components/siteControls/SiteInfoPopover.tsx',
  'components/siteControls/ClearBrowsingDataDialog.tsx',
  'components/siteControls/settingsRows.tsx',
  'components/overlays/SiteSettingsSection.tsx',
  'components/overlays/SafetyCheckSection.tsx',
  // The print preview (#225's UI): the option column's headings and validation lines in the
  // deemphasised and danger inks, the preview pane's notice and paging pill in the panel family.
  'components/print/PrintPreviewDialog.tsx',
  'components/print/PreviewPane.tsx',
  // The phone PDF viewer's docked bar and its sheets (#225's UI): the bar's chassis and its
  // notices in the panel family and the deemphasised ink, the outline rows' page numbers and
  // selected fill, the password sheet's error line in the danger ink.
  'components/pdf/PdfViewerBar.tsx',
  'components/pdf/PdfSheets.tsx'
]

/** The text of the first `selector {` block found after `from`. */
function block(selector: string, from = 0): string {
  const start = css.indexOf(`${selector} {`, from)
  expect(start, `block "${selector}"`).toBeGreaterThanOrEqual(0)
  return css.slice(start, css.indexOf('\n}', start))
}

/** Custom-property names declared inside the first `selector {` block found after `from`. */
function declared(selector: string, from = 0): Set<string> {
  return new Set(block(selector, from).match(/--v2-[a-z0-9-]+(?=:)/g) ?? [])
}

/**
 * The two §9.29 token families, as the blocks that resolve the shared control roles for a
 * surface root carrying `data-surface="page"` or `"window"` (lib/portals.tsx puts "page" on the
 * frame dialog host and the chrome layer; the window chrome roots carry "window").
 */
const FAMILIES = ["[data-surface='page']", "[data-surface='window']"] as const

/** The control roles a chip, badge or icon button reads to draw in its surface's family. */
const CONTROL_ROLES = ['text', 'text-deemphasized', 'fill', 'fill-hover', 'accent'].map(
  (n) => `--v2-control-${n}`
)

// The light block is the first `:root {` that declares a v2 token.
const lightStart = css.indexOf('--v2-page:')
const lightBlockStart = css.lastIndexOf(':root {', lightStart)
const light = declared(':root', lightBlockStart)
const dark = declared(":root[data-theme='dark']", lightStart)
const phone = declared(":root[data-form-factor='phone']", lightStart)

const SURFACE = [
  'page',
  'card',
  'card-border',
  'panel',
  'border',
  'urlbar',
  'text',
  'text-rgb',
  'text-deemphasized',
  'fill',
  'fill-hover',
  'accent',
  'on-accent',
  'scrim',
  'scrim-modal',
  'sidebar-neutral',
  'tab-active',
  'urlpill',
  'nav-active',
  'window-fill',
  'window-fill-hover',
  'selected'
].map((n) => `--v2-${n}`)

const SCALE = [
  'radius-control',
  'radius-card',
  'radius-sheet',
  'radius-checkbox',
  'radius-inner',
  'shadow-panel',
  'shadow-sheet',
  'shadow-urlbar',
  'shadow-frame',
  'font-title',
  'font-heading',
  'font-body',
  'font-small',
  'line-title',
  'line-heading',
  'line-body',
  'line-small',
  'weight-body',
  'weight-button',
  'weight-heading',
  'row',
  'row-two-line',
  'row-pad',
  'control',
  'checkbox',
  'nav-item',
  'menu-row',
  'icon-button',
  'icon',
  'icon-stroke',
  'card-padding',
  'content-max',
  'ring',
  'ring-room',
  'selection',
  'ok',
  'warn',
  'danger'
].map((n) => `--v2-${n}`)

describe('design language v2 tokens', () => {
  it('defines every surface and scale token in the light block', () => {
    for (const name of [...SURFACE, ...SCALE]) expect(light, name).toContain(name)
  })

  it('redefines every colour surface for dark, and nothing that is not a colour', () => {
    const colourOnly = SURFACE.filter(
      (n) => !['--v2-window-fill', '--v2-window-fill-hover'].includes(n)
    )
    for (const name of colourOnly) expect(dark, name).toContain(name)
    for (const name of dark)
      expect(light, `${name} declared for dark but not light`).toContain(name)
    for (const name of dark)
      expect(
        SCALE.filter((s) => !s.startsWith('--v2-shadow-urlbar')),
        `${name} is not a colour`
      ).not.toContain(name)
  })

  it('scales hit targets on phones without touching the vocabulary', () => {
    for (const name of [
      '--v2-row',
      '--v2-control',
      '--v2-checkbox',
      '--v2-menu-row',
      '--v2-icon-button',
      '--v2-icon'
    ])
      expect(phone, name).toContain(name)
    for (const name of phone)
      expect(SURFACE, `${name} must not change per form factor`).not.toContain(name)
  })

  // §9.3, one stroke per toolbar row: the constant the toolbar row's and the app title bar's
  // glyphs pass as Lucide's `strokeWidth` is the desktop value of the glyph-stroke token, so
  // the row and the v2 glyphs drawn from the token cannot drift apart (#245 chassis (d)).
  it('gives the toolbar row the desktop glyph stroke: TOOLBAR_STROKE is --v2-icon-stroke', () => {
    const m = /--v2-icon-stroke:\s*([\d.]+);/.exec(css.slice(lightBlockStart))
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(TOOLBAR_STROKE)
    expect(TOOLBAR_STROKE).toBe(1.5)
  })

  it('is read only by the surfaces deliberately moved to v2', () => {
    const blockEnd = css.indexOf("/* Zen clamps its primary colour's lightness")
    expect(blockEnd).toBeGreaterThan(lightStart)
    let outside = css.slice(0, lightBlockStart) + css.slice(blockEnd)
    for (const [start, end] of V2_SURFACES) {
      const from = outside.indexOf(start)
      const to = outside.indexOf(end, from)
      expect(from, `v2 surface "${start}"`).toBeGreaterThanOrEqual(0)
      expect(to, `end of v2 surface "${start}"`).toBeGreaterThan(from)
      expect(outside.slice(from, to), `"${start}" reads v2 tokens`).toMatch(/var\(--v2-/)
      outside = outside.slice(0, from) + outside.slice(to)
    }
    expect(outside.match(/var\(--v2-/g) ?? []).toHaveLength(0)
    const inside = css.slice(lightBlockStart, blockEnd)
    // Inside: the ring, selection and the selected-row fill (light and dark) derive from the
    // accent, the shared focus-ring rule reads the ring, the chassis scrim alias `--zen-scrim`
    // reads the v2 scrim (§9.28), the row padding `--v2-row-pad` derives from the row and the
    // body line (§9.34, two reads), the rows derive from the line boxes so they grow with the
    // system font size (§9.2, A11Y-05: `--v2-row`, `--v2-row-two-line` and `--v2-menu-row` in
    // the base block and again in the phone block, four reads each), and the two §9.29 family
    // blocks map the tokens onto the control roles.
    const familyReads = FAMILIES.map((f) => block(f).match(/var\(--v2-/g)?.length ?? 0)
    expect((inside.match(/var\(--v2-/g) ?? []).length).toBe(
      8 + 8 + familyReads.reduce((a, b) => a + b, 0)
    )
    expect(inside).toMatch(/--v2-row-pad: calc\(\(var\(--v2-row\) - var\(--v2-line-body\)\) \/ 2\)/)
    // The line boxes are the text zoom's only readers among the tokens: text grows inside a
    // growing line; controls, glyphs and distances stay in px literals.
    expect(inside).toMatch(/--v2-line-body: calc\(20px \* var\(--zen-text-zoom\)\)/)
    expect(inside).toMatch(/--v2-row: calc\(var\(--v2-line-body\) \+ 12px\)/)
    expect(inside).toMatch(/--v2-row: calc\(var\(--v2-line-body\) \+ 24px\)/)
    expect(inside).toMatch(/--v2-control: 40px/)
    expect(inside).toMatch(/--v2-icon-button: 44px/)
    expect(inside).not.toMatch(/--v2-(control|icon-button|icon|checkbox):[^;]*--zen-text-zoom/)
    expect(inside).toMatch(/--zen-scrim: var\(--v2-scrim\)/)
    expect(inside).toMatch(/\[class\^='zen-v2-'\]:focus-visible/)
  })

  it('gives the downloads surfaces no colour of their own', () => {
    const from = css.indexOf('.zen-dl-surface {')
    const to = css.indexOf('@keyframes zen-dl-pop-out {', from)
    expect(from).toBeGreaterThanOrEqual(0)
    expect(to).toBeGreaterThan(from)
    // Every tone comes from the block (or Zen's accent and status inks); no literal colours.
    expect(css.slice(from, to)).not.toMatch(/#[0-9a-f]{3,8}\b/i)
  })

  it('is read outside main.css only by the files deliberately moved to v2', () => {
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((f) => f.split('\\').join('/'))
      .filter((f) => /\.(css|tsx?)$/.test(f) && !f.includes('__tests__'))
      .filter((f) => f !== 'assets/main.css')
    for (const file of V2_FILES) expect(files, `v2 file "${file}"`).toContain(file)
    for (const file of files) {
      const reads = readFileSync(join(root, file), 'utf8').match(/var\(--v2-/g) ?? []
      if (V2_FILES.includes(file))
        expect(reads.length, `${file} reads v2 tokens`).toBeGreaterThan(0)
      else expect(reads, `${file} reads v2 tokens but is not listed in V2_FILES`).toHaveLength(0)
    }
  })
})

describe('token families (§9.29)', () => {
  const pageFamily = block(FAMILIES[0])
  const windowFamily = block(FAMILIES[1])
  const reads = (body: string): string[] => body.match(/var\(--[a-z0-9-]+\)/g) ?? []

  it('resolve the same control roles for a page surface and a window surface, inside the token block', () => {
    for (const family of FAMILIES) {
      expect(declared(family)).toEqual(new Set(CONTROL_ROLES))
      const at = css.indexOf(`${family} {`)
      expect(at).toBeGreaterThan(lightBlockStart)
      expect(at).toBeLessThan(css.indexOf("/* Zen clamps its primary colour's lightness"))
    }
  })

  it('never mixes them: page roles read the page tokens only, window roles the theme foreground and window fills only', () => {
    expect(reads(pageFamily)).toEqual([
      'var(--v2-text)',
      'var(--v2-text-deemphasized)',
      'var(--v2-fill)',
      'var(--v2-fill-hover)',
      'var(--v2-accent)'
    ])
    expect(pageFamily).not.toMatch(/--zen-|--v2-window-/)
    // Window ink is the theme's foreground, deemphasised at 69% of it.
    expect(reads(windowFamily)).toEqual([
      'var(--zen-fg)',
      'var(--zen-fg-rgb)',
      'var(--v2-window-fill)',
      'var(--v2-window-fill-hover)',
      'var(--zen-accent)'
    ])
    expect(windowFamily).toMatch(
      /--v2-control-text-deemphasized: rgb\(var\(--zen-fg-rgb\) \/ 0\.69\)/
    )
  })
})

/**
 * The desktop platform's surfaces (MW-16 media hub, MW-19 screen picker, MW-21 share popover,
 * MW-22 install dialog, MW-23 app title bar): their blocks in main.css, by the start marker of
 * their `V2_SURFACES` entry, and the renderer files they are drawn from.
 */
const DESKTOP_PLATFORM_BLOCKS = [
  '.zen-install-dialog-body {',
  '.zen-share-body {',
  '.zen-scpick-panes {',
  '.zen-mhub-body {',
  '.zen-app-titlebar {'
]
const DESKTOP_PLATFORM_FILES = [
  'components/install/InstallDialog.tsx',
  'components/share/SharePopover.tsx',
  'components/screenCapture/ScreenPicker.tsx',
  'components/media/MediaHubButton.tsx',
  'components/media/MediaHubPopover.tsx',
  'components/app/AppTitleBar.tsx',
  'lib/qr.ts',
  'lib/share.ts',
  'lib/screenPicker.ts',
  'lib/mediaHub.ts',
  'lib/media.ts',
  'hooks/useMediaSeek.ts'
]

/**
 * Content drawn inside chrome – favicons, thumbnails, artwork, a QR symbol – keeps its own
 * colours and is exempt from the token rule by name (§9.29). Every literal colour one of the
 * files above states, in order, with its reason. A literal not named here fails the guard; a
 * name whose literal is gone fails it too, so the list cannot outlive the code.
 */
const CONTENT_COLOURS: ReadonlyArray<
  readonly [file: string, literals: readonly string[], reason: string]
> = [
  [
    'components/share/SharePopover.tsx',
    ['#fff', '#000'],
    "the share popover's QR symbol: black modules on a white tile in both themes, because a scanner reads it and a theme does not (§9.29, the design lead's ruling on #245)"
  ]
]

describe('content pixels inside chrome (§9.29)', () => {
  const LITERAL = /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(|\bcolor-mix\(/gi
  /** A file's source without its block and line comments, so prose states no colour. */
  const code = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

  it('are the only literal colours the desktop platform’s surfaces state, each exempt by name', () => {
    // The rules read tokens only.
    for (const start of DESKTOP_PLATFORM_BLOCKS) {
      const surface = V2_SURFACES.find(([s]) => s === start)
      expect(surface, `v2 surface "${start}"`).toBeDefined()
      const from = css.indexOf(start)
      const to = css.indexOf(surface![1], from)
      expect(from, start).toBeGreaterThanOrEqual(0)
      expect(to, start).toBeGreaterThan(from)
      expect(code(css.slice(from, to)).match(LITERAL) ?? [], `${start} states a colour`).toEqual([])
    }
    // The components and their helpers: what each states is what is named for it, nothing else.
    const root = fileURLToPath(new URL('../../', import.meta.url))
    for (const [file] of CONTENT_COLOURS)
      expect(DESKTOP_PLATFORM_FILES, `${file} is not a desktop platform file`).toContain(file)
    for (const file of DESKTOP_PLATFORM_FILES) {
      const found = code(readFileSync(join(root, file), 'utf8')).match(LITERAL) ?? []
      const named = CONTENT_COLOURS.find(([f]) => f === file)?.[1] ?? []
      expect(found, `${file}: literal colours not exempt by name`).toEqual([...named])
    }
  })

  it('draw the QR symbol black on its white tile in both themes, the colours the symbol’s own', () => {
    const share = readFileSync(
      fileURLToPath(new URL('../../components/share/SharePopover.tsx', import.meta.url)),
      'utf8'
    )
    // The tile's white under the whole symbol and the modules' black, stated once each on no
    // theme condition: the SVG is content and does not read `data-theme`.
    expect(share).toMatch(/<rect width=\{QR_INNER\} height=\{QR_INNER\} fill="#fff" \/>/)
    expect(share).toMatch(/<path d=\{qr\.path\} fill="#000" \/>/)
    expect(share).not.toMatch(/data-theme|prefers-color-scheme|--v2-page|--v2-text\b/)
  })
})

/**
 * The stylesheet without its comments, so braces in prose do not count, and the number of
 * `{` blocks still open at `index` in it: 0 means the rule sits outside every `@layer`.
 */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
function nesting(index: number): number {
  const before = bare.slice(0, index)
  return (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length
}
function ruleAt(selector: string): number {
  const at = bare.indexOf(`\n${selector} {`)
  expect(at, `rule "${selector}"`).toBeGreaterThanOrEqual(0)
  return at + 1
}

describe('the v2 button', () => {
  it('is one rule, secondary by default with a data-primary variant', () => {
    expect(bare.match(/\.zen-v2-button \{/g) ?? []).toHaveLength(1)
    const base = ruleAt('.zen-v2-button')
    const primary = ruleAt('.zen-v2-button[data-primary]')
    expect(bare.slice(base, bare.indexOf('\n}', base))).toMatch(/background: var\(--v2-fill\)/)
    const primaryBody = bare.slice(primary, bare.indexOf('\n}', primary))
    expect(primaryBody).toMatch(/background: var\(--v2-accent\)/)
    expect(primaryBody).toMatch(/color: var\(--v2-on-accent\)/)
    // Same layer, so the variant's higher specificity is what makes it win – it must not rely on
    // coming later, but it does come later, as a variant reads.
    expect(primary).toBeGreaterThan(base)
  })

  it('sits outside the cascade layers, where it beats a Button’s utilities and no layered copy can beat it', () => {
    // Unlayered declarations win over every `@layer` (utilities included) whatever their order
    // or specificity: the rule must be unlayered to style a `Button` that carries the class, and
    // a second, layered copy of the class would lose all of its declarations to this one.
    for (const selector of [
      '.zen-v2-button',
      '.zen-v2-button:active:not(:disabled)',
      '.zen-v2-button:disabled',
      '.zen-v2-button[data-primary]',
      '.zen-v2-button[data-primary]:active:not(:disabled)'
    ])
      expect(nesting(ruleAt(selector)), `"${selector}" is inside a block`).toBe(0)
    // And no `@layer` block anywhere restates the class.
    for (const match of bare.matchAll(/\.zen-v2-button[^{]*\{/g))
      expect(nesting(match.index), `"${match[0].trim()}" is layered`).toBe(0)
  })
})

/**
 * Whether the rule at `index` of `source` (main.css without its comments unless another
 * stylesheet is given) sits inside an `@layer` block: the headers of the blocks still open
 * there, innermost last (a `@media` block is not a layer).
 */
function layered(index: number, source = bare): boolean {
  const stack: string[] = []
  let headerStart = 0
  const before = source.slice(0, index)
  for (const match of before.matchAll(/[{};]/g)) {
    if (match[0] === '{') stack.push(before.slice(headerStart, match.index).trim())
    else if (match[0] === '}') stack.pop()
    headerStart = match.index + 1
  }
  return stack.some((header) => header.startsWith('@layer'))
}

describe('the v2 primitives (§9.34)', () => {
  const PRIMITIVES = [
    '.zen-v2-row',
    '.zen-v2-field',
    '.zen-v2-icon-button',
    '.zen-v2-card-radio',
    '.zen-v2-switch',
    '.zen-v2-radio',
    // The checkbox (#93): the extensions UI's layered copy went with it.
    '.zen-v2-checkbox',
    // The menulist (#106) with its popover's popup and option: the extensions UI's layered
    // copies and the translate stylesheet's own went with it.
    '.zen-v2-menulist',
    '.zen-v2-menulist-popup',
    '.zen-v2-menulist-option',
    // The segment (#203, the overview's Tabs | Private): its tabs and their underline are rules
    // on the one class (`> [role='tab']`, `::after`), so the primitive is the whole control.
    '.zen-v2-segment',
    // The group heading (§9.27, §10.3) with its 20 / 4 beat: the customise sheet's layered copy
    // and the Settings tab's and phone panels' local beats went with it; what each surface adds
    // (the first heading's 8 under a header, a popover's tighter 12) is an unlayered modifier.
    '.zen-v2-heading'
  ]

  it('are one unlayered rule each, tokens only, with no layered or second copy', () => {
    for (const cls of PRIMITIVES) {
      // One base rule, and it is the shared one: unscoped, so every program's control takes it.
      expect(bare.match(new RegExp(`\\n\\${cls} \\{`, 'g')) ?? [], cls).toHaveLength(1)
      const rules = [...bare.matchAll(new RegExp(`[^\\n]*\\${cls}(?![\\w-])[^{]*\\{`, 'g'))]
      expect(rules.length, cls).toBeGreaterThan(0)
      for (const rule of rules) {
        const selector = rule[0].trim()
        expect(layered(rule.index), `"${selector}" is layered`).toBe(false)
        // Tokens only: no literal colour in a primitive's declarations.
        const body = bare.slice(rule.index + rule[0].length, bare.indexOf('}', rule.index))
        expect(body, `"${selector}" states a colour`).not.toMatch(/#[0-9a-f]{3,8}\b/i)
      }
    }
  })

  it('state the group heading’s beat once: 20 above, 4 below, the text at the 16 gutter (§9.27, §10.3)', () => {
    // The base rule (`ruleAt` finds the unscoped one; `block` would stop at the customise
    // sheet's `.zen-v2-section:first-child > .zen-v2-heading` modifier before it).
    const base = ruleAt('.zen-v2-heading')
    const heading = bare.slice(base, bare.indexOf('\n}', base))
    expect(heading).toMatch(/^ {2}margin: 20px 0 4px;$/m)
    expect(heading).toMatch(/^ {2}padding: 0 16px;$/m)
    expect(heading).toMatch(/font-size: var\(--v2-font-body\)/)
    expect(heading).toMatch(/font-weight: var\(--v2-weight-heading\)/)
    // No consumer keeps a copy of the beat: the Settings tab's groups, the customise sheet's
    // sections and the phone panels' day groups read the primitive, and what each adds (the
    // first heading's 8 under a header, a popover's tighter 12) is an unlayered modifier.
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const sheets = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((f) => f.split('\\').join('/'))
      .filter((f) => f.endsWith('.css'))
    for (const file of sheets) {
      const text = readFileSync(join(root, file), 'utf8')
      const copies = [...text.matchAll(/margin: 20px 0 4px;/g)]
      expect(copies.length, `${file} restates the heading beat`).toBe(
        file === 'assets/main.css' ? 1 : 0
      )
    }
    expect(readFileSync(join(root, 'components/phone/phonePanels.css'), 'utf8')).not.toMatch(
      /padding: 20px 16px 4px/
    )
    for (const modifier of [
      '.zen-v2-section:first-child > .zen-v2-heading',
      '.zen-v2-heading.zen-tab-search-heading',
      '.zen-v2-heading.zen-settings-heading'
    ])
      expect(layered(ruleAt(modifier)), `"${modifier}" is layered`).toBe(false)
    const panels = readFileSync(join(root, 'components/phone/phonePanels.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      ''
    )
    const list = panels.indexOf(
      '.zen-phone-list > :first-child > .zen-v2-heading.zen-list-heading {'
    )
    expect(list).toBeGreaterThanOrEqual(0)
    expect(layered(list, panels)).toBe(false)
  })

  it('pad the row with the --v2-row-pad token, not a local knob', () => {
    expect(block('.zen-v2-row')).toMatch(/padding: var\(--v2-row-pad\) 16px/)
    expect(css).not.toMatch(/--zen-settings-pad/)
  })

  it('grow a one-line row around its control by 4 above and below (§9.21): one unlayered mark on the row rule', () => {
    // pr-228 nit 2: `--v2-row-pad` around a 32 / 40 control measured 44 / 64. The control row is
    // the row primitive with `data-control` – padding 4, the base `min-height` still the row's –
    // so a 32 control makes 40 and a 40 one 48, a 28 / 44 icon button 36 / 52, and a text-only
    // row stays 32 / 44. It states the padding and nothing else: the geometry is the row rule's.
    expect(block('.zen-v2-row[data-control]').match(/^ {2}[a-z-]+:[^;]+;/gm)).toEqual([
      '  padding-block: 4px;'
    ])
    expect(ruleAt('.zen-v2-row[data-control]')).toBeGreaterThan(ruleAt('.zen-v2-row'))
    expect(nesting(ruleAt('.zen-v2-row[data-control]'))).toBe(0)
    // `ListRow` leaves the numbers to it: no utility height or padding on the row.
    const primitives = readFileSync(
      fileURLToPath(new URL('../../components/siteControls/primitives.tsx', import.meta.url)),
      'utf8'
    )
    const from = primitives.indexOf('export function ListRow(')
    expect(from).toBeGreaterThanOrEqual(0)
    const listRow = primitives.slice(from, primitives.indexOf('\n}\n', from))
    expect(listRow).not.toMatch(/min-h-\[|py-\[|py-\d/)
    expect(listRow).toMatch(/data-control=\{controlRow\}/)
  })

  it('has the translate, autofill and passwords control rows read the mark, their parallel §9.21 rules gone (#247 follow-up)', () => {
    // Each owner's stylesheet restated control + 8 (a padding of 4 / 4 and a `min-height` of the
    // control plus 8) on its own row class; the primitive supersedes them at 0 px, so the rows
    // carry `data-control` and the local rules go. What stays in passwords.css is the one case
    // the primitive does not cover – a 44 icon button in a phone two-line row – scoped away
    // from marked rows.
    const read = (path: string): string =>
      readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), 'utf8')
    const rules = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '')
    const translate = rules(read('assets/translate.css'))
    expect(translate).not.toMatch(/zen-translate-control-row/)
    expect(translate).not.toMatch(/padding-(top|bottom|block): 4px/)
    const autofill = rules(read('assets/autofill.css'))
    expect(autofill).not.toMatch(
      /\.zen-v2-af-pane-row:has\(> \.zen-v2-(af-pane-actions|menulist)\)/
    )
    expect(autofill).not.toMatch(/padding-block: 4px/)
    expect(autofill).not.toMatch(/min-height: max\(var\(--v2-row\)/)
    const passwords = rules(read('assets/passwords.css'))
    expect(passwords).not.toMatch(/min-height: max\(var\(--v2-row\)/)
    const remainders = passwords.match(/margin-block: calc\(4px - var\(--v2-row-pad\)\)/g) ?? []
    expect(remainders).toHaveLength(1)
    expect(passwords).toMatch(
      /\.zen-v2-pw-row:not\(\[data-control\], \[data-stack\]\) > \.zen-v2-pw-row-control > \.zen-v2-icon-button,\n\.zen-v2-pw-list-row:not\(\[data-control\]\) > \.zen-v2-icon-button \{\n {2}margin-block: calc\(4px - var\(--v2-row-pad\)\);\n\}/
    )
    // The rows write the mark: the translate rows on the surface (they have no wrapper), the
    // autofill and passwords wrappers only for a one-line row (a two-line row takes no mark).
    for (const file of [
      'components/translate/LanguagesSection.tsx',
      'components/translate/SelectionPopover.tsx'
    ]) {
      const text = read(file)
      expect(text, file).not.toMatch(/zen-translate-control-row/)
      expect(text, file).toMatch(/data-control=(""|\{controls \? '' : undefined\})/)
    }
    const autofillRows = read('components/overlays/AutofillSection.tsx')
    expect(autofillRows.match(/data-control=\{description \? undefined : ''\}/g)).toHaveLength(2)
    const shared = read('components/overlays/passwords/shared.tsx')
    expect(shared).toMatch(/data-control=\{control && !description && !stack \? '' : undefined\}/)
    expect(shared).toMatch(/const mark = control \? '' : undefined/)
    expect(read('components/overlays/passwords/LoginList.tsx')).toMatch(
      /<ListRow key=\{domain\} control>/
    )
  })

  it('draw the radio’s checked dot at §9.14’s 6 px: the inset ring is (box − 2 − 6) / 2 inside the 1 px border', () => {
    // (box − 6) / 2 measured a 4 px dot (the #235 ruling): the inset shadow starts inside the
    // border, so the border's 2 comes off the box before the dot does.
    const checked = block(
      ".zen-v2-radio[aria-checked='true'],\n[aria-checked='true'] > .zen-v2-radio"
    )
    expect(checked).toMatch(
      /box-shadow: inset 0 0 0 calc\(\(var\(--v2-checkbox\) - 2px - 6px\) \/ 2\) var\(--v2-accent\)/
    )
    expect(css.match(/calc\(\(var\(--v2-checkbox\) - 6px\) \/ 2\)(?! - 1px)/g) ?? []).toHaveLength(
      0
    )
  })

  it('let a field’s invalid state win over its focus ring (§9.12): the ring in the danger ink, on the shared field and the phone field alike', () => {
    // Dark's inset ring (−2, §1) lay over the 1 px danger border and hid it: focused and invalid,
    // the ring is `--v2-danger` – its 2 px, offset and shape the shared ring's – so the field
    // reads invalid either way, in light and in dark. The invalid rule re-inks the ring through
    // its token, the chrome's seam for re-inking a shared rule, and every form of the ring reads
    // that token (the shared ring, its coarse-pointer form, the base layer's), so no rule of the
    // field's needs the ring forms' weight – no `:root` bump, no `outline-color` restatement.
    expect(block(".zen-v2-field[aria-invalid='true']").match(/^ {2}[a-z0-9-]+:[^;]+;/gm)).toEqual([
      '  --v2-ring: var(--v2-danger);',
      '  border-color: var(--v2-danger);'
    ])
    expect(nesting(ruleAt(".zen-v2-field[aria-invalid='true']"))).toBe(0)
    expect(css).not.toMatch(/:root \.zen-v2-field/)
    expect(css).not.toMatch(/\.zen-v2-field\[aria-invalid='true'\]:focus-visible/)
    // The token is the one the ring forms draw with, declared once for the chrome and once here.
    expect(css.match(/--v2-ring:/g)).toHaveLength(2)
    expect(
      block(
        "[class^='zen-v2-']:focus-visible,\n[class*=' zen-v2-']:focus-visible,\n:root[data-pointer='coarse'] [class^='zen-v2-']:focus-visible,\n:root[data-pointer='coarse'] [class*=' zen-v2-']:focus-visible"
      )
    ).toMatch(/outline: 2px solid var\(--v2-ring\)/)
    expect(block(':focus-visible', css.indexOf('@layer base {'))).toMatch(
      /outline: 2px solid var\(--v2-ring\)/
    )
    // The phone field (phonePanels.css) reads the same two states off the input it wraps, where
    // the ARIA state sits, in the same tokens – its ring re-inked by `outline-color`, since the
    // wrapper's clear button would inherit the token.
    const panels = readFileSync(
      fileURLToPath(new URL('../../components/phone/phonePanels.css', import.meta.url)),
      'utf8'
    )
    const rule = (selector: string): string => {
      const at = panels.indexOf(`${selector} {`)
      expect(at, selector).toBeGreaterThanOrEqual(0)
      return panels.slice(at, panels.indexOf('}', at))
    }
    expect(rule(".zen-phone-field:has(> input[aria-invalid='true'])")).toMatch(
      /border-color: var\(--v2-danger\)/
    )
    expect(rule(".zen-phone-field:has(> input[aria-invalid='true']):focus-within")).toMatch(
      /outline-color: var\(--v2-danger\)/
    )
    expect(rule('.zen-phone-field:focus-within')).toMatch(/outline: 2px solid var\(--v2-ring\)/)
  })

  it('gate the row’s hover fill, press fill and pointer cursor on [data-static], as part of the one row rule', () => {
    // The static row (§9.34) is the row primitive with `data-static`: the attribute is read in
    // exactly three places, all in the row's own rule set – the static rule, and the `:not()` of
    // the press gate and of the hover gate inside the row's `(hover: hover)` media block – so no
    // surface has to fight the fill with a rule of its own, and nothing elsewhere gates on it.
    // (The test above already holds each of them unlayered and free of literal colour.)
    expect([...bare.matchAll(/[^\n]*\[data-static\][^{]*\{/g)].map((m) => m[0].trim())).toEqual([
      '.zen-v2-row[data-static] {',
      ".zen-v2-row:active:not([aria-disabled='true'], [data-static]) {",
      ".zen-v2-row:hover:not([aria-disabled='true'], [data-static]) {"
    ])
    const hoverGate = bare.indexOf(".zen-v2-row:hover:not([aria-disabled='true'], [data-static])")
    const hoverMedia = bare.lastIndexOf('@media (hover: hover) {', hoverGate)
    expect(hoverMedia).toBeGreaterThan(bare.indexOf('.zen-v2-row[data-static] {'))
    expect(bare.slice(hoverMedia, hoverGate)).not.toMatch(/\}/)
    // The static rule turns off the pointer cursor and states nothing else: the row's geometry
    // (height, padding, gap, text and glyph placement) is the row rule's, not a second copy.
    expect(block('.zen-v2-row[data-static]').match(/^ {2}[a-z-]+:[^;]+;/gm)).toEqual([
      '  cursor: default;'
    ])
    // No second static row: no other stylesheet of the renderer reads the attribute.
    const root = fileURLToPath(new URL('../../', import.meta.url))
    for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((f) => f.split('\\').join('/'))
      .filter((f) => f.endsWith('.css') && f !== 'assets/main.css'))
      expect(readFileSync(join(root, file), 'utf8'), `${file} gates on data-static`).not.toMatch(
        /data-static/
      )
  })

  it('are what the phone history and bookmarks rows are built on: one unlayered, token-only modifier beside the row, no row or icon-button box of their own', () => {
    // The panels' own row (`.zen-list-row`, #47) is gone from the renderer: nothing names it.
    const root = fileURLToPath(new URL('../../', import.meta.url))
    for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((f) => f.split('\\').join('/'))
      .filter((f) => /\.(css|tsx?)$/.test(f) && !f.includes('__tests__')))
      expect(readFileSync(join(root, file), 'utf8'), `${file} names .zen-list-row`).not.toMatch(
        /zen-list-row/
      )
    const panels = readFileSync(join(root, 'components/phone/phonePanels.css'), 'utf8').replace(
      /\/\*[\s\S]*?\*\//g,
      ''
    )
    // Every mention of the row primitive there is the `.zen-phone-row` modifier on it – never a
    // bare copy – and each of its rules is unlayered (a layered exception would lose to the
    // unlayered primitive whatever its specificity) and draws tokens only.
    const rules = [...panels.matchAll(/[^\n]*\.zen-v2-row(?![\w-])[^{]*\{/g)]
    expect(rules.length).toBeGreaterThan(0)
    for (const rule of rules) {
      const selector = rule[0].trim()
      expect(selector, `"${selector}" is not the modifier`).toMatch(/\.zen-v2-row\.zen-phone-row/)
      expect(layered(rule.index, panels), `"${selector}" is layered`).toBe(false)
      const body = panels.slice(rule.index + rule[0].length, panels.indexOf('}', rule.index))
      expect(body, `"${selector}" states a colour`).not.toMatch(
        /#[0-9a-f]{3,8}\b|color-mix\(|rgba?\(/i
      )
    }
    // The picked row's fill is the `--v2-selected` token (§9.6): never `--v2-selection` (text
    // selection) and never a local expression standing in for it.
    const selected = panels.indexOf(".zen-v2-row.zen-phone-row[data-selected='true']")
    expect(selected).toBeGreaterThanOrEqual(0)
    expect(panels.slice(selected, panels.indexOf('}', selected))).toMatch(
      /background: var\(--v2-selected\)/
    )
    expect(panels).not.toMatch(/--v2-selection\b/)
    // The rows' base height, padding and press fill and the icon buttons' box are the
    // primitives' (`.zen-v2-row`, `.zen-v2-icon-button`): the stylesheet restates none of them.
    // The one read of the row's padding is `.zen-list-main`'s fold: the row's accessible button
    // pulls the row's padding out by its margins and gives it back as its own, so the box
    // TalkBack frames is the row's 44 (A11Y-01) – no row geometry of its own, and nothing moves.
    const fold = panels.indexOf('.zen-list-main {')
    expect(fold).toBeGreaterThanOrEqual(0)
    const foldRule = panels.slice(fold, panels.indexOf('}', fold))
    expect(foldRule).toMatch(
      /align-self: stretch;\s*margin: calc\(-1 \* var\(--v2-row-pad\)\) 0;\s*padding: var\(--v2-row-pad\) 0;/
    )
    const rest = panels.replace(foldRule, '')
    expect(rest).not.toMatch(/min-height: var\(--v2-row\)/)
    expect(rest).not.toMatch(/padding: var\(--v2-row-pad\)|padding: 12px 16px/)
    expect(rest).not.toMatch(/zen-toolbar-button|width: var\(--v2-icon-button\)/)
  })
})

describe('the Settings drill-in pane (§10.2)', () => {
  it('enters by a keyframe animation that does not fill, so the back gesture’s inline transform moves it', () => {
    // BackDismissal writes `transform` inline as the finger moves and as the commit slides the
    // pane out; a `forwards` or `both` fill on the entrance would sit over that for the pane's
    // whole life (the recorded emulator run: the finger moved nothing).
    for (const side of ['right', 'left']) {
      const rule = block(`.zen-settings-drill-in[data-from='${side}']`)
      expect(rule).toMatch(new RegExp(`animation:\\s*zen-settings-enter-${side}\\b`))
      expect(rule).not.toMatch(/\b(forwards|both)\b/)
      expect(rule).not.toMatch(/animation-fill-mode/)
    }
  })
})

describe('the fullscreen hint palette', () => {
  /** The value a token is declared with in the first `selector {` block after `from`. */
  const value = (selector: string, from: number, name: string): string => {
    const match = block(selector, from).match(new RegExp(`${name}:\\s*([^;]+);`))
    expect(match, `${name} in ${selector}`).not.toBeNull()
    return match?.[1].trim() ?? ''
  }

  it('is the v2 panel, border, text and fill by value, one family per scheme (the page script cannot read main.css)', () => {
    const schemes = [
      [HINT_PALETTE.light, ':root', lightBlockStart],
      [HINT_PALETTE.dark, ":root[data-theme='dark']", lightStart]
    ] as const
    for (const [palette, selector, from] of schemes) {
      expect(palette.panel).toBe(value(selector, from, '--v2-panel'))
      expect(palette.border).toBe(value(selector, from, '--v2-border'))
      expect(palette.text).toBe(value(selector, from, '--v2-text'))
      expect(palette.fill).toBe(value(selector, from, '--v2-fill'))
    }
  })

  it("is the toast card's geometry by value: the numbers the page-drawn twin carries are the stylesheet's (§9.33's single exception)", () => {
    // The tokens the card reads, by value.
    expect(`${TOAST_CARD.radiusPx}px`).toBe(value(':root', lightBlockStart, '--v2-radius-card'))
    expect(TOAST_CARD.shadow).toBe(value(':root', lightBlockStart, '--v2-shadow-panel'))
    expect(`${TOAST_CARD.fontPx}px`).toBe(value(':root', lightBlockStart, '--v2-font-body'))
    expect(`${TOAST_CARD.linePx}px`).toBe(value(':root', lightBlockStart, '--v2-line-body'))
    expect(`${TOAST_CARD.weight}`).toBe(value(':root', lightBlockStart, '--v2-weight-body'))
    expect(`${TOAST_CARD.rowPx}px`).toBe(
      value(":root[data-form-factor='phone']", lightStart, '--v2-row')
    )
    const insetBlock = css.lastIndexOf(':root {', css.indexOf('--zen-message-inset:'))
    expect(`${TOAST_CARD.insetPx}px`).toBe(value(':root', insetBlock, '--zen-message-inset'))
    // The card reads those tokens – so the twin's copies are the card's – and states the rest
    // of its geometry once, where the twin's numbers come from.
    const card = block('.zen-message')
    expect(card).toMatch(/^ {4}min-height: var\(--v2-row\);$/m)
    expect(card).toMatch(/^ {4}border-radius: var\(--v2-radius-card\);$/m)
    expect(card).toMatch(/^ {4}box-shadow: var\(--v2-shadow-panel\);$/m)
    expect(card).toMatch(/^ {4}font-size: var\(--v2-font-body\);$/m)
    expect(card).toMatch(/^ {4}line-height: var\(--v2-line-body\);$/m)
    expect(card).toMatch(/^ {4}font-weight: var\(--v2-weight-body\);$/m)
    expect(card).toMatch(new RegExp(`^ {4}gap: ${TOAST_CARD.gapPx}px;$`, 'm'))
    expect(card).toMatch(
      new RegExp(
        `^ {4}padding: ${TOAST_CARD.padPx}px \\d+px ${TOAST_CARD.padPx}px ${TOAST_CARD.gutterPx}px;$`,
        'm'
      )
    )
    // A toast without an action closes its control side to the same gutter.
    expect(block('.zen-message-toast:not([data-action])')).toMatch(
      new RegExp(`^ {4}padding-right: ${TOAST_CARD.gutterPx}px;$`, 'm')
    )
    // The chrome's own constants are the same numbers, not copies.
    expect(TOAST_DURATION).toBe(TOAST_SHOW_MS)
    expect(MESSAGE_INSET).toBe(TOAST_CARD.insetPx)
    expect(FULLSCREEN_RETURN_MS).toBe(REDUCED_FADE_MS)
  })
})

describe('live counts (§4)', () => {
  it('are tabular wherever the request engine writes one, through the slot the count sits in', () => {
    // "1,284 requests", "116,161 filters", "Updated 2 h ago": a count that changes under the
    // user must not reflow its row. On a phone the counts sit in the Settings tab's value slot
    // and group description; on desktop in the pane's card title, detail line and row
    // descriptions; in the URL bar the chip's badge inherits it from the chip.
    for (const selector of [
      '.zen-settings-description',
      '.zen-settings-group-description',
      '.zen-privacy-card-title',
      '.zen-privacy-muted',
      '.zen-privacy-row-desc',
      '.zen-v2-blocked-chip'
    ])
      expect(block(selector), selector).toMatch(/^ {2}font-variant-numeric: tabular-nums;$/m)
  })
})
