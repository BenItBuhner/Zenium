import chromeCss from '../renderer/src/assets/main.css?raw'

/**
 * `zen://newtab`: the document of the new tab page. It is a static shell – search box, grid,
 * Customize button and the Undo toast's container – that the page script
 * (`newTabPageScript.ts`, run from the host's preload) fills from `NewTabPageState`. The page
 * has no scripts of its own and no network access beyond favicons and the custom background
 * image. It draws no popover, menu or dialog (design language v2 §9.20–9.23): the tile menu is
 * the host's, the add / edit dialog and Customize are the chrome's.
 *
 * Design: the page is the window showing through the frame (design language v2 §9.29, as Zen's
 * blank tab is) – the space gradient, painted by the page itself so a space switch crossfades
 * over 600 ms like the chrome, with the tiles, captions and Customize in the window's ink and
 * fills, and the search field a page surface on it. The page defines no token of its own: its
 * stylesheet starts with the chrome's token blocks, taken verbatim from main.css at build time
 * (`chromeTokenCss`), then the new tab page's shared rules – the one `.zen-ntp-*` vocabulary the
 * phone page draws with, cut from main.css as well (`newTabSharedCss`) – and reads `--v2-*` for
 * every surface, radius, size and weight; the space theme's `--zen-*` values arrive inline from
 * the page script. Motion is v1 §7: 120 ms state changes, 180 ms pop for the toast, springs for
 * the drag.
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
 * Where the new tab page's shared rules start in main.css: the one `.zen-ntp-*` block both pages
 * draw with (`v2Tokens.test.ts` lists it among the v2 surfaces). The rules run from the field to
 * the comment that opens the phone page's own additions, which are gated on the phone form factor
 * and never wanted here.
 */
export const NEW_TAB_RULES_START = '.zen-ntp-field {'
export const NEW_TAB_RULES_END = "/*\n   * The phone's page (components/newtab/NewTabPage.tsx)"

/**
 * The new tab page's shared rules, cut from the chrome's stylesheet (design language v2 §9.29,
 * one vocabulary on both platforms): the field's surface, radius, shadow and no border; the
 * tile's fill, radius, hover and press; the caption's, the empty sentence's and the fallbacks'
 * ink; the picture's scrim. Comments dropped, blank lines collapsed. Every size is left to each
 * platform's layout (`NEW_TAB_PAGE_STYLE` here, the phone page's classes there). An empty string
 * when a marker is gone – the page then degrades to its layout over the tokens rather than
 * failing (`newTabPage.test.ts` fails instead).
 */
export function newTabSharedCss(css: string = chromeCss): string {
  const start = css.indexOf(NEW_TAB_RULES_START)
  const end = start === -1 ? -1 : css.indexOf(NEW_TAB_RULES_END, start)
  if (end === -1) return ''
  return css
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\n(?:[ \t]*\n)+/g, '\n')
    .trim()
}

