/**
 * `zen://newtab`: the document of the new tab page. It is a static shell – search box, grid,
 * Customize button and the containers for the panel, dialog, menu and toast – that the page
 * script (`newTabPageScript.ts`, run from the host's preload) fills from `NewTabPageState`.
 * The page has no scripts of its own and no network access beyond favicons and the custom
 * background image.
 *
 * Design: the page background is the space gradient (design language v2 §1 – the page area of an
 * empty tab is the window), painted by the page itself so a space switch crossfades over 600 ms
 * like the chrome; everything on it is a neutral v2 surface: cards (radius 8, 1 px border), a
 * panel (radius 8, border, 2 px shadow), a dialog (radius 12), 32 px controls at radius 4,
 * weights 400/500/600 only, text `#15141a` / `#fbfbfe` with 69% for deemphasised. Motion is v1
 * §7: 120 ms state changes, 180 ms pop for panel and dialog, springs for the drag.
 */

const V2_TOKENS = `
  :root {
    color-scheme: light;
    --v2-page: #fbfbfe;
    --v2-card: #f4f4f7;
    --v2-card-border: #e7e7e8;
    --v2-panel: #f4f4f4;
    --v2-border: rgb(0 0 0 / 0.15);
    --v2-text: #15141a;
    --v2-text-rgb: 21 20 26;
    --v2-text-deemphasized: rgb(21 20 26 / 0.69);
    --v2-fill: rgb(21 20 26 / 0.1);
    --v2-fill-hover: rgb(21 20 26 / 0.16);
    --v2-accent: color-mix(in srgb, var(--zen-accent, #6264dc) 40%, #000);
    --v2-on-accent: #fff;
    --v2-scrim-modal: rgb(21 20 26 / 0.45);
    --v2-shadow-panel: 0 2px 6px rgb(0 0 0 / 0.2);
    --v2-shadow-sheet: 0 10px 8px rgb(0 0 0 / 0.15);
    --v2-danger: #c43434;
    --v2-ring-offset: 0;
    --zen-ease: cubic-bezier(0.2, 0.8, 0.2, 1);
    --zen-fg: var(--v2-text);
    --zen-fg-rgb: var(--v2-text-rgb);
  }
  :root[data-theme='dark'] {
    color-scheme: dark;
    --v2-page: #1c1b22;
    --v2-card: #19181f;
    --v2-card-border: #302f38;
    --v2-panel: #1f1f1f;
    --v2-border: rgb(255 255 255 / 0.12);
    --v2-text: #fbfbfe;
    --v2-text-rgb: 251 251 254;
    --v2-text-deemphasized: rgb(251 251 254 / 0.69);
    --v2-fill: rgb(251 251 254 / 0.1);
    --v2-fill-hover: rgb(251 251 254 / 0.16);
    --v2-accent: color-mix(in srgb, var(--zen-accent, #8284f0) 40%, #fff);
    --v2-on-accent: #15141a;
    --v2-scrim-modal: rgb(0 0 0 / 0.55);
    --v2-danger: #ff8080;
    --v2-ring-offset: -2px;
  }
`

