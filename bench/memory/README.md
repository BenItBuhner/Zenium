# Many-tabs memory benchmark

A reproducible benchmark of how much memory a browser needs with many real tabs open, used to
hill-climb Zenium's memory use and to compare it with stock Chromium, Firefox and Edge.
Results: [RESULTS.md](RESULTS.md).

## What one run does

1. Starts the browser with a fresh profile (inside a memory cgroup with `--cap`), window
   1280 × 800 on an X display (`:99`, started with Xvfb when nothing is set).
2. Opens N tabs **in the background**, one every 300 ms, from [`sites.txt`](sites.txt): 200 real
   public sites (news, shops, docs, video, social, government, Wikipedia…), shuffled once with a
   fixed seed so every preset mixes heavy and light pages. Waits 30 s.
3. **Active phase.** M of the tabs, spread evenly over the list, are the "active" ones: the run
   switches to each in turn, stays 2.5 s and scrolls it three times with real wheel input, and
   goes round all M at least three times (at least 90 s).
4. **Restore.** Switches to 5 background tabs that were never active (the oldest ones) and times
   each from the switch until the page is painted again: the document is visible, parsed
   (DOMContentLoaded) and two animation frames have run. It also records whether the tab had to
   load again (its document is newer than the switch: it had been discarded or unloaded).
5. Memory of the browser's **whole process tree** is sampled every second throughout.

Presets: `--preset 50` (50 tabs, 5 active), `100` (100 / 10), `200` (200 / 20).

**Live presets** (`--preset live24`, `live48`): the target is many tabs _in use at once_, not
many tabs asleep. Every one of the N tabs is active (the run cycles through all of them), and
no browser may unload any: the competitors' tab-sleeping is off, and Zenium runs with unloading
and its live-page cap off and its memory budget at 100 %. Zenium reports how many of the tabs
are loaded and how many frozen at the end; the headline number is **memory per live tab**
(steady PSS ÷ live tabs).

## The numbers

| Column                | Meaning                                                                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steady PSS            | Median over the last 60 s of the active phase of the summed PSS (proportional set size, `/proc/<pid>/smaps_rollup`). PSS splits shared pages between the processes that share them, so the sum is what the browser really costs. **The headline number.** |
| Peak PSS              | Highest PSS sample of the whole run (opening 200 tabs is usually the peak).                                                                                                                                                                               |
| RSS sum               | The plain resident sizes added up, the way most task managers show them. Shared pages count once per process, so it overstates; given because it is the familiar number.                                                                                  |
| Processes             | Processes in the tree at steady state.                                                                                                                                                                                                                    |
| Restore               | Median of the 5 restore times.                                                                                                                                                                                                                            |
| OOM kills             | Processes the kernel killed for exceeding the cgroup's limit (capped runs).                                                                                                                                                                               |
| Browser died          | The main browser process exited during the run.                                                                                                                                                                                                           |
| Switch to a woken tab | With `--switch-latency`: median time from a switch in the active phase to a tab whose page had been unloaded (it loads again) until that page is painted.                                                                                                 |
| Picture shown         | With `--switch-latency`, Zenium only: median time from such a switch until the tab's restore picture (what it looked like when last left) is on screen, and how many switches showed one.                                                                 |

Every table cell is the **median of 3 runs** unless the table says otherwise.

## The competitors' memory savers

Each browser runs with its own tab-sleeping feature on at its most aggressive setting, set the
way an administrator would:

- **Chromium** (Chrome for Testing 158, Playwright's build): policy `HighEfficiencyModeEnabled`
  (Memory Saver) with `MemorySaverModeSavings: 2` (maximum).
- **Edge** 158: policies `SleepingTabsEnabled` and `SleepingTabsTimeout: 30` (the shortest
  timeout Edge offers: tabs sleep after 30 s in the background).
- **Firefox** 161: its tab unloader (`browser.tabs.unloadOnLowMemory`) with tabs eligible after
  30 s (`browser.tabs.min_inactive_duration_before_unload`), and the low-memory threshold raised
  so it runs without real memory pressure (Firefox reads neither cgroup limits nor a timer
  otherwise, so without this it never unloads within a run). This is the most aggressive
  setting Firefox has; stock Firefox would unload nothing in these runs.
- **Zenium**: its defaults (the resource governor at "strict", 24 live pages at most), unless a
  run says otherwise.

Chromium-based browsers run with `--no-sandbox` because the cloud box runs as root; Zenium
does the same, so the four are alike there.

## Running it

```sh
# one run
node bench/memory/run.mjs --browser zenium --preset 200
node bench/memory/run.mjs --browser chromium --preset 200 --cap 512   # inside a 512 MB cgroup
# Zenium with other settings / switches
node bench/memory/run.mjs --browser zenium --preset 200 --label tuned \
  --zenium-state '{"settings":{"resources":{"maxLoadedTabs":4}}}' \
  --args-json '["--js-flags=--optimize-for-size"]'
# the whole matrix (3 rounds x 3 presets x 4 browsers, plus capped runs), then the tables
sh bench/memory/matrix.sh
node bench/memory/report.mjs bench/memory/results
```

Needs Linux (it reads `/proc`), root for `--cap` (it makes a cgroup v1 memory group under
`/sys/fs/cgroup/memory`), Xvfb, and Zenium built (`npx electron-vite build`). Browser binaries
come from `CHROMIUM_BIN`, `EDGE_BIN`, `FIREFOX_BIN` (defaults: Playwright's Chromium, and
Edge's `.deb` and Firefox's tarball unpacked under `/opt/bench`). Behind a TLS-intercepting
proxy, set `FIREFOX_EXTRA_CA` to the proxy's CA certificate (Firefox keeps its own store).

The harness talks to each browser over its own protocol without an automation library (CDP for
the Chromium family and Zenium, Marionette for Firefox) and attaches to a tab only for the moment
it scrolls or checks it, so no automation session keeps tabs from sleeping.

## Caveats

- Real sites change from day to day and some serve consent screens or bot checks; that is why
  every number is a median of runs taken in interleaved rounds.
- The cloud box has no GPU: every browser renders in software, so GPU-process memory is lower
  than on a desktop with a graphics card.
- Fresh profiles: first-run work (Zenium compiling its blocking lists, Chromium fetching
  components) happens inside the run and shows in the peak.
