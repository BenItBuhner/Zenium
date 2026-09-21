package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.os.Trace
import android.util.Log
import android.webkit.TracingConfig
import android.webkit.TracingController
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPInputStream
import java.util.zip.GZIPOutputStream
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * The profiling driver of the performance program's PERF-2 item: the three-dot menu sheet,
 * measured rather than guessed. Real touches on the phone chrome (a finger on the bar's Menu
 * button, a press on the scrim, a drag of the grabber between the detents) over two content
 * pages served from this process's loopback server – a copy of github.com's repository page
 * (server HTML and CSS, scripts stripped) and a long article (six chapters of a public-domain
 * novel) – plus one pass over the real github.com when the emulator has a network.
 *
 * Scenes (each `cycles` times, ten by default):
 *  - `<page>-open-close`: tap Menu, the sheet comes up; tap the scrim, it goes.
 *  - `<page>-drag`: with the menu up, the grabber dragged to the expanded detent and back.
 *  - `article-<variant>`: the open / close again (half the cycles) with one thing switched off
 *    from the probe, to put a number on each part of the recede: `radius-off` (the content
 *    frame's corner does not grow with `--zen-recede`), `recede-off` (nothing consumes
 *    `--zen-recede`: the frame does not scale, the bar does not fade; the root write stays),
 *    `rootwrite-off` (the chassis's per-frame write of `--zen-recede` on the root is dropped
 *    too). Test-only styles and a shim on the root's inline style; the product code is as built.
 *
 * What is captured, per scene, into the handshake directory (the workflow pulls it):
 *  - `framestats-<scene>.txt`: `dumpsys gfxinfo <app> reset` before the scene, `framestats` after
 *    every settled half-cycle (the profile ring holds 120 frames) and at the end, concatenated:
 *    HWUI's frames, its janky count and percentiles, and the per-frame stage columns.
 *  - `webview-<scene>.json.gz`: the chrome WebView's own Chromium trace for the scene through
 *    `android.webkit.TracingController` (blink, cc, v8, the scheduler, input and the DevTools
 *    timeline categories): the chrome renderer's main thread frame by frame – style recalc,
 *    layout, paint, script – and the compositor. The scene's start / end user-timing marks are
 *    inside the trace: the trace is started first, then the probe marks the scene.
 *  - `chrome-<scene>.json.txt`: what a probe in the chrome saw (test-only, put in from here):
 *    every pointer down / up, one sample per animation frame of the inline `--zen-recede`, the
 *    sheet's inline transform and height while a sheet is on the way, the moments the sheet and
 *    the page's picture were mounted and unmounted, long tasks, and the Event Timing entries.
 *  - `scenes.txt`: each scene's clocks (CLOCK_BOOTTIME for the Perfetto trace, CLOCK_MONOTONIC
 *    for the WebView trace) so the readers can cut the traces without markers.
 * One Perfetto system trace spans all the scenes (`sched gfx view input wm am binder_driver
 * dalvik` and the SurfaceFlinger frame timeline), started from here when the workflow has left
 * its config at `/data/misc/perfetto-configs/menu-perf.pbtxt` (the one directory the shell may
 * write and `perfetto` may read: run 35540328965 had it under /data/local/tmp and SELinux
 * refused perfetto the file, silently), with `Trace.beginAsyncSection` marks per scene and per
 * half-cycle from this process (the `app` atrace category).
 *
 * The scenes run in the warm-up, before the recorder rolls: `screenrecord` composes a second
 * copy of every frame on the emulator's software GPU and would be measured too. The recorded
 * sequence is one open, one drag up and down, and a press on the scrim: the media. Driven by
 * the `android-menu-perf` workflow; see [DemoHarness] for the plumbing.
 *
 * Instrumentation arguments: `cycles` (default 10), `live` (`0` skips the real-network pass),
 * `variants` (`0` skips the ablation scenes), `webviewTrace` and `perfetto` (`0` skips that
 * capture).
 */