/**
 * The page's own rules: its layout. Every colour, radius and weight comes from the shared rules
 * or is a token read from the blocks above; the only literals are the page's sizes (the field's
 * 48 × 560, the four by two grid of 64 px tiles at a 12 gap, the 32 px favicon, the 8 under a
 * tile, the 12 in from the corner – the desktop's numbers in §9.29) and the v1 motion timings.
 *
 * The page is the window (design language v2 §9.29): its root is `data-surface="window"`, so
 * the tiles, captions, empty sentence, explainer and Customize draw in the window's ink and
 * fills (`--v2-control-*` resolve to the window family); the search field and the Undo toast
 * are page surfaces on it. Over a picture the ink is white and the fills white alphas under a
 * neutral scrim. The class names are the phone page's (`NewTabPage.tsx`, #51) so the two pages
 * are one vocabulary: `zen-ntp-field`, `zen-v2-shortcut`, `zen-ntp-tile`, `zen-ntp-caption`,
 * `zen-ntp-empty`, `zen-ntp-icon`, `zen-ntp-letter`, `zen-ntp-scrim`.
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
    color: var(--v2-control-text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    font-size: var(--v2-font-body);
    line-height: var(--v2-line-body);
    font-weight: var(--v2-weight-body);
    -webkit-font-smoothing: antialiased;
  }
  /* Over a picture (§9.29): white ink, white fills a little stronger, the scrim below. */
  body[data-bg='image'] {
    --zen-fg: #fff;
    --zen-fg-rgb: 255 255 255;
    --v2-window-fill: rgb(255 255 255 / 0.16);
    --v2-window-fill-hover: rgb(255 255 255 / 0.26);
  }
  ::selection { background: var(--v2-selection); color: inherit; }
  button, input { font: inherit; color: inherit; }
  button { cursor: default; }
  svg { stroke-width: var(--v2-icon-stroke); }
  /* The script shows and hides with the attribute; a class setting display must not win over it. */
  [hidden] { display: none !important; }
  /* One focus ring (v2 §1): 2 px accent, outside on buttons and tiles, inside on the field. */
  :focus-visible { outline: 2px solid var(--v2-ring); outline-offset: 2px; }
  .zen-ntp-field:focus-within { outline: 2px solid var(--v2-ring); outline-offset: -2px; }
  .zen-ntp-field input:focus-visible { outline: none; }

  /* Two stacked background layers: the next background fades in over the current one. */
  .zen-bg { position: fixed; inset: 0; z-index: -2; background-position: center; background-size: cover; background-repeat: no-repeat; }
  #zen-bg-next { opacity: 0; transition: opacity 600ms var(--zen-ease); }
  #zen-bg-next[data-fading] { opacity: 1; }
  /* The legibility scrim over a picture (its gradient is the shared rule's). */
  .zen-ntp-scrim { position: fixed; inset: 0; z-index: -1; }
  body:not([data-bg='image']) .zen-ntp-scrim { display: none; }

  .zen-ntp {
    display: flex; flex-direction: column; align-items: center;
    box-sizing: border-box; min-height: 100vh;
    padding: clamp(48px, 26vh, 220px) 24px 96px;
  }
  .zen-greeting {
    margin: 0 0 20px; color: var(--v2-control-text);
    font-size: var(--v2-font-title); line-height: 28px; font-weight: var(--v2-weight-heading);
  }

  /*
   * The resting field is the floating URL bar's field (§9.29): 48 tall, at most 560 wide, a 20 px
   * glyph, the placeholder 15/400 at 69 %; its surface, radius 12, panel shadow and no border are
   * the shared rule's. A page surface on the window: it takes the page family.
   */
  .zen-ntp-field {
    display: flex; align-items: center; gap: 12px; box-sizing: border-box;
    width: min(560px, 100%); height: 48px; padding: 0 16px;
  }
  .zen-ntp-field svg { width: 20px; height: 20px; color: var(--v2-text-deemphasized); flex: none; }
  .zen-ntp-field input {
    flex: 1; min-width: 0; height: 100%; padding: 0; border: 0; background: transparent;
    font-size: var(--v2-font-body); font-weight: var(--v2-weight-body); line-height: var(--v2-line-body); color: var(--v2-text);
  }
  .zen-ntp-field input::placeholder { color: var(--v2-text-deemphasized); opacity: 1; }

  /* Empty state (§9.17): the shared rule's one sentence in the deemphasised window ink, 32 under the field. */
  .zen-ntp-empty { margin: 32px 0 0; }

  /*
   * A private window's explainer stands where the tiles would (§9.29): a title block (§9.23) –
   * padding 16, the title 17/600 at 22, the description 15 at 69 % 4 under it – centred, in the
   * window's ink. The block's 16 padding under a 16 margin puts the title's line 32 below the field.
   */
  .zen-ntp-private { box-sizing: border-box; width: min(560px, 100%); margin: 16px 0 0; padding: 16px; text-align: center; }
  .zen-ntp-private h2 { margin: 0; color: var(--v2-control-text); font-size: var(--v2-font-heading); line-height: 22px; font-weight: var(--v2-weight-heading); }
  .zen-ntp-private p { margin: 4px 0 0; color: var(--v2-control-text-deemphasized); }

  /*
   * The grid (§9.29): four columns by two rows at a 12 gap, centred under the field. A cell is a
   * 104 px column – the 64 tile centred in it, the caption across it – so the grid is 452 wide;
   * narrower pages shrink the columns, never the gap.
   */
  .zen-grid {
    display: grid; grid-template-columns: repeat(4, minmax(0, 104px)); gap: 12px; justify-content: center;
    width: min(452px, 100%); margin-top: 32px;
  }
  .zen-tile { position: relative; min-width: 0; touch-action: none; }
  /* The shortcut: tile and caption as one target, 8 between them, no card behind them. */
  .zen-v2-shortcut {
    display: flex; flex-direction: column; align-items: center; gap: 8px; box-sizing: border-box;
    width: 100%; margin: 0; padding: 0; border: 0; background: transparent;
    color: inherit; text-decoration: none; text-align: center;
  }
  .zen-v2-shortcut:focus-visible { outline: none; }
  .zen-v2-shortcut:focus-visible .zen-ntp-tile { outline: 2px solid var(--v2-ring); outline-offset: 2px; }
  /* The tile: a 64 square holding the 32 favicon; its fill, radius, hover and press are the shared rules'. */
  .zen-ntp-tile { display: grid; place-items: center; flex: none; box-sizing: border-box; width: 64px; height: 64px; }
  .zen-ntp-icon { width: 32px; height: 32px; }
  /* The fallbacks – the site's letter, or the globe when there is none – at 32, in the shared rules' ink. */
  .zen-ntp-tile svg { width: 32px; height: 32px; }
  .zen-tile-add .zen-ntp-tile svg { width: 24px; height: 24px; }
  /* The caption: the shared rules' 13 in the deemphasised window ink, one line with an ellipsis. */
  .zen-ntp-caption { display: block; max-width: 100%; }
  /* Dragging (v2 §9.4): the tile lifts to v1 level 2 at 90%; the page script adds scale(1.02). */
  .zen-tile[data-dragging] { z-index: 2; }
  .zen-tile[data-dragging] .zen-v2-shortcut { opacity: 0.9; }
  .zen-tile[data-dragging] .zen-ntp-tile { box-shadow: var(--zen-shadow-2); transition: none; }
  .zen-caret { position: fixed; width: 2px; border-radius: 1px; background: var(--v2-accent); pointer-events: none; z-index: 3; }

  /*
   * The shared v2 button (main.css's \`.zen-v2-button\`, same geometry: the control's height and
   * radius, padding 16, weight 500, press scale(.98)), reading the surface's control roles so it
   * takes the window family on the page and the page family in the toast; a 16 glyph sits 8
   * before the label.
   */
  .zen-v2-button {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; box-sizing: border-box;
    height: var(--v2-control); min-width: 96px; padding: 0 16px; border: 0; border-radius: var(--v2-radius-control);
    background: var(--v2-control-fill); color: var(--v2-control-text);
    font-size: var(--v2-font-body); font-weight: var(--v2-weight-button); line-height: var(--v2-line-body); white-space: nowrap;
    transition: background-color 120ms var(--zen-ease), transform 120ms var(--zen-ease);
  }
  .zen-v2-button:hover { background: var(--v2-control-fill-hover); }
  .zen-v2-button:active:not(:disabled) { background: var(--v2-control-fill-hover); transform: scale(0.98); }
  .zen-v2-button:disabled { opacity: 0.4; }
  .zen-v2-button svg { width: var(--v2-icon); height: var(--v2-icon); flex: none; }
  /* Customize (§9.29): the window-family button 12 in from the page's bottom trailing corner. */
  .zen-customize { position: fixed; right: 12px; bottom: 12px; z-index: 4; }

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

