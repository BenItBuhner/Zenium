import chromeCss from '../renderer/src/assets/main.css?raw'

/**
 * `zen://newtab`: the document of the new tab page. It is a static shell – search box, grid,
 * Customize button and the containers for the panel, dialog, menu and toast – that the page
 * script (`newTabPageScript.ts`, run from the host's preload) fills from `NewTabPageState`.
 * The page has no scripts of its own and no network access beyond favicons and the custom
 * background image.
 *
 * Design: the page background is the space gradient (design language v2 §1 – the page area of an
 * empty tab is the window), painted by the page itself so a space switch crossfades over 600 ms
 * like the chrome; everything on it is a neutral v2 surface. The page defines no token of its
 * own: its stylesheet starts with the chrome's token blocks, taken verbatim from main.css at
 * build time (`chromeTokenCss`), and reads `--v2-*` for every surface, radius, size and weight;
 * the space theme's `--zen-*` values arrive inline from the page script. Motion is v1 §7: 120 ms
 * state changes, 180 ms pop for panel and dialog, springs for the drag.
 */

/**
 * The chrome's token blocks from main.css, comments dropped: the window's `:root` defaults (the
 * space theme overrides them inline), their dark overrides, then the design language v2 tokens
 * with their dark, pointer and form-factor overrides. It stops at the first rule that is not a
 * plain `:root` or `:root[attribute]` block, so no chrome rule leaks into the page.
 */
export function chromeTokenCss(css: string = chromeCss): string {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const first = bare.search(/^:root \{/m)
  if (first < 0) throw new Error('main.css: no :root token block')
  const blocks: string[] = []
  let at = first
  for (;;) {
    const open = bare.indexOf('{', at)
    if (open < 0) break
    const selector = bare.slice(at, open).trim()
    if (!/^:root(\[[^\]]*\])?$/.test(selector)) break
    const close = bare.indexOf('}', open)
    if (close < 0) break
    const body = bare
      .slice(open + 1, close)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
    blocks.push(`${selector} { ${body} }`)
    at = close + 1
  }
  return blocks.join('\n')
}

/**
 * The page's own rules. Every colour, radius, size and weight is a token read from the blocks
 * above; the only literals are the page's layout (widths, gaps, the 40 px search box) and the
 * v1 motion timings.
 */
