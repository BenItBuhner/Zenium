# Memory benchmark results

Method, columns and the competitors' settings: [README.md](README.md). All runs in a cloud VM
(4 cores, 15 GB RAM, no GPU, Ubuntu 24.04, X server Xvfb) on 200 real public sites.
Steady PSS is the headline number: what the browser's whole process tree really costs while
the user cycles through the active tabs.

## Baseline (Zenium 0.5.87, before any change)

Round 1 of 3 (rounds 2 and 3 are running; this table becomes medians of 3 when they land).
Browsers: Zenium 0.5.87 (Electron), Chromium 158 (Chrome for Testing) with Memory Saver at
maximum, Firefox 161 with its tab unloader forced on, Edge 158 with sleeping tabs after 30 s.

| Tabs / active | Zenium | Chromium | Firefox | Edge |
|---|---|---|---|---|
| 50 / 5 | **2,060 MB** | 6,617 MB | rerun pending | 6,430 MB |
| 100 / 10 | **1,512 MB** | 7,836 MB | 4,548 MB | 7,217 MB |
| 200 / 20 | **2,013 MB** | 11,695 MB | 4,074 MB | 12,630 MB |

Restore (switching to a background tab until it is painted again), 200 / 20: Zenium 562 ms
(5 of 5 reloaded: they had been unloaded), Chromium 138 ms (none unloaded: Memory Saver never
acted within the run), Firefox 908 ms (unloaded), Edge 22.6 s (two restores never painted).

**Capped at 512 MB** (cgroup memory limit, 200 / 20): every browser died.

| Browser | Died after | OOM kills | Note |
|---|---|---|---|
| Zenium | 6 s | 2 | Killed while starting, before the first tab: its main process alone passes 512 MB during the first-run filter-list update. |
| Chromium | 26 min | 59 | Renderers killed one after another; tab opening timed out; the browser process went last. |
| Firefox | 44 s | 1 | |
| Edge | – | 82 | |

Full tables with peaks, RSS sums and process counts: `node bench/memory/report.mjs
bench/memory/results`.

### Where Zenium's memory goes

Idle Zenium (no page but the new tab page), 90 s after start: **~330–360 MB** — main
(browser) process 150–180, the chrome's own renderer ~55, the new tab page and its preloaded
twin ~20 each, GPU process ~60, network service ~20, zygotes ~17.

At 200 tabs / 20 active with the defaults (24 live pages): renderers ~1.3–1.6 GB (25–30
processes), main process 390–450 MB, GPU ~115 MB.

First launch on a fresh profile: the main process climbs to **~700 MB** around 20–40 s, while
the filter lists download and compile (and the background worker keeps its heap for 30 s
after), then falls back to ~160 MB by a minute.

## Changes, measured

200 tabs / 20 active, one run each unless noted; "before" is the run beside it in the same
batch. A change is kept only if steady PSS falls without restore time or failures getting
worse.

| Change | Steady PSS before → after | Restore | Kept |
|---|---|---|---|
| Code batch 1 (below), defaults | 1,961 → 1,930 MB (noise) | 565 → 581 ms | ✅ (fixes, no regression) |
| Live-page cap 24 → 4, freeze hidden pages at once | 1,930 → **1,034 MB (−46 %)** | 581 → 539 ms | next PR |
| `--js-flags=--optimize-for-size --max-semi-space-size=1` | 1,930 → 1,730 MB (−10 %) | 548 ms | under test |
| `--enable-low-end-device-mode` | 1,930 → 1,696 MB (−12 %) | 558 ms | under test |
| `--js-flags=--lite-mode` (no optimising compiler) | 1,930 → 1,604 MB (−17 %) | 716 ms (slower) | under test: costs JS speed |
| `--disable-site-isolation-trials --renderer-process-limit=4` | 1,930 → 3,017 MB (**+56 %**) | 933 ms | ❌ shared renderers cannot give an unloaded page's memory back |
| `--disable-site-isolation-trials` alone (screening, idle X) | 2,057 → 2,067 MB | | ❌ no effect: Zenium's blocking already removes most cross-site frames |

Code batch 1:

- The memory budget's share of RAM is taken of the cgroup limit (containers, systemd
  `MemoryMax=`) rather than the host's RAM.
- Hidden pages' renderers are the OOM killer's first choice (`oom_score_adj` 800, frozen 1000),
  not the browser process.
- A page is purged (critical memory pressure + GC) just before it is frozen.
- The background worker exits 3 s after its last task (was 30 s) with a small young
  generation: startup plateau 300 → 215 MB, first-run peak 700 → 550 MB (main process).
- Fixed: the load queue crashed (`TypeError` out of `tab.create`) whenever making room under the
  live-page cap discarded a page; with a low cap, tabs then loaded past the cap. This is why a
  cap of 4 first measured *worse* (3,481 MB, 55 renderers) in screening.