/** Lucide-style glyphs (stroke 1.5; sized by the stylesheet) inlined so the page needs no assets. */
export const NEW_TAB_ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  globe:
    '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  sliders: '<path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4"/>'
} as const

export type NewTabIcon = keyof typeof NEW_TAB_ICONS

export function newTabIconSvg(name: NewTabIcon): string {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${NEW_TAB_ICONS[name]}</svg>`
}

/**
 * What a private window's page says where its tiles would be (design language v2 §9.29, a
 * §9.23 title block): sentence case, no dash, no link until there is a page to link.
 */
export const PRIVATE_EXPLAINER = {
  title: "You're in a private window",
  description:
    "Zenium won't keep this window's history, cookies or site data after you close it. Your school, employer or internet provider can still see what you visit."
} as const

/** The `zen://newtab` document. Everything dynamic is added by the page script. */
export function newTabPageHtml(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src * data: zen:;"><title>New Tab</title><style>${chromeTokenCss()}\n${newTabSharedCss()}${NEW_TAB_PAGE_STYLE}</style></head>
<body data-surface="window">
<div class="zen-bg" id="zen-bg-current"></div><div class="zen-bg" id="zen-bg-next"></div><div class="zen-ntp-scrim" aria-hidden="true"></div>
<main class="zen-ntp" id="zen-ntp">
  <h1 class="zen-greeting" id="zen-greeting" hidden></h1>
  <form class="zen-ntp-field" id="zen-search" role="search" autocomplete="off" data-surface="page">${newTabIconSvg('search')}<input id="zen-search-input" type="text" placeholder="Search or enter address" aria-label="Search or enter address" autocomplete="off" autocapitalize="off" spellcheck="false"></form>
  <section class="zen-ntp-private" id="zen-private" aria-labelledby="zen-private-title" hidden><h2 id="zen-private-title">${PRIVATE_EXPLAINER.title}</h2><p>${PRIVATE_EXPLAINER.description}</p></section>
  <p class="zen-ntp-empty" id="zen-empty" hidden>Sites you visit often will appear here</p>
  <div class="zen-grid" id="zen-grid" role="list" aria-label="Shortcuts" hidden></div>
</main>
<button type="button" class="zen-v2-button zen-customize" id="zen-customize" aria-haspopup="dialog">${newTabIconSvg('sliders')}<span>Customize</span></button>
<div class="zen-toast" id="zen-toast" role="status" data-surface="page" hidden></div>
</body></html>`
}
