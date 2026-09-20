import type { ReaderArticle } from './reader'
import {
  READER_FONT_LABELS,
  READER_FONT_SIZES,
  READER_MESSAGE_KEY,
  READER_THEME_LABELS,
  READER_WIDTH_LABELS,
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
 * The page's typography follows `data-theme` / `data-font` / `data-width` on the root and the
 * `--font-size` variable; `data-theme='auto'` follows the browser's colour scheme through the
 * page's own media query (the `zen://` document is rendered with `color-scheme: light dark`, so
 * the host's forced scheme reaches it).
 */
const STYLE = `
  :root {
    --font-size: 18px; --width: 680px; --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --serif: Georgia, "Iowan Old Style", "Times New Roman", serif; --mono: ui-monospace, Menlo, Consolas, monospace; --font: var(--serif);
    --bg: #fbfbfd; --fg: #1c1c22; --muted: #66666e; --toolbar: rgba(255,255,255,.82); --border: rgba(0,0,0,.09); --link: #5b5fd6;
  }
  :root[data-theme='dark'] { --bg: #18181c; --fg: #ececf1; --muted: #a0a0ab; --toolbar: rgba(24,24,28,.86); --border: rgba(255,255,255,.1); --link: #9a9cff; color-scheme: dark; }
  @media (prefers-color-scheme: dark) {
    :root[data-theme='auto'] { --bg: #18181c; --fg: #ececf1; --muted: #a0a0ab; --toolbar: rgba(24,24,28,.86); --border: rgba(255,255,255,.1); --link: #9a9cff; color-scheme: dark; }
  }
  :root[data-theme='light'] { color-scheme: light; }
  :root[data-theme='sepia'] { --bg: #f4ecd8; --fg: #3d3020; --muted: #7d6b52; --toolbar: rgba(244,236,216,.9); --border: rgba(80,60,30,.14); --link: #8a5a2b; color-scheme: light; }
  :root[data-font='sans'] { --font: var(--sans); } :root[data-font='mono'] { --font: var(--mono); }
  :root[data-width='narrow'] { --width: 560px; } :root[data-width='wide'] { --width: 860px; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); }
  body { font-family: var(--font); font-size: var(--font-size); line-height: 1.65; -webkit-font-smoothing: antialiased; }
  .toolbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 6px; align-items: center; justify-content: center; flex-wrap: wrap; padding: 8px 12px; background: var(--toolbar); backdrop-filter: blur(18px); border-bottom: 1px solid var(--border); font-family: var(--sans); font-size: 13px; }
  .toolbar .group { display: inline-flex; gap: 2px; padding: 2px; border-radius: 12px; corner-shape: squircle; background: rgba(127,127,127,.12); }
  .toolbar button { font: inherit; color: inherit; background: transparent; border: 0; padding: 6px 10px; border-radius: 10px; corner-shape: squircle; cursor: pointer; }
  .toolbar button:hover { background: rgba(127,127,127,.18); }
  .toolbar button[aria-pressed='true'] { background: var(--bg); box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  .toolbar button:disabled { opacity: .4; cursor: default; }
  .toolbar .spacer { flex: 1; }
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
  @media print { .toolbar { display: none; } }
`

/**
 * The in-page toolbar changes the page at once and posts the change on the window; the page
 * script relays it (`READER_MESSAGE_KEY`, `zen:` documents only) and the core saves it, then
 * pushes the saved preferences to every reader page through `window.zenReaderApply` – this one
 * included, which is how a second reader tab (or the chrome's own controls) follows.
 */
const SCRIPT = `
  const root = document.documentElement;
  const sizes = ${JSON.stringify(READER_FONT_SIZES)};
  const state = JSON.parse(root.dataset.prefs || '{}');
  function render() {
    root.style.setProperty('--font-size', state.fontSize + 'px');
    root.dataset.theme = state.theme; root.dataset.font = state.font; root.dataset.width = state.width;
    for (const b of document.querySelectorAll('[data-set]')) {
      const [k, v] = b.dataset.set.split(':');
      b.setAttribute('aria-pressed', String(String(state[k]) === v));
    }
    const i = sizes.indexOf(state.fontSize);
    document.querySelector('[data-size="-1"]').disabled = i <= 0;
    document.querySelector('[data-size="1"]').disabled = i >= sizes.length - 1;
  }
  window.zenReaderApply = (prefs) => { Object.assign(state, prefs); render(); };
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const patch = {};
    if (b.dataset.size) { const i = sizes.indexOf(state.fontSize) + Number(b.dataset.size); patch.fontSize = sizes[Math.max(0, Math.min(sizes.length - 1, i))]; }
    if (b.dataset.set) { const [k, v] = b.dataset.set.split(':'); patch[k] = v; }
    window.zenReaderApply(patch);
    window.postMessage({ ${JSON.stringify(READER_MESSAGE_KEY)}: patch }, '*');
  });
  render();
`

/** The `zen://reader` document for an extracted article, rendered with the user's preferences. */
export function readerPage(article: ReaderArticle, prefs: ReaderPreferences): string {
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
  const choice = (key: keyof ReaderPreferences, value: string, label: string): string =>
    `<button data-set="${key}:${value}">${escapeHtml(label)}</button>`
  const fonts = (Object.keys(READER_FONT_LABELS) as Array<keyof typeof READER_FONT_LABELS>)
    .map((f) => choice('font', f, READER_FONT_LABELS[f]))
    .join('')
  const themes = (Object.keys(READER_THEME_LABELS) as Array<keyof typeof READER_THEME_LABELS>)
    .map((t) => choice('theme', t, READER_THEME_LABELS[t]))
    .join('')
  const widths = (Object.keys(READER_WIDTH_LABELS) as Array<keyof typeof READER_WIDTH_LABELS>)
    .map((w) => choice('width', w, READER_WIDTH_LABELS[w]))
    .join('')
  const rootAttributes = [
    `lang="${escapeHtml(article.lang ?? '')}"`,
    article.dir ? `dir="${article.dir}"` : '',
    `data-theme="${prefs.theme}"`,
    `data-font="${prefs.font}"`,
    `data-width="${prefs.width}"`,
    `data-prefs="${escapeHtml(JSON.stringify(prefs))}"`,
    `style="--font-size: ${prefs.fontSize}px"`
  ]
    .filter(Boolean)
    .join(' ')
  return `<!doctype html><html ${rootAttributes}>
<head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${escapeHtml(article.title)}</title><style>${STYLE}</style></head>
<body>
<nav class="toolbar" aria-label="Reader view controls">
  <span class="group"><button data-size="-1" title="Smaller text">A−</button><button data-size="1" title="Larger text">A+</button></span>
  <span class="group">${fonts}</span>
  <span class="group">${themes}</span>
  <span class="group">${widths}</span>
</nav>
<main>
  <header><h1>${escapeHtml(article.title)}</h1><div class="meta">${meta}</div></header>
  <article>${article.content}</article>
</main>
<script>${SCRIPT}</script>
</body></html>`
}
