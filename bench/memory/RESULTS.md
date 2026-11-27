# Memory benchmark results

Method, columns and the competitors' settings: [README.md](README.md). All runs in a cloud VM
(4 cores, 15 GB RAM, no GPU, Ubuntu 24.04, X server Xvfb) on 200 real public sites.
Steady PSS is the headline number: what the browser's whole process tree really costs while
the user cycles through the active tabs.

## Baseline (Zenium 0.5.87, before any change)

Round 1 of 3 (rounds 2 and 3 are running; this table becomes medians of 3 when they land).
Browsers: Zenium 0.5.87 (Electron), Chromium 158 (Chrome for Testing) with Memory Saver at
maximum, Firefox 161 with its tab unloader forced on, Edge 158 with sleeping tabs after 30 s.

| Tabs / active | Zenium       | Chromium  | Firefox       | Edge      |
| ------------- | ------------ | --------- | ------------- | --------- |
| 50 / 5        | **2,060 MB** | 6,617 MB  | rerun pending | 6,430 MB  |
| 100 / 10      | **1,512 MB** | 7,836 MB  | 4,548 MB      | 7,217 MB  |
| 200 / 20      | **2,013 MB** | 11,695 MB | 4,074 MB      | 12,630 MB |

Restore (switching to a background tab until it is painted again), 200 / 20: Zenium 562 ms
(5 of 5 reloaded: they had been unloaded), Chromium 138 ms (none unloaded: Memory Saver never
acted within the run), Firefox 908 ms (unloaded), Edge 22.6 s (two restores never painted).

**Capped at 512 MB** (cgroup memory limit, 200 / 20): every browser died.

| Browser  | Died after | OOM kills | Note                                                                                                                       |
| -------- | ---------- | --------- | -------------------------------------------------------------------------------------------------------------------------- |
| Zenium   | 6 s        | 2         | Killed while starting, before the first tab: its main process alone passes 512 MB during the first-run filter-list update. |
| Chromium | 26 min     | 59        | Renderers killed one after another; tab opening timed out; the browser process went last.                                  |
| Firefox  | 44 s       | 1         |                                                                                                                            |
| Edge     | –          | 82        |                                                                                                                            |

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

| Change                                                       | Steady PSS before → after    | Restore         | Kept                                                                   |
| ------------------------------------------------------------ | ---------------------------- | --------------- | ---------------------------------------------------------------------- |
| Code batch 1 (below), defaults                               | 1,961 → 1,930 MB (noise)     | 565 → 581 ms    | ✅ (fixes, no regression)                                              |
| Live-page cap 24 → 4, freeze hidden pages at once            | 1,930 → **1,034 MB (−46 %)** | 581 → 539 ms    | next PR                                                                |
| `--js-flags=--optimize-for-size --max-semi-space-size=1`     | 1,930 → 1,730 MB (−10 %)     | 548 ms          | under test                                                             |
| `--enable-low-end-device-mode`                               | 1,930 → 1,696 MB (−12 %)     | 558 ms          | under test                                                             |
| `--js-flags=--lite-mode` (no optimising compiler)            | 1,930 → 1,604 MB (−17 %)     | 716 ms (slower) | under test: costs JS speed                                             |
| `--disable-site-isolation-trials --renderer-process-limit=4` | 1,930 → 3,017 MB (**+56 %**) | 933 ms          | ❌ shared renderers cannot give an unloaded page's memory back         |
| `--disable-site-isolation-trials` alone (screening, idle X)  | 2,057 → 2,067 MB             |                 | ❌ no effect: Zenium's blocking already removes most cross-site frames |

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
  cap of 4 first measured _worse_ (3,481 MB, 55 renderers) in screening.

## Many tabs in use at once (live presets)

The target: dozens of tabs **active at the same time**, not hundreds asleep. In these runs every
tab is active (the run cycles through all of them, scrolling) and no browser may unload any (the
competitors' tab-sleeping is off; Zenium's unloading, live-page cap and budget are off). At the
end Zenium had all 24 / 48 tabs loaded and none frozen. One run each unless noted.

| Live tabs | Zenium                   | Edge           | Chromium       | Firefox        |
| --------- | ------------------------ | -------------- | -------------- | -------------- |
| 24        | **3,370 MB** (140 / tab) | 5,060 MB (211) | 5,429 MB (226) | 6,385 MB (266) |
| 48        | **4,924 MB** (103 / tab) | 8,328 MB (174) | 7,111 MB (148) | 9,678 MB (202) |

### Per-live-tab changes, 24 live tabs

