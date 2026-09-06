# Zen on Chromium

A port of [Zen Browser](https://zen-browser.app)'s user experience to the Chromium engine.
Zen itself is a Firefox (Gecko) fork; this project rebuilds its distinctive UI and behaviours on
Blink/V8 via Electron, so pages render exactly as they do in Chrome while the browser chrome is
Zen's.

> This is an independent port and is not affiliated with the Zen Browser team.

## What is ported

| Zen feature | Status in this port |
| --- | --- |
| Vertical tabs sidebar (single / multiple / collapsed toolbar layouts, tabs on the right, resizable, collapsible to icons) | Done |
| **Spaces** – icons, per-space gradient themes, default containers, slide animation, space switcher, Space Routing | Done |
| **Essentials** – favicon tile grid at the top, container-specific, max count | Done |
| Pinned tabs – reset to pinned URL, "close" resets/unloads/switches (all seven Zen behaviours), edit pinned URL, rename (double-click) | Done |
| Folders – create, rename, collapse, unpack/delete, drag tabs in | Done |
| **Split View** – grid / vertical / horizontal, up to 4 tabs, resizable gutters, unsplit one or all, drag a tab onto the page edge to split, "Split link in new tab" | Done |
| **Compact Mode** – hide sidebar and/or toolbar, edge-hover reveal (tracks the real cursor, so it works over pages and window borders), persistent floating sidebar (Ctrl+Alt+S) | Done |
| **Glance** – Alt/Ctrl/Shift+click preview over the current page, close / expand (Ctrl+O) / split, third-party links on pinned tabs open their own tab | Done |
| Zen URL bar – floating, inline autofill, history / bookmarks / open tabs ("Switch to Tab") / spaces / Command Bar actions / live search suggestions, `` ` `` space-only mode, `@engine` keywords, draft text remembered | Done |
| Theme picker – colour wheel dots, harmony algorithms, monochrome, opacity, texture, rotation, presets | Done |
| Keyboard shortcuts – Zen's default table (from `ZenKeyboardShortcuts.mjs`), fully rebindable with conflict detection | Done |
| Tab unloading (inactivity timeout, excluded domains, unload tab / space / other spaces) | Done |
| Containers – isolated cookie sessions per container, per-space defaults, "Open in New Container Tab" | Done |
| History, bookmarks, downloads (saved to the Downloads folder with Firefox-style unique names, or "always ask"), find in page, screenshots, save page, print, view source, zoom, mute, PiP | Done |
| Native context menus for pages, tabs, spaces, folders and the new-tab button; permission prompts remembered per site; `window.open` popups | Done |
| Onboarding – look, search engine (Google / DuckDuckGo / Ecosia), Essentials, shortcuts | Done |
| Multiple windows / window sync, private windows, Mods & Boosts (custom CSS), Live Folders, reader view, extensions | Not yet |

## Architecture

```
src/
  shared/     Types, Zen shortcut table, URL/search/theme helpers (pure, unit tested)
  main/       Electron main process
    browser/  BrowserState (persistence), TabManager (WebContentsView per tab), window layout,
              sessions/containers, zen:// pages, history, bookmarks, downloads, permissions,
              native menus, keyboard routing, URL-bar suggestions
  preload/    index.ts – typed IPC bridge for the chrome; page.ts – Glance / pinned-tab click rules
  renderer/   Zen's chrome in React + Tailwind (shadcn-style primitives)
```

Every page is a `WebContentsView` owned by the main process. The React chrome measures where the
content area is and reports view rectangles back; the main process positions the views. Chrome
overlays (URL bar, panels, Glance frame) hide the live views and show a dimmed snapshot of the
page behind them, which is how Zen's "dim the page" look is reproduced.

All browser state lives in the main process and is broadcast to the renderer as a single
snapshot; the renderer only sends commands. State is persisted atomically to
`<userData>/zen/*.json`.

## Running it

Requirements: Node 22+, npm.

```bash
npm install
npm run dev          # start the browser with hot reload
```

Other scripts:

```bash
npm run typecheck    # tsc for main/preload/shared and renderer
npm run lint         # eslint
npm run test         # vitest unit tests
npm run check        # all of the above
npm run build        # production bundle in out/
npm run build:linux  # packaged app via electron-builder (also build:win / build:mac)
```

On a headless Linux box run with a display, e.g. `xvfb-run -a npm run dev`.

## Default shortcuts (Linux/Windows – Cmd replaces Ctrl on macOS)

| Action | Shortcut |
| --- | --- |
| New tab (opens the floating URL bar) | Ctrl+T |
| Toggle Compact Mode | Ctrl+S |
| Toggle floating sidebar | Ctrl+Alt+S |
| Next / previous space | Ctrl+Alt+→ / Ctrl+Alt+← |
| Split view grid / vertical / horizontal / unsplit | Ctrl+Alt+G / V / H / U |
| New empty split | Ctrl+Shift+* |
| Pin / unpin tab | Ctrl+Shift+D |
| Copy URL / as Markdown | Ctrl+Shift+C / Ctrl+Shift+Alt+C |
| Expand Glance into a tab | Ctrl+O |
| Close all unpinned tabs | Ctrl+Shift+K |
| Glance a link | Alt+click |
| Save page | Ctrl+Alt+Shift+S |

Everything is editable in Settings → Keyboard Shortcuts.

## Notes

- The Glance trigger (Alt+click) can be swallowed by desktop environments that use Alt+click to
  move windows; change the trigger in Settings → Look and Feel → Glance if that happens.
- Ctrl+Alt+←/→ are also common desktop-workspace shortcuts on Linux; rebind them if your window
  manager grabs them first.
