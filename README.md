# Zen on Chromium

A port of [Zen Browser](https://zen-browser.app)'s user experience to the Chromium engine.
Zen itself is a Firefox (Gecko) fork; this project rebuilds its distinctive UI and behaviours on
Blink/V8 via Electron, so pages render exactly as they do in Chrome while the browser chrome is
Zen's. The current reference is **Zen 1.22b** (September 2026).

> This is an independent port and is not affiliated with the Zen Browser team.

## What is ported

| Zen feature                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Status in this port |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Vertical tabs sidebar (single / multiple / collapsed toolbar layouts, tabs on the right, resizable, collapsible to icons, 1.22 squircle chrome and larger sidebar type)                                                                                                                                                                                                                                                                                         | Done                |
| **Spaces** – icons, per-space gradient themes, default containers, slide animation, space switcher, Space Routing ("Add Route for Domain"), "Create New Space" shortcut, open a space in a new window                                                                                                                                                                                                                                                           | Done                |
| **Essentials** – favicon tile grid at the top, container-specific, max count                                                                                                                                                                                                                                                                                                                                                                                    | Done                |
| Pinned tabs – reset to pinned URL, "close" resets/unloads/switches (all seven Zen behaviours), "Edit pinned tab…" URL editor, rename (double-click), "Change Icon…" emoji picker                                                                                                                                                                                                                                                                                | Done                |
| Folders – create, rename, collapse, unpack/delete, drag tabs in, "Move to folder…"                                                                                                                                                                                                                                                                                                                                                                              | Done                |
| **Live Folders** – GitHub pull requests (with draft filter) / GitHub issues / RSS & Atom feeds / REST endpoints with a field mapping (Zen's local schema for localhost); 15 min – 8 h refresh, dismissed items never return, folder context menu                                                                                                                                                                                                                | Done                |
| **Split View** – grid / vertical / horizontal, up to 4 tabs, resizable gutters, unsplit one or all, drag a tab onto the page edge to split, "Split link in new tab", Alt+click a tab to split it with (or separate it from) the active tab, Ctrl/Shift+click to select several tabs and open them in a split (or pin / move / folder / unload / close them together)                                                                                            | Done                |
| **Compact Mode** – hide sidebar and/or toolbar, edge-hover reveal (tracks the real cursor, so it works over pages and window borders), persistent floating sidebar (Ctrl+Alt+S), per window                                                                                                                                                                                                                                                                     | Done                |
| **Glance** – Alt/Ctrl/Shift+click preview over the current page, close / expand (Ctrl+O) / split, third-party links on pinned tabs open their own tab, fullscreen inside a Glance expands it                                                                                                                                                                                                                                                                    | Done                |
| **Window sync** – any number of windows share the same tabs, spaces, folders and split views; a tab selected in two windows keeps one live page and shows a dimmed preview in the window that does not hold it (focus brings it over); "Sync only pinned tabs in spaces" mode; every window is restored on the space it was in                                                                                                                                  | Done                |
| **Blank windows** (Ctrl+Shift+N, `--blank-window`) – an independent, temporary tab list that inherits the container of the space it was opened from, with "Move to…" to bring the tabs back                                                                                                                                                                                                                                                                     | Done                |
| **Private windows** (Ctrl+Shift+P, `--private-window`) – in-memory session, private space, no history / suggestions, purple chrome; wiped when the last private window closes                                                                                                                                                                                                                                                                                   | Done                |
| **Boosts** – per-site colour tint, fonts and text size, "zap element" picker, force dark mode, custom CSS; site-control button in the address bar, "New Boost" URL-bar command, page context-menu submenu, list in Settings                                                                                                                                                                                                                                     | Done                |
| **Reader View** (Ctrl+Alt+R) – Mozilla Readability, `zen://reader` with font size / serif–sans / light–sepia–dark / width controls, address-bar indicator when a page is readable                                                                                                                                                                                                                                                                               | Done                |
| **Cross-device sync** – Zen 1.22's "Sync your Spaces across devices" for a browser without Mozilla accounts: devices exchange end-to-end encrypted (scrypt + AES-256-GCM) record sets through any folder your cloud drive or Syncthing keeps in sync; spaces, folders, pinned tabs, Essentials, (optionally) open tabs, containers, bookmarks, settings, shortcuts and Boosts; last-writer-wins per record, merge prompt on first join, device list, "Sync now" | Done                |
| **Extensions** (Ctrl+Shift+A) – load unpacked Chrome extensions into every container, remembered across restarts, toolbar buttons with popups; the API surface is Electron's (content scripts, storage, webRequest, scripting, DevTools panels)                                                                                                                                                                                                                 | Done                |
| **Mods** – custom CSS for the browser chrome (Zen's `chrome.css` mods / `userChrome.css`): new, import from file or URL, toggle, edit live                                                                                                                                                                                                                                                                                                                      | Done                |
| Zen URL bar – floating, inline autofill, history / bookmarks / open tabs ("Switch to Tab") / spaces / Command Bar actions / live search suggestions, `` ` `` space-only mode, `@engine` keywords, draft text remembered                                                                                                                                                                                                                                         | Done                |
| Theme picker – colour wheel dots, harmony algorithms, monochrome, opacity, texture, rotation, presets                                                                                                                                                                                                                                                                                                                                                           | Done                |
| Keyboard shortcuts – Zen's default table (from `ZenKeyboardShortcuts.mjs`, schema v20), fully rebindable with conflict detection                                                                                                                                                                                                                                                                                                                                | Done                |
| Tab unloading (inactivity timeout, excluded domains, unload tab / space / other spaces)                                                                                                                                                                                                                                                                                                                                                                         | Done                |
| **Resource governor** – memory / CPU / GPU budgets the browser never exceeds: purge → throttle → freeze → unload ladders, live-page cap, queued background loads, battery / idle / suspend awareness, Chromium & V8 startup switches, live meters in Settings                                                                                                                                                                                                   | Done (this port only) |
| Containers – isolated cookie sessions per container, per-space defaults, "Open in New Container Tab", icons and colours, reorderable (1.22)                                                                                                                                                                                                                                                                                                                     | Done                |
| History, bookmarks, downloads (saved to the Downloads folder with Firefox-style unique names, or "always ask"), find in page, screenshots, save page, print, view source, zoom (1.21 fine steps), mute, PiP, multiple media controls in the sidebar                                                                                                                                                                                                             | Done                |
| Native context menus for pages, tabs (incl. Share ▸ Copy Link / Email Link), spaces, folders and the new-tab button; permission prompts remembered per site; `window.open` popups                                                                                                                                                                                                                                                                               | Done                |
| Onboarding – look, search engine (Google / DuckDuckGo / Ecosia), Essentials, feature tour (Spaces, Compact Mode, Glance & Split, Boosts, Live Folders), sync, shortcuts                                                                                                                                                                                                                                                                                         | Done                |
| Things a Chromium port cannot mirror: Mozilla account sign-in, Firefox add-ons (AMO), Gecko-only engine features (Firefox Translations, PDF merging, QWAC display)                                                                                                                                                                                                                                                                                              | Not applicable      |

## Architecture

```
src/
  shared/     Types, Zen shortcut table, URL/search/theme/boost/live-folder helpers (pure, unit tested)
  main/       Electron main process
    browser/  BrowserState (persistence, per-window snapshots), TabManager (one WebContentsView
              per tab, moved between windows), ZenWindow, sessions/containers (+ private session),
              zen:// pages (blank, error, reader), history, bookmarks, downloads, permissions,
              native menus, keyboard routing, URL-bar suggestions, Boosts, Reader View,
              Live Folders, extensions, Mods
      resources/  The resource governor: planner (pure, unit tested), governor service,
                  CDP tab lifecycle (freeze / throttle / purge), load scheduler, startup switches
    sync/     Cross-device sync: records + LWW merge (pure), crypto, folder transport, engine
  preload/    index.ts – typed IPC bridge for the chrome; page.ts – Glance / pinned-tab click rules,
              Boost "zap element" picker
  renderer/   Zen's chrome in React + Tailwind (shadcn-style primitives)
```

Every page is a `WebContentsView` owned by the main process. The React chrome of each window
measures where its content area is and reports view rectangles back; the main process positions
the views it has attached to that window. Chrome overlays (URL bar, panels, Glance frame) hide the
live views and show a dimmed snapshot of the page behind them, which is how Zen's "dim the page"
look is reproduced – the same mechanism renders the preview of a tab shown in another window.

All browser state lives in the main process and is shared by every synced window; each window
receives its own snapshot (its selection, Glance, find bar, compact state) and only sends
commands. State is persisted atomically to `<userData>/zen/*.json`; blank and private windows
are never persisted.

### Resource governor

Settings → Resources sets budgets for the whole browser (every Chromium process together):
memory in MB or as a share of installed RAM, CPU as a share of all cores, and GPU-process memory.
Every few seconds the governor samples `app.getAppMetrics()`, attributes each process to the tabs
that own it (shared renderers are split evenly, out-of-process iframes count towards their tab)
and, when a budget is exceeded, escalates cheapest-first through Chromium's own lifecycle
machinery (reached over the DevTools protocol):

- **memory** – V8 low-memory GC + browser-wide memory-pressure purge → unload hidden pages by
  score (cost × time out of sight) → purge visible pages (strict) → reload the active page when it
  alone busts the budget (extreme)
- **CPU** – throttle hidden pages 4× / 8× / 16× (`Emulation.setCPUThrottlingRate`) → freeze
  (`Page.setWebLifecycleState`) → unload pages that keep burning CPU while frozen; pages are also
  told they have proportionally fewer cores (`navigator.hardwareConcurrency`)
- **GPU** – pause muted background media → purge → unload one hidden page per cycle

Independently of pressure, hidden pages are frozen after a timeout (and at once when the system is
idle, the screen is locked or the machine suspends), unloaded after Zen's tab-unloading timeout,
a hard cap on live pages is enforced, and background loads queue up instead of all starting at
once. Budgets shrink on battery. Pages playing audio, excluded domains and pages with DevTools open
are never touched; pinned tabs and Essentials can be protected too. The process profile (renderer
process limit, per-page V8 heap cap, low-end-device mode, no back/forward cache, no prerendering,
raster threads, GPU mode) becomes Chromium command-line switches at the next launch. A page that
grows past its heap cap – or any hidden page whose renderer dies – is unloaded, not left as an error
page. `ZEN_GOVERNOR_LOG=1` prints one diagnostic line per sample.

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

On a headless Linux box run with a display, e.g. `xvfb-run -a npm run dev`. Command-line flags:
`zen https://example.com`, `zen --blank-window`, `zen --private-window`.

## Setting up sync

Zen syncs Spaces through a Mozilla account. A Chromium port has no access to Firefox Sync, so
this build brings its own transport: Settings → Sync → choose a folder that is already synced
between your computers (Dropbox, iCloud Drive, Google Drive, OneDrive, Nextcloud, Syncthing…) and
a passphrase. Each device writes one AES-256-GCM encrypted file (`zen-sync/<device>.zensync`) into
that folder; the folder never holds anything readable without the passphrase. Joining a folder
that already has data asks whether to merge or keep only the joining device's data, just like Zen
1.22. Conflicts resolve last-writer-wins per record (a space, a folder, a pinned tab, the settings
blob, …), with edits stamped when they happen.

## Default shortcuts (Linux/Windows – Cmd replaces Ctrl on macOS)

| Action                                             | Shortcut                             |
| -------------------------------------------------- | ------------------------------------ |
| New tab (opens the floating URL bar)               | Ctrl+T                               |
| New window / new blank window / new private window | Ctrl+N / Ctrl+Shift+N / Ctrl+Shift+P |
| Toggle Compact Mode                                | Ctrl+S                               |
| Toggle floating sidebar                            | Ctrl+Alt+S                           |
| Next / previous space                              | Ctrl+Alt+→ / Ctrl+Alt+←              |
| Split view grid / vertical / horizontal / unsplit  | Ctrl+Alt+G / V / H / U               |
| New empty split                                    | Ctrl+Shift+*                         |
| Pin / unpin tab                                    | Ctrl+Shift+D                         |
| Copy URL / as Markdown                             | Ctrl+Shift+C / Ctrl+Shift+Alt+C      |
| Expand Glance into a tab                           | Ctrl+O                               |
| Close all unpinned tabs                            | Ctrl+Shift+K                         |
| Reader View                                        | Ctrl+Alt+R                           |
| Add-ons and Themes                                 | Ctrl+Shift+A                         |
| Glance a link                                      | Alt+click                            |
| Split a tab with the active one                    | Alt+click the tab                    |
| Save page                                          | Ctrl+Alt+Shift+S                     |

Everything is editable in Settings → Keyboard Shortcuts.

## Notes

- The Glance trigger (Alt+click) can be swallowed by desktop environments that use Alt+click to
  move windows; change the trigger in Settings → Look and Feel → Glance if that happens.
- Ctrl+Alt+←/→ are also common desktop-workspace shortcuts on Linux; rebind them if your window
  manager grabs them first.
- Zen 1.21 lets you drag the window from empty space at the top of a web page. Pages here are
  native child views, so the chrome cannot intercept those drags; use the sidebar / toolbar.
- Extensions use Electron's Chrome-extension support, which covers content scripts, `storage`,
  `webRequest`, `scripting`, `runtime` messaging and DevTools panels but not the full Chrome API;
  extensions that rely on unsupported APIs will report errors in the Add-ons manager.