export const NEW_TAB_PAGE_STYLE = `
  :root { color-scheme: light; }
  :root[data-theme='dark'] { color-scheme: dark; }
  html, body { margin: 0; min-height: 100%; }
  html { height: 100%; }
  body {
    position: relative;
    min-height: 100%;
    background: transparent;
    color: var(--v2-text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    font-size: var(--v2-font-body);
    line-height: var(--v2-line-body);
    font-weight: var(--v2-weight-body);
    -webkit-font-smoothing: antialiased;
  }
  ::selection { background: var(--v2-selection); color: inherit; }
  button, input { font: inherit; color: inherit; }
  button { cursor: default; }
  svg { stroke-width: var(--v2-icon-stroke); }
  /* The script shows and hides with the attribute; a class setting display must not win over it. */
  [hidden] { display: none !important; }
  /* One focus ring (v2 §1): outside on buttons, tiles, radios and rows; inside on text fields. */
  :focus-visible { outline: 2px solid var(--v2-ring); outline-offset: 2px; }
  .zen-search:focus-within, .zen-field:focus-visible { outline: 2px solid var(--v2-ring); outline-offset: -2px; }
  .zen-search input:focus-visible { outline: none; }

  /* Two stacked background layers: the next background fades in over the current one. */
  .zen-bg { position: fixed; inset: 0; z-index: -1; background-position: center; background-size: cover; background-repeat: no-repeat; }
  #zen-bg-next { opacity: 0; transition: opacity 600ms var(--zen-ease); }
  #zen-bg-next[data-fading] { opacity: 1; }
  body[data-bg='image'] .zen-on-bg { color: #fff; text-shadow: 0 1px 3px rgb(0 0 0 / 0.55); }

  .zen-ntp {
    display: flex; flex-direction: column; align-items: center;
    box-sizing: border-box; min-height: 100vh;
    padding: clamp(48px, 26vh, 220px) 24px 96px;
  }
  /* The private marker is a neutral text badge on the window (v2 §9.19), never a coloured one. */
  .zen-private {
    display: inline-flex; align-items: center; height: 20px; padding: 0 8px; margin-bottom: 20px;
    border-radius: 99px; background: var(--v2-window-fill); color: rgb(var(--zen-fg-rgb) / 0.69);
    font-size: var(--v2-font-small); line-height: var(--v2-line-small); font-weight: var(--v2-weight-heading);
  }
  body[data-bg='image'] .zen-private { background: var(--v2-panel); color: var(--v2-text-deemphasized); }
  .zen-greeting {
    margin: 0 0 20px; color: var(--zen-fg);
    font-size: var(--v2-font-title); line-height: 28px; font-weight: var(--v2-weight-heading);
  }

  .zen-search {
    display: flex; align-items: center; gap: 10px; box-sizing: border-box;
    width: min(560px, 100%); height: 40px; padding: 0 12px;
    background: var(--v2-page); border: 1px solid var(--v2-border); border-radius: var(--v2-radius-inner);
  }
  .zen-search svg { width: var(--v2-icon); height: var(--v2-icon); color: var(--v2-text-deemphasized); flex: none; }
  .zen-search input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; background: transparent; }
  .zen-search input::placeholder { color: var(--v2-text-deemphasized); }

  /* Empty state (v2 §9.17): one sentence at 69%, 32 px under the search box. */
  .zen-empty { margin: 32px 0 0; text-align: center; color: rgb(var(--zen-fg-rgb) / 0.69); }
  .zen-grid { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; width: min(568px, 100%); margin-top: 28px; }
  .zen-tile { position: relative; width: 104px; touch-action: none; }
  .zen-tile-link {
    display: flex; flex-direction: column; align-items: center; gap: 8px; box-sizing: border-box;
    width: 100%; height: 100px; padding: 12px 8px 0; margin: 0;
    background: var(--v2-card); border: 1px solid var(--v2-card-border); border-radius: var(--v2-radius-card);
    color: var(--v2-text); text-decoration: none; text-align: center;
    transition: background-color 120ms var(--zen-ease), transform 120ms var(--zen-ease), box-shadow 200ms var(--zen-ease);
  }
  .zen-tile-link:hover { background: color-mix(in srgb, var(--v2-card) 96%, var(--v2-text)); }
  .zen-tile-link:active { transform: scale(0.98); }
  /* Dragging (v2 §9.4): the tile lifts to v1 level 2 at 90%; the page script adds scale(1.02). */
  .zen-tile[data-dragging] { z-index: 2; }
  .zen-tile[data-dragging] .zen-tile-link { opacity: 0.9; box-shadow: var(--zen-shadow-2); transition: none; }
  .zen-tile-icon {
    display: grid; place-items: center; width: 40px; height: 40px; box-sizing: border-box;
    background: var(--v2-page); border: 1px solid var(--v2-card-border); border-radius: var(--v2-radius-inner);
  }
  .zen-tile-icon img { width: 24px; height: 24px; object-fit: contain; border-radius: 3px; }
  .zen-tile-icon svg { width: var(--v2-icon); height: var(--v2-icon); color: var(--v2-text-deemphasized); }
  .zen-tile-letter { font-size: var(--v2-font-heading); font-weight: var(--v2-weight-heading); line-height: 1; color: var(--v2-text-deemphasized); }
  .zen-tile-label {
    max-width: 100%; font-size: var(--v2-font-small); line-height: var(--v2-line-small);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .zen-tile-menu {
    position: absolute; top: 4px; right: 4px; display: grid; place-items: center;
    width: var(--v2-icon-button); height: var(--v2-icon-button); padding: 0; border: 0; border-radius: var(--v2-radius-inner);
    background: transparent; color: var(--v2-text-deemphasized); opacity: 0;
    transition: opacity 120ms var(--zen-ease), background-color 120ms var(--zen-ease);
  }
  .zen-tile-menu svg { width: var(--v2-icon); height: var(--v2-icon); }
  .zen-tile:hover .zen-tile-menu, .zen-tile:focus-within .zen-tile-menu, .zen-tile-menu[aria-expanded='true'] { opacity: 1; }
  .zen-tile-menu:hover, .zen-tile-menu[aria-expanded='true'] { background: var(--v2-fill); }
  .zen-caret { position: fixed; width: 2px; border-radius: 1px; background: var(--v2-accent); pointer-events: none; z-index: 3; }

  /* Buttons (v2 §6): secondary is the text at 10%, primary the accent; press scale(.98). */
  .zen-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box;
    height: var(--v2-control); padding: 0 12px; border: 0; border-radius: var(--v2-radius-control);
    background: var(--v2-fill); color: var(--v2-text);
    font-size: var(--v2-font-body); font-weight: var(--v2-weight-button); line-height: var(--v2-line-body);
    transition: background-color 120ms var(--zen-ease), transform 120ms var(--zen-ease);
  }
  .zen-btn:hover { background: var(--v2-fill-hover); }
  .zen-btn:active:not(:disabled) { transform: scale(0.98); }
  .zen-btn:disabled { opacity: 0.4; }
  .zen-btn svg { width: var(--v2-icon); height: var(--v2-icon); }
  .zen-btn-primary { background: var(--v2-accent); color: var(--v2-on-accent); }
  .zen-btn-primary:hover { background: color-mix(in srgb, var(--v2-on-accent) 12%, var(--v2-accent)); }
  .zen-btn-primary:active:not(:disabled) { background: color-mix(in srgb, var(--v2-on-accent) 30%, var(--v2-accent)); }
  /* A chip on the window itself: an alpha of the window's ink; a panel surface over an image. */
  .zen-customize { position: fixed; right: 20px; bottom: 20px; z-index: 4; background: var(--v2-window-fill); color: var(--zen-fg); }
  .zen-customize:hover { background: var(--v2-window-fill-hover); }
  body[data-bg='image'] .zen-customize { background: var(--v2-panel); color: var(--v2-text); border: 1px solid var(--v2-border); }
  body[data-bg='image'] .zen-customize:hover { background: color-mix(in srgb, var(--v2-panel) 92%, var(--v2-text)); }

  /* The Customize popover (v2 §9.20, §9.23): 320 wide, panel surface, a title block, 32 px rows. */
  .zen-panel {
    position: fixed; right: 20px; bottom: 60px; z-index: 5; box-sizing: border-box; width: 320px; padding: var(--v2-card-padding);
    background: var(--v2-panel); color: var(--v2-text); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius-card); box-shadow: var(--v2-shadow-panel);
    transform-origin: 100% 100%; animation: zen-pop 180ms var(--zen-ease);
  }
  .zen-panel h2 { margin: 0 0 16px; font-size: var(--v2-font-heading); line-height: 22px; font-weight: var(--v2-weight-heading); }
  .zen-panel h3 { margin: 12px 0 4px; font-size: var(--v2-font-body); line-height: var(--v2-line-body); font-weight: var(--v2-weight-heading); }
  .zen-panel h3:first-of-type { margin-top: 0; }
  .zen-option { display: flex; align-items: center; gap: 8px; min-height: var(--v2-row); }
  /* Proton controls (v2 §6, §9.14): 16 px radio and checkbox, 1 px border at 45%, accent when on. */
  .zen-option input {
    appearance: none; position: relative; flex: none; box-sizing: border-box; margin: 0;
    width: var(--v2-checkbox); height: var(--v2-checkbox);
    background: var(--v2-page); border: 1px solid rgb(var(--v2-text-rgb) / 0.45);
    transition: background-color 120ms var(--zen-ease), border-color 120ms var(--zen-ease);
  }
  .zen-option input[type='radio'] { border-radius: 50%; }
  .zen-option input[type='radio']:checked { border-color: var(--v2-accent); box-shadow: inset 0 0 0 4px var(--v2-accent); }
  .zen-option input[type='checkbox'] { border-radius: var(--v2-radius-checkbox); }
  .zen-option input[type='checkbox']:checked { border-color: var(--v2-accent); background: var(--v2-accent); }
  .zen-option input[type='checkbox']:checked::after {
    content: ''; position: absolute; left: 4px; top: 1px; width: 4px; height: 8px;
    border: solid var(--v2-on-accent); border-width: 0 2px 2px 0; transform: rotate(45deg);
  }
  .zen-option input:disabled { opacity: 0.4; }
  .zen-option input:disabled + span { color: var(--v2-text-deemphasized); }
  .zen-panel-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .zen-image-actions { display: flex; gap: 8px; margin: 4px 0 0 24px; }

  /* The add / edit dialog (v2 §3, §9.5, §9.20): 400 wide, radius 12, the modal scrim behind it. */
  dialog.zen-dialog {
    box-sizing: border-box; width: 400px; max-width: calc(100vw - 32px); padding: var(--v2-card-padding); margin: auto;
    background: var(--v2-panel); color: var(--v2-text);
    border: 1px solid var(--v2-border); border-radius: var(--v2-radius-sheet); box-shadow: var(--v2-shadow-sheet);
  }
  dialog.zen-dialog[open] { animation: zen-pop 180ms var(--zen-ease); }
  dialog.zen-dialog::backdrop { background: var(--v2-scrim-modal); }
  dialog.zen-dialog[open]::backdrop { animation: zen-fade 180ms var(--zen-ease); }
  .zen-dialog h2 { margin: 0 0 16px; font-size: var(--v2-font-heading); line-height: 22px; font-weight: var(--v2-weight-heading); }
  .zen-dialog label { display: block; margin: 12px 0 4px; font-size: var(--v2-font-small); line-height: var(--v2-line-small); color: var(--v2-text-deemphasized); }
  .zen-dialog label:first-of-type { margin-top: 0; }
  .zen-field {
    box-sizing: border-box; width: 100%; height: var(--v2-control); padding: 0 8px;
    background: var(--v2-page); border: 1px solid var(--v2-border); border-radius: var(--v2-radius-control);
  }
  .zen-dialog-error { min-height: var(--v2-line-small); margin: 8px 0 0; font-size: var(--v2-font-small); line-height: var(--v2-line-small); color: var(--v2-danger); }
  .zen-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }

  /* The tile's context menu (v2 §2, §6): radius 6, 31 px rows with a 16 px glyph. */
  .zen-menu {
    position: fixed; z-index: 6; box-sizing: border-box; min-width: 232px; padding: 4px;
    background: var(--v2-panel); color: var(--v2-text); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius-inner); box-shadow: var(--v2-shadow-panel);
    animation: zen-pop 180ms var(--zen-ease);
  }
  .zen-menu button {
    display: flex; align-items: center; gap: 10px; box-sizing: border-box; width: 100%; height: var(--v2-menu-row); padding: 0 10px;
    border: 0; border-radius: var(--v2-radius-control); background: transparent; text-align: left;
    font-size: 14px; font-weight: var(--v2-weight-body);
  }
  .zen-menu button:hover, .zen-menu button:focus-visible { background: var(--v2-fill); outline: none; }
  .zen-menu button svg { width: var(--v2-icon); height: var(--v2-icon); color: var(--v2-text-deemphasized); }

  /* The Undo toast: a panel surface holding a 32 px control, so 40 tall (v2 §9.21). */
  .zen-toast {
    position: fixed; left: 50%; bottom: 24px; z-index: 5; display: flex; align-items: center; gap: 12px; box-sizing: border-box;
    height: 40px; padding: 0 4px 0 12px; transform: translateX(-50%);
    background: var(--v2-panel); color: var(--v2-text); border: 1px solid var(--v2-border);
    border-radius: var(--v2-radius-card); box-shadow: var(--v2-shadow-panel);
    animation: zen-pop 180ms var(--zen-ease);
  }

  @keyframes zen-pop { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: none; } }
  @keyframes zen-fade { from { opacity: 0; } to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) {
    *, ::backdrop { animation-duration: 1ms !important; transition-duration: 1ms !important; }
  }
`

