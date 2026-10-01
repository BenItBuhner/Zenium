#!/usr/bin/env python3
"""The host's own marks in the tab-wake Perfetto trace (TabWakePerfDemo, W6-S26-b): every
`zen:TabHost.create` (a page view handed to the core – the spare taken, or one built on the spot)
and `zen:TabHost.warm` (a spare built ahead of a wake) slice on the app's UI thread, placed against
the driver's scenes (`scenes.txt`: name, start, end in CLOCK_BOOTTIME nanoseconds) and its
measured windows (`windows.txt`: scene, window, start, end in the same clock – the `switch`
window is the tap to the page view's show, the morph; `out` the way out's first stretch) – the
second witness, outside the app, of what the driver asserted in-process. Markdown on stdout; the
two `PASS` / `FAIL` lines are the trace's reading of the deterministic claims: `create` at or
under the cap inside every sleeping scene (spare on), and no spare built inside a measured
`switch` window – the spare is built off the morph by construction (the host waits for the window
to have drawn nothing for 600 ms, then for the looper's idle). Where a spare was built inside an
`out` window is a note: the way out's spring comes to rest inside that window by design, and the
build follows the rest. No frame-time comparison is judged here (the lane's reading is the
driver's FACT lines).

Usage: android-tab-wake-spans.py <trace> <scenes.txt> [--windows <windows.txt>] [--app <process name>] [--cap-ms 2]
"""
import os
import sys

from perfetto.trace_processor import TraceProcessor

FLAGS_WITH_VALUE = {'--app', '--cap-ms', '--windows'}
positional = [a for i, a in enumerate(sys.argv[1:]) if not a.startswith('--') and (i == 0 or sys.argv[i] not in FLAGS_WITH_VALUE)]
if len(positional) < 2:
    sys.exit(__doc__)
trace_path, scenes_path = positional[0], positional[1]
app = sys.argv[sys.argv.index('--app') + 1] if '--app' in sys.argv else 'io.github.benitbuhner.zenium.debug'
cap_ms = float(sys.argv[sys.argv.index('--cap-ms') + 1]) if '--cap-ms' in sys.argv else 2.0
windows_path = sys.argv[sys.argv.index('--windows') + 1] if '--windows' in sys.argv else None

tp = TraceProcessor(trace=trace_path)


def rows(sql):
    try:
        return list(tp.query(sql))
    except Exception as e:  # one failing query must not lose the rest
        print(f'> query failed: {str(e)[:160]}')
        return []


scenes = []
for line in open(scenes_path):
    p = line.split()
    if len(p) >= 3:
        scenes.append((p[0], int(p[1]), int(p[2])))

windows = []
if windows_path and os.path.exists(windows_path):
    for line in open(windows_path):
        p = line.split()
        if len(p) >= 4:
            windows.append((p[0], p[1], int(p[2]), int(p[3])))

procs = rows(f"select upid from process where name like '{app}%' order by start_ts")
if not procs:
    print(f'no process named {app} in the trace')
    sys.exit(0)
upid = procs[-1].upid
spans = rows(
    f"select s.name, s.ts, s.dur, t.name tname from slice s join thread_track tt on s.track_id = tt.id "
    f"join thread t on t.utid = tt.utid where t.upid = {upid} and s.name in ('zen:TabHost.create', 'zen:TabHost.warm') and s.dur > 0 order by s.ts"
)


def scene_of(ts):
    for name, a, b in scenes:
        if a <= ts <= b:
            return name, (ts - a) / 1e6
    return None, None


def window_of(ts):
    for name, window, a, b in windows:
        if a <= ts <= b:
            return name, window, (ts - a) / 1e6
    return None, None, None


print('### The host\'s marks (zen:TabHost.create, zen:TabHost.warm)')
print()
if not spans:
    print('no `zen:TabHost.*` slice in the trace (an app built without the marks, or the atrace app category missing from the config)')
    sys.exit(0)
print('| mark | thread | ms | scene | at | measured window |')
print('| --- | --- | ---: | --- | ---: | --- |')
creates_in_sleeping = []
builds_in_scenes = []
builds_in_windows = []
for r in spans:
    name, at = scene_of(r.ts)
    kind = r.name.split('.')[-1]
    wname, window, wat = window_of(r.ts)
    inside = f'{window} (+{wat:.0f} ms)' if window else ''
    print(f"| {kind} | {r.tname} | {r.dur / 1e6:.2f} | {name or '(between scenes)'} | {'' if at is None else f'+{at:.0f} ms'} | {inside} |")
    if name and kind == 'create' and ('-sleeping' in name or '-cold' in name):
        creates_in_sleeping.append((name, r.dur / 1e6))
    if name and kind == 'warm':
        builds_in_scenes.append((name, at, r.dur / 1e6))
    if window and kind == 'warm':
        builds_in_windows.append((wname, window, wat, r.dur / 1e6))
print()
spare_on = [(n, d) for n, d in creates_in_sleeping if '-sleeping' in n]
cold = [(n, d) for n, d in creates_in_sleeping if '-cold' in n]
if spare_on:
    over = [(n, d) for n, d in spare_on if d > cap_ms]
    verdict = 'PASS' if not over else 'FAIL'
    print(f"{verdict} trace: TabHost.create inside the sleeping scenes (spare on) held the UI thread "
          + ', '.join(f'{d:.2f}' for _, d in spare_on) + f' ms (cap {cap_ms:.1f})'
          + ('' if not over else '; over in ' + ', '.join(n for n, _ in over)))
else:
    print('note trace: no TabHost.create inside a sleeping scene (spare on)')
if cold:
    print('note trace: before (spare off), TabHost.create built the view in ' + ', '.join(f'{d:.1f}' for _, d in cold) + ' ms inside ' + ', '.join(n for n, _ in cold))
if windows:
    in_switch = [(n, at, d) for n, w, at, d in builds_in_windows if w == 'switch']
    switch_windows = sum(1 for _, w, _, _ in windows if w == 'switch')
    if in_switch:
        print(f'FAIL trace: a spare was built inside a measured switch window (the morph): '
              + '; '.join(f'{n} at +{at:.0f} ms, {d:.1f} ms' for n, at, d in in_switch))
    else:
        print(f'PASS trace: no spare built inside any of the {switch_windows} measured switch window(s) (the morph)')
    in_out = [(n, at, d) for n, w, at, d in builds_in_windows if w == 'out']
    if in_out:
        print('note trace: spare builds inside the way out\'s window (after the spring\'s rest, by design): '
              + '; '.join(f'{n} at +{at:.0f} ms, {d:.1f} ms' for n, at, d in in_out))
else:
    print('note trace: no windows.txt – the measured windows are not placed (an older record)')
if builds_in_scenes:
    print('note trace: spare builds inside scenes (after the gesture\'s rest, by design): '
          + '; '.join(f'{n} at +{at:.0f} ms, {d:.1f} ms' for n, at, d in builds_in_scenes))
else:
    print('note trace: every spare was built between the scenes')
