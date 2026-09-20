#!/usr/bin/env python3
"""Turns what BarHidePerfDemo left in an artifact directory into the profile's tables.

    python3 .github/scripts/android-perf-analyze.py <artifact dir> [--summary <file>]

Reads `perf-scenes.json` (the scenes, their windows in the traces' clocks, the in-process
counters), each scene's `gfx-<page>-<scene>.txt` (`dumpsys gfxinfo … framestats` verbatim), each
page's `blink-<page>.json.gz` (the WebViews' Chromium trace) and the Perfetto trace
(`zen-*.pftrace`, read with trace_processor through the `perfetto` package when it is installed),
and writes `perf-report.md` and `perf-report.json` next to them; `--summary` appends the Markdown
to a file (the job summary). Every source is optional: a missing one leaves its columns empty
and a line saying so, so a run the emulator cut short still reports what it has.

The numbers, per page and scene:
  - gfxinfo: total frames, janky frames and share, the 50 / 90 / 95 / 99th percentiles, and from
    the framestats rows (the last 120 frames at most) each stage's mean and 95th – input,
    animation, measure / layout, draw, the sync queue wait, sync, command issue (GPU), swap – and
    which stage was the longest in the frames over budget;
  - the Chromium trace: on the chrome renderer's and the page renderer's main threads (told apart
    by the URLs in their events), the main-thread frames and how many of them ran style
    recalculation, layout and paint, the time in UpdateLayoutTree / Layout / Paint / FunctionCall
    / GC, the page's resize events, and the top slices by self time;
  - Perfetto: the app's Choreographer frames and their durations, its layout passes, the
    RenderThread's DrawFrames and dequeueBuffer waits, SurfaceFlinger's frame timeline (frames
    and jank types for the app's layer), CPU time by thread across the device (the app's main
    thread and RenderThread, both renderers' main threads, SurfaceFlinger), binder transactions
    and the main thread's context switches.
"""
from __future__ import annotations

import argparse
import gzip
import json
import math
import os
import re
import statistics
import sys
from collections import defaultdict
from pathlib import Path

FRAME_BUDGET_MS = 16.67
CHROME_HINT = "appassets.androidplatform.net"
PAGE_HINTS = ("127.0.0.1", "github.com", "wikipedia.org")

# --- helpers --------------------------------------------------------------------------------------


def percentile(values, p):
    if not values:
        return None
    ordered = sorted(values)
    k = (len(ordered) - 1) * p / 100.0
    lo = math.floor(k)
    hi = math.ceil(k)
    if lo == hi:
        return ordered[int(k)]
    return ordered[lo] + (ordered[hi] - ordered[lo]) * (k - lo)


def fmt(value, digits=1, unit=""):
    if value is None:
        return "–"
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, int):
        return f"{value}{unit}"
    if isinstance(value, float):
        if math.isnan(value):
            return "–"
        return f"{value:.{digits}f}{unit}"
    return str(value)


def ms(ns):
    return None if ns is None else ns / 1e6


# --- dumpsys gfxinfo --------------------------------------------------------------------------------

STAGES = ("input", "animation", "layout", "draw", "syncQueue", "sync", "issue", "swap")
STAGE_LABELS = {
    "input": "input",
    "animation": "animation",
    "layout": "measure/layout",
    "draw": "draw",
    "syncQueue": "sync queue wait",
    "sync": "sync",
    "issue": "command issue (GPU)",
    "swap": "swap",
}


