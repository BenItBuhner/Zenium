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

The numbers, per page and scene, in the order the performance program reads them (the harness
floor: on the software-GPU emulator frame times are reported, never judged; the main thread's
work per frame is what a device would feel):
  - the renderer's main thread from the Chromium trace: WebView runs ONE renderer process per
    app, so the chrome and the page share one `CrRendererMain`. Its busy time over the scene and
    per frame, its style recalculations / layouts / pre-paints / paints per frame, the script it
    ran (the host's `evaluateJavascript` tasks among them), its long tasks and its GC. WebView's
    tracing controller strips every event's arguments, so the chrome and the page are told
    apart by the `performance.mark()` sentinels the driver plants (`blink.user_timing`, named
    `zenperf c:…` in the chrome and `zenperf p:…` in the page): a main-thread frame or task is
    the chrome's when a chrome mark lies inside it, the page's when a page mark does, unmarked
    otherwise (a page's own script, a timer, GC);
  - gfxinfo: total frames, janky frames and share, the 50 / 90 / 95 / 99th percentiles, and from
    the framestats rows (the last 120 frames at most) each stage's mean and 95th – input,
    animation, measure / layout, draw, the sync queue wait, sync, command issue (GPU), swap – and
    which stage was the longest in the frames over budget;
  - Perfetto: the app's Choreographer frames and their durations, its layout passes, the
    RenderThread's DrawFrames and dequeueBuffer waits, SurfaceFlinger's frame timeline (frames
    and jank types for the app's layer), CPU time by thread across the device (the app's main
    thread and RenderThread, the renderer's main thread, SurfaceFlinger), binder transactions
    and the main thread's context switches.
"""
from __future__ import annotations

import argparse
import bisect
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
LONG_TASK_MS = 50.0
MARK_PREFIX = "zenperf "

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

# The lifecycle stages of a main-thread frame and the script tasks, as the DevTools timeline names them.
STAGE_SLICES = ("UpdateLayoutTree", "Layout", "PrePaint", "Paint")
NAMED_SLICES = STAGE_SLICES + ("UpdateLayer", "Commit", "FunctionCall", "EvaluateScript", "v8.callFunction", "TimerFire",
                               "HitTest", "EventDispatch", "Animation", "ScrollUpdate", "ParseHTML", "UpdateLayerTree",
                               "LocalFrameView::NotifyResizeObservers", "LayerTreeHost::WaitForCommitCompletion")
GC_NAMES = ("MinorGC", "MajorGC", "V8.GCScavenger", "V8.GCFinalizeMC", "V8.GCIncrementalMarking", "V8.GC_MC_INCREMENTAL",
            "V8.GC_MC_INCREMENTAL_EMBEDDER_PROLOGUE", "V8.GC_MC_INCREMENTAL_START", "V8.GC_SCAVENGER_SCAVENGE_PARALLEL",
            "BlinkGC.AtomicPauseMarkTransitiveClosure", "BlinkGC.CompleteSweep", "BlinkGC.IncrementalMarkingStep")
MAIN_FRAME_NAMES = ("ProxyMain::BeginMainFrame", "BeginMainThreadFrame", "ThreadProxy::BeginMainFrame")
# The enclosing task the scheduler runs (its name depends on the categories on; the outermost slice is the task either way).
OWNERS = ("chrome", "page", "both", "unmarked")


class Thread:
    __slots__ = ("events", "name")

    def __init__(self, name):
        self.name = name
        self.events = []  # (ts, dur, name) for complete events, sorted by (ts, -dur)


def load_blink(path):
    """Events by (pid, tid); process and thread names; the driver's marks as (ts, label, pid, tid).

    The marks are the `performance.mark('zenperf …')` events (`blink.user_timing`); should their
    names not survive the controller's filter, the chrome's `console.timeStamp` calls – `TimeStamp`
    instants of the DevTools timeline, which only the chrome makes – stand in as `c:stamp` marks.
    """
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
    marks = []
    stamps = []
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
        if name.startswith(MARK_PREFIX) and ph in ("R", "I", "i", "n", "b"):
            marks.append((ev.get("ts", 0), name[len(MARK_PREFIX):], pid, tid))
            continue
        if name == "TimeStamp" and ph in ("I", "i", "n", "R"):
            stamps.append((ev.get("ts", 0), "c:stamp", pid, tid))
            continue
        key = (pid, tid)
        thread = threads.get(key)
        if thread is None:
            thread = threads[key] = Thread(thread_names.get(key, ""))
        if ph == "X":
            thread.events.append((ev.get("ts", 0), ev.get("dur", 0) or 0, name))
        elif ph == "B":
            open_stack[key].append(ev)
        elif ph == "E":
            stack = open_stack[key]
            if stack:
                begin = stack.pop()
                thread.events.append((begin.get("ts", 0), ev.get("ts", 0) - begin.get("ts", 0), begin.get("name", "")))
    for key, thread in threads.items():
        thread.name = thread_names.get(key, thread.name)
        thread.events.sort(key=lambda e: (e[0], -e[1]))
    if not marks:
        marks = stamps
    marks.sort()
    return threads, process_names, marks


def self_times(events):
    """Each event's self time (its duration less its children's), and its depth, in event order."""
    child = [0.0] * len(events)
    depth = [0] * len(events)
    stack = []  # (end, index)
    for i, (ts, dur, _name) in enumerate(events):
        while stack and stack[-1][0] <= ts:
            stack.pop()
        if stack:
            child[stack[-1][1]] += dur
        depth[i] = len(stack)
        stack.append((ts + dur, i))
    selves = [max(0.0, dur - c) for (_ts, dur, _name), c in zip(events, child)]
    return selves, depth


def owner_of(mark_ts, mark_kind, start, end):
    """Who a range [start, end) belongs to, by the marks inside it: c: the chrome, p: the page."""
    lo = bisect.bisect_left(mark_ts, start)
    hi = bisect.bisect_left(mark_ts, end)
    kinds = set(mark_kind[lo:hi])
    if "c" in kinds and "p" in kinds:
        return "both"
    if "c" in kinds:
        return "chrome"
    if "p" in kinds:
        return "page"
    return "unmarked"


def analyse_main_thread(thread, marks, start_us, end_us, gfx_frames):
    """The renderer main thread's work inside [start_us, end_us): per owner, per frame, its long tasks."""
    events = thread.events
    if not events:
        return None
    lo = bisect.bisect_left([e[0] for e in events], start_us)
    window = []
    for i in range(lo, len(events)):
        if events[i][0] >= end_us:
            break
        window.append(events[i])
    if not window:
        return {"events": 0}
    selves, depth = self_times(window)
    mark_ts = [m[0] for m in marks]
    mark_kind = [m[1][:1] for m in marks]
    mark_labels = defaultdict(int)
    for ts, label, _pid, _tid in marks:
        if start_us <= ts < end_us:
            mark_labels[label] += 1

    # Tasks: the outermost slices. Frames: BeginMainThreadFrame, wherever they nest.
    tasks = []
    for i, (ts, dur, name) in enumerate(window):
        if depth[i] == 0:
            tasks.append({"ts": ts, "dur": dur, "name": name, "owner": owner_of(mark_ts, mark_kind, ts, ts + dur), "index": i})
    frames = [(ts, dur, owner_of(mark_ts, mark_kind, ts, ts + dur)) for ts, dur, name in window if name in MAIN_FRAME_NAMES]
    frame_starts = [f[0] for f in frames]

    def owner_at(ts):
        # The innermost frame around `ts` decides; else the task around it.
        i = bisect.bisect_right(frame_starts, ts) - 1
        if i >= 0 and frames[i][0] <= ts < frames[i][0] + frames[i][1]:
            return frames[i][2]
        j = bisect.bisect_right([t["ts"] for t in tasks], ts) - 1
        if j >= 0 and tasks[j]["ts"] <= ts < tasks[j]["ts"] + tasks[j]["dur"]:
            return tasks[j]["owner"]
        return "unmarked"

    by_owner = {o: {"busyMs": 0.0, "frames": 0, "named": defaultdict(lambda: {"count": 0, "totalMs": 0.0, "maxMs": 0.0})} for o in OWNERS}
    for _ts, _dur, owner in frames:
        by_owner[owner]["frames"] += 1
    by_name_total = defaultdict(float)
    by_name_self = defaultdict(float)
    by_name_count = defaultdict(int)
    by_name_max = defaultdict(float)
    for (ts, dur, name), self_us in zip(window, selves):
        by_name_total[name] += dur
        by_name_self[name] += self_us
        by_name_count[name] += 1
        by_name_max[name] = max(by_name_max[name], dur)
        owner = owner_at(ts)
        by_owner[owner]["busyMs"] += self_us / 1000.0
        if name in NAMED_SLICES or name in GC_NAMES:
            n = by_owner[owner]["named"][name]
            n["count"] += 1
            n["totalMs"] += dur / 1000.0
            n["maxMs"] = max(n["maxMs"], dur / 1000.0)

    # The host's script tasks in the chrome: a `barScroll` report is a task with a `c:scroll` mark inside.
    scroll_mark_ts = [m[0] for m in marks if m[1] == "c:scroll"]
    bar_scroll_tasks = []
    for t in tasks:
        i = bisect.bisect_left(scroll_mark_ts, t["ts"])
        if i < len(scroll_mark_ts) and scroll_mark_ts[i] < t["ts"] + t["dur"]:
            bar_scroll_tasks.append(t["dur"] / 1000.0)

    long_tasks = []
    for t in tasks:
        if t["dur"] / 1000.0 > LONG_TASK_MS:
            i = t["index"]
            end = t["ts"] + t["dur"]
            inner = defaultdict(float)
            for j in range(i + 1, len(window)):
                if window[j][0] >= end:
                    break
                inner[window[j][2]] += selves[j]
            top_inner = sorted(inner.items(), key=lambda kv: -kv[1])[:4]
            long_tasks.append({
                "atMs": (t["ts"] - start_us) / 1000.0, "ms": t["dur"] / 1000.0, "name": t["name"], "owner": t["owner"],
                "selfMs": selves[i] / 1000.0,
                "inside": [{"name": n, "selfMs": v / 1000.0} for n, v in top_inner],
            })
    long_tasks.sort(key=lambda t: -t["ms"])

    busy_ms = sum(selves) / 1000.0
    frames_div = gfx_frames if gfx_frames else None

    def per_frame(count):
        return (count / frames_div) if frames_div else None

    result = {
        "events": len(window),
        "busyMs": busy_ms,
        "busyShare": busy_ms / ((end_us - start_us) / 1000.0) if end_us > start_us else None,
        "msPerGfxFrame": per_frame(busy_ms),
        "tasks": len(tasks),
        "longTasks": long_tasks[:6],
        "longTaskCount": len(long_tasks),
        "longTaskMaxMs": long_tasks[0]["ms"] if long_tasks else 0.0,
        "longTaskMs": sum(t["ms"] for t in long_tasks),
        "mainFrames": {"total": len(frames), **{o: by_owner[o]["frames"] for o in OWNERS}},
        "mainFrameMaxMs": max((d for _, d, _ in frames), default=0) / 1000.0,
        "perGfxFrame": {name: per_frame(by_name_count.get(name, 0)) for name in STAGE_SLICES},
        "named": {},
        "byOwner": {},
        "barScrollTasks": {"count": len(bar_scroll_tasks), "totalMs": sum(bar_scroll_tasks), "maxMs": max(bar_scroll_tasks, default=0.0)},
        "marks": dict(mark_labels),
        "gcMs": sum(by_name_total[n] for n in GC_NAMES if n in by_name_total) / 1000.0,
        "gcCount": sum(by_name_count[n] for n in GC_NAMES if n in by_name_count),
        "topSelf": [],
    }
    for name in NAMED_SLICES:
        if by_name_count.get(name):
            result["named"][name] = {"count": by_name_count[name], "totalMs": by_name_total[name] / 1000.0, "maxMs": by_name_max[name] / 1000.0}
    for o in OWNERS:
        result["byOwner"][o] = {"busyMs": by_owner[o]["busyMs"], "frames": by_owner[o]["frames"],
                               "named": {k: dict(v) for k, v in by_owner[o]["named"].items()}}
    top = sorted(by_name_self.items(), key=lambda kv: -kv[1])[:8]
    result["topSelf"] = [{"name": n, "selfMs": v / 1000.0, "count": by_name_count[n], "maxMs": by_name_max[n] / 1000.0} for n, v in top]
    return result


def analyse_blink(path, scenes, gfx_by_label):
    """Per scene, the renderer main thread; the busiest `CrRendererMain` of the trace (there is one renderer, a restart aside)."""
    threads, process_names, marks = load_blink(path)
    mains = [(pid, thread) for (pid, _tid), thread in threads.items() if thread.name == "CrRendererMain" and thread.events]
    mains.sort(key=lambda pt: -len(pt[1].events))
    coverage = {}
    for pid, thread in mains:
        coverage[str(pid)] = {"firstUs": thread.events[0][0], "lastUs": thread.events[-1][0] + thread.events[-1][1], "events": len(thread.events)}
    per_scene = {}
    for scene in scenes:
        start = scene["startMonoUs"]
        end = scene["endMonoUs"]
        gfx_frames = (gfx_by_label.get(scene["label"]) or {}).get("frames")
        best = None
        for pid, thread in mains:
            r = analyse_main_thread(thread, [m for m in marks if m[2] == pid], start, end, gfx_frames)
            if r and (best is None or r.get("events", 0) > best[1].get("events", 0)):
                best = (pid, r)
        if best:
            pid, r = best
            r["pid"] = pid
            first = coverage[str(pid)]["firstUs"]
            r["covered"] = first <= start
            per_scene[scene["label"]] = r
        else:
            per_scene[scene["label"]] = {"events": 0}
    return {
        "file": os.path.basename(path),
        "processes": {str(pid): process_names.get(pid, "") for pid in process_names},
        "rendererPids": [pid for pid, _ in mains],
        "marks": len(marks),
        "coverage": coverage,
        "scenes": per_scene,
    }


# --- Perfetto ---------------------------------------------------------------------------------------


def analyse_perfetto(path, package, scenes, renderer_pids):
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
        renderers = {}
        for r in q("SELECT pid, name FROM process WHERE name LIKE '%sandboxed_process%' OR name LIKE '%webview%'"):
            renderers[r.pid] = r.name
        out["renderers"] = {str(k): v for k, v in renderers.items()}
        renderer_set = set(renderers) | set(renderer_pids)
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
                f"WHERE tt.utid = {main_utid} AND s.name IN ('traversal','measure','layout','draw','input','animation','inflate','deliverInputEvent') "
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
                f"GROUP BY 1, 2, 3, 4 ORDER BY running DESC LIMIT 16")
            window_ms = (e - s) / 1e6
            threads = []
            for r in rows:
                proc = r.process or ""
                if proc == package:
                    proc = "app"
                elif r.pid in renderer_set or "sandboxed_process" in proc or "webview" in proc:
                    proc = "renderer"
                threads.append({"process": proc, "pid": r.pid, "thread": r.thread or "", "tid": r.tid, "ms": ms(r.running),
                                "share": (r.running / 1e6) / window_ms if window_ms else None})
            total = q(f"SELECT SUM(MIN(ts + dur, {e}) - MAX(ts, {s})) AS running FROM thread_state WHERE state = 'Running' AND ts < {e} AND ts + dur > {s}")
            return {"windowMs": window_ms, "totalRunningMs": ms(total[0].running) if total and total[0].running else 0.0, "threads": threads}

        def binder():
            # Transactions the app's threads made or answered, and those the renderer's did: the bridge is binder both ways.
            def count(pred):
                rows = q(
                    f"SELECT COUNT(*) AS n, SUM(s.dur) AS total FROM slice s JOIN thread_track tt ON s.track_id = tt.id JOIN thread t USING(utid) "
                    f"LEFT JOIN process p USING(upid) WHERE {pred} AND (s.name = 'binder transaction' OR s.name = 'binder reply' OR s.name = 'binder transaction async') "
                    f"AND s.ts >= {s} AND s.ts < {e}")
                return {"count": rows[0].n if rows else 0, "totalMs": ms(rows[0].total) if rows and rows[0].total else 0.0}
            renderer_pred = " OR ".join(f"p.pid = {rp}" for rp in renderer_set) or "0"
            return {"app": count(f"t.upid = {upid}"), "renderer": count(f"({renderer_pred})")}

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


def named(main, name, digits=0):
    n = (main or {}).get("named", {}).get(name)
    if not n:
        return "–"
    return f"{n['totalMs']:.{digits}f} ({n['count']})"


def owner_cell(main, owner, name):
    n = (((main or {}).get("byOwner") or {}).get(owner) or {}).get("named", {}).get(name)
    if not n:
        return "–"
    return f"{n['count']} / {n['totalMs']:.0f}"


def per_frame_cell(main, name):
    r = ((main or {}).get("perGfxFrame") or {}).get(name)
    n = (main or {}).get("named", {}).get(name)
    if r is None:
        return f"– ({n['count']})" if n else "–"
    return f"{r:.2f} ({n['count'] if n else 0})"


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
        "Emulator caveat (the harness floor): the hosted runner has no GPU, so the emulator composites in software and every frame is over "
        "budget whatever the app does – the frame times and the janky share below are reported, never judged. The evidence is the main "
        "thread's work per frame: WebView runs one renderer process per app, so the chrome and the page share one main thread, and what "
        "it does per frame (style recalculation, layout, paint, script, GC) is what a device feels. A before and an after on this one recipe are comparable."
    )
    lines.append("")

    def blink_of(scene):
        return ((blink_by_page.get(scene["pageKey"]) or {}).get("scenes") or {}).get(scene["label"]) or {}

    # Table 1: the renderer main thread per frame (the harness floor's columns), frame times at the side.
    lines.append("### The renderer main thread per frame (Chromium trace; frames are `dumpsys gfxinfo`'s over the scene)")
    lines.append("")
    lines.append("| page | scene | frames | main thread busy ms (share) | ms / frame | style recalcs / frame (n) | layouts / frame (n) | pre-paints / frame (n) | paints / frame (n) | script evals n / ms (max) | long tasks > 50 ms n / ms (max) | GC ms (n) | janky % | 50th | 90th | 95th | 99th |")
    lines.append("|---|---|---:|---|---:|---|---|---|---|---|---|---|---:|---:|---:|---:|---:|")
    for scene in scenes_flat:
        g = gfx_by_label.get(scene["label"]) or {}
        m = blink_of(scene)
        if not m or m.get("events", 0) == 0:
            lines.append(f"| {scene['pageKey']} | {scene['name']} | {fmt(g.get('frames'))} | no renderer events in the window | – | – | – | – | – | – | – | – | "
                         f"{fmt(g.get('jankyPercent'))} | {fmt(g.get('p50'))} | {fmt(g.get('p90'))} | {fmt(g.get('p95'))} | {fmt(g.get('p99'))} |")
            continue
        ev = (m.get("named") or {}).get("EvaluateScript") or {}
        share = m.get("busyShare")
        lines.append(
            f"| {scene['pageKey']} | {scene['name']} | {fmt(g.get('frames'))} | {fmt(m.get('busyMs'), 0)} ({fmt((share or 0) * 100, 0)}%) | {fmt(m.get('msPerGfxFrame'))} | "
            f"{per_frame_cell(m, 'UpdateLayoutTree')} | {per_frame_cell(m, 'Layout')} | {per_frame_cell(m, 'PrePaint')} | {per_frame_cell(m, 'Paint')} | "
            f"{fmt(ev.get('count'))} / {fmt(ev.get('totalMs'), 0)} ({fmt(ev.get('maxMs'), 0)}) | "
            f"{fmt(m.get('longTaskCount'))} / {fmt(m.get('longTaskMs'), 0)} ({fmt(m.get('longTaskMaxMs'), 0)}) | {fmt(m.get('gcMs'), 0)} ({fmt(m.get('gcCount'))}) | "
            f"{fmt(g.get('jankyPercent'))} | {fmt(g.get('p50'))} | {fmt(g.get('p90'))} | {fmt(g.get('p95'))} | {fmt(g.get('p99'))} |"
        )
    lines.append("")
    lines.append(
        "Busy: the main thread's self time over the scene's window (share of the window). Style recalcs / layouts / pre-paints / paints: "
        "`UpdateLayoutTree` / `Layout` / `PrePaint` / `Paint` slices per gfxinfo frame (count in brackets). Script evals: the host's "
        "`evaluateJavascript` tasks (`EvaluateScript`: the `barScroll` reports in, the bridge's replies, `setBounds`). Long tasks: "
        "outermost tasks over 50 ms (the ones a finger feels as a stutter)."
    )
    lines.append("")

    # Table 2: whose work, by the marks.
    lines.append("### Whose work (the marks the driver planted: `c:` the chrome, `p:` the page; n / ms)")
    lines.append("")
    lines.append("| page | scene | main-thread frames: all / chrome / page / both / unmarked | chrome style | chrome layout | chrome pre-paint | chrome paint | chrome busy ms | page style | page layout | page pre-paint | page paint | page busy ms | unmarked busy ms | barScroll tasks n / ms (max) | marks seen |")
    lines.append("|---|---|---|---|---|---|---|---:|---|---|---|---|---:|---:|---|---|")
    for scene in scenes_flat:
        m = blink_of(scene)
        if not m or m.get("events", 0) == 0:
            lines.append(f"| {scene['pageKey']} | {scene['name']} | – | – | – | – | – | – | – | – | – | – | – | – | – | – |")
            continue
        f = m.get("mainFrames") or {}
        bo = m.get("byOwner") or {}
        bs = m.get("barScrollTasks") or {}
        marks = ", ".join(f"{k} {v}" for k, v in sorted((m.get("marks") or {}).items())) or "none"
        lines.append(
            f"| {scene['pageKey']} | {scene['name']} | {fmt(f.get('total'))} / {fmt(f.get('chrome'))} / {fmt(f.get('page'))} / {fmt(f.get('both'))} / {fmt(f.get('unmarked'))} | "
            f"{owner_cell(m, 'chrome', 'UpdateLayoutTree')} | {owner_cell(m, 'chrome', 'Layout')} | {owner_cell(m, 'chrome', 'PrePaint')} | {owner_cell(m, 'chrome', 'Paint')} | "
            f"{fmt((bo.get('chrome') or {}).get('busyMs'), 0)} | "
            f"{owner_cell(m, 'page', 'UpdateLayoutTree')} | {owner_cell(m, 'page', 'Layout')} | {owner_cell(m, 'page', 'PrePaint')} | {owner_cell(m, 'page', 'Paint')} | "
            f"{fmt((bo.get('page') or {}).get('busyMs'), 0)} | {fmt((bo.get('unmarked') or {}).get('busyMs'), 0)} | "
            f"{fmt(bs.get('count'))} / {fmt(bs.get('totalMs'), 0)} ({fmt(bs.get('maxMs'), 0)}) | {marks} |"
        )
    lines.append("")
    lines.append(
        "A frame or task is the chrome's when a chrome mark lies inside it (`c:scroll` a `barScroll` report arriving, `c:style` a write of "
        "`--zen-bar-hide`, `c:frame` the chrome's next animation frame after a write, `c:hidden` a `data-bar-hidden` flip, `c:column` the content "
        "column's padding changing), the page's when a page mark does (`p:scroll` its scroll event, `p:resize` its resize event); "
        "`c:stamp` says the marks' names did not survive the controller's filter and the chrome's `console.timeStamp` instants stood in "
        "(the chrome is told, the page is not). Without marks (a trace from before they were planted) everything is unmarked."
    )
    lines.append("")

    # Table 3: long tasks.
    lines.append("### The long tasks (> 50 ms) of the renderer main thread per scene")
    lines.append("")
    any_long = False
    for scene in scenes_flat:
        m = blink_of(scene)
        for t in (m.get("longTasks") or []):
            any_long = True
            inside = ", ".join(f"{i['name']} {i['selfMs']:.0f}" for i in t.get("inside", [])) or "nothing named"
            lines.append(f"- {scene['pageKey']} / {scene['name']} at +{t['atMs']:.0f} ms: {t['ms']:.0f} ms `{t['name']}` ({t['owner']}; self {t['selfMs']:.0f} ms; inside: {inside})")
    if not any_long:
        lines.append("None.")
    lines.append("")

    # Table 4: the in-process counters.
    lines.append("### The in-process counters per scene")
    lines.append("")
    lines.append("| page | scene | UI layouts | UI draws | page WebView resizes | barScroll in | root style writes | data-bar-hidden flips | page resize events | page scroll events | innerHeight | hide |")
    lines.append("|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|")
    for scene in scenes_flat:
        v = scene.get("views", {})
        c = scene.get("chrome", {})
        p = scene.get("pageCounters", {})
        lines.append(
            f"| {scene['pageKey']} | {scene['name']} | {fmt(v.get('layouts'))} | {fmt(v.get('draws'))} | {fmt(v.get('pageBounds'))} | {fmt(c.get('barScroll'))} | "
            f"{fmt(c.get('styleWrites'))} | {fmt(c.get('hiddenFlips'))} | {fmt(p.get('resizes'))} | {fmt(p.get('scrolls'))} | "
            f"{fmt(scene.get('innerHeightBefore'))} → {fmt(scene.get('innerHeightAfter'))} | {fmt(scene.get('hideBefore'))} → {fmt(scene.get('hideAfter'))} |"
        )
    lines.append("")
    lines.append(
        "UI layouts / draws: layout passes and draws of the app's window (`OnGlobalLayoutListener`, `OnDrawListener`); page WebView resizes: "
        "changes of the page view's bounds; barScroll in: scroll reports the host streamed into the chrome; root style writes: writes of "
        "`--zen-bar-hide` on the chrome's root (each is a host frame back, `chrome.setBarHide`); page resize events: the page's own `resize` "
        "events (its viewport changed)."
    )
    lines.append("")

    # Table 5: stages.
    lines.append("### The stages of the frames (framestats, the last 120 frames of each scene at most; mean / 95th, ms)")
    lines.append("")
    lines.append("| page | scene | sample | slow | input | animation | measure/layout | draw | sync queue | sync | command issue (GPU) | swap | UI thread 95th | frame 95th | long stage of the slow frames |")
    lines.append("|---|---|---:|---:|---|---|---|---|---|---|---|---|---:|---:|---|")
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
            + f" | {fmt(g.get('uiThreadP95Sample'))} | {fmt(g.get('totalP95Sample'))} | {long_stage(g)} |"
        )
    lines.append("")

    # Table 6: Perfetto.
    lines.append("### The device per scene (Perfetto)")
    lines.append("")
    if not perfetto:
        lines.append("No Perfetto trace in the artifact.")
    elif perfetto.get("error"):
        lines.append(f"The Perfetto trace was not read: {perfetto['error']}")
    else:
        lines.append(
            "| page | scene | window ms | doFrame n / 50th / 95th / max | over budget | UI layout slices | input deliveries | DrawFrames n / 95th / max | dequeueBuffer n / 95th | "
            "frame timeline: frames / janky (by type) | app main CPU | RenderThread CPU | renderer main CPU | renderer compositor CPU | SurfaceFlinger CPU | all CPU (of 3 cores) | binder txns app / renderer | main thread switches |"
        )
        lines.append("|---|---|---:|---|---:|---:|---:|---|---|---|---:|---:|---:|---:|---:|---|---|---:|")
        for scene in scenes_flat:
            e = (perfetto.get("scenes") or {}).get(scene["label"]) or {}
            d = e.get("doFrame") or {}
            u = e.get("uiSlices") or {}
            r = e.get("renderThread") or {}
            t = e.get("frameTimeline") or {}
            c = e.get("cpu") or {}
            b = e.get("binder") or {}
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
                f"{fmt(d.get('overBudget'))} | {fmt((u.get('layout') or {}).get('count'))} | {fmt((u.get('deliverInputEvent') or {}).get('count'))} | "
                f"{fmt(r.get('drawFrames'))} / {fmt(r.get('drawP95Ms'))} / {fmt(r.get('drawMaxMs'))} | {fmt(r.get('dequeueBuffer'))} / {fmt(r.get('dequeueP95Ms'))} | "
                f"{fmt(t.get('frames'))} / {fmt(t.get('janky'))} ({jank_types or 'none'}) | "
                f"{cpu_of(lambda th: th['process'] == 'app' and th['tid'] == th['pid'])} | {cpu_of(lambda th: th['process'] == 'app' and th['thread'] == 'RenderThread')} | "
                f"{cpu_of(lambda th: th['process'] == 'renderer' and th['thread'] == 'CrRendererMain')} | "
                f"{cpu_of(lambda th: th['process'] == 'renderer' and th['thread'] == 'Compositor')} | "
                f"{cpu_of(lambda th: (th['process'] or '').endswith('surfaceflinger'))} | {cores} | "
                f"{fmt((b.get('app') or {}).get('count'))} / {fmt((b.get('renderer') or {}).get('count'))} | {fmt(e.get('mainThreadSwitches'))} |"
            )
        lines.append("")
        lines.append(f"Scene windows from the driver's markers in the trace: {perfetto.get('markersFound', 0)} of {len(scenes_flat)}; the rest from the driver's clock.")
        if perfetto.get("queries"):
            lines.append("")
            lines.append("Queries that failed: " + "; ".join(f"{k}: {v}" for k, v in perfetto["queries"].items()))
    lines.append("")

    # Notes: pages that did not load, the traces.
    notes = []
    for page in record.get("pages", []):
        if not page.get("loaded"):
            notes.append(f"{page['key']} did not load ({page.get('url')}); its scenes are missing.")
    for page_key, b in blink_by_page.items():
        notes.append(
            f"{page_key}: Chromium trace {b.get('file')}, renderer main thread{'s' if len(b.get('rendererPids') or []) != 1 else ''} "
            f"{', '.join(str(p) for p in b.get('rendererPids') or [])}, {b.get('marks', 0)} marks (the driver's clock and the trace's are both CLOCK_MONOTONIC)."
        )
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
    renderer_pids = set()
    for page in record.get("pages", []):
        name = page.get("blink")
        if not name:
            continue
        path = root / name
        if not path.exists():
            continue
        page_scenes = [s for s in scenes_flat if s["pageKey"] == page["key"]]
        try:
            result = analyse_blink(path, page_scenes, gfx_by_label)
        except Exception as e:  # noqa: BLE001
            print(f"::warning::could not read {name}: {e}")
            continue
        blink_by_page[page["key"]] = result
        renderer_pids.update(result.get("rendererPids") or [])

    perfetto = None
    traces = sorted(root.glob("zen-*.pftrace"))
    if traces:
        perfetto = analyse_perfetto(traces[-1], record.get("package", ""), scenes_flat, renderer_pids)

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
