#!/usr/bin/env python3
"""Reads the Perfetto system trace a profiling driver captured over its scenes (the config in
android-perf-trace.pbtxt: sched, gfx, view, input, wm, am, binder_driver, dalvik, the app's
atrace marks, SurfaceFlinger's frame timeline) with the perfetto trace_processor and writes
Markdown: per scene the app's frames as SurfaceFlinger saw them (presented, janky by type, the
frame-time percentiles), HWUI's UI-thread frames (Choreographer#doFrame) and RenderThread
frames (DrawFrame) with what was long inside them, the binder transactions the UI thread made,
and where the CPU went (the busiest threads across every process, the chrome and page renderers
included). The scenes come from the driver's `menu-perf:<scene>` async marks (the app's atrace
category), else from `scenes.txt` (CLOCK_BOOTTIME nanoseconds, the trace clock).

Usage: android-perf-trace.py <trace> [scenes.txt] [--app <process name>] [--json <file>]
"""
import json
import sys
from collections import defaultdict

from perfetto.trace_processor import TraceProcessor

FLAGS_WITH_VALUE = {'--app', '--json'}
args = [a for i, a in enumerate(sys.argv[1:]) if not a.startswith('--') and (i == 0 or sys.argv[i] not in FLAGS_WITH_VALUE)]
trace_path = args[0]
scenes_path = args[1] if len(args) > 1 else None
app = sys.argv[sys.argv.index('--app') + 1] if '--app' in sys.argv else 'io.github.benitbuhner.zenium.debug'
json_out = sys.argv[sys.argv.index('--json') + 1] if '--json' in sys.argv else None

tp = TraceProcessor(trace=trace_path)
out = {'notes': [], 'scenes': {}}


def rows(sql):
    try:
        return list(tp.query(sql))
    except Exception as e:  # one failing query must not lose the rest
        out['notes'].append(f'query failed: {str(e)[:160]} :: {" ".join(sql.split())[:120]}')
        return []


def fmt(x, d=1):
    return '–' if x is None else f'{x:.{d}f}'


def pct(values, p):
    if not values:
        return None
    s = sorted(values)
    i = min(len(s) - 1, max(0, int((p / 100.0) * len(s) + 0.999999) - 1))
    return s[i]


# --- the app and its threads ------------------------------------------------------------------------
procs = rows(f"select upid, pid, name from process where name like '{app}%' order by start_ts")
app_upid = procs[-1].upid if procs else None
if app_upid is None:
    out['notes'].append(f'no process named {app} in the trace')
main_utid = None
render_utid = None
if app_upid is not None:
    for r in rows(f"select utid, tid, name, is_main_thread from thread where upid = {app_upid}"):
        if r.is_main_thread == 1 or r.name == app.split('.')[-1][:15] or (r.name and r.name.startswith('io.github.benit')):
            main_utid = main_utid or r.utid
        if r.name == 'RenderThread':
            render_utid = r.utid

# --- the scenes -------------------------------------------------------------------------------------
scenes = {}
if app_upid is not None:
    for r in rows(
        f"select s.name, s.ts, s.dur from slice s join process_track pt on s.track_id = pt.id "
        f"where pt.upid = {app_upid} and s.name like 'menu-perf:%' and s.dur > 0 order by s.ts"
    ):
        name = r.name[len('menu-perf:'):]
        if name in ('open', 'close', 'drag-up', 'drag-down'):
            continue
        scenes[name] = (r.ts, r.ts + r.dur)
if not scenes and scenes_path:
    try:
        for line in open(scenes_path):
            p = line.split()
            if len(p) >= 3:
                scenes[p[0]] = (int(p[1]), int(p[2]))
        out['notes'].append('scene windows from scenes.txt (no menu-perf async marks in the trace)')
    except OSError:
        pass
if not scenes:
    b = rows('select min(ts) a, max(ts) b from slice')
    if b and b[0].a is not None:
        scenes['whole-trace'] = (b[0].a, b[0].b)
        out['notes'].append('no scenes found; the whole trace is one scene')

# Half-cycle marks, for the frames of the opens and closes apart.
halves = defaultdict(list)
if app_upid is not None:
    for r in rows(
        f"select s.name, s.ts, s.dur from slice s join process_track pt on s.track_id = pt.id "
        f"where pt.upid = {app_upid} and s.name in ('menu-perf:open','menu-perf:close','menu-perf:drag-up','menu-perf:drag-down') and s.dur > 0"
    ):
        halves[r.name[len('menu-perf:'):]].append((r.ts, r.ts + r.dur))

cpus = rows('select count(distinct cpu) n from sched')
ncpu = cpus[0].n if cpus else 0
out['cpus'] = ncpu