def parse_gfx(text):
    """The summary and the framestats rows of one `dumpsys gfxinfo <pkg> framestats` dump."""
    out = {}

    def grab(label, cast=int):
        m = re.search(rf"^{re.escape(label)}: (\d+)", text, re.M)
        return cast(m.group(1)) if m else None

    out["frames"] = grab("Total frames rendered")
    m = re.search(r"^Janky frames: (\d+) \(([\d.]+)%\)", text, re.M)
    if m:
        out["janky"] = int(m.group(1))
        out["jankyPercent"] = float(m.group(2))
    for p in (50, 90, 95, 99):
        m = re.search(rf"^{p}th percentile: (\d+)ms", text, re.M)
        out[f"p{p}"] = int(m.group(1)) if m else None
    for label, key in (
        ("Number Missed Vsync", "missedVsync"),
        ("Number High input latency", "highInputLatency"),
        ("Number Slow UI thread", "slowUiThread"),
        ("Number Slow bitmap uploads", "slowBitmapUploads"),
        ("Number Slow issue draw commands", "slowIssueDrawCommands"),
        ("Number Frame deadline missed", "frameDeadlineMissed"),
    ):
        out[key] = grab(label)

    rows = []
    block = re.search(r"---PROFILEDATA---\n(.*?)\n---PROFILEDATA---", text, re.S)
    if block:
        lines = [line for line in block.group(1).splitlines() if line.strip()]
        header = [h for h in lines[0].split(",") if h]
        for line in lines[1:]:
            fields = [f for f in line.split(",") if f != ""]
            if len(fields) < len(header):
                continue
            try:
                values = dict(zip(header, (int(f) for f in fields[: len(header)])))
            except ValueError:
                continue
            rows.append(values)
    frames = []
    for r in rows:
        flags = r.get("Flags", 0)
        # Skipped frames (8) carry garbage; the first frame of a window (1) is not a scroll frame.
        if flags & 9:
            continue
        g = r.get
        if not g("FrameCompleted") or not g("IntendedVsync"):
            continue
        stages = {
            "input": g("AnimationStart", 0) - g("HandleInputStart", 0),
            "animation": g("PerformTraversalsStart", 0) - g("AnimationStart", 0),
            "layout": g("DrawStart", 0) - g("PerformTraversalsStart", 0),
            "draw": g("SyncQueued", 0) - g("DrawStart", 0),
            "syncQueue": g("SyncStart", 0) - g("SyncQueued", 0),
            "sync": g("IssueDrawCommandsStart", 0) - g("SyncStart", 0),
            "issue": g("SwapBuffers", 0) - g("IssueDrawCommandsStart", 0),
            "swap": g("FrameCompleted", 0) - g("SwapBuffers", 0),
        }
        stages_ms = {k: max(0.0, v / 1e6) for k, v in stages.items()}
        total = (g("FrameCompleted") - g("IntendedVsync")) / 1e6
        ui = (g("SyncQueued", 0) - g("IntendedVsync")) / 1e6
        latency = (g("HandleInputStart", 0) - g("Vsync", 0)) / 1e6
        gpu = None
        if g("GpuCompleted") and g("SwapBuffersCompleted") and g("GpuCompleted") > g("SwapBuffersCompleted"):
            gpu = (g("GpuCompleted") - g("SwapBuffersCompleted")) / 1e6
        frames.append({"total": total, "ui": ui, "latency": latency, "gpu": gpu, "stages": stages_ms})
    out["sample"] = len(frames)
    if frames:
        out["stageMean"] = {k: statistics.fmean(f["stages"][k] for f in frames) for k in STAGES}
        out["stageP95"] = {k: percentile([f["stages"][k] for f in frames], 95) for k in STAGES}
        out["totalP95Sample"] = percentile([f["total"] for f in frames], 95)
        out["uiThreadP95Sample"] = percentile([f["ui"] for f in frames], 95)
        gpus = [f["gpu"] for f in frames if f["gpu"] is not None]
        out["gpuP95Sample"] = percentile(gpus, 95) if gpus else None
        slow = [f for f in frames if f["total"] > FRAME_BUDGET_MS]
        out["slowInSample"] = len(slow)
        longest = defaultdict(int)
        for f in slow:
            longest[max(f["stages"], key=lambda k: f["stages"][k])] += 1
        out["slowByLongStage"] = dict(sorted(longest.items(), key=lambda kv: -kv[1]))
        if slow:
            out["slowStageMean"] = {k: statistics.fmean(f["stages"][k] for f in slow) for k in STAGES}
    return out


def long_stage(gfx):
    by = gfx.get("slowByLongStage") or {}
    if not by:
        return "–"
    top = list(by.items())[:2]
    total = sum(by.values())
    return ", ".join(f"{STAGE_LABELS[k]} {v}/{total}" for k, v in top)


# --- the WebViews' Chromium trace -------------------------------------------------------------------

NAMED_SLICES = ("UpdateLayoutTree", "Layout", "PrePaint", "Paint", "UpdateLayer", "Commit", "FunctionCall", "EvaluateScript",
                "TimerFire", "HitTest", "EventDispatch", "Animation", "ScrollUpdate", "ParseHTML", "UpdateLayerTree")
GC_NAMES = ("MinorGC", "MajorGC", "V8.GCScavenger", "V8.GCFinalizeMC", "V8.GCIncrementalMarking", "V8.GC_MC_INCREMENTAL",
            "BlinkGC.AtomicPauseMarkTransitiveClosure", "BlinkGC.CompleteSweep", "BlinkGC.IncrementalMarkingStep")
MAIN_FRAME_NAMES = ("ProxyMain::BeginMainFrame", "BeginMainThreadFrame", "ThreadProxy::BeginMainFrame")


class Thread:
    __slots__ = ("events", "name")

    def __init__(self, name):
        self.name = name
        self.events = []  # (ts, dur, name, args) for complete events