const PAGE_STYLE = `
  html, body { margin: 0; min-height: 100%; }
  html { height: 100%; }
  body {
    position: relative;
    min-height: 100%;
    background: transparent;
    color: var(--v2-text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    font-size: 15px;
    line-height: 20px;
    -webkit-font-smoothing: antialiased;
  }
  ::selection { background: color-mix(in srgb, var(--v2-accent) 30%, transparent); color: inherit; }
  button, input { font: inherit; color: inherit; }
  button { cursor: default; }
  :focus-visible { outline: 2px solid var(--v2-accent); outline-offset: var(--v2-ring-offset); }

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
  .zen-private {
    display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 10px 0 8px;
    margin-bottom: 20px; border-radius: 99px; border: 1px solid rgb(var(--zen-fg-rgb) / 0.35);
    color: var(--zen-fg); font-size: 13px; font-weight: 600; line-height: 18px;
  }
  .zen-private svg { width: 14px; height: 14px; }
  .zen-greeting { margin: 0 0 20px; font-size: 22px; line-height: 28px; font-weight: 600; color: var(--zen-fg); }

  .zen-search {
    display: flex; align-items: center; gap: 10px; box-sizing: border-box;
    width: min(560px, 100%); height: 40px; padding: 0 12px;
    background: var(--v2-page); border: 1px solid var(--v2-border); border-radius: 6px;
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.06);
  }
  .zen-search:focus-within { outline: 2px solid var(--v2-accent); outline-offset: var(--v2-ring-offset); }
  .zen-search svg { width: 16px; height: 16px; color: var(--v2-text-deemphasized); flex: none; }
  .zen-search input { flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; background: transparent; outline: none; }
  .zen-search input::placeholder { color: var(--v2-text-deemphasized); }

  .zen-empty { margin: 28px 0 0; font-size: 15px; color: rgb(var(--zen-fg-rgb) / 0.69); }
  .zen-grid { display: flex; flex-wrap: wrap; justify-content: center; gap: 12px; width: min(568px, 100%); margin-top: 28px; }
  .zen-grid[hidden] { display: none; }
  .zen-tile { position: relative; width: 104px; touch-action: none; }
  .zen-tile-link {
    display: flex; flex-direction: column; align-items: center; gap: 8px; box-sizing: border-box;
    width: 100%; height: 100px; padding: 12px 8px 0; margin: 0;
    background: var(--v2-card); border: 1px solid var(--v2-card-border); border-radius: 8px;
    color: var(--v2-text); text-decoration: none; text-align: center;
    transition: background-color 120ms var(--zen-ease), transform 120ms var(--zen-ease), box-shadow 200ms var(--zen-ease);
  }
  .zen-tile-link:hover { background: color-mix(in srgb, var(--v2-card) 96%, var(--v2-text)); }
  .zen-tile-link:active { transform: scale(0.98); }
  .zen-tile[data-dragging] { z-index: 2; }
  .zen-tile[data-dragging] .zen-tile-link { opacity: 0.9; box-shadow: var(--v2-shadow-panel); transition: none; }
  .zen-tile-icon {
    display: grid; place-items: center; width: 40px; height: 40px; box-sizing: border-box;
    background: var(--v2-page); border: 1px solid var(--v2-card-border); border-radius: 6px;
  }
  .zen-tile-icon img { width: 24px; height: 24px; object-fit: contain; border-radius: 3px; }
  .zen-tile-icon svg { width: 16px; height: 16px; color: var(--v2-text-deemphasized); }
  .zen-tile-letter { font-size: 17px; font-weight: 600; line-height: 1; color: var(--v2-text-deemphasized); }
  .zen-tile-label {
    max-width: 100%; font-size: 13px; line-height: 18px; color: var(--v2-text-deemphasized);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .zen-tile-menu {
    position: absolute; top: 4px; right: 4px; display: grid; place-items: center;
    width: 28px; height: 28px; padding: 0; border: 0; border-radius: 6px;
    background: transparent; color: var(--v2-text-deemphasized); opacity: 0;
    transition: opacity 120ms var(--zen-ease), background-color 120ms var(--zen-ease);
  }
  .zen-tile-menu svg { width: 16px; height: 16px; }
  .zen-tile:hover .zen-tile-menu, .zen-tile:focus-within .zen-tile-menu, .zen-tile-menu[aria-expanded='true'] { opacity: 1; }
  .zen-tile-menu:hover, .zen-tile-menu[aria-expanded='true'] { background: var(--v2-fill); }
  .zen-caret { position: fixed; width: 2px; border-radius: 1px; background: var(--v2-accent); pointer-events: none; z-index: 3; }

  .zen-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box;
    height: 32px; padding: 0 12px; border: 0; border-radius: 4px;
    background: var(--v2-fill); color: var(--v2-text); font-size: 15px; font-weight: 500; line-height: 20px;
    transition: background-color 120ms var(--zen-ease), transform 120ms var(--zen-ease);
  }
  .zen-btn:hover { background: var(--v2-fill-hover); }
  .zen-btn:active { transform: scale(0.98); }
  .zen-btn:disabled { opacity: 0.5; }
  .zen-btn svg { width: 16px; height: 16px; }
  .zen-btn-primary { background: var(--v2-accent); color: var(--v2-on-accent); }
  .zen-btn-primary:hover { background: color-mix(in srgb, var(--v2-accent) 88%, var(--v2-page)); }
  .zen-btn-surface { background: var(--v2-panel); border: 1px solid var(--v2-border); }
  .zen-btn-surface:hover { background: color-mix(in srgb, var(--v2-panel) 92%, var(--v2-text)); }
  .zen-customize { position: fixed; right: 20px; bottom: 20px; z-index: 4; }

  .zen-panel {
    position: fixed; right: 20px; bottom: 60px; z-index: 5; box-sizing: border-box; width: 320px; padding: 16px;
    background: var(--v2-panel); border: 1px solid var(--v2-border); border-radius: 8px; box-shadow: var(--v2-shadow-panel);
    transform-origin: 100% 100%; animation: zen-pop 180ms var(--zen-ease);
  }
  .zen-panel[hidden] { display: none; }
  .zen-panel h2 { margin: 0 0 12px; font-size: 17px; line-height: 24px; font-weight: 600; }
  .zen-panel h3 { margin: 12px 0 2px; font-size: 15px; line-height: 20px; font-weight: 600; }
  .zen-option { display: flex; align-items: center; gap: 10px; min-height: 32px; }
  .zen-option input { width: 16px; height: 16px; margin: 0; accent-color: var(--v2-accent); flex: none; }
  .zen-option input:disabled + span { color: var(--v2-text-deemphasized); }
  .zen-panel-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .zen-image-actions { display: flex; gap: 8px; margin: 4px 0 0 26px; }

  dialog.zen-dialog {
    box-sizing: border-box; width: 360px; max-width: calc(100vw - 32px); padding: 16px; margin: auto;
    background: var(--v2-panel); color: var(--v2-text);
    border: 1px solid var(--v2-border); border-radius: 12px; box-shadow: var(--v2-shadow-sheet);
  }
  dialog.zen-dialog[open] { animation: zen-pop 180ms var(--zen-ease); }
  dialog.zen-dialog::backdrop { background: var(--v2-scrim-modal); }
  dialog.zen-dialog[open]::backdrop { animation: zen-fade 180ms var(--zen-ease); }
  .zen-dialog h2 { margin: 0 0 8px; font-size: 17px; line-height: 24px; font-weight: 600; }
  .zen-dialog label { display: block; margin: 12px 0 4px; font-size: 13px; line-height: 18px; color: var(--v2-text-deemphasized); }
  .zen-field {
    box-sizing: border-box; width: 100%; height: 32px; padding: 0 8px;
    background: var(--v2-page); border: 1px solid var(--v2-border); border-radius: 4px;
  }
  .zen-field:focus { outline: 2px solid var(--v2-accent); outline-offset: var(--v2-ring-offset); }
  .zen-dialog-error { min-height: 18px; margin: 8px 0 0; font-size: 13px; line-height: 18px; color: var(--v2-danger); }
  .zen-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }

  .zen-menu {
    position: fixed; z-index: 6; box-sizing: border-box; min-width: 200px; padding: 4px;
    background: var(--v2-panel); border: 1px solid var(--v2-border); border-radius: 8px; box-shadow: var(--v2-shadow-panel);
    animation: zen-pop 180ms var(--zen-ease);
  }
  .zen-menu[hidden] { display: none; }
  .zen-menu button {
    display: flex; align-items: center; gap: 10px; box-sizing: border-box; width: 100%; height: 31px; padding: 0 10px;
    border: 0; border-radius: 4px; background: transparent; text-align: left; font-size: 14px; font-weight: 400;
  }
  .zen-menu button:hover, .zen-menu button:focus-visible { background: var(--v2-fill); outline: none; }
  .zen-menu button svg { width: 16px; height: 16px; color: var(--v2-text-deemphasized); }

  .zen-toast {
    position: fixed; left: 50%; bottom: 24px; z-index: 5; display: flex; align-items: center; gap: 12px; box-sizing: border-box;
    height: 44px; padding: 0 6px 0 14px; transform: translateX(-50%);
    background: var(--v2-panel); border: 1px solid var(--v2-border); border-radius: 8px; box-shadow: var(--v2-shadow-panel);
    animation: zen-pop 180ms var(--zen-ease);
  }
  .zen-toast[hidden] { display: none; }

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
    '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  mask: '<path d="M2 12a5 5 0 0 0 5 5 8 8 0 0 1 5 2 8 8 0 0 1 5-2 5 5 0 0 0 5-5V7H2Z"/><path d="M6 11c1.5 0 3 .5 3 2-2 0-3 0-3-2Z"/><path d="M18 11c-1.5 0-3 .5-3 2 2 0 3 0 3-2Z"/>'
} as const

export type NewTabIcon = keyof typeof NEW_TAB_ICONS

export function newTabIconSvg(name: NewTabIcon): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NEW_TAB_ICONS[name]}</svg>`
}

