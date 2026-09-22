import type { ReaderArticle } from './reader'
import {
  LINE_FOCUS_MASK_CLASS,
  READER_LINE_FOCUS_ATTRIBUTE,
  READER_SPACING_ATTRIBUTE,
  READER_SYLLABLES_ATTRIBUTE,
  SYLLABLE_MARK_CLASS,
  type ReaderPreferences
} from '../shared/reader'
import { READ_ALOUD_SENTENCE_HIGHLIGHT, READ_ALOUD_WORD_HIGHLIGHT } from '../shared/readAloud'

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

/**
 * What the document shows of the article (`ReaderService.shown`): the content with every unit
 * wrapped as `<span data-zu>` (CT-36: a translation swaps a unit's content in place), the title
 * and the language as shown – the translation's while it shows, else the article's own.
 */
export interface ReaderShown {
  content: string
  title: string
  lang: string | null
}

/**
 * The page's typography follows `data-theme` / `data-font` / `data-width` on the root and the
 * `--font-size` variable; `data-theme='auto'` follows the browser's colour scheme through the
 * page's own media query (the `zen://` document is rendered with `color-scheme: light dark`, so
 * the host's forced scheme reaches it). The document carries no toolbar of its own: a `zen://`
 * document is chrome (v2 §10.1), and its preferences – the text, the extras, read aloud – live
 * in the pill chip's Text preferences popover and sheet, the one home for them.
 */
const STYLE = `
  :root {
    --font-size: 18px; --width: 680px; --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --serif: Georgia, "Iowan Old Style", "Times New Roman", serif; --mono: ui-monospace, Menlo, Consolas, monospace; --font: var(--serif);
    --bg: #fbfbfd; --fg: #1c1c22; --muted: #66666e; --border: rgba(0,0,0,.09); --link: #5b5fd6;
  }
  :root[data-theme='dark'] { --bg: #18181c; --fg: #ececf1; --muted: #a0a0ab; --border: rgba(255,255,255,.1); --link: #9a9cff; color-scheme: dark; }
  @media (prefers-color-scheme: dark) {
    :root[data-theme='auto'] { --bg: #18181c; --fg: #ececf1; --muted: #a0a0ab; --border: rgba(255,255,255,.1); --link: #9a9cff; color-scheme: dark; }
  }
  :root[data-theme='light'] { color-scheme: light; }
  :root[data-theme='sepia'] { --bg: #f4ecd8; --fg: #3d3020; --muted: #7d6b52; --border: rgba(80,60,30,.14); --link: #8a5a2b; color-scheme: light; }
  :root[data-font='sans'] { --font: var(--sans); } :root[data-font='mono'] { --font: var(--mono); }
  :root[data-width='narrow'] { --width: 560px; } :root[data-width='wide'] { --width: 860px; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); }
  body { font-family: var(--font); font-size: var(--font-size); line-height: 1.65; -webkit-font-smoothing: antialiased; }
  main { max-width: var(--width); margin: 0 auto; padding: 40px 24px 120px; }
  header h1 { font-size: 1.9em; line-height: 1.2; margin: 0 0 12px; letter-spacing: -0.01em; }
  header .meta { font-family: var(--sans); font-size: 13px; color: var(--muted); display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 28px; }
  header .meta a { color: inherit; }
  article img, article video, article figure { max-width: 100%; height: auto; margin: 1.2em auto; display: block; border-radius: 10px; }
  article figcaption { font-family: var(--sans); font-size: 0.8em; color: var(--muted); text-align: center; }
  article a { color: var(--link); }
  article pre { font-size: 0.8em; padding: 14px 16px; overflow: auto; border-radius: 10px; background: rgba(127,127,127,.12); }
  article code { font-family: var(--mono); font-size: 0.9em; }
  article blockquote { margin: 1.2em 0; padding: 0 0 0 1em; border-left: 3px solid var(--border); color: var(--muted); }
  article table { border-collapse: collapse; font-size: 0.9em; } article td, article th { border: 1px solid var(--border); padding: 6px 10px; }
  article h2, article h3 { line-height: 1.3; margin-top: 1.6em; }
  ::highlight(${READ_ALOUD_SENTENCE_HIGHLIGHT}) { background-color: rgba(255, 214, 10, 0.32); }
  ::highlight(${READ_ALOUD_WORD_HIGHLIGHT}) { background-color: rgba(255, 149, 0, 0.6); }
  :root[data-theme='dark'] ::highlight(${READ_ALOUD_SENTENCE_HIGHLIGHT}) { background-color: rgba(255, 214, 10, 0.22); }
  @media (prefers-color-scheme: dark) { :root[data-theme='auto'] ::highlight(${READ_ALOUD_SENTENCE_HIGHLIGHT}) { background-color: rgba(255, 214, 10, 0.22); } }
  :root[data-spacing='wide'] article { letter-spacing: 0.06em; word-spacing: 0.16em; line-height: 1.9; }
  :root[data-spacing='wider'] article { letter-spacing: 0.12em; word-spacing: 0.32em; line-height: 2.15; }
  .${SYLLABLE_MARK_CLASS}::before { content: '\\00B7'; color: var(--muted); opacity: 0.8; }
  .${LINE_FOCUS_MASK_CLASS} { position: fixed; left: 0; right: 0; z-index: 20; pointer-events: none; background: color-mix(in srgb, var(--bg) 78%, transparent); }
  @media print { .${LINE_FOCUS_MASK_CLASS} { display: none; } .${SYLLABLE_MARK_CLASS}::before { content: none; } }
`

