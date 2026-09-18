import chromeCss from '../renderer/src/assets/main.css?raw'

/**
 * `zen://newtab`: the document of the new tab page. It is a static shell – search box, grid,
 * Customize button and the Undo toast's container – that the page script
 * (`newTabPageScript.ts`, run from the host's preload) fills from `NewTabPageState`. The page
 * has no scripts of its own and no network access beyond favicons and the custom background
 * image. It draws no popover, menu or dialog (design language v2 §9.20–9.23): the tile menu is
 * the host's, the add / edit dialog and Customize are the chrome's.
 *
 * Design: the page background is the space gradient (design language v2 §1 – the page area of an
 * empty tab is the window), painted by the page itself so a space switch crossfades over 600 ms
 * like the chrome; everything on it is a neutral v2 surface. The page defines no token of its
 * own: its stylesheet starts with the chrome's token blocks, taken verbatim from main.css at
 * build time (`chromeTokenCss`), and reads `--v2-*` for every surface, radius, size and weight;
 * the space theme's `--zen-*` values arrive inline from the page script. Motion is v1 §7: 120 ms
 * state changes, 180 ms pop for the toast, springs for the drag.
 */

/** A token block's selector: `:root`, `:root[attribute]`, or a `data-surface` family root (§9.29). */
const TOKEN_BLOCK_SELECTOR = /^(?::root(?:\[[^\]]*\])?|\[data-surface='(?:window|page)'\])$/

/**
 * The chrome's token blocks from main.css, comments dropped: the window's `:root` defaults (the
 * space theme overrides them inline), their dark overrides, then the design language v2 tokens
 * with their dark, pointer and form-factor overrides and the two `data-surface` families' control
 * roles. It stops at the first rule that is not such a block, so no chrome rule leaks into the page.
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
    if (!TOKEN_BLOCK_SELECTOR.test(selector)) break
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
  /* One focus ring (v2 §1): outside on buttons and tiles; inside on the search box. */
  :focus-visible { outline: 2px solid var(--v2-ring); outline-offset: 2px; }
  .zen-search:focus-within { outline: 2px solid var(--v2-ring); outline-offset: -2px; }
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
  .zen-tile:hover .zen-tile-menu, .zen-tile:focus-within .zen-tile-menu { opacity: 1; }
  .zen-tile-menu:hover { background: var(--v2-fill); }
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
  sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>'
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
<button type="button" class="zen-btn zen-customize" id="zen-customize" aria-haspopup="dialog">${newTabIconSvg('sliders')}<span>Customize</span></button>
<div class="zen-toast" id="zen-toast" role="status" hidden></div>
</body></html>`
}