def load_blink(path):
    """Events by (pid, tid); process and thread names; renderer pids by role."""
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8", errors="replace") as f:
        raw = f.read()
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        # A trace cut short: the array is unterminated; close it at the last complete event.
        cut = raw.rfind("},")
        data = json.loads(raw[: cut + 1] + "]}" if raw.lstrip().startswith("{") else raw[: cut + 1] + "]")
    events = data["traceEvents"] if isinstance(data, dict) else data
    process_names = {}
    thread_names = {}
    threads = {}
    open_stack = defaultdict(list)
    hints = defaultdict(set)
    markers = []
    for ev in events:
        ph = ev.get("ph")
        pid = ev.get("pid")
        tid = ev.get("tid")
        name = ev.get("name", "")
        if ph == "M":
            if name == "process_name":
                process_names[pid] = ev.get("args", {}).get("name", "")
            elif name == "thread_name":
                thread_names[(pid, tid)] = ev.get("args", {}).get("name", "")
            continue
        args = ev.get("args") or {}
        if name == "TimeStamp":
            message = (args.get("data") or {}).get("message", "")
            if isinstance(message, str) and message.startswith("zenperf "):
                markers.append((message[len("zenperf "):], ev.get("ts", 0), pid))
        if len(hints[pid]) < 2 and args:
            blob = json.dumps(args) if not isinstance(args, str) else args
            if CHROME_HINT in blob:
                hints[pid].add("chrome")
            elif any(h in blob for h in PAGE_HINTS):
                hints[pid].add("page")
        key = (pid, tid)
        thread = threads.get(key)
        if thread is None:
            thread = threads[key] = Thread(thread_names.get(key, ""))
        if ph == "X":
            thread.events.append((ev.get("ts", 0), ev.get("dur", 0) or 0, name, args))
        elif ph == "B":
            open_stack[key].append(ev)
        elif ph == "E":
            stack = open_stack[key]
            if stack:
                begin = stack.pop()
                thread.events.append((begin.get("ts", 0), ev.get("ts", 0) - begin.get("ts", 0), begin.get("name", ""), begin.get("args") or {}))
    for key, thread in threads.items():
        thread.name = thread_names.get(key, thread.name)
        thread.events.sort(key=lambda e: (e[0], -e[1]))
    roles = {}
    for pid, found in hints.items():
        if "chrome" in found:
            roles[pid] = "chrome"
        elif "page" in found:
            roles[pid] = "page"
    return threads, process_names, roles, markers


def self_times(events):
    """Each event's self time (its duration less its children's), in event order."""
    selves = [0.0] * len(events)
    stack = []  # (end, index)
    child = [0.0] * len(events)
    for i, (ts, dur, _name, _args) in enumerate(events):
        while stack and stack[-1][0] <= ts:
            stack.pop()
        if stack:
            child[stack[-1][1]] += dur
        stack.append((ts + dur, i))
    for i, (_ts, dur, _name, _args) in enumerate(events):
        selves[i] = max(0.0, dur - child[i])
    return selves


def analyse_main_thread(thread, start_us, end_us):
    """The main thread's frames and named slices inside [start_us, end_us)."""
    events = thread.events
    if not events:
        return None
    # Only events starting inside the window; a frame straddling the edge is counted where it began.
    lo = 0
    hi = len(events)
    while lo < hi:
        mid = (lo + hi) // 2
        if events[mid][0] < start_us:
            lo = mid + 1
        else:
            hi = mid
    window = []
    for i in range(lo, len(events)):
        if events[i][0] >= end_us:
            break
        window.append(events[i])
    if not window:
        return {"events": 0}
    selves = self_times(window)
    by_name_total = defaultdict(float)
    by_name_self = defaultdict(float)
    by_name_count = defaultdict(int)
    by_name_max = defaultdict(float)
    resize_events = 0
    for (ts, dur, name, args), self_us in zip(window, selves):
        by_name_total[name] += dur
        by_name_self[name] += self_us
        by_name_count[name] += 1
        by_name_max[name] = max(by_name_max[name], dur)
        if name == "EventDispatch" and (args.get("data") or {}).get("type") == "resize":
            resize_events += 1
    frames = [(ts, dur) for ts, dur, name, _ in window if name in MAIN_FRAME_NAMES]
    frame_names = {name for _, _, name, _ in window if name in MAIN_FRAME_NAMES}

    def frames_with(slice_name):
        starts = sorted(ts for ts, _, name, _ in window if name == slice_name)
        if not starts or not frames:
            return 0
        count = 0
        import bisect

        for fts, fdur in frames:
            i = bisect.bisect_left(starts, fts)
            if i < len(starts) and starts[i] < fts + fdur:
                count += 1
        return count

    result = {
        "events": len(window),
        "busyMs": sum(selves) / 1000.0,
        "mainFrames": len(frames),
        "mainFrameNames": sorted(frame_names),
        "mainFrameMaxMs": max((d for _, d in frames), default=0) / 1000.0,
        "framesWithStyle": frames_with("UpdateLayoutTree"),
        "framesWithLayout": frames_with("Layout"),
        "framesWithPaint": frames_with("Paint"),
        "resizeEvents": resize_events,
        "named": {},
        "gcMs": sum(by_name_total[n] for n in GC_NAMES if n in by_name_total) / 1000.0,
        "gcCount": sum(by_name_count[n] for n in GC_NAMES if n in by_name_count),
        "topSelf": [],
    }
    for name in NAMED_SLICES:
        if by_name_count.get(name):
            result["named"][name] = {
                "count": by_name_count[name],
                "totalMs": by_name_total[name] / 1000.0,
                "maxMs": by_name_max[name] / 1000.0,
            }
    top = sorted(by_name_self.items(), key=lambda kv: -kv[1])[:8]
    result["topSelf"] = [{"name": n, "selfMs": v / 1000.0, "count": by_name_count[n], "maxMs": by_name_max[n] / 1000.0} for n, v in top]
    return result


