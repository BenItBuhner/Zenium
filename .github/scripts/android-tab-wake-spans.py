#!/usr/bin/env python3
"""The host's own marks in the tab-wake Perfetto trace (TabWakePerfDemo, W6-S26-b): every
`zen:TabHost.create` (a page view handed to the core – the spare taken, or one built on the spot)
and `zen:TabHost.warm` (a spare built ahead of a wake) slice on the app's UI thread, placed against
the driver's scenes (`scenes.txt`: name, start, end in CLOCK_BOOTTIME nanoseconds) – the second
witness, outside the app, of what the driver asserted in-process: how long the UI thread held
`create` inside each sleeping scene, and where the spares were built (meant to fall between the
scenes or after a gesture's rest, never inside a measured window). Markdown on stdout; the
`PASS` / `FAIL` lines are the trace's reading of the same bar (`create` at or under the cap inside
every sleeping scene; builds reported, not judged – the driver's windows are narrower than its
scenes).

Usage: android-tab-wake-spans.py <trace> <scenes.txt> [--app <process name>] [--cap-ms 5]
"""
import sys

from perfetto.trace_processor import TraceProcessor

FLAGS_WITH_VALUE = {'--app', '--cap-ms'}
positional = [a for i, a in enumerate(sys.argv[1:]) if not a.startswith('--') and (i == 0 or sys.argv[i] not in FLAGS_WITH_VALUE)]
if len(positional) < 2:
    sys.exit(__doc__)
trace_path, scenes_path = positional[0], positional[1]
app = sys.argv[sys.argv.index('--app') + 1] if '--app' in sys.argv else 'io.github.benitbuhner.zenium.debug'
cap_ms = float(sys.argv[sys.argv.index('--cap-ms') + 1]) if '--cap-ms' in sys.argv else 5.0

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


print('### The host\'s marks (zen:TabHost.create, zen:TabHost.warm)')
print()
if not spans:
    print('no `zen:TabHost.*` slice in the trace (an app built without the marks, or the atrace app category missing from the config)')
    sys.exit(0)
print('| mark | thread | ms | scene | at |')
print('| --- | --- | ---: | --- | ---: |')
creates_in_sleeping = []
builds_in_scenes = []
for r in spans:
    name, at = scene_of(r.ts)
    kind = r.name.split('.')[-1]
    print(f"| {kind} | {r.tname} | {r.dur / 1e6:.2f} | {name or '(between scenes)'} | {'' if at is None else f'+{at:.0f} ms'} |")
    if name and kind == 'create' and ('-sleeping' in name or '-cold' in name):
        creates_in_sleeping.append((name, r.dur / 1e6))
    if name and kind == 'warm':
        builds_in_scenes.append((name, at, r.dur / 1e6))
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
if builds_in_scenes:
    print('note trace: spare builds inside scenes (after the gesture\'s rest, by design): '
          + '; '.join(f'{n} at +{at:.0f} ms, {d:.1f} ms' for n, at, d in builds_in_scenes))
else:
    print('note trace: every spare was built between the scenes')
