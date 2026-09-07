import type { ReaderArticle } from './reader'

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )
}

const STYLE = `
  :root {
    --font-size: 18px; --width: 680px; --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --serif: Georgia, "Iowan Old Style", "Times New Roman", serif; --font: var(--serif);
    --bg: #fbfbfd; --fg: #1c1c22; --muted: #66666e; --toolbar: rgba(255,255,255,.82); --border: rgba(0,0,0,.09); --link: #5b5fd6;
  }
  :root[data-theme='dark'] { --bg: #18181c; --fg: #ececf1; --muted: #a0a0ab; --toolbar: rgba(24,24,28,.86); --border: rgba(255,255,255,.1); --link: #9a9cff; color-scheme: dark; }
  :root[data-theme='sepia'] { --bg: #f4ecd8; --fg: #3d3020; --muted: #7d6b52; --toolbar: rgba(244,236,216,.9); --border: rgba(80,60,30,.14); --link: #8a5a2b; }
  :root[data-font='sans'] { --font: var(--sans); }
  :root[data-width='narrow'] { --width: 560px; } :root[data-width='wide'] { --width: 860px; }
  html, body { margin: 0; background: var(--bg); color: var(--fg); }
  body { font-family: var(--font); font-size: var(--font-size); line-height: 1.65; -webkit-font-smoothing: antialiased; }
  .toolbar { position: sticky; top: 0; z-index: 10; display: flex; gap: 6px; align-items: center; justify-content: center; padding: 8px 12px; background: var(--toolbar); backdrop-filter: blur(18px); border-bottom: 1px solid var(--border); font-family: var(--sans); font-size: 13px; }
  .toolbar .group { display: inline-flex; gap: 2px; padding: 2px; border-radius: 12px; corner-shape: squircle; background: rgba(127,127,127,.12); }
  .toolbar button { font: inherit; color: inherit; background: transparent; border: 0; padding: 6px 10px; border-radius: 10px; corner-shape: squircle; cursor: pointer; }
  .toolbar button:hover { background: rgba(127,127,127,.18); }
  .toolbar button[aria-pressed='true'] { background: var(--bg); box-shadow: 0 1px 3px rgba(0,0,0,.12); }
  .toolbar .spacer { flex: 1; }
  main { max-width: var(--width); margin: 0 auto; padding: 40px 24px 120px; }
  header h1 { font-size: 1.9em; line-height: 1.2; margin: 0 0 12px; letter-spacing: -0.01em; }
  header .meta { font-family: var(--sans); font-size: 13px; color: var(--muted); display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 28px; }
  header .meta a { color: inherit; }
  article img, article video, article figure { max-width: 100%; height: auto; margin: 1.2em auto; display: block; border-radius: 10px; }
  article figcaption { font-family: var(--sans); font-size: 0.8em; color: var(--muted); text-align: center; }
  article a { color: var(--link); }
  article pre { font-size: 0.8em; padding: 14px 16px; overflow: auto; border-radius: 10px; background: rgba(127,127,127,.12); }
  article code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 0.9em; }
  article blockquote { margin: 1.2em 0; padding: 0 0 0 1em; border-left: 3px solid var(--border); color: var(--muted); }
  article table { border-collapse: collapse; font-size: 0.9em; } article td, article th { border: 1px solid var(--border); padding: 6px 10px; }
  article h2, article h3 { line-height: 1.3; margin-top: 1.6em; }
  @media print { .toolbar { display: none; } }
`

const SCRIPT = `
  const root = document.documentElement;
  const prefs = JSON.parse(localStorage.getItem('zen-reader') || '{}');
  const sizes = [14, 15, 16, 17, 18, 20, 22, 24, 28];
  let size = sizes.includes(prefs.size) ? prefs.size : 18;
  const themeDefault = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  const state = { theme: prefs.theme || themeDefault, font: prefs.font || 'serif', width: prefs.width || 'normal' };
  function apply() {
    root.style.setProperty('--font-size', size + 'px');
    root.dataset.theme = state.theme; root.dataset.font = state.font; root.dataset.width = state.width;
    for (const b of document.querySelectorAll('[data-set]')) {
      const [k, v] = b.dataset.set.split(':');
      b.setAttribute('aria-pressed', String(state[k] === v));
    }
    localStorage.setItem('zen-reader', JSON.stringify({ size, ...state }));
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.size) { const i = sizes.indexOf(size) + Number(b.dataset.size); size = sizes[Math.max(0, Math.min(sizes.length - 1, i))]; }
    if (b.dataset.set) { const [k, v] = b.dataset.set.split(':'); state[k] = v; }
    apply();
  });
  apply();
`

/** The `zen://reader` document for an extracted article. */
export function readerPage(article: ReaderArticle): string {
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
  return `<!doctype html><html lang="${escapeHtml(article.lang ?? '')}"${article.dir ? ` dir="${article.dir}"` : ''}>
<head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${escapeHtml(article.title)}</title><style>${STYLE}</style></head>
<body>
<nav class="toolbar" aria-label="Reader view controls">
  <span class="group"><button data-size="-1" title="Smaller text">A−</button><button data-size="1" title="Larger text">A+</button></span>
  <span class="group"><button data-set="font:serif">Serif</button><button data-set="font:sans">Sans</button></span>
  <span class="group"><button data-set="theme:light">Light</button><button data-set="theme:sepia">Sepia</button><button data-set="theme:dark">Dark</button></span>
  <span class="group"><button data-set="width:narrow" title="Narrow">▯</button><button data-set="width:normal" title="Normal">▭</button><button data-set="width:wide" title="Wide">▬</button></span>
</nav>
<main>
  <header><h1>${escapeHtml(article.title)}</h1><div class="meta">${meta}</div></header>
  <article>${article.content}</article>
</main>
<script>${SCRIPT}</script>
</body></html>`
}