/** Lucide-style glyphs (16 px, stroke 1.5) inlined so the page needs no assets. */
export const NEW_TAB_ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  trash:
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'
} as const

export type NewTabIcon = keyof typeof NEW_TAB_ICONS

export function newTabIconSvg(name: NewTabIcon): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NEW_TAB_ICONS[name]}</svg>`
}

/** The `zen://newtab` document. Everything dynamic is added by the page script. */
export function newTabPageHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src * data: zen:;"><title>New Tab</title><style>${chromeTokenCss()}${NEW_TAB_PAGE_STYLE}</style></head>
<body>
<div class="zen-bg" id="zen-bg-current"></div><div class="zen-bg" id="zen-bg-next"></div>
<main class="zen-ntp" id="zen-ntp">
  <div class="zen-private" id="zen-private" hidden>Private</div>
  <h1 class="zen-greeting zen-on-bg" id="zen-greeting" hidden></h1>
  <form class="zen-search" id="zen-search" role="search" autocomplete="off">${newTabIconSvg('search')}<input id="zen-search-input" type="text" placeholder="Search or enter address" aria-label="Search or enter address" autocomplete="off" autocapitalize="off" spellcheck="false"></form>
  <p class="zen-empty zen-on-bg" id="zen-empty" hidden>Sites you visit often will appear here</p>
  <div class="zen-grid" id="zen-grid" role="list" aria-label="Shortcuts" hidden></div>
</main>
<button type="button" class="zen-btn zen-customize" id="zen-customize" aria-haspopup="dialog" aria-expanded="false">${newTabIconSvg('sliders')}<span>Customize</span></button>
<div class="zen-panel" id="zen-panel" role="dialog" aria-labelledby="zen-panel-title" hidden></div>
<div class="zen-menu" id="zen-menu" role="menu" hidden></div>
<dialog class="zen-dialog" id="zen-dialog" aria-labelledby="zen-dialog-title"></dialog>
<div class="zen-toast" id="zen-toast" role="status" hidden></div>
</body></html>`
}