Zenium main at 24 live tabs: 3,220–3,432 MB over 7 runs (median 3,292). Switch times p50
~520 ms and p90 ~630–660 ms in every variant (the harness's own polling sets the floor).

| Change                                                                                    | Steady PSS        | Δ         | Note                                                         |
| ----------------------------------------------------------------------------------------- | ----------------- | --------- | ------------------------------------------------------------ |
| Trim hidden live tabs: GC + critical pressure 15 s after leaving, ≤ 1 notification / 30 s | 2,669 MB (3 runs) | **−18 %** | #830                                                         |
| Trim, moderate pressure                                                                   | 2,884 MB (4 runs) | −14 %     | first version                                                |
| Trim + `--disable-site-isolation-trials --renderer-process-limit=6`                       | 2,193 MB          | **−33 %** | 12 processes instead of 41; isolation trade-off              |
| … the same at 48 live tabs                                                                | 3,817 MB vs 4,661 | −18 %     |                                                              |
| Trim + low-end device mode                                                                | 2,539 MB          | −24 %     | low-end mode crashed on Bennett's machine                    |
| Trim + no isolation + 6 renderers + `--lite-mode`                                         | 2,334 MB          | −30 %     | lite costs JS speed; no gain over the line above in this run |
| Freeze hidden tabs at once                                                                | 2,681 MB          | −21 %     | frozen tabs do not run: not "active"                         |
| `--enable-low-end-device-mode`                                                            | 2,883 MB          | −15 %     |                                                              |
| No site isolation + 6 renderers                                                           | 2,916 MB          | −14 %     |                                                              |
| `--js-flags=--lite-mode`                                                                  | 3,125 MB          | −8 %      |                                                              |
| `--renderer-process-limit=6` alone                                                        | 3,286 MB          | −3 %      | site isolation keeps sites apart anyway                      |
| `--js-flags=--optimize-for-size --max-semi-space-size=1`                                  | 3,329 MB          | −2 %      |                                                              |

### With the hidden-tab trim merged (#830): what is left per live tab

Main (with #830) at 24 live tabs: 2,592 / 2,602 / 2,609 MB (median 2,602, **108 MB per live
tab**); at 48: 4,564 / 4,678 MB (96 per tab). One run each below unless noted, against that
main (run-to-run spread ±20 MB): none of these moved it.

| Change (on top of the trim)                                   | Steady PSS       | Processes |
| ------------------------------------------------------------- | ---------------- | --------- |
| `--enable-features=ProcessPerSiteUpToMainFrameThreshold`      | 2,721 MB         | 41        |
| `--process-per-site`                                          | 2,599 MB         | 34        |
| `IsolateSandboxedIframes` off                                 | 2,646 MB         | 41        |
| `BackForwardCache` off                                        | 2,661 MB         | 41        |
| `PartitionAllocBackupRefPtr` off                              | 2,630 MB         | 41        |
| Pause every playing video in every frame (harness experiment) | 2,652 MB         | 41        |
| `--js-flags=--max-semi-space-size=1` / `=4`                   | 2,653 / 2,631 MB | 41        |

Why: a memory-infra dump (`--memory-dump`) of the 24-tab run shows 35 page processes for 24
tabs (`--dump-targets`: 33 cross-site frames – video players, payment, captcha and tracker
frames – get processes of their own). JavaScript heaps are about a quarter of renderer memory;
the rest is mostly each process's fixed cost (malloc, Blink, compositor). Fewer processes is the
lever, and with full site isolation Chromium will not share them.

**Max concurrency** (opt-in setting: relaxed site isolation, at most 6 page processes): 3 runs each at 24 tabs; at 48, one run (main: two).

| Live tabs | Main                           | Max concurrency                   | Δ         |
| --------- | ------------------------------ | --------------------------------- | --------- |
| 24        | 2,602 MB (108 / tab, 41 procs) | **2,167 MB** (90 / tab, 12 procs) | **−17 %** |
| 48        | 4,621 MB (96 / tab, 69 procs)  | **3,765 MB** (78 / tab, 12 procs) | **−19 %** |

Switch times unchanged (p50 521–526 ms, p90 651–710 ms in both). The renderer process limit only
works from the real command line (Chromium reads it before the main script runs; set from the
script it left 33 processes), so Zenium restarts itself once at launch when the setting asks
for one.

### Merged

- #828: smaller main bundle (minified, ASCII): main process 185 → 169 MB settled, first-run peak
  of the whole browser 869 → 744 MB (fresh profile, 3 runs each).
- #829: renderer heap setting clamped to ≥ 512 MB; site-isolation setting (`full` / `relaxed`).
- Held: a 1 GB budget with 6 live pages (200 tabs: 1.82 → 0.90 GB) works by unloading tabs in
  use, which is not the goal.