def analyse_blink(path, scenes, marker_hint):
    """Per scene, the chrome's and the page's main thread; the clock offset checked against the markers."""
    threads, process_names, roles, markers = load_blink(path)
    offsets = []
    marker_by_label = {label: ts for label, ts, _pid in markers}
    for scene in scenes:
        label = scene.get("label")
        mark = scene.get("markerMonoUs")
        if label in marker_by_label and mark:
            offsets.append(marker_by_label[label] - mark)
    offset = statistics.median(offsets) if offsets else 0
    mains = {}
    for (pid, tid), thread in threads.items():
        if thread.name == "CrRendererMain" and pid in roles:
            role = roles[pid]
            # Several renderers of one role (a navigation moved the page to a new process): the busiest wins per scene.
            mains.setdefault(role, []).append((pid, thread))
    coverage = {}
    for role, items in mains.items():
        for pid, thread in items:
            if thread.events:
                coverage[f"{role}:{pid}"] = {"firstUs": thread.events[0][0], "lastUs": thread.events[-1][0] + thread.events[-1][1]}
    per_scene = {}
    for scene in scenes:
        start = scene["startMonoUs"] + offset
        end = scene["endMonoUs"] + offset
        entry = {}
        for role, items in mains.items():
            best = None
            for pid, thread in items:
                r = analyse_main_thread(thread, start, end)
                if r and (best is None or r.get("events", 0) > best[1].get("events", 0)):
                    best = (pid, r)
            if best:
                pid, r = best
                r["pid"] = pid
                first = coverage.get(f"{role}:{pid}", {}).get("firstUs")
                r["covered"] = first is not None and first <= start
                entry[role] = r
        per_scene[scene["label"]] = entry
    return {
        "file": os.path.basename(path),
        "processes": {str(pid): {"name": process_names.get(pid, ""), "role": roles.get(pid)} for pid in set(list(process_names) + list(roles))},
        "markerOffsetUs": offset,
        "markersFound": len(offsets),
        "coverage": coverage,
        "scenes": per_scene,
    }


# --- Perfetto ---------------------------------------------------------------------------------------