/** The `zen://newtab` document. Everything dynamic is added by the page script. */
export function newTabPageHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src * data: zen:;"><title>New Tab</title><style>${V2_TOKENS}${PAGE_STYLE}</style></head>
<body>
<div class="zen-bg" id="zen-bg-current"></div><div class="zen-bg" id="zen-bg-next"></div>
<main class="zen-ntp" id="zen-ntp">
  <div class="zen-private zen-on-bg" id="zen-private" hidden>${newTabIconSvg('mask')}<span>Private</span></div>
  <h1 class="zen-greeting zen-on-bg" id="zen-greeting" hidden></h1>
  <form class="zen-search" id="zen-search" role="search" autocomplete="off">${newTabIconSvg('search')}<input id="zen-search-input" type="text" placeholder="Search or enter address" aria-label="Search or enter address" autocomplete="off" autocapitalize="off" spellcheck="false"></form>
  <p class="zen-empty zen-on-bg" id="zen-empty" hidden>Sites you visit often will appear here.</p>
  <div class="zen-grid" id="zen-grid" role="list" aria-label="Shortcuts" hidden></div>
</main>
<button type="button" class="zen-btn zen-btn-surface zen-customize" id="zen-customize" aria-haspopup="dialog" aria-expanded="false">${newTabIconSvg('sliders')}<span>Customize</span></button>
<div class="zen-panel" id="zen-panel" role="dialog" aria-labelledby="zen-panel-title" hidden></div>
<div class="zen-menu" id="zen-menu" role="menu" hidden></div>
<dialog class="zen-dialog" id="zen-dialog" aria-labelledby="zen-dialog-title"></dialog>
<div class="zen-toast" id="zen-toast" role="status" hidden></div>
</body></html>`
}
