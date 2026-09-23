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
  // The pull-to-refresh disc (components/content/PullIndicator.tsx) and the history navigation
  // bubble after it (components/content/HistoryNavBubble.tsx, GN-04).
  ['.zen-ptr-disc {', '.zen-space-strip {'],
  // The phone's resting pill (components/phone/PhoneShell.tsx, pillChips.tsx; §9.29, the shell
  // pass): its fill and pressed fill on the window family's control roles, its quiet chips (the
  // lock, a paused state) in the deemphasised window ink.
  ['.zen-phone-pill-docked {', '.zen-pill-well {'],
  // The tablet layout (components/tablet/*, TABLET-01 / 02 / 06): the toolbar row's icon buttons
  // and pill, the sidebar's rows and close buttons and the drawer at §9.3's tablet sizes, read
  // from the scale tokens the tablet root sets. Unlayered, right before the phone bar's layer.
  [
    ' * The tablet layout (TABLET-01 / 02 / 06',
    "@layer components {\n  /*\n   * The phone bar's controls"
  ],
  // The v2 badge (§9.19): site information's Private badge (components/siteinfo/SiteInfoSheet.tsx).
  ['.zen-v2-badge {', '/* Safe-area insets pushed by mobile hosts'],
  // The confirmation prompt (components/dialogs/ConfirmDialog.tsx; §9.23, §9.22): the notice's
  // body and footer on the card padding, unlayered beside the button so its check row can reach
  // past the gutter of the unlayered row primitive. Inside the button's span, so it is cut first.
  ['.zen-confirm-dialog {', "/*\n * The first run's own controls keep the ring"],
  // The v2 button, shared by every v2 surface (the Settings tab's row buttons and dialogs,
  // components/pages/settings/*; the first run, overlays/PhoneOnboarding.tsx; the
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
  // The chrome document's body (A11Y-05, lib/textScale.ts): its weight reads the body weight
  // token (400 at rest), so the bold-text setting's adjustment reaches every inherited weight.
  ['  body {\n    font-family: var(--font-sans);', '  input,\n  textarea,'],
  // The bold-text setting's utility overrides (A11Y-05): the weights set by class move up with
  // the weight tokens while the setting is on; unlayered, between the focus ring and the first
  // components layer, so it is cut out before the ring's span.
  ['/*\n * The bold-text setting (A11Y-05', '@layer components {'],
  // The overlay scrollbar's thumb (§9.20): the base-layer floor under every scroller of a mouse's
  // chrome, reading the control role's ink (§9.29) at rest and the deemphasised ink under the
  // pointer; it ends where the focus ring's comment begins.
  ["  :root[data-pointer='fine'] ::-webkit-scrollbar-thumb {", "/*\n * The chrome's focus ring"],
  // The chrome's focus ring (§1, a11y-10): the base-layer floor under every control of the chrome
  // document, reading the ring token, and the one text-selection rule after it (§9.6, reading
  // `--v2-selection`); it ends where the first components layer begins.
  [" * The chrome's focus ring (v2 §1, a11y-10)", '@layer components {'],
  // A web app's standalone window's title bar (components/app/AppTitleBar.tsx, MW-23): a window
  // surface (§9.29) in the chassis' first components layer – the theme's ink, the title's weight
  // and line from the scale. It ends where the tab row begins, so it is cut before the row.
  ['.zen-app-titlebar {', '.zen-tab {'],
  // The sidebar's tab row (components/sidebar/TabItem.tsx, SpacePanel.tsx; §5, §9.29, shell pass
  // 7(a)): the hover and active fills in the window family. It ends where the split row begins.
  ['.zen-tab {', '.zen-split-row {'],
  // The split group's row in the sidebar (components/sidebar/SplitGroupRow.tsx, §9.35): the
  // container's hover and selected fills and its segments' 60 % fill in the window family (§9.29).
  ['.zen-split-row {', '.zen-essential {'],
  // An Essentials tile (components/sidebar/Essentials.tsx; §5, §9.29): the window fill at rest,
  // the hover fill on hover and on the active tile. It ends where the drop-into rules begin.
  ['.zen-essential {', '[data-drop-into] {'],
  // The sidebar tab drag – drop-into targets, the audio indicator, ghost, caret and tear-off card
  // (lib/drag.ts, components/DragLayer.tsx, components/sidebar/TabItem.tsx).
  ['[data-drop-into] {', '.zen-panel {'],
  // The tab row's throbber (components/sidebar/Favicon.tsx, tabs-41): its two phases in the
  // control roles' deemphasised ink and accent (§9.29), the v1 inks as fallbacks off a surface.
  ['.zen-tab-throbber {', '.zen-tab-favicon-in {'],
  // The overlay header (§9.7, overlays/OverlayShell.tsx): the title on the type scale, the
  // hairline in the border token once the body scrolls under it.
  ['.zen-overlay-header {', '/* The 1px outline is a spread shadow'],
  // The downloads bubble and toolbar button (components/downloads; the zen://downloads page tab
  // is the list pages' block below). Its block sits between the bookmark chrome's rules and the
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
  ['.zen-privacy + .zen-privacy.zen-protection {', '/*\n * The frame\'s strips – "Make Zenium'],
  // Settings > Privacy and Security (components/overlays/PrivacySection.tsx) and the URL bar's
  // blocked-count chip (components/urlbar/BlockedChip.tsx). Its block sits between the find
  // bar's and the Default Browser range, so it is cut out before the find bar's, which ends there.
  ['.zen-privacy {', '/*\n * The frame\'s strips – "Make Zenium'],
  // Find in page, zoom and fullscreen: the docked find bar (components/content/FindBar.tsx).
  ['.zen-find-bar {', '/*\n * The frame\'s strips – "Make Zenium'],
  // The phone page zoom sheet, docked under the live page, and its own instance of the stepper
  // (components/content/ZoomSheet.tsx, components/ZoomStepper.tsx). The last block before the
  // reduced-motion rules, so it is cut out before the Default Browser range that ends there.
  ['.zen-zoom-sheet {', '\n@media (prefers-reduced-motion: reduce) {'],
  // The frame's strips (content/DefaultBrowserBanner.tsx, content/CrashRestoreBanner.tsx): the
  // window-family band, its hairline and text, and the default-browser prompt's icon.
  ['  .zen-frame-strips[data-under-overlay] {', '\n@media (prefers-reduced-motion: reduce) {'],
  // The message cards: toast and banner, their action button, glyph and close (components/messages/*).
  ['.zen-message {', '.zen-suggestion {'],
  // The tab overview's select-tabs mode (components/phone/TabOverview.tsx, OverviewCard.tsx,
  // TAB-08): the picked card's selected fill (§9.6, no ring) and the action row's band in the
  // window fill with its 13 labels (§9.29). Its block ends where the lock cover's begins.
  ['.zen-overview-card[data-selected]::after {', '/*\n   * The lock cover of "Lock private tabs'],
  // The lock cover of "Lock private tabs when you leave Zenium" (components/phone/
  // PrivateLockCover.tsx, INC-05 / SET-17): the panel-toned base under a locked private tab's
  // blurred picture. Its block ends where the phone sheet chassis begins.
  ['.zen-private-lock {', '/*\n   * The phone sheet chassis'],
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
  ['.zen-page-host {', ' * List pages as chrome page tabs'],
  // The list pages as chrome page tabs – History, the bookmarks manager, Downloads (components/
  // pages/PageFrame.tsx and pages/history, pages/bookmarks, pages/downloads; §10.1): the sticky
  // header with the title block and search field, the text column, the group headings, the
  // two-line rows' slots and reveal, the empty state.
  ['.zen-page {', '/*\n * Find in page, zoom and fullscreen'],
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
  // The toolbar icon button (§9.3, shell pass 7(a)): the 28 box's hover and pressed fills in the
  // window family's `--v2-window-fill-hover` (§9.29), the resting opacity on the glyph.
  [
    '  /*\n   * The toolbar icon button (design language v2 §9.3)',
    " * A web app's standalone window"
  ]
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
  // The page dialogs' message (alert, confirm, prompt): 13 px on the small line (§4, §9.2).
  'components/dialogs/PageDialog.tsx',
  // The extension details page's error line in the danger ink (#68).
  'components/extensions/ExtensionDetails.tsx',
  // The new tab page's shortcut dialog: its validation line in the danger ink (#148).
  'components/newtab/NewTabShortcutDialog.tsx',
  // The external-protocol sheet on the v2 sheet chassis (#140): its deemphasised host line.
  'components/protocol/ExternalProtocolSheet.tsx',
  // The blocked pop-ups popover, sheet and phone bar, and the sign-in and certificate dialogs
  // (#62): the glyph's size and stroke, the title block's glyph offset, the notice's warn ink,
  // the ink of an expired certificate; `glyph.ts` is the row glyph they share.
  'components/security/BlockedPopupsPanel.tsx',
  'components/security/SecurityPromptDialog.tsx',
  'components/security/glyph.ts',
  // The address pill's blocked pop-ups chip and its count (#62) and the sidebar's tab count
  // badge, drawn in their surface's family through the §9.29 control roles; the pill's own fill
  // and its chips' hover fills the same way (shell pass 7(a)), the zoom chip's among them.
  'components/sidebar/SidebarTop.tsx',
  'components/sidebar/SpacePanel.tsx',
  'components/zoom/ZoomChip.tsx',
  // The sidebar's rows on the window family (shell pass 7(a), §5 / §9.29): a row's indicator
  // inks and its rename field's fill (TabItem), the Essentials grid's empty state, the bottom
  // bar's space switcher fills and status line (SidebarBottom); the empty space-glyph dot's
  // ring at §9.3's glyph stroke (SpaceGlyph, the lead's #226 note).
  'components/sidebar/TabItem.tsx',
  'components/sidebar/Essentials.tsx',
  'components/sidebar/SidebarBottom.tsx',
  'components/SpaceGlyph.tsx',
  // Site information (#39): the connection state's ok / warn / danger ink on its glyphs and values.
  'components/siteinfo/SiteInfoSheet.tsx',
  // The connection verdict the pill's chip and the site-information sheet share (ERR-09, §9.19's
  // ink rule): the warn and danger inks of the open lock, the triangle and the shield.
  'lib/securityVerdict.ts',
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
  // The print preview (#225's UI): the option column's headings and validation lines in the
  // deemphasised and danger inks, the preview pane's notice and paging pill in the panel family.
  'components/print/PrintPreviewDialog.tsx',
  'components/print/PreviewPane.tsx',
  // The phone PDF viewer's docked bar and its sheets (#225's UI): the bar's chassis and its
  // notices in the panel family and the deemphasised ink, the outline rows' page numbers and
  // selected fill, the password sheet's error line in the danger ink.
  'components/pdf/PdfViewerBar.tsx',
  'components/pdf/PdfSheets.tsx',
  // Settings > Import's dialog (ID-23's UI): the choice and checkbox rows' heights, the running
  // browser line in the warn / danger ink, the notes and the results in the deemphasised ink;
  // a result's glyph (the dialog's and the pane's Last import row) in the danger ink on failure.
  'components/import/ImportDialog.tsx',
  'components/import/ResultGlyph.tsx',
  // Look and Feel's Layout cards (§9.37, §10.4): each picture is a line drawing in the page
  // ink, its frame in the surface fill and its selected row in the accent, so one drawing
  // reads in both schemes.
  'components/pages/settings/LayoutCards.tsx'
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
const tablet = declared(":root[data-form-factor='tablet']", lightStart)

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
  'window-border',
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
  'ring-offset',
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

  // §9.29: the window's fills are Zen's `--zen-toolbar-element-bg` – 8% of the ink in light, 15%
  // in dark – with the hover one step above each; a dark fill at .1 left a secondary button on a
  // mid-tone band fifteen units from it (#281).
  it("draws the window fills at Zen's alphas: 8 / 14 in light, 15 / 20 in dark", () => {
    const lightBlock = block(':root', lightBlockStart)
    const darkBlock = block(":root[data-theme='dark']", lightStart)
    expect(lightBlock).toContain('--v2-window-fill: rgb(var(--zen-fg-rgb) / 0.08);')
    expect(lightBlock).toContain('--v2-window-fill-hover: rgb(var(--zen-fg-rgb) / 0.14);')
    expect(darkBlock).toContain('--v2-window-fill: rgb(var(--zen-fg-rgb) / 0.15);')
    expect(darkBlock).toContain('--v2-window-fill-hover: rgb(var(--zen-fg-rgb) / 0.2);')
  })

  // §1: the danger ink is ink only, and §9.11 draws the destructive verb as a secondary – the
  // ink on `--v2-fill` over the panel (221 221 222 in light), where `#c43434` measured 3.98:1.
  // The lead's value is `#b02a2a` (4.82 on the fill, 5.95 on the panel; the hue kept); dark stays
  // `#ff8080` (5.05). The triple is the same colour, for tints; `--v2-danger` aliases the ink.
  it('inks danger #b02a2a / 176 42 42 in light and #ff8080 / 255 128 128 in dark, reading on the secondary fill', () => {
    const v1Start = css.lastIndexOf(':root {', css.indexOf('--zen-danger:'))
    const lightBlock = block(':root', v1Start)
    const darkBlock = block(":root[data-theme='dark']", v1Start)
    expect(lightBlock).toContain('--zen-danger: #b02a2a;')
    expect(lightBlock).toContain('--zen-danger-rgb: 176 42 42;')
    expect(darkBlock).toContain('--zen-danger: #ff8080;')
    expect(darkBlock).toContain('--zen-danger-rgb: 255 128 128;')
    expect(block(':root', lightBlockStart)).toContain('--v2-danger: var(--zen-danger);')
    expect(block(":root[data-theme='dark']", lightStart)).not.toMatch(/--v2-danger:/)
    // Measured, not asserted: the ink over the fill it is drawn on – `--v2-fill`'s alpha at the
    // 8 bits Skia paints it, over `--v2-panel` – and over the panel itself, both at least 4.5:1.
    const hex = (v: string): number[] => [0, 2, 4].map((i) => parseInt(v.slice(1 + i, 3 + i), 16))
    const alpha = (v: string): { rgb: number[]; a: number } => {
      const m = /^rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\)$/.exec(v)
      expect(m, v).not.toBeNull()
      return { rgb: [Number(m![1]), Number(m![2]), Number(m![3])], a: Number(m![4]) }
    }
    const luminance = (rgb: number[]): number =>
      [0.2126, 0.7152, 0.0722].reduce((sum, w, i) => {
        const c = rgb[i] / 255
        return sum + w * (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      }, 0)
    const contrast = (a: number[], b: number[]): number => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    }
    const value = (body: string, name: string): string => {
      const m = new RegExp(`${name}: ([^;]+);`).exec(body)
      expect(m, name).not.toBeNull()
      return m![1]
    }
    for (const [ink, v2] of [
      [lightBlock, block(':root', lightBlockStart)],
      [darkBlock, block(":root[data-theme='dark']", lightStart)]
    ]) {
      const danger = hex(value(ink, '--zen-danger'))
      expect(value(ink, '--zen-danger-rgb')).toBe(danger.join(' '))
      const panel = hex(value(v2, '--v2-panel'))
      const fill = alpha(value(v2, '--v2-fill'))
      const a = Math.round(fill.a * 255) / 255
      const onPanel = fill.rgb.map((c, i) => Math.round(c * a + panel[i] * (1 - a)))
      expect(contrast(danger, onPanel)).toBeGreaterThanOrEqual(4.5)
      expect(contrast(danger, panel)).toBeGreaterThanOrEqual(4.5)
    }
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

  // TABLET-01: the tablet root scales the same names, and only those – the touch rows and
  // controls with §9.3's 40 / 20 icon button – so a tablet never forks the vocabulary either.
  it('scales the tablet the same way, at the tablet icon button', () => {
    expect([...tablet].sort()).toEqual([...phone].sort())
    const tabletBlock = block(":root[data-form-factor='tablet']", lightStart)
    expect(tabletBlock).toMatch(/--v2-icon-button: 40px;/)
    expect(tabletBlock).toMatch(/--v2-icon: 20px;/)
    expect(tabletBlock).toMatch(/--v2-row: calc\(var\(--v2-line-body-box\) \+ 24px\);/)
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
    // accent, the shared focus-ring rule reads the ring and its offset (§1, two reads), the
    // chassis scrim alias `--zen-scrim` reads the v2 scrim (§9.28), the row padding
    // `--v2-row-pad` derives from the row and the body line box (§9.34, two reads), the four
    // `-box` line tokens read the four line tokens (A11Y-05: what a line box measures at the
    // text zoom, four reads), the rows derive from the line boxes so they grow with the system
    // font size (§9.2, A11Y-05: `--v2-row`, `--v2-row-two-line` and `--v2-menu-row` in the base
    // block and again in the phone block and the tablet block, four reads each), the tab card's
    // title row `--zen-overview-card-header` derives from the small line box (§9.21, A11Y-05:
    // once at rest, once as the two-line row from scale 1.5), the group card's title row
    // `--zen-overview-group-header` from the same line box (one line at every size), the window
    // chrome's hairline alias `--zen-border` reads the v2 window border (§9.29, the shell pass),
    // and the two §9.29 family blocks map the tokens onto the control roles.
    const familyReads = FAMILIES.map((f) => block(f).match(/var\(--v2-/g)?.length ?? 0)
    expect((inside.match(/var\(--v2-/g) ?? []).length).toBe(
      9 + 4 + 4 + 8 + 3 + 1 + familyReads.reduce((a, b) => a + b, 0)
    )
    expect(inside).toMatch(/--zen-border: var\(--v2-window-border\)/)
    expect(inside).toMatch(/--zen-overview-card-header: calc\(var\(--v2-line-small-box\) \+ 24px\)/)
    expect(inside).toMatch(
      /--zen-overview-group-header: calc\(var\(--v2-line-small-box\) \+ 24px\)/
    )
    expect(inside).toMatch(
      /:root\[data-text-scale='larger'\] \{\n {2}--zen-overview-card-header: calc\(2 \* var\(--v2-line-small-box\) \+ 24px\)/
    )
    expect(inside).toMatch(
      /--v2-row-pad: calc\(\(var\(--v2-row\) - var\(--v2-line-body-box\)\) \/ 2\)/
    )
    // The line tokens are px literals for `line-height`, which Blink zooms with the text itself;
    // their `-box` twins carry the zoom for the box model, and are the text zoom's only readers
    // among the tokens: controls, glyphs and distances stay in px literals.
    expect(inside).toMatch(/--v2-line-body: 20px;/)
    expect(inside).toMatch(
      /--v2-line-body-box: calc\(var\(--v2-line-body\) \* var\(--zen-text-zoom\)\)/
    )
    expect(inside).toMatch(/--v2-row: calc\(var\(--v2-line-body-box\) \+ 12px\)/)
    expect(inside).toMatch(/--v2-row: calc\(var\(--v2-line-body-box\) \+ 24px\)/)
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
    // copies and the translate stylesheet's own went with it; the desktop Settings tab's value
    // rows are the first to draw the trigger outside those UIs.
    '.zen-v2-menulist',
    '.zen-v2-menulist-popup',
    '.zen-v2-menulist-option',
    // The segment (#203, the overview's Tabs | Private): its tabs and their underline are rules
    // on the one class (`> [role='tab']`, `::after`), so the primitive is the whole control.
    '.zen-v2-segment',
    // The group heading (§9.27, §10.3) with its 20 / 4 beat: the customise sheet's layered copy
    // and the Settings tab's and phone panels' local beats went with it; what each surface adds
    // (the first heading's 8 under a header, a popover's tighter 12) is an unlayered modifier.
    '.zen-v2-heading',
    // The inline link (§9.10, the #294 ruling): the extensions UI's layered copy in the accent
    // and the passwords detail's `.zen-v2-pw-link` went with it; the test below pins its values.
    '.zen-v2-link'
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
    // The row wrappers write the mark (§9.34): the translate rows through `ControlRow` (the
    // surfaces set none by hand; #272's audit), the passwords wrappers only for a one-line row
    // (a two-line row takes no mark). (The desktop Languages and Autofill panes went with the
    // Settings tab, #193: their rows are the builder's, which marks its control rows itself.)
    for (const file of ['components/translate/SelectionPopover.tsx']) {
      const text = read(file)
      expect(text, file).not.toMatch(/zen-translate-control-row/)
      expect(text, file).not.toMatch(/data-control=/)
      expect(text, file).toMatch(/<ControlRow/)
    }
    const controlRow = read('components/translate/ControlRow.tsx')
    expect(controlRow).toMatch(/'data-static': ''/)
    expect(controlRow).toMatch(/'data-control': control \? '' : undefined/)
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

  it('keep a checked checkbox’s accent under the pointer: the one hover rule steps aside from :checked and both aria-checked forms', () => {
    // `.zen-v2-checkbox:hover:not(:disabled)` (0,3,0) outranked `.zen-v2-checkbox:checked`
    // (0,2,0), so a checked desktop box under the mouse lost its accent to `--v2-fill`. The
    // hover rule excludes every checked form the checked rule knows – the `<input>`'s
    // `:checked`, the span's own `[aria-checked='true']` and the row-as-checkbox parent form.
    const hovers = [...bare.matchAll(/^ *(\.zen-v2-checkbox:hover[^{]*)\{/gm)].map((m) =>
      m[1].replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim()
    )
    expect(hovers).toEqual([
      ".zen-v2-checkbox:hover:not(:disabled, :checked, [aria-checked='true'], [aria-checked='true'] > *)"
    ])
    // The checked rule still names the same three forms, in that order, filling with the accent.
    const checked = block(
      ".zen-v2-checkbox:checked,\n.zen-v2-checkbox[aria-checked='true'],\n[aria-checked='true'] > .zen-v2-checkbox"
    )
    expect(checked).toMatch(/^ {2}background: var\(--v2-accent\);$/m)
    expect(checked).toMatch(/^ {2}border-color: var\(--v2-accent\);$/m)
    // No other stylesheet hovers the checkbox on its own.
    const root = fileURLToPath(new URL('../../', import.meta.url))
    for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((f) => f.split('\\').join('/'))
      .filter((f) => f.endsWith('.css') && f !== 'assets/main.css'))
      expect(readFileSync(join(root, file), 'utf8'), `${file} hovers the checkbox`).not.toMatch(
        /\.zen-v2-checkbox:hover/
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

  it('draw a prompt about Zenium with the 48 app icon above the sheet title block, the desktop form (§9.23, #264)', () => {
    // The chassis slot (`PhoneSheet`'s `appIcon`, `.zen-sheet-app-icon`): 48 at the block's 16
    // from the sheet's edges, 16 to the title through the block's own padding, beside the block
    // rule – the same numbers as the desktop prompt's `.zen-default-browser-prompt-icon`. Both
    // rules are nested one level (the chassis layer, the components layer): cut at their own `}`.
    const nested = (selector: string): string => {
      const start = css.indexOf(`${selector} {`)
      expect(start, `block "${selector}"`).toBeGreaterThanOrEqual(0)
      return css.slice(start, css.indexOf('\n  }', start))
    }
    expect(nested('.zen-sheet-app-icon').match(/^ {4}[a-z-]+:[^;]+;/gm)).toEqual([
      '    display: flex;',
      '    flex-shrink: 0;',
      '    width: 48px;',
      '    height: 48px;',
      '    margin: 16px 16px 0;'
    ])
    expect(nested('.zen-default-browser-prompt-icon')).toMatch(
      /width: 48px;\s*height: 48px;\s*margin: var\(--v2-card-padding\) var\(--v2-card-padding\) 0;/
    )
    expect(css.indexOf('.zen-sheet-app-icon {')).toBeGreaterThan(
      css.indexOf('.zen-sheet-title-block {')
    )
    // The promo's phone sheet takes the slot and no inline glyph; its mouse dialog draws the
    // same icon over its block, as the desktop's `AskDialog` does (the one composition).
    const prompt = readFileSync(
      fileURLToPath(
        new URL('../../components/defaultbrowser/DefaultBrowserPrompt.tsx', import.meta.url)
      ),
      'utf8'
    )
    expect(prompt).toMatch(/appIcon: <AppIconImage variant=\{appIconVariant\(appIcon\)\} \/>/)
    expect(prompt).not.toMatch(/lucide-react/)
    expect(prompt.match(/className="zen-default-browser-prompt-icon"/g)).toHaveLength(2)
    // The site-info sheet's `data-control` rule went with the primitives pass 3: no row on that
    // surface sets the mark, and the mark's geometry is `.zen-v2-row[data-control]`'s alone.
    expect(css).not.toMatch(/\.zen-siteinfo-row\[data-control\]/)
  })

  it('paint a message row’s status glyph and description in the status ink through the row’s one data-tone (§9.33 in §1’s ink; pr-261)', () => {
    // The tone is the row's attribute: the two rules sit beside the row rule in main.css,
    // unlayered, and reach the status glyph – leading where every row of a list carries one,
    // trailing on a lone status row – and the description THROUGH the row, so a consumer sets
    // nothing on the span or the glyph. Each states the status token and nothing else.
    for (const [tone, token] of [
      ['danger', '--v2-danger'],
      ['warn', '--v2-warn']
    ] as const) {
      const selector = `.zen-v2-row[data-tone='${tone}'] .zen-v2-row-lead,\n.zen-v2-row[data-tone='${tone}'] .zen-v2-row-trail,\n.zen-v2-row[data-tone='${tone}'] .zen-v2-description`
      const at = bare.indexOf(`\n${selector} {`)
      expect(at, `rule "${selector}"`).toBeGreaterThanOrEqual(0)
      expect(at).toBeGreaterThan(ruleAt('.zen-v2-row[data-static]'))
      expect(nesting(at + 1)).toBe(0)
      expect(bare.slice(at, bare.indexOf('\n}', at)).match(/^ {2}[a-z-]+:[^;]+;/gm)).toEqual([
        `  color: var(${token});`
      ])
    }
    // The trailing status glyph (§9.33, §9.3): one unlayered rule beside the tone rules – 16 on
    // both platforms at the size's stroke token, in the deemphasised ink until the row's tone
    // inks it – and no second copy anywhere.
    const trail = ruleAt('.zen-v2-row-trail')
    expect(trail).toBeGreaterThan(ruleAt('.zen-v2-row[data-static]'))
    expect(nesting(trail)).toBe(0)
    expect(bare.slice(trail, bare.indexOf('\n}', trail)).match(/^ {2}[a-z-]+:[^;]+;/gm)).toEqual([
      '  flex-shrink: 0;',
      '  width: 16px;',
      '  height: 16px;',
      '  stroke-width: var(--v2-icon-stroke);',
      '  color: var(--v2-text-deemphasized);'
    ])
    expect(bare.match(/\n\.zen-v2-row-trail \{/g)).toHaveLength(1)
    // The span and the glyph carry no tone of their own anywhere: no stylesheet colours
    // `.zen-v2-description`, `.zen-v2-row-lead` or `.zen-v2-row-trail` by an attribute on the
    // element, and the settings page's description and its trailing glyph read the same row
    // attribute (`.zen-settings-row[data-tone]`), not one on the span or a class on the glyph.
    const root = fileURLToPath(new URL('../../', import.meta.url))
    for (const file of readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((f) => f.split('\\').join('/'))
      .filter((f) => f.endsWith('.css'))) {
      const text = readFileSync(join(root, file), 'utf8')
      expect(text, `${file} tones the span`).not.toMatch(
        /\.zen-v2-(description|row-lead|row-trail)\[data-tone|\.zen-settings-(description|glyph|trailing-glyph)\[data-tone/
      )
      if (file !== 'assets/main.css')
        expect(text, `${file} restates the trailing glyph`).not.toMatch(/\.zen-v2-row-trail/)
    }
    for (const [tone, token] of [
      ['danger', '--v2-danger'],
      ['warn', '--v2-warn']
    ] as const) {
      for (const part of [
        '.zen-settings-description',
        '.zen-settings-trailing > .zen-settings-trailing-glyph'
      ]) {
        const selector = `.zen-settings-row[data-tone='${tone}'] ${part}`
        const at = bare.indexOf(`\n${selector} {`)
        expect(at, `rule "${selector}"`).toBeGreaterThanOrEqual(0)
        expect(bare.slice(at, bare.indexOf('\n}', at)).match(/^ {2}[a-z-]+:[^;]+;/gm)).toEqual([
          `  color: var(${token});`
        ])
      }
      // The leading slot is not toned through the row: a lead glyph is a list's structural
      // column (every row fills it), a lone status row's glyph trails (§9.33).
      expect(bare).not.toContain(`.zen-settings-row[data-tone='${tone}'] .zen-settings-leading`)
    }
  })

  it('draw an inline link as text with a 40 % underline, the accent on hover and focus-visible (§9.10): one unlayered rule, the old forms gone', () => {
    // The #294 ruling: a `.zen-v2-link` in the accent with no underline at rest was the
    // primitive's fault, and the 18 px site link in the passwords detail the other failure case.
    // The one rule sits after the token block, unlayered, and states §9.10's declarations and
    // nothing else: the surrounding ink and font (never larger), the underline at 40 % of the
    // ink with a 2 px offset, the pointer a link has.
    const declarations = (at: number): string[] =>
      (bare.slice(at, bare.indexOf('}', at)).match(/^ +[a-z-]+:[^;]+;/gm) ?? []).map((d) =>
        d.trim()
      )
    const base = ruleAt('.zen-v2-link')
    expect(base).toBeGreaterThan(bare.indexOf('--v2-page:'))
    expect(nesting(base)).toBe(0)
    expect(bare.match(/\n\.zen-v2-link \{/g)).toHaveLength(1)
    expect(declarations(base)).toEqual([
      'color: inherit;',
      'font: inherit;',
      'text-decoration: underline;',
      'text-decoration-color: color-mix(in srgb, currentColor 40%, transparent);',
      'text-underline-offset: 2px;',
      'cursor: pointer;'
    ])
    // Hover – a mouse's, under the hover media query – and focus-visible: the surface family's
    // accent through the §9.29 control role, the underline in the same. Beside the rule,
    // unlayered like it.
    const media = '\n@media (hover: hover) {'
    const hover = bare.indexOf('\n  .zen-v2-link:hover {')
    expect(hover).toBeGreaterThan(base)
    expect(bare.slice(hover - media.length, hover)).toBe(media)
    expect(layered(hover + 1)).toBe(false)
    const focus = ruleAt('.zen-v2-link:focus-visible')
    expect(nesting(focus)).toBe(0)
    for (const at of [hover + 1, focus])
      expect(declarations(at)).toEqual([
        'color: var(--v2-control-accent, var(--v2-accent));',
        'text-decoration-color: currentColor;'
      ])
    // The trailing glyph (§9.10: a link that leaves the app): the icon token's 16 / 20 at the
    // size's stroke, 4 after the last word; a link that carries one lays out as an inline-flex
    // so the glyph is centred on the line and never orphaned, and a link without one sets no
    // `display` – it is inline in a sentence and wraps as text does.
    expect(declarations(ruleAt('.zen-v2-link > svg'))).toEqual([
      'flex-shrink: 0;',
      'width: var(--v2-icon);',
      'height: var(--v2-icon);',
      'stroke-width: var(--v2-icon-stroke);'
    ])
    expect(declarations(ruleAt('.zen-v2-link:has(> svg)'))).toEqual([
      'display: inline-flex;',
      'align-items: center;',
      'gap: 4px;'
    ])
    // A link standing alone on its line takes `data-touch`, and on a phone its hit area grows
    // to the row height around the unchanged text (the passwords detail's extender, folded in).
    expect(declarations(ruleAt('.zen-v2-link[data-touch]'))).toEqual(['position: relative;'])
    const touch = ruleAt(":root[data-form-factor='phone'] .zen-v2-link[data-touch]::before")
    expect(nesting(touch)).toBe(0)
    expect(declarations(touch)).toEqual([
      "content: '';",
      'position: absolute;',
      'inset: calc((var(--v2-row) - 100%) / -2) 0;'
    ])
    // No stylesheet keeps the old forms: no `.zen-v2-link` rule outside main.css (the extensions
    // UI's accent-and-no-underline copy went), no second link under another name (the passwords
    // detail's `.zen-v2-pw-link` and its phone extender went), and at rest no rule anywhere inks
    // a link in the accent or takes its underline off.
    const root = fileURLToPath(new URL('../../', import.meta.url))
    const sources = readdirSync(root, { recursive: true, encoding: 'utf8' })
      .map((f) => f.split('\\').join('/'))
      .filter((f) => /\.(css|tsx?)$/.test(f) && !f.includes('__tests__'))
    for (const file of sources) {
      const text = readFileSync(join(root, file), 'utf8')
      expect(text, `${file} names the passwords link`).not.toMatch(/zen-v2-pw-link/)
      if (!file.endsWith('.css')) continue
      const rules = text.replace(/\/\*[\s\S]*?\*\//g, '')
      if (file !== 'assets/main.css') {
        expect(rules, `${file} restates the link`).not.toMatch(/\.zen-v2-link[^{]*\{/)
        expect(rules, `${file} restates the phone extender`).not.toMatch(
          /inset: calc\(\(var\(--v2-row\) - 100%\) \/ -2\) 0/
        )
        continue
      }
      for (const rule of rules.matchAll(/[^\n{}]*\.zen-v2-link(?![\w-])[^{]*\{/g)) {
        const selector = rule[0].trim()
        if (/:hover|:focus-visible/.test(selector)) continue
        const body = rules.slice(rule.index + rule[0].length, rules.indexOf('}', rule.index))
        expect(body, `"${selector}" inks the link in the accent at rest`).not.toMatch(
          /color: var\(--v2-(control-)?accent/
        )
        expect(body, `"${selector}" takes the underline off`).not.toMatch(/text-decoration: none/)
      }
    }
    // Its three consumers on main take the class and add nothing of their own: the extension
    // details' store link with its glyph, the login detail's site link (a button, as the site
    // opens through a command) with `data-touch` – no size utility on the glyph, no link class
    // of the surface's – and the leak warning's manager link in a sentence, which navigates
    // inside the app and so carries no glyph and no `data-touch` (never in running prose).
    const details = readFileSync(join(root, 'components/extensions/ExtensionDetails.tsx'), 'utf8')
    expect(details).toMatch(/className="zen-v2-link"/)
    const login = readFileSync(join(root, 'components/overlays/passwords/LoginDetail.tsx'), 'utf8')
    expect(login).toMatch(/className="zen-v2-link min-w-0 max-w-full"\n\s+data-touch=""/)
    expect(login).toMatch(/<ExternalLink \/>/)
    const leak = readFileSync(join(root, 'components/autofill/LeakWarning.tsx'), 'utf8')
    const manager = /<a\n\s+className="zen-v2-link"\n[\s\S]*?>\s*password manager\s*<\/a>/.exec(
      leak
    )
    expect(manager, 'the leak warning links the manager as plain text').not.toBeNull()
    expect(manager?.[0]).not.toMatch(/data-touch|<svg|Lucide|Icon/)
  })
})

/** The shared `zen-v2-` ring rule's selector, as main.css writes it. */
const RING_RULE =
  "[class^='zen-v2-']:focus-visible,\n[class*=' zen-v2-']:focus-visible,\n:root[data-pointer='coarse'] [class^='zen-v2-']:focus-visible,\n:root[data-pointer='coarse'] [class*=' zen-v2-']:focus-visible"

describe('the focus ring (§1, §4)', () => {
  const panels = readFileSync(
    fileURLToPath(new URL('../../components/phone/phonePanels.css', import.meta.url)),
    'utf8'
  ).replace(/\/\*[\s\S]*?\*\//g, '')
  /** The declarations of the first `selector {` rule of a stylesheet's comment-free text. */
  const rule = (source: string, selector: string): string => {
    const at = source.indexOf(`${selector} {`)
    expect(at, selector).toBeGreaterThanOrEqual(0)
    return source.slice(at + selector.length + 2, source.indexOf('}', at))
  }

  it('sits at --v2-ring-offset from the control, the token read by the one shared rule at every pointer', () => {
    // The offset is a token beside the ring's colour: 2 outside, declared once for the chrome in
    // the light block and not per theme (the "nothing that is not a colour" test above holds
    // dark to colours), so a control moves its ring through the token at its own rule's weight.
    expect(block(':root', lightBlockStart)).toMatch(/^ {2}--v2-ring-offset: 2px;$/m)
    // Declared five times in all: the chrome's default, the field's −2, the picked card radio's
    // −2, the picked swatch's 2 back and the Settings row's −2 (each pinned below).
    expect(css.match(/--v2-ring-offset:/g)).toHaveLength(5)
    const ring = block(RING_RULE)
    expect(ring.match(/^ {2}[a-z-]+:[^;]+;/gm)).toEqual([
      '  outline: 2px solid var(--v2-ring);',
      '  outline-offset: var(--v2-ring-offset);'
    ])
    expect(nesting(ruleAt(RING_RULE))).toBe(0)
  })

  it('is the same in both themes, by control: no theme-conditioned offset and no theme form of the shared rule remain (the #247 chassis note)', () => {
    // 0 light / −2 dark had no rule behind it and put a dark button's ring inside its edge; §1
    // stands, so nothing under `data-theme` sets an offset on a v2 control or on the URL field.
    expect(bare).not.toMatch(/:root\[data-theme='dark'\] \[class\^='zen-v2-'\]/)
    expect(bare).not.toMatch(/:root\[data-theme='dark'\][^{]*zen-v2-[^{]*\{[^}]*outline-offset/)
    expect(bare).not.toMatch(/:root\[data-theme='dark'\] \.zen-pill/)
    expect(panels).not.toMatch(/:root\[data-theme='dark'\][^{]*\{[^}]*outline-offset/)
    // And no v2 control's focus rule writes `outline-offset` past the token: a control that
    // needs another offset sets `--v2-ring-offset` on itself (the field, the picked card radio,
    // the picked swatch), which the coarse-pointer form of the ring reads as the mouse's does.
    for (const m of bare.matchAll(/[^\n{}]*zen-v2-[^{}]*:focus-visible[^{]*\{([^}]*)\}/g)) {
      const selector = m[0].split('{')[0].trim()
      // A standing outline drawn while the control is NOT focused (the forced-colours picked
      // card) is not the ring and sets its own offset, as every standing outline does.
      if (selector.includes(':not(:focus-visible)')) continue
      const offsets = m[1].match(/outline-offset:[^;]+;/g) ?? []
      for (const offset of offsets)
        expect(offset, selector).toBe('outline-offset: var(--v2-ring-offset);')
    }
  })

  it('goes 2 inside on text fields and the URL field, where an outside ring would clip (§1)', () => {
    // The shared field sets the token on itself, the leaf input; the invalid field's `--v2-ring`
    // re-ink beside it is the same seam (§9.12, #247).
    expect(block('.zen-v2-field')).toMatch(/^ {2}--v2-ring-offset: -2px;$/m)
    // The URL field – the pill the address button fills – in both themes.
    expect(block('.zen-pill:has(> button:focus-visible)').match(/^ {2}[a-z-]+:[^;]+;/gm)).toEqual([
      '  outline: 2px solid var(--v2-ring);',
      '  outline-offset: -2px;'
    ])
    // The phone field (phonePanels.css) is a text field wrapping its input: the same −2, stated
    // as `outline-offset` on the wrapper – the token would reach its clear button, a 2-outside one.
    expect(rule(panels, '.zen-phone-field:focus-within')).toMatch(/outline-offset: -2px;/)
    expect(panels).not.toMatch(/\.zen-phone-field[^{]*\{[^}]*--v2-ring-offset/)
    // A row that runs edge to edge inside a clipping scroll body takes the inset ring for the
    // field's reason – the Settings tab's rows that are themselves the target (the pressable
    // row, an option sheet's radio row) through the token, the phone list's rows
    // (phonePanels.css) as the −2 they state on the row.
    const INSET_ROWS = ['.zen-settings-row-pressable', '.zen-settings-radio-row']
    expect(block(INSET_ROWS.join(',\n')).match(/^ {2}[a-z0-9-]+:[^;]+;/gm)).toEqual([
      '  --v2-ring-offset: -2px;'
    ])
    expect(rule(panels, '.zen-phone-row:has(> .zen-list-main:focus-visible)')).toMatch(
      /outline-offset: -2px;/
    )
    // The token inherits (the #272 review), so it is set only where nothing inside can take
    // it: never on `.zen-settings-row` itself – the desktop's static rows (§10.5) hold a
    // menulist, a button, a field or a checkbox in their slot, each ringing at its own offset –
    // and every element that carries an inset row's class, in any surface, is a `button`, which
    // holds no interactive content. Every declaration of the token, by its rule's selector: the
    // light block's default, the field, the picked card radio and its swatch, the two rows.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const declaring = [...bare.matchAll(/--v2-ring-offset:/g)].map((m) => {
      const open = bare.lastIndexOf('{', m.index)
      const from = Math.max(
        bare.lastIndexOf('}', open),
        bare.lastIndexOf('{', open - 1),
        bare.lastIndexOf(';', open)
      )
      return bare
        .slice(from + 1, open)
        .trim()
        .replace(/\s*\n\s*/g, ' ')
    })
    expect(declaring).toEqual([
      ':root',
      '.zen-v2-field',
      ".zen-v2-card-radio[aria-checked='true']",
      ".zen-v2-card-radio.zen-group-editor-swatch[aria-checked='true']",
      INSET_ROWS.join(', ')
    ])
    const components = fileURLToPath(new URL('../../components/', import.meta.url))
    const carriers: string[] = []
    for (const entry of readdirSync(components, { recursive: true, encoding: 'utf8' })) {
      const file = entry.split('\\').join('/')
      if (!file.endsWith('.tsx') || file.includes('__tests__')) continue
      const source = readFileSync(join(components, entry), 'utf8')
      const marks = source.match(/\bzen-settings-(?:row-pressable|radio-row)\b/g) ?? []
      if (marks.length === 0) continue
      // The nearest tag opener before each mark, with no other `<` between them.
      const openers = [
        ...source.matchAll(/<([a-zA-Z][\w.]*)\b[^<]*?\bzen-settings-(?:row-pressable|radio-row)\b/g)
      ]
      expect(openers, `${file}: every inset row's class sits in a tag opener`).toHaveLength(
        marks.length
      )
      for (const [, tag] of openers) {
        expect(tag, `${file}: an inset row is a <${tag}>`).toBe('button')
        carriers.push(file)
      }
    }
    // The three rows that take the inset today; a fourth carrier is a `button` or fails above.
    expect(new Set(carriers)).toEqual(
      new Set(['pages/settings/rows.tsx', 'pages/settings/blocks.tsx', 'translate/pickers.tsx'])
    )
    // Their trailing marks are presentational: the switch and the radio circle are `aria-hidden`
    // spans, the row button being the switch / radio itself.
    const rows = readFileSync(join(components, 'pages/settings/rows.tsx'), 'utf8')
    expect(rows).toMatch(/<span className="zen-v2-switch" aria-hidden="true" \/>/)
    const blocks = readFileSync(join(components, 'pages/settings/blocks.tsx'), 'utf8')
    expect(blocks).toMatch(/<span className="zen-v2-radio" aria-hidden="true" \/>/)
  })

  it('leaves a popover row the room its ring now takes: --v2-ring-room is 4 (§9.20, the #251 chassis (b))', () => {
    // The ring's 2 px at the row's 2 outside: the rows in a clipped popover body stand 4 in from
    // its sides and give the 4 back from their gutter, the text staying at 16. One rule for the
    // two clipped bodies – the bookmark popovers' and the omnibox dropdown's list (shell pass
    // 7(b)); popoverRingRoom.test.ts models the geometry.
    expect(block(':root', lightBlockStart)).toMatch(/^ {2}--v2-ring-room: 4px;$/m)
    expect(block(':is(.zen-bm-popover-body, .zen-omnibox-results) .zen-v2-row')).toMatch(
      /padding-inline: calc\(16px - var\(--v2-ring-room\)\)/
    )
  })

  it('rings an accent-filled control outside its fill like every other (§4, the #251 ruling): no exception moves or re-inks it', () => {
    // The primary button, a checked checkbox, switch or radio: at 2 outside the ring stands off
    // the accent fill by the 2 px of surface between them and reads against it (Firefox's
    // primary buttons ring outside their fill the same way), so the dark-theme exception that
    // pulled their ring back to 0 is gone and no rule singles them out for the ring.
    for (const control of [
      '.zen-v2-button[data-primary]',
      '.zen-v2-checkbox:checked',
      ".zen-v2-checkbox[aria-checked='true']",
      ".zen-v2-switch[aria-checked='true']",
      ".zen-v2-radio[aria-checked='true']"
    ]) {
      const escaped = control.replace(/[.[\]()*+?^$|\\]/g, '\\$&')
      expect(bare, `${control} has a ring rule of its own`).not.toMatch(
        new RegExp(`${escaped}[^,{\\n]*:focus-visible`)
      )
    }
    // The picked card radio (its accent outline 2 outside) and the picked swatch are the two
    // controls that move the ring, through the token, and they are not accent fills.
    expect(
      block(".zen-v2-card-radio[aria-checked='true']", css.indexOf('.zen-v2-card-radio {'))
    ).toMatch(/box-shadow: 0 0 0 2px var\(--v2-accent\)/)
    expect(
      block(
        ".zen-v2-card-radio[aria-checked='true']",
        css.indexOf('box-shadow: 0 0 0 2px var(--v2-accent)')
      )
    ).toMatch(/^ {2}--v2-ring-offset: -2px;$/m)
    expect(
      block(
        ".zen-v2-card-radio.zen-group-editor-swatch[aria-checked='true']",
        css.indexOf('.zen-group-editor-swatch-disc')
      )
    ).toMatch(/^ {2}--v2-ring-offset: 2px;$/m)
  })
})

describe('text selection (§9.6)', () => {
  const rendererRoot = fileURLToPath(new URL('../../', import.meta.url))
  /** Every renderer source file that could carry a stylesheet rule, main.css first. */
  const sources = readdirSync(rendererRoot, { recursive: true, encoding: 'utf8' })
    .map((f) => f.split('\\').join('/'))
    .filter((f) => /\.(css|tsx?)$/.test(f) && !f.includes('__tests__'))

  it('is one rule, once, on the chrome document’s root: no component sets ::selection of its own', () => {
    // main.css states the rule exactly once, as one selector list naming the window root and
    // the chrome layer the popovers portal into (lib/portals.tsx) – the same chrome document.
    const rules = [...bare.matchAll(/[^\n]*::selection[^{]*\{/g)].map((m) => m[0].trim())
    expect(rules).toEqual(['.zen-window ::selection,\n.zen-chrome-layer ::selection {'])
    // Its two declarations: the selection token (the accent at 30 %) and the text's own ink.
    const at = bare.indexOf('.zen-window ::selection,')
    const body = bare.slice(bare.indexOf('{', at) + 1, bare.indexOf('}', at))
    expect(body.match(/^ {2}[a-z-]+:[^;]+;/gm)).toEqual([
      '  background: var(--v2-selection);',
      '  color: inherit;'
    ])
    // Unlayered: a layered copy anywhere would lose to it, so none can be the selection colour.
    expect(nesting(at)).toBe(0)
    // And no other renderer stylesheet or component carries one – the omnibox field's went with
    // this rule. (zen://newtab is its own document and cannot link main.css; shared/newTabPage.ts
    // writes the same rule into it, outside this tree.)
    for (const file of sources) {
      if (file === 'assets/main.css') continue
      expect(
        readFileSync(join(rendererRoot, file), 'utf8'),
        `${file} sets ::selection`
      ).not.toMatch(/::selection/)
    }
  })
})

describe('the overlay scrollbar (§9.20)', () => {
  const rendererRoot = fileURLToPath(new URL('../../', import.meta.url))
  const sources = readdirSync(rendererRoot, { recursive: true, encoding: 'utf8' })
    .map((f) => f.split('\\').join('/'))
    .filter((f) => /\.(css|tsx?)$/.test(f) && !f.includes('__tests__'))
  const desktop = ":root[data-pointer='fine'] "
  /** The chassis rule's declarations for one `::-webkit-scrollbar` part, in source order. */
  const part = (name: string): string[] => {
    const at = bare.indexOf(`${desktop}::-webkit-scrollbar${name} {`)
    expect(at, `the chassis states ::-webkit-scrollbar${name}`).toBeGreaterThanOrEqual(0)
    // In the base layer, the floor under every scroller of the chrome document.
    expect(nesting(at), `::-webkit-scrollbar${name} sits in @layer base`).toBe(1)
    const body = bare.slice(bare.indexOf('{', at) + 1, bare.indexOf('}', at))
    return (body.match(/^ {4}[a-z-]+:[^;]+;/gm) ?? []).map((d) => d.trim())
  }

  it('is one chassis rule on every scroller of a mouse’s chrome: an 8 gutter, no buttons, no track, the thumb the family’s ink at 30 %', () => {
    expect(part('')).toEqual(['width: 8px;', 'height: 8px;', 'background: transparent;'])
    expect(part('-button')).toEqual(['display: none;'])
    // The track and the corner are one rule; the corner's selector is read here through the track's.
    expect(part("-track,\n  :root[data-pointer='fine'] ::-webkit-scrollbar-corner")).toEqual([
      'background: transparent;'
    ])
    // The thumb: the control role's ink (the page ink on a page, the theme's on the window,
    // §9.29; the page ink where no family is set) at the spec's 30 %, a pill 1 inside the gutter.
    expect(part('-thumb')).toEqual([
      'border: 1px solid transparent;',
      'border-radius: 4px;',
      'background: color-mix(in srgb, var(--v2-control-text, var(--v2-text)) 30%, transparent);',
      'background-clip: padding-box;'
    ])
    // §9.20 (lead's #281 verdict): the thumb answers the pointer at 50 %, no size change; nothing
    // under `:active`.
    expect(part('-thumb:hover')).toEqual([
      'background: color-mix(in srgb, var(--v2-control-text, var(--v2-text)) 50%, transparent);',
      'background-clip: padding-box;'
    ])
    expect(bare).not.toMatch(/::-webkit-scrollbar-thumb:active/)
  })

  it('leaves the standard properties to a finger’s chrome alone: Chromium paints the parts only where both are auto', () => {
    // The one `thin` and the one `scrollbar-color` in the renderer are the coarse pointer's
    // (Android's WebView, whose bar is its own overlay); on the desktop neither is stated, since
    // Chromium 121+ ignores every `::-webkit-scrollbar` part where either is not `auto`.
    const coarse = bare.indexOf(":root[data-pointer='coarse'] * {")
    expect(coarse).toBeGreaterThanOrEqual(0)
    expect(nesting(coarse)).toBe(1)
    const body = bare.slice(bare.indexOf('{', coarse) + 1, bare.indexOf('}', coarse))
    expect(body).toContain('scrollbar-width: thin;')
    expect(body).toContain('scrollbar-color: rgb(var(--zen-fg-rgb) / 0.25) transparent;')
    for (const file of sources) {
      const text = readFileSync(join(rendererRoot, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
      const widths = [...text.matchAll(/scrollbar-width\s*:\s*([a-z]+)/g)].map((m) => m[1])
      const colors = text.match(/scrollbar-color\s*:/g) ?? []
      if (file === 'assets/main.css') {
        expect(widths.filter((w) => w !== 'none')).toEqual(['thin'])
        expect(colors).toHaveLength(1)
      } else {
        // A component hides a bar by design (`none`) or says nothing; it never thins or colours one.
        expect(
          widths.filter((w) => w !== 'none'),
          `${file} sets scrollbar-width`
        ).toEqual([])
        expect(colors, `${file} sets scrollbar-color`).toHaveLength(0)
      }
      // No `::-webkit-scrollbar` styling of a component's own: only the chassis draws a bar, and a
      // hidden bar's `display: none` companion is the most a component states.
      const webkit = [
        ...text.matchAll(/([^\n{]*)::-webkit-scrollbar[a-z-]*(?::hover)?[^{]*\{([^}]*)\}/g)
      ]
      for (const m of webkit) {
        if (m[1].includes(desktop.trim())) continue
        expect(m[2].trim(), `${file}: ${m[0].trim().split('\n')[0]}`).toBe('display: none;')
      }
    }
  })

  it('reaches the Settings tab’s panes: their hide is the phone’s only', () => {
    // The nav column and the scroll pane said `scrollbar-width: none` for every pointer; the
    // desktop's panes now draw the chassis bar and only a finger's Settings hides its own.
    const at = bare.indexOf(":root[data-pointer='coarse'] .zen-settings-scroll,")
    expect(at).toBeGreaterThanOrEqual(0)
    expect(bare.slice(at, bare.indexOf('}', at))).toMatch(
      /^:root\[data-pointer='coarse'\] \.zen-settings-scroll,\n:root\[data-pointer='coarse'\] \.zen-settings-nav \{\n {2}scrollbar-width: none;\n$/
    )
    for (const cls of ['.zen-settings-scroll', '.zen-settings-nav']) {
      const from = bare.search(new RegExp(`^\\${cls} \\{`, 'm'))
      expect(from, `${cls}'s own rule`).toBeGreaterThanOrEqual(0)
      expect(bare.slice(from, bare.indexOf('}', from))).not.toMatch(/scrollbar/)
    }
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
    // The body weight and the phone row follow the system font size (A11Y-05, §4): the weight
    // adds the bold-text adjustment, the row is the body line box (the line zoomed) plus 24. At
    // the defaults – zoom 1, adjustment 0, where the page-drawn twin lives – they reduce to the
    // twin's 400 and 44.
    expect(value(':root', lightBlockStart, '--v2-weight-body')).toBe(
      `min(900, calc(${TOAST_CARD.weight} + var(--zen-font-weight-adjustment)))`
    )
    expect(value(':root', lightBlockStart, '--v2-line-body-box')).toBe(
      'calc(var(--v2-line-body) * var(--zen-text-zoom))'
    )
    expect(value(":root[data-form-factor='phone']", lightStart, '--v2-row')).toBe(
      `calc(var(--v2-line-body-box) + ${TOAST_CARD.rowPx - TOAST_CARD.linePx}px)`
    )
    const insetBlock = css.lastIndexOf(':root {', css.indexOf('--zen-message-inset:'))
    expect(`${TOAST_CARD.insetPx}px`).toBe(value(':root', insetBlock, '--zen-message-inset'))
    // The cap where the frame is wider (§9.33): the toasts' cell and the banners' stack span
    // the frame up to it and centre – the twin caps its own host element by the same number.
    expect(`${TOAST_CARD.maxWidthPx}px`).toBe(value(':root', insetBlock, '--zen-message-max-width'))
    for (const selector of ['.zen-message-toasts', '.zen-message-stack']) {
      const cell = block(selector)
      expect(cell).toMatch(/^ {2}max-width: var\(--zen-message-max-width\);$/m)
      expect(cell).toMatch(/^ {2}margin: 0 auto;$/m)
    }
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

describe('the chrome tooltip (§9.31, a11y-26)', () => {
  it('is the plain panel at the control radius through the token, a round corner – no squircle under 8 (§2)', () => {
    // The design review of #400 (A2): the tooltip had its own 6 with the squircle. It reads
    // the control radius (4 on the desktop; the coarse-pointer block's 6 follows through the
    // same token), and declares no `corner-shape` – §2 keeps the squircle for radius 8 and up.
    // The rule sits inside `@layer components`: its own close is the indented one.
    const whole = block('.zen-tooltip')
    const tip = whole.slice(0, whole.indexOf('\n  }'))
    expect(tip).toMatch(/^ {4}border-radius: var\(--v2-radius-control\);$/m)
    expect(tip).not.toMatch(/corner-shape/)
    expect(tip).not.toMatch(/box-shadow/)
    expect(tip).toMatch(/^ {4}background: var\(--v2-panel\);$/m)
    expect(tip).toMatch(/^ {4}border: 1px solid var\(--v2-border\);$/m)
    expect(block(':root', lightBlockStart)).toMatch(/^ {2}--v2-radius-control: 4px;$/m)
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

describe('the system font size above the default (§4 / §9.2, A11Y-05)', () => {
  const start = css.indexOf('/*\n * The system font size above the default (A11Y-05')
  const end = css.indexOf('@layer components {', start)
  const rules = css.slice(start, end)

  it('lets a row label wrap to a second line before its ellipsis only while the root says the text is scaled', () => {
    expect(start).toBeGreaterThan(0)
    // Every label rule is keyed on `data-text-scale`, which `applyTextScale` sets above scale 1
    // alone, so at the default size the stylesheet computes as before.
    for (const line of rules.split('\n').filter((l) => /^[:.]/.test(l)))
      expect(line, line).toMatch(/^:root\[data-text-scale(?:='larger')?\]/)
    const labels = rules.slice(0, rules.indexOf('display: -webkit-box'))
    for (const label of ['.zen-list-title', '.zen-settings-label', '.zen-settings-category-label'])
      expect(labels).toContain(`:root[data-text-scale] ${label}`)
    expect(labels).toMatch(
      /:root\[data-text-scale\]\s+:is\(\.zen-v2-row, \.zen-sheet-item, \.zen-quick-menu-item, \.zen-bar-row\)\s+> \.truncate/
    )
    expect(rules).toMatch(/-webkit-line-clamp: 2;/)
    // Suggestion rows stay one line at every scale, as Chrome's do.
    expect(rules).not.toContain('zen-omnibox-row')
    // The fixed-height rows take their height as a floor so the second line has room.
    expect(rules).toMatch(
      /:root\[data-text-scale\] \.zen-sheet-item \{\n {2}height: auto;\n {2}min-height: var\(--v2-row\);\n {2}padding-block: var\(--v2-row-pad\);/
    )
  })

  it('gives a tab card’s title two lines from scale 1.5 alone, on the same line box the row grows by', () => {
    const title = rules.slice(
      rules.indexOf(":root[data-text-scale='larger'] .zen-overview-card-title {")
    )
    expect(title).toMatch(/line-height: var\(--v2-line-small\);/)
    expect(title).toMatch(/-webkit-line-clamp: 2;/)
    expect(rules).not.toMatch(/:root\[data-text-scale\][^\n]*zen-overview-card-title/)
    expect(block('.zen-overview-card-header')).toMatch(/height: var\(--zen-overview-card-header\);/)
  })

  it('grows the select-tabs action strip from its 13 label’s line box, never a fixed height (§4, TAB-08)', () => {
    // The strip's rules sit inside `@layer components`, so each is read to its own `}`. The
    // action is the 20 glyph, the 4 gap, the label's line box and 4 above and below (52 at
    // rest, 68 at Android's 1.8 text zoom); the band is the action plus its 6 padding each side.
    const rule = (selector: string): string => {
      const start = css.indexOf(`\n  ${selector} {`)
      expect(start, `rule "${selector}"`).toBeGreaterThanOrEqual(0)
      return css.slice(start, css.indexOf('}', start))
    }
    expect(rule('.zen-overview-actions')).toMatch(
      /--zen-overview-action: calc\(20px \+ 4px \+ var\(--v2-line-small-box\) \+ 8px\);/
    )
    expect(rule('.zen-overview-actions-band')).toMatch(
      /height: calc\(var\(--zen-overview-action\) \+ 12px\);/
    )
    expect(rule('.zen-overview-action')).toMatch(/height: var\(--zen-overview-action\);/)
    for (const selector of ['.zen-overview-actions-band', '.zen-overview-action']) {
      expect(rule(selector)).not.toMatch(/height: \d+px/)
    }
  })

  it('lays the bar’s 44 boxes on the 36 pitch their 32 boxes had, the pill keeping its room (§9.3, the lead’s L1 ruling)', () => {
    // The phone's icon button is the 44 box; the bar's controls overlap by 8 through their
    // margins, as the pill's chips do on their 28, so the pill stays 252 wide on the 412 phone.
    const box = block(":root[data-form-factor='phone'] .zen-toolbar-button")
    expect(box).toMatch(/width: 44px;\s*height: 44px;/)
    const room = css.indexOf(":root[data-form-factor='phone'] [data-bar-item] {")
    expect(room).toBeGreaterThanOrEqual(0)
    expect(css.slice(room, css.indexOf('\n}', room))).toMatch(/margin-inline: -6px;/)
    expect(layered(room, css)).toBe(false)
    expect(44 - 2 * 6 + 4).toBe(36)
  })

  it('clamps the bold-text weights at 900', () => {
    for (const [token, base] of [
      ['--v2-weight-body', 400],
      ['--v2-weight-button', 500],
      ['--v2-weight-heading', 600]
    ] as const)
      expect(css).toContain(
        `${token}: min(900, calc(${base} + var(--zen-font-weight-adjustment)));`
      )
    expect(css).toContain('font-weight: min(900, calc(700 + var(--zen-font-weight-adjustment)));')
  })
})