def analyse_perfetto(path, package, scenes, roles_by_pid):
    try:
        from perfetto.trace_processor import TraceProcessor
    except ImportError:
        return {"error": "the perfetto package is not installed (pip install perfetto); the system trace was not read"}
    try:
        tp = TraceProcessor(trace=str(path))
    except Exception as e:  # noqa: BLE001
        return {"error": f"trace_processor could not open {os.path.basename(path)}: {e}"}

    def q(sql):
        return list(tp.query(sql))

    out = {"file": os.path.basename(path), "queries": {}}
    try:
        procs = q(f"SELECT upid, pid, name FROM process WHERE name = '{package}' ORDER BY start_ts DESC")
        if not procs:
            procs = q(f"SELECT upid, pid, name FROM process WHERE name LIKE '%{package.split('.')[-1]}%' ORDER BY start_ts DESC")
        if not procs:
            out["error"] = f"no process named {package} in the trace"
            return out
        upid = procs[0].upid
        pid = procs[0].pid
        out["pid"] = pid
        main = q(f"SELECT utid FROM thread WHERE upid = {upid} AND tid = {pid}")
        main_utid = main[0].utid if main else None
        render = q(f"SELECT utid FROM thread WHERE upid = {upid} AND name = 'RenderThread'")
        render_utid = render[0].utid if render else None
        # The scene markers the driver planted (async slices under the app's atrace tag), preferred over the JSON's clock.
        marks = {}
        for r in q("SELECT name, ts, dur FROM slice WHERE name LIKE 'zenperf %' AND dur > 0"):
            marks[r.name[len("zenperf "):]] = (r.ts, r.ts + r.dur)
        out["markersFound"] = len(marks)
        renderer_pids = {}
        for r in q("SELECT pid, name FROM process WHERE name LIKE '%sandboxed_process%' OR name LIKE '%webview%'"):
            renderer_pids[r.pid] = r.name
        out["renderers"] = {str(k): {"name": v, "role": roles_by_pid.get(k)} for k, v in renderer_pids.items()}
    except Exception as e:  # noqa: BLE001
        out["error"] = f"trace_processor: {e}"
        return out

    per_scene = {}
    for scene in scenes:
        label = scene["label"]
        s, e = marks.get(label, (scene["startBootNs"], scene["endBootNs"]))
        entry = {"fromMarker": label in marks}

        def guarded(name, fn):
            try:
                entry[name] = fn()
            except Exception as ex:  # noqa: BLE001
                entry[name] = None
                out["queries"].setdefault(name, str(ex))

        def do_frames():
            if main_utid is None:
                return None
            durs = [r.dur for r in q(
                f"SELECT s.dur FROM slice s JOIN thread_track tt ON s.track_id = tt.id "
                f"WHERE tt.utid = {main_utid} AND s.name LIKE 'Choreographer#doFrame%' AND s.ts >= {s} AND s.ts < {e}")]
            return {"count": len(durs), "p50Ms": ms(percentile(durs, 50)), "p95Ms": ms(percentile(durs, 95)), "maxMs": ms(max(durs)) if durs else None,
                    "overBudget": sum(1 for d in durs if d / 1e6 > FRAME_BUDGET_MS)}

        def ui_slices():
            if main_utid is None:
                return None
            rows = q(
                f"SELECT s.name AS name, COUNT(*) AS n, SUM(s.dur) AS total, MAX(s.dur) AS mx FROM slice s JOIN thread_track tt ON s.track_id = tt.id "
                f"WHERE tt.utid = {main_utid} AND s.name IN ('traversal','measure','layout','draw','input','animation','inflate') "
                f"AND s.ts >= {s} AND s.ts < {e} GROUP BY s.name")
            return {r.name: {"count": r.n, "totalMs": ms(r.total), "maxMs": ms(r.mx)} for r in rows}

        def render_thread():
            if render_utid is None:
                return None
            draws = [r.dur for r in q(
                f"SELECT s.dur FROM slice s JOIN thread_track tt ON s.track_id = tt.id "
                f"WHERE tt.utid = {render_utid} AND s.name LIKE 'DrawFrames%' AND s.ts >= {s} AND s.ts < {e}")]
            deq = [r.dur for r in q(
                f"SELECT s.dur FROM slice s JOIN thread_track tt ON s.track_id = tt.id "
                f"WHERE tt.utid = {render_utid} AND s.name = 'dequeueBuffer' AND s.ts >= {s} AND s.ts < {e}")]
            return {"drawFrames": len(draws), "drawP50Ms": ms(percentile(draws, 50)), "drawP95Ms": ms(percentile(draws, 95)),
                    "drawMaxMs": ms(max(draws)) if draws else None,
                    "dequeueBuffer": len(deq), "dequeueP95Ms": ms(percentile(deq, 95)), "dequeueMaxMs": ms(max(deq)) if deq else None}

        def timeline():
            rows = q(
                f"SELECT jank_type, present_type, COUNT(*) AS n, AVG(dur) AS avg_dur FROM actual_frame_timeline_slice "
                f"WHERE upid = {upid} AND ts >= {s} AND ts < {e} GROUP BY jank_type, present_type")
            total = sum(r.n for r in rows)
            by_jank = defaultdict(int)
            for r in rows:
                by_jank[r.jank_type or "None"] += r.n
            janky = sum(n for j, n in by_jank.items() if j not in ("None",))
            return {"frames": total, "janky": janky, "byJankType": dict(by_jank),
                    "presentTypes": {f"{r.present_type}": r.n for r in rows}}

        def cpu():
            rows = q(
                f"SELECT p.pid AS pid, p.name AS process, t.tid AS tid, t.name AS thread, "
                f"SUM(MIN(ts.ts + ts.dur, {e}) - MAX(ts.ts, {s})) AS running FROM thread_state ts "
                f"JOIN thread t USING(utid) LEFT JOIN process p USING(upid) "
                f"WHERE ts.state = 'Running' AND ts.ts < {e} AND ts.ts + ts.dur > {s} "
                f"GROUP BY 1, 2, 3, 4 ORDER BY running DESC LIMIT 14")
            window_ms = (e - s) / 1e6
            threads = []
            for r in rows:
                role = roles_by_pid.get(r.pid)
                proc = r.process or ""
                if proc == package:
                    proc = "app"
                elif "sandboxed_process" in proc or "webview" in proc:
                    proc = f"renderer{'(' + role + ')' if role else ''}"
                threads.append({"process": proc, "pid": r.pid, "thread": r.thread or "", "tid": r.tid, "ms": ms(r.running),
                                "share": (r.running / 1e6) / window_ms if window_ms else None})
            total = q(f"SELECT SUM(MIN(ts + dur, {e}) - MAX(ts, {s})) AS running FROM thread_state WHERE state = 'Running' AND ts < {e} AND ts + dur > {s}")
            return {"windowMs": window_ms, "totalRunningMs": ms(total[0].running) if total and total[0].running else 0.0, "threads": threads}

        def binder():
            rows = q(
                f"SELECT COUNT(*) AS n, SUM(s.dur) AS total FROM slice s JOIN thread_track tt ON s.track_id = tt.id JOIN thread t USING(utid) "
                f"WHERE t.upid = {upid} AND (s.name = 'binder transaction' OR s.name = 'binder reply' OR s.name = 'binder transaction async') "
                f"AND s.ts >= {s} AND s.ts < {e}")
            return {"count": rows[0].n if rows else 0, "totalMs": ms(rows[0].total) if rows and rows[0].total else 0.0}

        def switches():
            if main_utid is None:
                return None
            rows = q(f"SELECT COUNT(*) AS n FROM sched WHERE utid = {main_utid} AND ts >= {s} AND ts < {e}")
            return rows[0].n if rows else None

        guarded("doFrame", do_frames)
        guarded("uiSlices", ui_slices)
        guarded("renderThread", render_thread)
        guarded("frameTimeline", timeline)
        guarded("cpu", cpu)
        guarded("binder", binder)
        guarded("mainThreadSwitches", switches)
        per_scene[label] = entry
    out["scenes"] = per_scene
    return out


