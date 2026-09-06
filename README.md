# Zen on Chromium

A port of [Zen Browser](https://zen-browser.app)'s user experience to the Chromium engine.
Zen itself is a Firefox (Gecko) fork; this project rebuilds its distinctive UI and behaviours on
Blink/V8, so pages render exactly as they do in Chrome while the browser chrome is Zen's.

It ships as a desktop app (Electron, Linux/Windows/macOS) and as an Android app (the system
WebView) that share the browser core and the whole React chrome. On a phone the chrome becomes a
bottom bar with the sidebar in a drawer; on a tablet, or a phone in a Samsung DeX session with a
mouse, it is the desktop layout.

> This is an independent port and is not affiliated with the Zen Browser team.

## What is ported

| Zen feature                                                                                                                                                                                                             | Status in this port |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| Vertical tabs sidebar (single / multiple / collapsed toolbar layouts, tabs on the right, resizable, collapsible to icons)                                                                                               | Done                |
| **Spaces** – icons, per-space gradient themes, default containers, slide animation, space switcher, Space Routing                                                                                                       | Done                |
| **Essentials** – favicon tile grid at the top, container-specific, max count                                                                                                                                            | Done                |
| Pinned tabs – reset to pinned URL, "close" resets/unloads/switches (all seven Zen behaviours), edit pinned URL, rename (double-click)                                                                                   | Done                |
| Folders – create, rename, collapse, unpack/delete, drag tabs in                                                                                                                                                         | Done                |
| **Split View** – grid / vertical / horizontal, up to 4 tabs, resizable gutters, unsplit one or all, drag a tab onto the page edge to split, "Split link in new tab"                                                     | Done                |
| **Compact Mode** – hide sidebar and/or toolbar, edge-hover reveal (tracks the real cursor, so it works over pages and window borders), persistent floating sidebar (Ctrl+Alt+S)                                         | Done                |
| **Glance** – Alt/Ctrl/Shift+click preview over the current page, close / expand (Ctrl+O) / split, third-party links on pinned tabs open their own tab                                                                   | Done                |
| Zen URL bar – floating, inline autofill, history / bookmarks / open tabs ("Switch to Tab") / spaces / Command Bar actions / live search suggestions, `` ` `` space-only mode, `@engine` keywords, draft text remembered | Done                |
| Theme picker – colour wheel dots, harmony algorithms, monochrome, opacity, texture, rotation, presets                                                                                                                   | Done                |
| Keyboard shortcuts – Zen's default table (from `ZenKeyboardShortcuts.mjs`), fully rebindable with conflict detection                                                                                                    | Done                |
| Tab unloading (inactivity timeout, excluded domains, unload tab / space / other spaces)                                                                                                                                 | Done                |
| Containers – isolated cookie sessions per container, per-space defaults, "Open in New Container Tab"                                                                                                                    | Done                |
| History, bookmarks, downloads (saved to the Downloads folder with Firefox-style unique names, or "always ask"), find in page, screenshots, save page, print, view source, zoom, mute, PiP                               | Done                |
| Native context menus for pages, tabs, spaces, folders and the new-tab button; permission prompts remembered per site; `window.open` popups                                                                              | Done                |
| Onboarding – look, search engine (Google / DuckDuckGo / Ecosia), Essentials, shortcuts                                                                                                                                  | Done                |
| Multiple windows / window sync, private windows, Mods & Boosts (custom CSS), Live Folders, reader view, extensions                                                                                                      | Not yet             |

## Architecture

```
src/
  shared/     Types, Zen shortcut table, URL/search/theme helpers, zen:// page HTML, the page
              click script (Glance / pinned-tab rules) – pure, unit tested
  core/       The browser: BrowserState (persistence), TabManager, Viewport (view placement),
              spaces/split/glance behaviours, history, bookmarks, downloads, permissions,
              menus, keyboard routing, URL-bar suggestions. Talks to the host only through the
              interfaces in core/platform.ts – no Electron, Node or DOM imports (lint-enforced)
  main/       Electron host: main process entry + platform/ (WebContentsView per tab, native
              menus/dialogs, sessions/containers, zen:// protocol, download tracking, fs storage)
  preload/    index.ts – typed IPC bridge for the chrome; page.ts – Electron transport for the
              page script
  renderer/   Zen's chrome in React + Tailwind (shadcn-style primitives); adapts to phone /
              tablet / desktop from the viewport and pointer type, not from the platform
  android/    Android host, JS side: runs the core inside the chrome WebView, bridges to Kotlin,
              renders context menus in the chrome (sheets on touch, popovers with a mouse), and a
              browser-only preview host for developing the mobile layout on a desktop
android/      Android host, Kotlin side (Gradle project): one WebView per tab, downloads,
              permissions, WebView profiles for containers, snapshots, hardware keyboards, DeX
```

Every page is a host-owned web view (`WebContentsView` on Electron, `WebView` on Android). The
React chrome measures where the content area is and reports view rectangles; the core positions
the views. Chrome overlays (URL bar, panels, Glance frame, the phone drawer, menus) hide the live
views and show a dimmed snapshot of the page behind them, which is how Zen's "dim the page" look
is reproduced.

All browser state lives in the core and is broadcast to the renderer as a single snapshot; the
renderer only sends commands over `window.zen` (Electron: IPC through the preload; Android: a
direct in-process call, since core and chrome share the WebView). State is persisted atomically
to `<userData>/zen/*.json` on desktop and `files/zen/*.json` on Android.

Because the core and the chrome are shared, a feature landed for the desktop app is the same
feature on Android; only the host adapters (`src/main/platform`, `src/android` + `android/`)
know which platform they are on.

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

## Android

Requirements: Node 22+, JDK 17+, an Android SDK with platform 35 / build-tools 35 (set
`ANDROID_HOME` or `android/local.properties`). Minimum Android 8.0 (API 26); containers need a
WebView with multi-profile support (Chrome 111+).

```bash
npm install
npm run build:android            # web bundle + Gradle → android/app/build/outputs/apk/debug/
npm run build:android:release    # unsigned release APK (R8) – add your signing config
```

Or use Android Studio: open `android/`; the Gradle build runs the Vite build first (pass
`-PskipWeb` to skip it when the assets are already built).

Developing the mobile chrome without a device:

```bash
npm run dev:android              # http://localhost:41734 – the Android chrome in a desktop
                                 # browser with iframes as tabs (use DevTools device emulation)
./gradlew installDebug -PdevServer=http://10.0.2.2:41734/   # emulator loads the dev server
```

Debug builds expose the chrome WebView (browser core + UI) and every tab in `chrome://inspect`.

### How the layout adapts

| Window                                                          | Layout                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Width < 600 dp (phones)                                         | Bottom bar: back, address pill (favicon, lock, space badge – swipe sideways to change space), new tab, tab count, menu. Sidebar (Essentials, pinned, folders, spaces, theme) opens as a drawer; swiping the pill switches spaces. URL bar anchors to the top above the keyboard. Menus are bottom sheets. |
| ≥ 600 dp with touch (tablets, phones in landscape)              | The desktop layout with touch-sized controls (permanent close buttons, wider split gutters); long-press for context menus.                                                                                                                                                                                |
| Mouse / trackpad present (Samsung DeX, tablets with a keyboard) | The desktop layout as on Linux/Windows: hover affordances, tab drag & drop, popover menus, Zen's full shortcut table on the hardware keyboard, freeform window resizing.                                                                                                                                  |

The decision is made from the viewport and pointer, so rotating a phone or docking it into DeX
switches layouts live.

### Feature parity on Android

Everything in the table above that lives in the core works identically: Spaces, Essentials,
pinned tabs, folders, Split View (grid / vertical / horizontal, resizable gutters), Glance
(from the long-press link menu, or Alt/Ctrl/Shift+tap with a keyboard), the URL bar and its
suggestions, Space Routing, containers (WebView profiles), themes, shortcuts, tab unloading,
history, bookmarks, downloads (Android's download manager – no pause/resume), find in page,
screenshots (to Downloads), save page (web archive), print, zoom, permissions remembered per
site, `window.open` popups, session restore.

Not available on Android: developer tools for pages (use `chrome://inspect`), view-source,
Picture-in-Picture, window controls, Compact Mode's hover reveal (tap the edge instead), tab
drag & drop with a finger (use the tab menu), per-tab mute is best-effort (mutes the page's
media elements).

## Default shortcuts (Linux/Windows – Cmd replaces Ctrl on macOS)

| Action                                            | Shortcut                        |
| ------------------------------------------------- | ------------------------------- |
| New tab (opens the floating URL bar)              | Ctrl+T                          |
| Toggle Compact Mode                               | Ctrl+S                          |
| Toggle floating sidebar                           | Ctrl+Alt+S                      |
| Next / previous space                             | Ctrl+Alt+→ / Ctrl+Alt+←         |
| Split view grid / vertical / horizontal / unsplit | Ctrl+Alt+G / V / H / U          |
| New empty split                                   | Ctrl+Shift+*                    |
| Pin / unpin tab                                   | Ctrl+Shift+D                    |
| Copy URL / as Markdown                            | Ctrl+Shift+C / Ctrl+Shift+Alt+C |
| Expand Glance into a tab                          | Ctrl+O                          |
| Close all unpinned tabs                           | Ctrl+Shift+K                    |
| Glance a link                                     | Alt+click                       |
| Save page                                         | Ctrl+Alt+Shift+S                |

Everything is editable in Settings → Keyboard Shortcuts.

## Notes

- The Glance trigger (Alt+click) can be swallowed by desktop environments that use Alt+click to
  move windows; change the trigger in Settings → Look and Feel → Glance if that happens.
- Ctrl+Alt+←/→ are also common desktop-workspace shortcuts on Linux; rebind them if your window
  manager grabs them first.