/**
 * The chrome's controls (the Text preferences popover or sheet, Settings) change the saved
 * preferences through the core, which pushes them to every reader page through
 * `window.zenReaderApply`; the script renders them onto the root – the typography as
 * attributes and the font size variable, the extras as the attributes `shared/readerExtras.ts`
 * watches (the page script installs it in `zen://reader` documents on both hosts).
 */
const SCRIPT = `
  const root = document.documentElement;
  const state = JSON.parse(root.dataset.prefs || '{}');
  function render() {
    root.style.setProperty('--font-size', state.fontSize + 'px');
    root.dataset.theme = state.theme; root.dataset.font = state.font; root.dataset.width = state.width;
    root.setAttribute(${JSON.stringify(READER_LINE_FOCUS_ATTRIBUTE)}, String(state.lineFocus || 0));
    root.setAttribute(${JSON.stringify(READER_SPACING_ATTRIBUTE)}, state.spacing || 'normal');
    root.setAttribute(${JSON.stringify(READER_SYLLABLES_ATTRIBUTE)}, String(state.syllables === true));
  }
  window.zenReaderApply = (prefs) => { Object.assign(state, prefs); render(); };
  window.zenReaderShow = (units, title, lang) => {
    for (const [id, html] of units) {
      const el = document.querySelector('main > article [data-zu="' + id + '"]');
      if (el && el.innerHTML !== html) el.innerHTML = html;
    }
    if (typeof title === 'string') {
      const h1 = document.querySelector('main > header h1');
      if (h1) h1.textContent = title;
      document.title = title;
    }
    if (lang !== undefined) root.lang = lang || '';
  };
  render();
`

/**
 * The `zen://reader` document for an extracted article, rendered with the user's preferences and
 * with what the article shows now (`shown`: the translation where one stands, CT-36). The core
 * swaps units, the title and the language in the open document through `window.zenReaderShow`
 * (a translation's batches, the Show original toggle); a fresh load renders them from here.
 */
export function readerPage(
  article: ReaderArticle,
  prefs: ReaderPreferences,
  shown: ReaderShown
): string {
  const minutes = Math.max(1, Math.round(article.length / 1100))
  const host = (() => {
    try {
      return new URL(article.url).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  })()
  const meta = [
    article.byline ? `<span>${escapeHtml(article.byline)}</span>` : '',
    `<a href="${escapeHtml(article.url)}">${escapeHtml(article.siteName || host)}</a>`,
    `<span>${minutes} min read</span>`
  ]
    .filter(Boolean)
    .join('<span aria-hidden="true">·</span>')
  const rootAttributes = [
    `lang="${escapeHtml(shown.lang ?? '')}"`,
    article.dir ? `dir="${article.dir}"` : '',
    `data-theme="${prefs.theme}"`,
    `data-font="${prefs.font}"`,
    `data-width="${prefs.width}"`,
    `${READER_LINE_FOCUS_ATTRIBUTE}="${prefs.lineFocus}"`,
    `${READER_SPACING_ATTRIBUTE}="${prefs.spacing}"`,
    `${READER_SYLLABLES_ATTRIBUTE}="${prefs.syllables}"`,
    `data-prefs="${escapeHtml(JSON.stringify(prefs))}"`,
    `style="--font-size: ${prefs.fontSize}px"`
  ]
    .filter(Boolean)
    .join(' ')
  return `<!doctype html><html ${rootAttributes}>
<head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${escapeHtml(shown.title)}</title><style>${STYLE}</style></head>
<body>
<main>
  <header><h1>${escapeHtml(shown.title)}</h1><div class="meta">${meta}</div></header>
  <article>${shown.content}</article>
</main>
<script>${SCRIPT}</script>
</body></html>`
}