# --- the report -------------------------------------------------------------------------------------


def named(main, name):
    n = (main or {}).get("named", {}).get(name)
    if not n:
        return "–"
    return f"{n['totalMs']:.0f} ({n['count']})"


def build_report(record, gfx_by_label, blink_by_page, perfetto, scenes_flat):
    lines = []
    window = record.get("window", {})
    lines.append("## Zenium Android bar hide profile")
    lines.append("")
    lines.append(
        f"Window {window.get('width')}x{window.get('height')} at density {window.get('density')}, WebView {record.get('webview')}, "
        f"package `{record.get('package')}`, bar travel {record.get('barTravelCss')} CSS px. Frame budget {FRAME_BUDGET_MS} ms (60 Hz)."
    )
    lines.append("")
    lines.append(
        "Emulator caveat: the hosted runner has no GPU, so the emulator composites in software and the GPU-side stages "
        "(command issue, swap, dequeueBuffer) are inflated; a before and an after on this one recipe are the evidence, and the "
        "main-thread work – the chrome renderer's style, layout, paint and script, the app's traversals – is representative."
    )
    lines.append("")

    # Table 1: frames per scene (gfxinfo + counters).
    lines.append("### Frames per scene (`dumpsys gfxinfo`, the whole scene) and the in-process counters")
    lines.append("")
    lines.append("| page | scene | frames | janky | janky % | 50th | 90th | 95th | 99th | long stage of the slow frames (sample) | UI layouts | page WebView resizes | barScroll in | root style writes | page resize events | page scroll events |")
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|")
    for scene in scenes_flat:
        g = gfx_by_label.get(scene["label"]) or {}
        v = scene.get("views", {})
        c = scene.get("chrome", {})
        p = scene.get("pageCounters", {})
        lines.append(
            f"| {scene['pageKey']} | {scene['name']} | {fmt(g.get('frames'))} | {fmt(g.get('janky'))} | {fmt(g.get('jankyPercent'))} | "
            f"{fmt(g.get('p50'))} | {fmt(g.get('p90'))} | {fmt(g.get('p95'))} | {fmt(g.get('p99'))} | {long_stage(g)} | "
            f"{fmt(v.get('layouts'))} | {fmt(v.get('pageBounds'))} | {fmt(c.get('barScroll'))} | {fmt(c.get('styleWrites'))} | "
            f"{fmt(p.get('resizes'))} | {fmt(p.get('scrolls'))} |"
        )
    lines.append("")
    lines.append(
        "UI layouts: layout passes of the app's window (`OnGlobalLayoutListener`); page WebView resizes: changes of the page view's bounds; "
        "barScroll in: scroll reports the host streamed into the chrome; root style writes: writes of `--zen-bar-hide` on the chrome's root "
        "(each is a host frame back, `chrome.setBarHide`); page resize events: the page's own `resize` events (its viewport changed)."
    )
    lines.append("")

    # Table 2: stages.
    lines.append("### The stages of the frames (framestats, the last 120 frames of each scene at most; mean / 95th, ms)")
    lines.append("")
    lines.append("| page | scene | sample | slow | input | animation | measure/layout | draw | sync queue | sync | command issue (GPU) | swap | UI thread 95th | frame 95th |")
    lines.append("|---|---|---:|---:|---|---|---|---|---|---|---|---|---:|---:|")
    for scene in scenes_flat:
        g = gfx_by_label.get(scene["label"]) or {}
        mean = g.get("stageMean") or {}
        p95 = g.get("stageP95") or {}

        def cell(k):
            if k not in mean:
                return "–"
            return f"{mean[k]:.1f} / {p95[k]:.1f}"

        lines.append(
            f"| {scene['pageKey']} | {scene['name']} | {fmt(g.get('sample'))} | {fmt(g.get('slowInSample'))} | "
            + " | ".join(cell(k) for k in STAGES)
            + f" | {fmt(g.get('uiThreadP95Sample'))} | {fmt(g.get('totalP95Sample'))} |"
        )
    lines.append("")

    # Table 3: the chrome renderer's main thread.
    lines.append("### The chrome renderer's main thread per scene (Chromium trace; ms, count in brackets)")
    lines.append("")
    lines.append("| page | scene | covered | main frames | with style recalc | with layout | with paint | busy ms | UpdateLayoutTree | Layout | PrePaint | Paint | FunctionCall | GC | top slices by self time |")
    lines.append("|---|---|---|---:|---:|---:|---:|---:|---|---|---|---|---|---|---|")
    for scene in scenes_flat:
        b = ((blink_by_page.get(scene["pageKey"]) or {}).get("scenes") or {}).get(scene["label"]) or {}
        m = b.get("chrome")
        if not m or m.get("events", 0) == 0:
            lines.append(f"| {scene['pageKey']} | {scene['name']} | – | – | – | – | – | – | – | – | – | – | – | – | no chrome renderer events in the window |")
            continue
        top = "; ".join(f"{t['name']} {t['selfMs']:.0f} ({t['count']})" for t in m.get("topSelf", [])[:5])
        lines.append(
            f"| {scene['pageKey']} | {scene['name']} | {fmt(m.get('covered'))} | {fmt(m.get('mainFrames'))} | {fmt(m.get('framesWithStyle'))} | "
            f"{fmt(m.get('framesWithLayout'))} | {fmt(m.get('framesWithPaint'))} | {fmt(m.get('busyMs'), 0)} | {named(m, 'UpdateLayoutTree')} | {named(m, 'Layout')} | "
            f"{named(m, 'PrePaint')} | {named(m, 'Paint')} | {named(m, 'FunctionCall')} | {fmt(m.get('gcMs'), 0)} ({fmt(m.get('gcCount'))}) | {top} |"
        )
    lines.append("")

    # Table 4: the page renderer's main thread.
    lines.append("### The page renderer's main thread per scene (Chromium trace; ms, count in brackets)")
    lines.append("")
    lines.append("| page | scene | covered | main frames | with layout | with paint | busy ms | Layout | UpdateLayoutTree | Paint | FunctionCall | resize events dispatched | GC | top slices by self time |")
    lines.append("|---|---|---|---:|---:|---:|---:|---|---|---|---|---:|---|---|")
    for scene in scenes_flat:
        b = ((blink_by_page.get(scene["pageKey"]) or {}).get("scenes") or {}).get(scene["label"]) or {}
        m = b.get("page")
        if not m or m.get("events", 0) == 0:
            lines.append(f"| {scene['pageKey']} | {scene['name']} | – | – | – | – | – | – | – | – | – | – | – | no page renderer events in the window |")
            continue
        top = "; ".join(f"{t['name']} {t['selfMs']:.0f} ({t['count']})" for t in m.get("topSelf", [])[:5])
        lines.append(
            f"| {scene['pageKey']} | {scene['name']} | {fmt(m.get('covered'))} | {fmt(m.get('mainFrames'))} | {fmt(m.get('framesWithLayout'))} | {fmt(m.get('framesWithPaint'))} | "
            f"{fmt(m.get('busyMs'), 0)} | {named(m, 'Layout')} | {named(m, 'UpdateLayoutTree')} | {named(m, 'Paint')} | {named(m, 'FunctionCall')} | "
            f"{fmt(m.get('resizeEvents'))} | {fmt(m.get('gcMs'), 0)} ({fmt(m.get('gcCount'))}) | {top} |"
        )
    lines.append("")

    # Table 5: Perfetto.
    lines.append("### The device per scene (Perfetto)")
    lines.append("")
    if not perfetto:
        lines.append("No Perfetto trace in the artifact.")
    elif perfetto.get("error"):
        lines.append(f"The Perfetto trace was not read: {perfetto['error']}")
    else:
        lines.append(
            "| page | scene | window ms | doFrame n / 50th / 95th / max | over budget | UI layout slices | DrawFrames n / 95th / max | dequeueBuffer n / 95th | "
            "frame timeline: frames / janky (by type) | app main CPU | RenderThread CPU | chrome renderer main CPU | page renderer main CPU | SurfaceFlinger CPU | all CPU (of 3 cores) | binder txns | main thread switches |"
        )
        lines.append("|---|---|---:|---|---:|---:|---|---|---|---:|---:|---:|---:|---:|---|---:|---:|")
        for scene in scenes_flat:
            e = (perfetto.get("scenes") or {}).get(scene["label"]) or {}
            d = e.get("doFrame") or {}
            u = e.get("uiSlices") or {}
            r = e.get("renderThread") or {}
            t = e.get("frameTimeline") or {}
            c = e.get("cpu") or {}
            threads = c.get("threads") or []

            def cpu_of(pred):
                total = sum(th["ms"] for th in threads if pred(th))
                return f"{total:.0f}" if total else "–"

            jank_types = ", ".join(f"{k} {v}" for k, v in sorted((t.get("byJankType") or {}).items(), key=lambda kv: -kv[1]) if k != "None")
            window_ms = c.get("windowMs")
            all_cpu = c.get("totalRunningMs")
            cores = f"{all_cpu:.0f} ({all_cpu / window_ms / 3 * 100:.0f}%)" if window_ms and all_cpu is not None else "–"
            lines.append(
                f"| {scene['pageKey']} | {scene['name']} | {fmt(window_ms, 0)} | {fmt(d.get('count'))} / {fmt(d.get('p50Ms'))} / {fmt(d.get('p95Ms'))} / {fmt(d.get('maxMs'))} | "
                f"{fmt(d.get('overBudget'))} | {fmt((u.get('layout') or {}).get('count'))} | "
                f"{fmt(r.get('drawFrames'))} / {fmt(r.get('drawP95Ms'))} / {fmt(r.get('drawMaxMs'))} | {fmt(r.get('dequeueBuffer'))} / {fmt(r.get('dequeueP95Ms'))} | "
                f"{fmt(t.get('frames'))} / {fmt(t.get('janky'))} ({jank_types or 'none'}) | "
                f"{cpu_of(lambda th: th['process'] == 'app' and th['tid'] == th['pid'])} | {cpu_of(lambda th: th['process'] == 'app' and th['thread'] == 'RenderThread')} | "
                f"{cpu_of(lambda th: th['process'] == 'renderer(chrome)' and th['thread'] == 'CrRendererMain')} | "
                f"{cpu_of(lambda th: th['process'] == 'renderer(page)' and th['thread'] == 'CrRendererMain')} | "
                f"{cpu_of(lambda th: (th['process'] or '').endswith('surfaceflinger'))} | {cores} | "
                f"{fmt((e.get('binder') or {}).get('count'))} | {fmt(e.get('mainThreadSwitches'))} |"
            )
        lines.append("")
        lines.append(f"Scene windows from the driver's markers in the trace: {perfetto.get('markersFound', 0)} of {len(scenes_flat)}; the rest from the driver's clock.")
        if perfetto.get("queries"):
            lines.append("")
            lines.append("Queries that failed: " + "; ".join(f"{k}: {v}" for k, v in perfetto["queries"].items()))
    lines.append("")

    # Notes: pages that did not load, markers.
    notes = []
    for page in record.get("pages", []):
        if not page.get("loaded"):
            notes.append(f"{page['key']} did not load ({page.get('url')}); its scenes are missing.")
    for page_key, b in blink_by_page.items():
        if b.get("markersFound") is not None:
            notes.append(f"{page_key}: Chromium trace {b.get('file')}, clock offset to the driver {b.get('markerOffsetUs', 0) / 1000:.1f} ms from {b.get('markersFound')} markers.")
    if notes:
        lines.append("Notes: " + " ".join(notes))
        lines.append("")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dir")
    ap.add_argument("--summary", help="append the Markdown report to this file (the job summary)")
    args = ap.parse_args()
    root = Path(args.dir)
    record_path = root / "perf-scenes.json"
    if not record_path.exists():
        print(f"::warning::no perf-scenes.json under {root}; nothing to analyse")
        return 0
    record = json.loads(record_path.read_text())
    scenes_flat = []
    for page in record.get("pages", []):
        for scene in page.get("scenes", []):
            scene = dict(scene)
            scene["pageKey"] = page["key"]
            scene["pageCounters"] = scene.get("page") or {}
            scene["label"] = f"{page['key']}/{scene['name']}"
            scenes_flat.append(scene)

    gfx_by_label = {}
    for scene in scenes_flat:
        path = root / scene.get("gfx", "")
        if scene.get("gfx") and path.exists():
            gfx_by_label[scene["label"]] = parse_gfx(path.read_text(errors="replace"))

    blink_by_page = {}
    roles_by_pid = {}
    for page in record.get("pages", []):
        name = page.get("blink")
        if not name:
            continue
        path = root / name
        if not path.exists():
            continue
        page_scenes = [s for s in scenes_flat if s["pageKey"] == page["key"]]
        try:
            result = analyse_blink(path, page_scenes, None)
        except Exception as e:  # noqa: BLE001
            print(f"::warning::could not read {name}: {e}")
            continue
        blink_by_page[page["key"]] = result
        for pid, info in result.get("processes", {}).items():
            if info.get("role"):
                roles_by_pid[int(pid)] = info["role"]

    perfetto = None
    traces = sorted(root.glob("zen-*.pftrace"))
    if traces:
        perfetto = analyse_perfetto(traces[-1], record.get("package", ""), scenes_flat, roles_by_pid)

    report = build_report(record, gfx_by_label, blink_by_page, perfetto, scenes_flat)
    (root / "perf-report.md").write_text(report)
    (root / "perf-report.json").write_text(json.dumps({
        "record": record, "gfx": gfx_by_label, "blink": blink_by_page, "perfetto": perfetto
    }, indent=1, default=str))
    print(report)
    if args.summary:
        with open(args.summary, "a", encoding="utf-8") as f:
            f.write(report + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