@RunWith(AndroidJUnit4::class)
class MenuSheetPerfDemo : DemoHarness("menu-perf-demo-state.json", "menu-perf", "menu-perf-demo") {
    override val tag = "MenuSheetPerfDemo"
    private val args = InstrumentationRegistry.getArguments()
    private val cycles = args.getString("cycles")?.toIntOrNull()?.coerceIn(1, 50) ?: 10
    private val livePass = args.getString("live") != "0"
    private val variants = args.getString("variants") != "0"
    private val webviewTrace = args.getString("webviewTrace") != "0"
    private val perfetto = args.getString("perfetto") != "0"
    private lateinit var server: DemoServer
    private val findings = StringBuilder()
    private val scenes = StringBuilder()
    private val host get() = (activity as MainActivity).host
    private val pkg: String get() = app.packageName
    private var perfettoPid: String? = null
    private var cookie = 1
    /** Where the grabber was at the collapsed detent, for the drag back down. */
    private var restHandle: PointF? = null
    /** The sheet's inline height (CSS px) at the collapsed detent, read once the menu has landed. */
    private var restHeight = 0.0

    @Test
    fun record() {
        server = DemoServer(PORT, routes()).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            File(out, "menu-perf-findings.txt").writeText(findings.toString())
            File(out, "scenes.txt").writeText(scenes.toString())
            Log.i(tag, "findings:\n$findings")
        }
    }

    /** The github.com copy at `/` (its assets under their own paths) and the article at `/article.html`. */
    private fun routes(): Map<String, Pair<String, ByteArray>> {
        val routes = HashMap<String, Pair<String, ByteArray>>()
        for (line in readAsset("menu-perf/github/manifest.tsv").lines()) {
            val parts = line.split('\t')
            if (parts.size < 3) continue
            routes[parts[0]] = parts[1] to pageAsset("menu-perf/github/${parts[2]}")
        }
        routes["/article.html"] = "text/html; charset=utf-8" to pageAsset("menu-perf/article.html.gz")
        return routes
    }

    /**
     * The repository keeps the page copies gzipped (`.gz`); AAPT unpacks a `.gz` asset when it
     * packages the APK and drops the suffix, so the installed APK carries them plain (run
     * 35539898644 found `article.html`, never `article.html.gz`). Read the plain name, and the
     * gzipped one should the packaging ever leave them as they are.
     */
    private fun pageAsset(name: String): ByteArray {
        val assets = instrumentation.context.assets
        return try {
            assets.open(name.removeSuffix(".gz")).use { it.readBytes() }
        } catch (_: java.io.FileNotFoundException) {
            GZIPInputStream(assets.open(name)).use { it.readBytes() }
        }
    }

    // --- the scenes, before the camera ---------------------------------------------------------------

    override fun warmUp() {
        finding("Zenium Android menu sheet profile (${width}x$height, density $density, $cycles cycles, api ${Build.VERSION.SDK_INT})")
        finding("demo server: ${server.selfCheck()}")
        finding("webview: ${webViewVersion()}")
        awaitLoaded("$ORIGIN/")
        SystemClock.sleep(2_500)
        installProbe()
        // The first sheet pays for layout and script compilation once, off the record.
        openMenu()
        closeMenu()
        SystemClock.sleep(1_000)

        perfettoStart()
        try {
            scene("github-open-close") { openCloseCycles("github-open-close", cycles) }
            scene("github-drag") { dragCycles("github-drag") }

            navigate("$ORIGIN/article.html")
            openMenu()
            closeMenu()
            scene("article-open-close") { openCloseCycles("article-open-close", cycles) }
            scene("article-drag") { dragCycles("article-drag") }

            if (variants) {
                val half = (cycles / 2).coerceAtLeast(3)
                variant("article-radius-off", RADIUS_OFF_CSS) { openCloseCycles("article-radius-off", half) }
                variant("article-recede-off", RECEDE_OFF_CSS) { openCloseCycles("article-recede-off", half) }
                variant("article-rootwrite-off", RECEDE_OFF_CSS, muteRoot = true) { openCloseCycles("article-rootwrite-off", half) }
            }

            if (livePass) {
                val live = navigate(LIVE_URL, timeoutMs = 60_000)
                if (live) {
                    SystemClock.sleep(4_000)
                    openMenu()
                    closeMenu()
                    scene("live-github-open-close") { openCloseCycles("live-github-open-close", cycles) }
                } else {
                    finding("live pass skipped: $LIVE_URL did not load (no network on this emulator?)")
                }
            }
        } finally {
            perfettoStop()
        }
        // Back to the loopback copy for the camera.
        navigate("$ORIGIN/")
        SystemClock.sleep(2_000)
        Log.i(tag, "warm-up (the scenes) done")
    }

    /** On camera: one open, the grabber up to the expanded detent and back, a press on the scrim. */
    override fun demo() {
        openMenu()
        SystemClock.sleep(1_200)
        shot("menu-up")
        dragUp()
        SystemClock.sleep(1_200)
        shot("menu-expanded")
        dragDown()
        SystemClock.sleep(1_200)
        closeMenu()
        SystemClock.sleep(1_500)
        shot("menu-closed")
    }

    private fun openCloseCycles(scene: String, n: Int) {
        for (i in 1..n) {
            mark("open", i)
            val opened = openMenu()
            unmark("open", i)
            dumpFramestats(scene, "$i-open")
            if (!opened) {
                finding("$scene cycle $i: the menu did not come up (${poseText()}); skipping the close")
                back()
                SystemClock.sleep(1_500)
                continue
            }
            SystemClock.sleep(500)
            mark("close", i)
            val closed = closeMenu()
            unmark("close", i)
            dumpFramestats(scene, "$i-close")
            if (!closed) finding("$scene cycle $i: the menu did not go on the scrim press (${poseText()})")
            SystemClock.sleep(600)
        }
    }

    private fun dragCycles(scene: String) {
        if (!openMenu()) {
            finding("$scene: the menu did not come up; no drags")
            return
        }
        SystemClock.sleep(600)
        val pairs = (cycles / 2).coerceAtLeast(2)
        for (i in 1..pairs) {
            mark("drag-up", i)
            val up = dragUp()
            unmark("drag-up", i)
            dumpFramestats(scene, "$i-up")
            if (!up) {
                finding("$scene pair $i: the sheet did not reach the expanded detent (${poseText()}, rest $restHeight)")
            }
            SystemClock.sleep(500)
            mark("drag-down", i)
            val down = dragDown()
            unmark("drag-down", i)
            dumpFramestats(scene, "$i-down")
            if (!down) {
                finding("$scene pair $i: the drag down did not land at the collapsed detent (${poseText()}, rest $restHeight)")
                if (!awaitSurface(up = true, timeoutMs = 500)) {
                    finding("$scene pair $i: the sheet went; opening it again")
                    SystemClock.sleep(1_000)
                    if (!openMenu()) return
                }
            }
            SystemClock.sleep(500)
        }
        closeMenu()
        dumpFramestats(scene, "close")
    }

    /** The open / close scene with a test-only style (and, `muteRoot`, without the root's `--zen-recede` write). */
    private fun variant(name: String, css: String, muteRoot: Boolean = false, body: () -> Unit) {
        chromeJs("window.__zenPerf&&window.__zenPerf.variant(${JSONObject.quote(css)})")
        if (muteRoot) chromeJs("window.__zenPerf&&window.__zenPerf.muteRoot(true)")
        SystemClock.sleep(800)
        // One cycle off the record: the styles take, and the first frame under them is paid for.
        openMenu()
        closeMenu()
        try {
            scene(name, body)
        } finally {
            chromeJs("window.__zenPerf&&window.__zenPerf.muteRoot(false)")
            chromeJs("window.__zenPerf&&window.__zenPerf.variant('')")
            SystemClock.sleep(800)
        }
    }

    // --- the moves -----------------------------------------------------------------------------------

    /**
     * A finger on the Menu button; true once the sheet is up and at rest at its detent. A sheet
     * still up from a cycle that did not close is sent away first (Back), or the finger meant for
     * the button lands on a row of it and opens something else (run 35540328965's github cycle
     * 10: a 209 px sheet where the menu's 499 px one was expected, and every cycle after it off).
     */
    private fun openMenu(): Boolean {
        if (chromeSurfaceUp()) {
            finding("a surface is up before the open; Back first (${poseText()})")
            back()
            awaitSurface(up = false, timeoutMs = 6_000)
            SystemClock.sleep(1_200)
        }
        val button = menuButton()
        Finger().tap(button.exactCenterX(), button.exactCenterY())
        if (!awaitSurface(up = true, timeoutMs = 8_000)) return false
        val landed = awaitPose(SETTLE_MS) { pose -> pose.sheet && pose.landed && pose.still }
        if (landed) sheetPose()?.let { if (it.height > 0) restHeight = it.height }
        return landed
    }

    /**
     * The bar's Menu button: from the chrome's own layout (fast; the accessibility tree of a
     * page like github.com takes seconds to walk on the emulator), else by label, else where
     * the default bar has it.
     */
    private fun menuButton(): Rect {
        val raw = chromeJs(
            "(function(){var b=document.querySelector('.zen-phone-bar [aria-label=\"$MENU_LABEL\"]')||document.querySelector('[aria-label=\"$MENU_LABEL\"]');" +
                "if(!b)return '';var r=b.getBoundingClientRect();if(!r.width)return '';return r.left+','+r.top+','+r.width+','+r.height})()"
        )
        val text = (JSONTokener(raw).nextValue() as? String).orEmpty()
        val parts = text.split(',').mapNotNull { it.toFloatOrNull() }
        if (parts.size == 4) {
            return Rect(
                (parts[0] * density).roundToInt(),
                (parts[1] * density).roundToInt(),
                ((parts[0] + parts[2]) * density).roundToInt(),
                ((parts[1] + parts[3]) * density).roundToInt()
            )
        }
        return findByLabel(MENU_LABEL) ?: Rect((width - 52 * density).roundToInt(), (pillY - 22 * density).roundToInt(), (width - 8 * density).roundToInt(), (pillY + 22 * density).roundToInt())
    }

    /**
     * A finger on the scrim above the sheet; true once the sheet has gone and the recede is back
     * at 0. A press on the scrim while the sheet still settles catches the sheet instead of
     * dismissing it (the chassis, §9.20) – so the open waits for the spring to rest before this is
     * called – and a sheet the press did not send away is sent away by Back, off the record for
     * this half-cycle, so the next cycle starts clean.
     */
    private fun closeMenu(): Boolean {
        val insets = windowInsets()
        // Well above any detent of the menu and below the status bar: the page's upper third.
        Finger().tap(width * 0.5f, insets.top + (height - insets.top) * 0.22f)
        var dismissed = awaitSurface(up = false, timeoutMs = 5_000)
        if (!dismissed) {
            finding("the scrim press did not send the sheet away (${poseText()}); Back")
            back()
            dismissed = awaitSurface(up = false, timeoutMs = 8_000)
            if (!dismissed) return false
            awaitPose(SETTLE_MS) { pose -> !pose.sheet }
            SystemClock.sleep(900)
            return false
        }
        val landed = awaitPose(SETTLE_MS) { pose -> !pose.sheet || (pose.recede <= 0.005 && pose.still) }
        // The live page comes back and its picture goes once the host has drawn it: part of the close.
        SystemClock.sleep(900)
        return landed
    }

    /** The grabber pulled up to the expanded detent (a real finger, released with some speed). */
    private fun dragUp(): Boolean {
        val handle = handle() ?: return false
        restHandle = handle
        val travel = 0.42f * height
        Finger().apply {
            down(handle.x, handle.y)
            moveBy(0f, -travel * 0.75f, 150)
            moveBy(0f, -travel * 0.25f, 120)
            up()
        }
        return awaitDetent(expanded = true)
    }

    /** The grabber pulled back down to the collapsed detent, decelerating so the release does not dismiss. */
    private fun dragDown(): Boolean {
        val from = handle() ?: return false
        val to = restHandle ?: PointF(from.x, from.y + 0.42f * height)
        val dy = to.y - from.y
        Finger().apply {
            down(from.x, from.y)
            moveBy(0f, dy * 0.8f, 160)
            moveBy(0f, dy * 0.2f, 220)
            hold(80)
            up()
        }
        return awaitDetent(expanded = false)
    }

    private fun handle(): PointF? {
        // The chrome's own layout first: the accessibility tree lags the emulator by seconds.
        val raw = chromeJs("(function(){var s=document.querySelector('.zen-sheet');if(!s)return '';var r=s.getBoundingClientRect();return r.left+','+r.top+','+r.width})()")
        val text = (JSONTokener(raw).nextValue() as? String).orEmpty()
        val parts = text.split(',').mapNotNull { it.toFloatOrNull() }
        if (parts.size == 3 && parts[2] > 0) return PointF((parts[0] + parts[2] / 2) * density, (parts[1] + 14) * density)
        return waitFor(MENU_HANDLE_LABEL, 3_000)?.let { PointF(it.exactCenterX(), it.exactCenterY()) }
    }

    /**
     * Wait for the sheet's spring to land at the detent asked for. Between its detents the sheet
     * changes height (lib/motion/sheet.ts), so the detent is read from the sheet's inline height
     * against the height it rested at when the menu came up: the expanded detent stands at least
     * half a detent gap (`SHEET_MIN_DETENT_GAP` / 2) taller, the collapsed one within a few px.
     * (Run 35540328965 judged it by the sheet's top against the screen's middle, and the menu's
     * peek – 52 % of the layer – already stands above that: every drag read as expanded.)
     */
    private fun awaitDetent(expanded: Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + SETTLE_MS
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
            if (!chromeSurfaceUp()) return false
            val pose = sheetPose() ?: continue
            if (!pose.sheet || !pose.still || pose.height <= 0) continue
            val atExpanded = pose.height >= restHeight + 48
            val atCollapsed = abs(pose.height - restHeight) <= 6
            if (expanded && atExpanded) return true
            if (!expanded && atCollapsed) return true
        }
        return false
    }

    // --- the chrome's word ---------------------------------------------------------------------------

    /**
     * `landed`: the sheet's inline transform stands at translateY 0 – at its detent, not at the
     * pose it mounts in (translated fully below the screen, waiting for the page's picture), which
     * is as still as a landed sheet and read as one in run 35540328965 (the scrim press then came
     * on a sheet still settling, and caught it instead of dismissing it).
     */
    private class Pose(val sheet: Boolean, val height: Double, val recede: Double, val still: Boolean, val landed: Boolean)

    /** The sheet's inline height and transform and the root's inline `--zen-recede` (what the chassis writes each frame), from the probe. */
    private fun sheetPose(): Pose? {
        val raw = chromeJs("window.__zenPerf?window.__zenPerf.pose():''")
        val text = (JSONTokener(raw).nextValue() as? String).orEmpty()
        if (text.isEmpty()) return null
        return try {
            val o = JSONObject(text)
            val ty = o.optDouble("ty", Double.NaN)
            Pose(o.optInt("s") == 1, o.optDouble("h", 0.0), o.optDouble("p", 0.0), o.optBoolean("still"), !ty.isNaN() && abs(ty) < 0.5)
        } catch (_: Exception) {
            null
        }
    }

    private fun poseText(): String = sheetPose()?.let { "sheet ${if (it.sheet) "up" else "away"}, height ${it.height}, recede ${it.recede}, ${if (it.landed) "at its detent" else "off its detent"}, ${if (it.still) "still" else "moving"}" } ?: "no probe"

    private fun awaitPose(timeoutMs: Long, settled: (Pose) -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val pose = sheetPose()
            if (pose != null && settled(pose)) return true
            SystemClock.sleep(200)
        }
        return false
    }

    /**
     * The probe in the chrome (test-only): pointer taps; one sample per animation frame of the
     * inline `--zen-recede`, the sheet's inline transform and height while a sheet is on the way
     * (from the tap until the values rest, so the frame intervals of the spring are on record);
     * the moments the sheet layer and the page's picture (the snapshot `img`) are mounted and
     * unmounted, from a MutationObserver – the React commits of the open, on the DOM's clock;
     * long tasks and Event Timing entries. Every mark is also a `performance.mark`, so it is in
     * the WebView trace (`blink.user_timing`). Reads inline styles only – nothing here forces a
     * style pass. The variants (`variant`, `muteRoot`) are test-only styles and a shim over the
     * root's inline `setProperty`; nothing is written into the product.
     */
    private fun installProbe() {
        chromeJs(
            """(function(){if(window.__zenPerf)return;
var P=window.__zenPerf={scene:null,taps:[],motion:[],long:[],events:[],marks:[]};
var root=document.documentElement;var running=false;var quiet=0;var last='';
document.addEventListener('pointerdown',function(e){P.taps.push({t:performance.now(),k:'down',x:e.clientX,y:e.clientY});arm()},{capture:true,passive:true});
document.addEventListener('pointerup',function(e){P.taps.push({t:performance.now(),k:'up',x:e.clientX,y:e.clientY});arm()},{capture:true,passive:true});
try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){P.long.push({t:e.startTime,d:e.duration})})}).observe({type:'longtask'})}catch(_){}
try{new PerformanceObserver(function(l){l.getEntries().forEach(function(e){P.events.push({t:e.startTime,d:e.duration,n:e.name,p:e.processingStart-e.startTime,q:e.processingEnd-e.processingStart})})}).observe({type:'event',durationThreshold:16})}catch(_){}
function isSheet(n){return n.matches('[data-sheet-layer]')||!!n.querySelector('[data-sheet-layer]')}
function isCover(n){return (n.tagName==='IMG'&&/^(data:|blob:)/.test(n.getAttribute('src')||''))||!!n.querySelector('img[src^="data:"],img[src^="blob:"]')}
try{new MutationObserver(function(ms){for(var i=0;i<ms.length;i++){var a=ms[i].addedNodes,r=ms[i].removedNodes,j,n;
for(j=0;j<a.length;j++){n=a[j];if(n.nodeType!==1)continue;if(isSheet(n))P.mark('sheet-mounted');if(isCover(n))P.mark('cover-mounted')}
for(j=0;j<r.length;j++){n=r[j];if(n.nodeType!==1)continue;if(isSheet(n))P.mark('sheet-unmounted');if(isCover(n))P.mark('cover-unmounted')}}}).observe(document.body,{childList:true,subtree:true})}catch(_){}
function sample(t){var s=document.querySelector('.zen-sheet');var p=root.style.getPropertyValue('--zen-recede');var tr=s?s.style.transform:'';var h=s?s.style.height:'';
var key=p+'|'+tr+'|'+h+'|'+(s?1:0);if(key===last)quiet++;else quiet=0;last=key;
P.motion.push({t:t,p:p===''?-1:+p,tr:tr,h:h,s:s?1:0});
if((s||quiet<24)&&P.motion.length<6000)requestAnimationFrame(sample);else running=false}
function arm(){if(running)return;running=true;quiet=0;requestAnimationFrame(sample)}
P.arm=arm;P.still=function(){return !running||quiet>=6};
P.pose=function(){var s=document.querySelector('.zen-sheet');var p=root.style.getPropertyValue('--zen-recede');var m=s?/translate3d\(\s*[-\d.]+(?:px)?\s*,\s*(-?[\d.]+)px/.exec(s.style.transform):null;
return JSON.stringify({s:s?1:0,h:s?(parseFloat(s.style.height)||0):0,p:p===''?0:+p,ty:m?+m[1]:null,still:P.still()})};
P.mark=function(n){try{performance.mark('menu-perf:'+n)}catch(_){}P.marks.push({t:performance.now(),n:n})};
P.begin=function(name){P.scene=name;P.taps=[];P.motion=[];P.long=[];P.events=[];P.marks=[];P.mark(name+':start')};
P.end=function(){P.mark(P.scene+':end');return JSON.stringify({scene:P.scene,origin:performance.timeOrigin,taps:P.taps,motion:P.motion,long:P.long,events:P.events,marks:P.marks})};
var vs=null;P.variant=function(css){if(vs){vs.remove();vs=null}if(css){vs=document.createElement('style');vs.id='zen-perf-variant';vs.textContent=css;document.head.appendChild(vs)}};
var st=root.style;var setP=st.setProperty.bind(st);var muted=false;
try{Object.defineProperty(st,'setProperty',{configurable:true,writable:true,value:function(n,v,pr){if(muted&&n==='--zen-recede')return;return setP(n,v,pr)}})}catch(_){}
P.muteRoot=function(on){muted=!!on;if(!on)return;try{st.removeProperty('--zen-recede')}catch(_){}};
})()"""
        )
    }

    private fun webViewVersion(): String {
        val raw = chromeJs("navigator.userAgent")
        return (JSONTokener(raw).nextValue() as? String).orEmpty().substringAfter("Chrome/").substringBefore(' ').ifEmpty { "?" }
    }

    // --- the captures --------------------------------------------------------------------------------

    private fun scene(name: String, body: () -> Unit) {
        finding("== scene $name")
        shell("dumpsys gfxinfo $pkg reset")
        File(out, "framestats-$name.txt").writeText("")
        // The trace first, then the scene's start mark, so the mark is inside the trace.
        val started = webviewTraceStart()
        chromeJs("window.__zenPerf&&window.__zenPerf.begin(${JSONObject.quote(name)})")
        val startBoot = SystemClock.elapsedRealtimeNanos()
        val startMono = System.nanoTime()
        val startUptime = SystemClock.uptimeMillis()
        traceAsync("menu-perf:$name", begin = true, cookie = cookie)
        try {
            body()
        } finally {
            traceAsync("menu-perf:$name", begin = false, cookie = cookie)
            cookie++
            val endBoot = SystemClock.elapsedRealtimeNanos()
            val endMono = System.nanoTime()
            scenes.append("$name $startBoot $endBoot $startMono $endMono\n")
            dumpFramestats(name, "end")
            val probe = chromeJs("window.__zenPerf?window.__zenPerf.end():''")
            val json = (JSONTokener(probe).nextValue() as? String).orEmpty()
            File(out, "chrome-$name.json.txt").writeText(json)
            if (started) webviewTraceStop("webview-$name.json.gz")
            finding("$name: ${(SystemClock.uptimeMillis() - startUptime) / 1000.0} s; probe ${json.length} chars")
        }
    }

    private fun dumpFramestats(scene: String, step: String) {
        val text = shell("dumpsys gfxinfo $pkg framestats")
        File(out, "framestats-$scene.txt").appendText("=== $scene $step ===\n$text\n")
    }

    private fun mark(kind: String, n: Int) {
        traceAsync("menu-perf:$kind", begin = true, cookie = 1000 + n)
        chromeJs("window.__zenPerf&&window.__zenPerf.mark(${JSONObject.quote("$kind:$n:start")})")
    }

    private fun unmark(kind: String, n: Int) {
        traceAsync("menu-perf:$kind", begin = false, cookie = 1000 + n)
        chromeJs("window.__zenPerf&&window.__zenPerf.mark(${JSONObject.quote("$kind:$n:end")})")
    }

    private fun traceAsync(name: String, begin: Boolean, cookie: Int) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
        if (begin) Trace.beginAsyncSection(name, cookie) else Trace.endAsyncSection(name, cookie)
    }

    private fun webviewTraceStart(): Boolean {
        if (!webviewTrace) return false
        // The previous scene's trace may still be writing out: give it its time rather than share it.
        val deadline = SystemClock.uptimeMillis() + 60_000
        while (SystemClock.uptimeMillis() < deadline && isTracing()) SystemClock.sleep(500)
        var ok = false
        instrumentation.runOnMainSync {
            val controller = TracingController.getInstance()
            if (controller.isTracing) {
                finding("webview trace: a session was already running; the scene shares it")
                return@runOnMainSync
            }
            val config = TracingConfig.Builder()
                .addCategories(WEBVIEW_CATEGORIES)
                .setTracingMode(TracingConfig.RECORD_CONTINUOUSLY)
                .build()
            try {
                controller.start(config)
                ok = true
            } catch (e: Exception) {
                finding("webview trace: start failed: $e")
            }
        }
        // The renderers take a moment to learn the categories.
        if (ok) SystemClock.sleep(600)
        return ok
    }

    private fun isTracing(): Boolean {
        var tracing = false
        instrumentation.runOnMainSync { tracing = TracingController.getInstance().isTracing }
        return tracing
    }

    private fun webviewTraceStop(name: String) {
        val file = File(out, name)
        val closed = CountDownLatch(1)
        val stream = object : GZIPOutputStream(FileOutputStream(file), 64 * 1024) {
            override fun close() {
                super.close()
                closed.countDown()
            }
        }
        var stopped = false
        instrumentation.runOnMainSync {
            stopped = TracingController.getInstance().stop(stream, Executors.newSingleThreadExecutor())
        }
        if (!stopped) {
            stream.close()
            finding("webview trace: nothing to stop for $name")
            return
        }
        if (!closed.await(180, TimeUnit.SECONDS)) finding("webview trace: $name did not finish writing in 180 s")
        finding("webview trace: $name ${file.length() / 1024} KB")
    }

    private fun perfettoStart() {
        if (!perfetto) return
        val present = !shell("ls $CONFIG_PATH").contains("No such file")
        val command = if (present) {
            "perfetto --background --txt -c $CONFIG_PATH -o $TRACE_PATH"
        } else {
            // No config from the workflow: the lightweight atrace form, without the frame timeline.
            "perfetto --background -t 1800s -o $TRACE_PATH --app $pkg sched gfx view input wm am binder_driver dalvik"
        }
        val (output, error) = shellWithError(command)
        perfettoPid = output.lines().lastOrNull { it.trim().toIntOrNull() != null }?.trim()
            ?: shell("pidof perfetto").trim().split(' ').firstOrNull { it.toIntOrNull() != null }
        finding("perfetto: ${if (present) "workflow config" else "lightweight atrace config"}, pid ${perfettoPid ?: "?"}: ${output.trim().take(200)}${if (error.isNotBlank()) " / stderr: ${error.trim().take(300)}" else ""}")
        if (perfettoPid == null) finding("perfetto: no trace this run")
    }

    private fun perfettoStop() {
        val pid = perfettoPid ?: return
        shell("kill -TERM $pid")
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (SystemClock.uptimeMillis() < deadline && shell("pidof perfetto").trim().isNotEmpty()) SystemClock.sleep(300)
        SystemClock.sleep(500)
        finding("perfetto: ${shell("ls -l $TRACE_PATH").trim()}")
        perfettoPid = null
    }

    // --- pages ---------------------------------------------------------------------------------------

    /** Load `url` in the demo tab and wait for it; false when it did not finish in time. */
    private fun navigate(url: String, timeoutMs: Long = 25_000): Boolean {
        instrumentation.runOnMainSync {
            (host.tabs.get(TAB_ID) ?: host.tabs.all().firstOrNull())?.loadUrl(url)
        }
        val loaded = awaitLoaded(url, timeoutMs)
        SystemClock.sleep(2_000)
        finding("page $url: ${if (loaded) "loaded" else "NOT loaded in time"}")
        return loaded
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 25_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            var loaded = false
            instrumentation.runOnMainSync {
                val view = host.tabs.get(TAB_ID) ?: host.tabs.all().firstOrNull()
                val current = view?.url.orEmpty()
                loaded = view != null && view.progress == 100 &&
                    (current == url || current.removeSuffix("/") == url.removeSuffix("/"))
            }
            if (loaded) return true
            SystemClock.sleep(250)
        }
        return false
    }

    private fun finding(line: String) {
        findings.append(line).append('\n')
        Log.i(tag, line)
    }

    /** Run a shell command with the instrumentation's shell permissions; returns its output. */
    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    /**
     * The same with the command's stderr, where the platform gives it (API 31+): `perfetto`
     * refused a config with one line there and nothing on stdout (run 35540328965).
     */
    private fun shellWithError(command: String): Pair<String, String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return shell(command) to ""
        val fds: Array<ParcelFileDescriptor> = ui.executeShellCommandRwe(command)
        fds[1].close()
        val err = StringBuilder()
        val reader = Thread {
            try {
                FileInputStream(fds[2].fileDescriptor).bufferedReader().use { err.append(it.readText()) }
            } catch (_: Exception) {
            }
        }
        reader.start()
        val output = FileInputStream(fds[0].fileDescriptor).bufferedReader().use { it.readText() }
        reader.join(5_000)
        fds[0].close()
        fds[2].close()
        return output to err.toString()
    }

    companion object {
        private const val PORT = 18135
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val TAB_ID = "tab_perf"
        private const val LIVE_URL = "https://github.com/BenItBuhner/Zenium"
        private const val CONFIG_PATH = "/data/misc/perfetto-configs/menu-perf.pbtxt"
        private const val TRACE_PATH = "/data/misc/perfetto-traces/menu-perf.perfetto-trace"
        /** The longest a spring is given to land on the emulator. */
        private const val SETTLE_MS = 8_000L
        /**
         * The chrome renderer's main thread and compositor. Not the invalidation-tracking
         * category: its arguments are stripped from a release WebView's trace anyway, and on
         * the github.com copy it filled the ring and made a 7 MB trace of a 12-minute scene
         * (run 35540328965); nor viz / gpu, whose emulator numbers are the software GPU's.
         */
        private val WEBVIEW_CATEGORIES = listOf(
            "blink", "blink.user_timing", "cc", "v8", "renderer.scheduler", "input",
            "devtools.timeline", "disabled-by-default-devtools.timeline"
        )
        /** The frame's corner stays at rest while everything else recedes. */
        private const val RADIUS_OFF_CSS =
            ":root[data-form-factor='phone'] .zen-content-frame{border-radius:var(--zen-content-radius)!important}"
        /** Nothing consumes `--zen-recede`: the frame and its edge layers do not scale, the bar does not fade. */
        private const val RECEDE_OFF_CSS =
            ":root[data-form-factor='phone'] .zen-content-frame,:root[data-form-factor='phone'] .zen-load-progress-layer,:root[data-form-factor='phone'] .zen-message-frame{transform:none!important;border-radius:var(--zen-content-radius)!important}" +
                ":root[data-form-factor='phone'] .zen-phone-bar[data-edge='bottom']{opacity:1!important}"
    }
}