def frame_timeline(a, b):
    if app_upid is None:
        return None
    fr = rows(
        f"select ts, dur, jank_type, present_type, on_time_finish, layer_name from actual_frame_timeline_slice "
        f"where upid = {app_upid} and ts >= {a} and ts < {b} and dur > 0"
    )
    if not fr:
        return None
    durs = [r.dur / 1e6 for r in fr]
    janky = [r for r in fr if r.jank_type not in ('None', None, 'Buffer Stuffing')]
    by_type = defaultdict(int)
    for r in janky:
        by_type[r.jank_type] += 1
    present = defaultdict(int)
    for r in fr:
        present[r.present_type] += 1
    return {
        'frames': len(fr),
        'janky': len(janky),
        'jankyPct': 100.0 * len(janky) / len(fr),
        'jankTypes': dict(sorted(by_type.items(), key=lambda kv: -kv[1])),
        'presentTypes': dict(sorted(present.items(), key=lambda kv: -kv[1])),
        'p50': pct(durs, 50), 'p90': pct(durs, 90), 'p95': pct(durs, 95), 'p99': pct(durs, 99), 'max': max(durs),
    }


def thread_slices(utid, name_filter, a, b):
    if utid is None:
        return []
    return rows(
        f"select s.id, s.ts, s.dur, s.name from slice s join thread_track tt on s.track_id = tt.id "
        f"where tt.utid = {utid} and s.ts >= {a} and s.ts < {b} and s.dur > 0 and ({name_filter}) order by s.ts"
    )


def long_children(utid, parents, a, b, name_filter):
    """What was longest inside the long frames: the child slices summed by name."""
    if utid is None or not parents:
        return []
    ids = ','.join(str(p.id) for p in parents[:400])
    kids = rows(
        f"select c.name, sum(c.dur) total, count(*) n from slice c where c.parent_id in ({ids}) group by c.name order by total desc limit 8"
    )
    return [{'name': k.name, 'ms': k.total / 1e6, 'count': k.n} for k in kids]


def hwui(utid, name_filter, a, b, label):
    fr = thread_slices(utid, name_filter, a, b)
    if not fr:
        return None
    durs = [r.dur / 1e6 for r in fr]
    long = [r for r in fr if r.dur > 16_666_667]
    return {
        'frames': len(fr), 'long': len(long), 'longPct': 100.0 * len(long) / len(fr),
        'p50': pct(durs, 50), 'p90': pct(durs, 90), 'p99': pct(durs, 99), 'max': max(durs),
        'inLong': long_children(utid, long, a, b, name_filter),
        'inAll': long_children(utid, fr, a, b, name_filter),
    }


def binder(a, b):
    if main_utid is None:
        return None
    tr = rows(
        f"select s.dur, s.name from slice s join thread_track tt on s.track_id = tt.id "
        f"where tt.utid = {main_utid} and s.ts >= {a} and s.ts < {b} and s.name like 'binder%' and s.dur > 0"
    )
    if not tr:
        return {'count': 0, 'ms': 0, 'max': 0}
    return {'count': len(tr), 'ms': sum(r.dur for r in tr) / 1e6, 'max': max(r.dur for r in tr) / 1e6}


def cpu_by_thread(a, b, limit=14):
    return [
        {'thread': r.tname, 'process': r.pname, 'pid': r.pid, 'ms': r.run / 1e6, 'share': (r.run / (b - a)) if b > a else 0}
        for r in rows(
            f"select t.name tname, p.name pname, p.pid pid, sum(min(ts.ts + ts.dur, {b}) - max(ts.ts, {a})) run "
            f"from thread_state ts join thread t using(utid) left join process p using(upid) "
            f"where ts.state = 'Running' and ts.ts < {b} and ts.ts + ts.dur > {a} "
            f"group by ts.utid order by run desc limit {limit}"
        )
    ]


def main_thread_top(a, b):
    if main_utid is None:
        return []
    return [
        {'name': r.name, 'ms': r.total / 1e6, 'count': r.n}
        for r in rows(
            f"select s.name, sum(s.dur) total, count(*) n from slice s join thread_track tt on s.track_id = tt.id "
            f"where tt.utid = {main_utid} and s.ts >= {a} and s.ts < {b} and s.depth = 0 and s.dur > 0 group by s.name order by total desc limit 10"
        )
    ]


def in_halves(kind, a, b):
    """The frame timeline's frames inside the half-cycles of `kind` within [a, b)."""
    if app_upid is None or kind not in halves:
        return None
    spans = [(x, y) for (x, y) in halves[kind] if x >= a and y <= b]
    if not spans:
        return None
    cond = ' or '.join(f'(ts >= {x} and ts < {y})' for x, y in spans[:60])
    fr = rows(f"select dur, jank_type from actual_frame_timeline_slice where upid = {app_upid} and dur > 0 and ({cond})")
    if not fr:
        return None
    durs = [r.dur / 1e6 for r in fr]
    janky = [r for r in fr if r.jank_type not in ('None', None, 'Buffer Stuffing')]
    return {'spans': len(spans), 'frames': len(fr), 'janky': len(janky), 'jankyPct': 100.0 * len(janky) / len(fr), 'p90': pct(durs, 90), 'p99': pct(durs, 99), 'max': max(durs)}


for name, (a, b) in scenes.items():
    s = {
        'seconds': (b - a) / 1e9,
        'frameTimeline': frame_timeline(a, b),
        'uiThread': hwui(main_utid, "s.name like 'Choreographer#doFrame%'", a, b, 'ui'),
        'renderThread': hwui(render_utid, "s.name in ('DrawFrame','DrawFrames') or s.name like 'DrawFrame%'", a, b, 'render'),
        'binder': binder(a, b),
        'mainTop': main_thread_top(a, b),
        'cpu': cpu_by_thread(a, b),
        'halves': {k: in_halves(k, a, b) for k in ('open', 'close', 'drag-up', 'drag-down')},
    }
    out['scenes'][name] = s

tp.close()

# --- Markdown --------------------------------------------------------------------------------------
md = []
md.append(f'Perfetto: {ncpu} CPUs seen by the scheduler; app process `{app}`' + (f' upid {app_upid}' if app_upid is not None else ' NOT FOUND'))
if out['notes']:
    md.append('Notes: ' + '; '.join(out['notes']))
md.append('')
md.append('| scene | s | SF frames | janky (types) | p50 | p90 | p95 | p99 | max | UI thread doFrame: n / > 16.7 ms / p90 / max | RenderThread DrawFrame: n / > 16.7 ms / p90 / max | binder on UI thread |')
md.append('|---|---|---|---|---|---|---|---|---|---|---|---|')
for name, s in out['scenes'].items():
    ft = s['frameTimeline']
    ui = s['uiThread']
    rt = s['renderThread']
    bi = s['binder']
    ft_cell = '–'
    j_cell = '–'
    if ft:
        ft_cell = str(ft['frames'])
        j_cell = f"{ft['janky']} ({ft['jankyPct']:.0f} %)" + (' ' + ', '.join(f'{k} {v}' for k, v in list(ft['jankTypes'].items())[:3]) if ft['jankTypes'] else '')
    ui_cell = f"{ui['frames']} / {ui['long']} ({ui['longPct']:.0f} %) / {fmt(ui['p90'])} / {fmt(ui['max'], 0)}" if ui else '–'
    rt_cell = f"{rt['frames']} / {rt['long']} ({rt['longPct']:.0f} %) / {fmt(rt['p90'])} / {fmt(rt['max'], 0)}" if rt else '–'
    bi_cell = f"{bi['count']} ({bi['ms']:.0f} ms, max {bi['max']:.1f})" if bi else '–'
    md.append(
        f"| {name} | {s['seconds']:.0f} | {ft_cell} | {j_cell} | {fmt(ft['p50']) if ft else '–'} | {fmt(ft['p90']) if ft else '–'} | "
        f"{fmt(ft['p95']) if ft else '–'} | {fmt(ft['p99']) if ft else '–'} | {fmt(ft['max'], 0) if ft else '–'} | {ui_cell} | {rt_cell} | {bi_cell} |"
    )
md.append('')
for name, s in out['scenes'].items():
    md.append(f'**{name}**')
    md.append('')
    for k, h in s['halves'].items():
        if h:
            md.append(f"- {k} half-cycles ({h['spans']}): {h['frames']} SF frames, janky {h['janky']} ({h['jankyPct']:.0f} %), p90 {fmt(h['p90'])} ms, p99 {fmt(h['p99'])} ms, max {fmt(h['max'], 0)} ms")
    ft = s['frameTimeline']
    if ft:
        md.append(f"- present types: {', '.join(f'{k} {v}' for k, v in ft['presentTypes'].items())}")
    ui = s['uiThread']
    if ui and ui['inLong']:
        md.append('- inside the long UI-thread frames: ' + ', '.join(f"{c['name']} {c['ms']:.0f} ms ×{c['count']}" for c in ui['inLong']))
    rt = s['renderThread']
    if rt and rt['inLong']:
        md.append('- inside the long RenderThread frames: ' + ', '.join(f"{c['name']} {c['ms']:.0f} ms ×{c['count']}" for c in rt['inLong']))
    if s['mainTop']:
        md.append('- UI thread, top-level slices: ' + ', '.join(f"{c['name']} {c['ms']:.0f} ms ×{c['count']}" for c in s['mainTop']))
    if s['cpu']:
        md.append('- CPU, busiest threads: ' + ', '.join(f"{c['thread']} [{c['process']} {c['pid']}] {c['ms']:.0f} ms ({100 * c['share']:.0f} %)" for c in s['cpu']))
    md.append('')
print('\n'.join(md))
if json_out:
    with open(json_out, 'w') as f:
        json.dump(out, f, indent=1)
