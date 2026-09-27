package app.zen.chromium

import android.app.Instrumentation
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PointF
import android.graphics.Rect
import android.graphics.RectF
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * Drives the TABLET's new tab page (NTP-35: the served `zen://newtab` document – the desktop's,
 * its tiles, each tile's hold menu – in the tablet's tab, where the phone keeps its chrome-drawn
 * page over `zen://blank`) on the `pixel_tablet` AVD laid out at 1280 x 800 dp, one px per dp
 * (`DEMO_DISPLAY=1280x800@160`), on the engine the private tabs demos run on (a Chromium snapshot
 * WebView on the AOSP image: Open in Private Tab needs multi-profile WebView). The profile is a
 * fresh one past its first run: one space, no tab, the tour done. Every press a real touch, every
 * claim read off the core's state, the chrome's DOM or the served page's own DOM:
 *
 *  0. THE COLD START, for the boot path's BEFORE / AFTER: the activity's marks ([BootMarks]:
 *     `ready` – `chrome.ready` heard, on this head armed on the served page's placement – and
 *     `frame` – the first frame confirmed drawn, `reportFullyDrawn`), each as ms from the
 *     `activity` mark (MainActivity.onCreate), in a process the instrumentation already held; on
 *     a host with the new tab page the window's first tab is the served page – MADE, LOADED and
 *     placed after the FULLY DRAWN frame (the host's boot hold, #563's third half) – and its own
 *     `performance.timing` says what the document cost. THE LANDING is watched from the
 *     DISPLAY's side, from `onCreate` on ([LandingWatch], the lead's conditions of form): the
 *     frames SurfaceFlinger composed, classified after the fact against the slot's own pixels –
 *     the slot in the space's ground and nothing else before the page, the page's first painted
 *     frame WHOLE (filled from the state push, its icons in hand: one paint, nothing arriving
 *     after it), the 120 ms fade where a capture landed in it – with the page's own clock
 *     (`performance.timeOrigin`, the landing's `performance.mark`s) beside them; the stills cut
 *     from those frames – light at the fresh boot, dark and with tiles at a relaunch off camera
 *     in the warm-up ([darkLanding]: the session restored on a served tab). On main's tree
 *     (`newTabPage` off: `Browser.ensureFirstTab` opens no tab) the window comes up with no tab
 *     and the chrome's own surface, so the same driver on main is the 'before' run. The fresh
 *     tab COMES UP BARE on the tablet: the served page in view, its own field at rest – no URL
 *     bar in new-tab mode over a cover, no keyboard rising unasked – where the desktop's rule
 *     (`Browser.revealFreshTab` → `newtab.opened` → the bar) still holds on the desktop: the
 *     renderer's `newTabRevealOpensUrlbar` lets the arrival's announcement (no `text`) open no
 *     bar on a touch layout. A REAL TAP on the page's field HANDS OFF to the pill's omnibox
 *     popup (the page's `search` action, `text` ''): on this chassis the pages composite above
 *     the chrome, so the popup stands over the tab's cover picture while the live view is hidden
 *     under it (`overlayCoversContent`); a back puts the popup away and the view comes back.
 *     Then the page's EMPTY state at a fresh boot ("Sites you visit often will appear here"),
 *     light and dark;
 *  1. eight loopback sites visited off camera, a new tab from the sidebar's row under a finger:
 *     the served page with the most visited tiles, bare as at boot (`NewTabService.open` →
 *     `newtab.opened`), the tab's URL `zen://newtab`, the page view placed and shown, the tiles
 *     in the page's DOM AND in the accessibility tree, the pill reading the empty tab's words;
 *     the tiles' ICONS REAL: every tile's `<img>` loaded from `zen://favicon/<hash>`, answered
 *     at the head of the view's intercept chain on the served view alone from the chrome's
 *     favicon store (`TabWebView.newTabFavicon` → `BootHandoff.favicon`), not the letter it
 *     falls back to; the coarse pointer's numbers: the field 56, Customise 40, a tile 64 in the
 *     page's CSS px; the tap on the field → the omnibox popup, and a back. On main's tree the
 *     same row opens the bar bound to no tab and makes no tab at all (`urlbar.toggle`);
 *  2. a REAL HOLD on a tile (the finger down past the long press, on the tile's own box read off
 *     the page's DOM): the tablet's anchored menu with the touch template's FIVE rows – Open in
 *     New Tab · Open in Private Tab · Copy Link · a separator · Remove (the desktop's template is
 *     not this one; a most-visited tile has no Edit Shortcut) – HUNG FROM THE TILE's BOX: the
 *     `tile-menu` action carries the tile's rect up the bridge (`MenuAnchor.rect`), the menu's
 *     start edge level with the tile's and its top flush at the box's bottom (above the box when
 *     the room below runs out), not at the finger's point – and Open in Private Tab under a
 *     finger opening the site in a private tab in front, the private session closed after;
 *  3. the hold again and Copy Link under a finger: the tile's URL on the system clipboard;
 *  4. the dark scheme through the core's setting (the chrome and the served page re-ink in
 *     place: `Host.applyTheme` flips the app's night mode without a relaunch): the page and the
 *     hold menu in dark, and Remove under a finger taking the tile off the page through the
 *     core's command down the same channel (`sendNewTabCommand`); the light scheme back.
 *
 * Findings in `tablet-newtab-findings.txt`, stills `tablet-newtab-NN-<state>.png`. Driven by
 * `android-tablet-newtab-demo.yml`; the nightly's `tablet-webview` shard. See [GroupsDemoBase]
 * (the reads and the fingers) and [DemoHarness]. The hold on a tile reaches the page only because
 * `TabWebView.onLongPress` declines the served new tab page (`LinkHits.holdIsThePages`): Chromium
 * offers a long press to the embedder first, and a handled one never becomes the page's
 * `contextmenu` – so a tile, an `<a>`, would raise the LINK menu instead.
 */
@RunWith(AndroidJUnit4::class)
class TabletNewTabDemo : GroupsDemoBase(shotPrefix = "tablet-newtab", handshakeDir = "tablet-newtab-demo", stateAsset = "tablet-newtab-demo-state.json") {
    override val tag = "TabletNewTabDemo"
    override val findingsFile = "tablet-newtab-findings.txt"
    override val title = "Zenium Android tablet: the new tab as the served zen://newtab page, its tiles, a tile's hold menu"

    private val host get() = (activity as MainActivity).host
    private val servers = ArrayList<DemoServer>()

    /** Whether this host serves the new tab page (the head under test) or not (main's tree: the 'before' run). */
    private var served = false

    /** The tab the recording's served page is in, once the sidebar's row opened it. */
    private var pageTab: String? = null

    /** The scheme the next launch's landing is watched in ([onLaunching]); null for a launch whose landing is not wanted. */
    private var landingScheme: String? = "light"

    /** Whether the next launch is a relaunch (the boot marks the first boot's, the picture before it the old activity's). */
    private var landingRelaunch = false

    /** The watch on the launch in progress, read once the launch has settled ([readLanding]). */
    private var watch: LandingWatch? = null

    /** Where the last hold's finger was on the screen ([holdTile]): the point the menu must NOT hang from. */
    private var lastHold: PointF? = null

    /** The box of the tile last held, on the screen, read at the hold while the page was in view. */
    private var lastTileBox: RectF? = null

    /** The sites: a host each, the page's title (the tile's caption) and an icon colour. */
    private class Site(val n: Int, val title: String, val color: Int) {
        val address get() = "127.0.0.$n"
        val url get() = "http://$address:$SITE_PORT/"
    }

    private val sites = listOf(
        Site(1, "Orchard", 0xFF2E7D32.toInt()),
        Site(2, "Tides", 0xFF0277BD.toInt()),
        Site(3, "Atlas", 0xFFEF6C00.toInt()),
        Site(4, "Ledger", 0xFF5E35B1.toInt()),
        Site(5, "Foundry", 0xFFC62828.toInt()),
        Site(6, "Meadow", 0xFF00897B.toInt()),
        Site(7, "Lantern", 0xFFF9A825.toInt()),
        Site(8, "Quarry", 0xFF546E7A.toInt())
    )

    @Test
    fun record() {
        for (site in sites) {
            servers += DemoServer(
                SITE_PORT,
                mapOf(
                    "/" to ("text/html; charset=utf-8" to siteHtml(site).toByteArray()),
                    "/icon.png" to ("image/png" to iconPng(site))
                ),
                site.address
            ).also { it.start() }
        }
        try {
            recordDemo()
        } finally {
            servers.forEach { it.close() }
        }
    }

    // --- off camera --------------------------------------------------------------------------------

    override fun warmUp() {
        ensureForeground()
        head()
        for (server in servers) finding("demo server: ${server.selfCheck()}")
        served = coreState().getJSONObject("capabilities").optBoolean("newTabPage")
        finding(
            "multi-profile WebView: ${onMain { Profiles.supported }} (${WebViewCompat.getCurrentWebViewPackage(app)?.versionName ?: "?"}); " +
                "the host's new tab page: ${if (served) "ON (the served zen://newtab page: the head under test)" else "OFF (the chrome's own surface: main's tree, the 'before' run)"}"
        )
        check("the chrome laid the window out as the tablet", awaitJs("document.documentElement.dataset.formFactor==='tablet'", true, 10_000), "form factor ${jsText("document.documentElement.dataset.formFactor")}")
        coldStart()

        // The visits, typed through the core so they weigh in the ranking: every site once, the
        // first three twice, so the tiles' order is not the visiting order alone.
        // A host without the new tab page boots with no tab: one is made for the visits.
        if (activeTabId() == null) {
            coreInvoke("tab.create", JSONObject().put("url", sites[0].url).put("active", true).toString())
            awaitUntil(8_000) { activeTabId() != null }
        }
        val warm = activeTabId()
        if (warm == null) {
            check("a tab to visit the sites in", false, "no active tab after tab.create")
            return
        }
        for (site in sites) visit(warm, site)
        for (site in sites.take(3)) visit(warm, site)
        finding("history.topSites after the visits: ${summarise(coreInvoke("history.topSites", "{\"n\":8}"))}")
        if (served) darkLanding()
        // The pill reads the site's address now: the one read of the tree the fingers are calibrated on.
        calibrate(ADDRESS_PILL, PILL_LABEL, prefix = true)
        // Pay for the first layout of a popover menu off camera (the emulator compiles and lays
        // one out slowly the first time): the app menu, opened and closed.
        touch(domRect(MENU_BUTTON), "the toolbar's menu button")
        if (awaitJs(MENU_OPEN, true, 4_000)) {
            SystemClock.sleep(800)
            back()
            awaitJs(MENU_OPEN, false)
        }
        SystemClock.sleep(1_000)
        finding("warm-up done: ${describeSpace()}")
    }

    /**
     * Section 0: the cold start's marks, read off the process right after the launch – the
     * numbers the boot path's BEFORE / AFTER are stated from – and the fresh boot's page.
     */
    private fun coldStart() {
        section("0. The cold start: the activity's marks, the window's first tab")
        awaitUntil(10_000) { BootMarks.get("frame") != null }
        val marks = BootMarks.line()
        finding("  boot marks (ms since the process started, BootMarks): $marks")
        val activityMark = BootMarks.get("activity")
        val since = { name: String -> BootMarks.get(name)?.let { m -> activityMark?.let { m - it } } }
        val launchGap = activityMark?.let { it - (appLaunchedAt - Process.getStartUptimeMillis()) }
        finding(
            "  COLD START from MainActivity.onCreate (the activity mark; the process held by the instrumentation, launch→onCreate $launchGap ms): " +
                "host +${since("host")} ms, content +${since("content")} ms, load +${since("load")} ms, boot +${since("boot")} ms, " +
                "READY +${since("ready")} ms, FULLY DRAWN (frame, reportFullyDrawn) +${since("frame")} ms"
        )
        check("the boot reached its first frame (the marks ready and frame are set)", since("ready") != null && since("frame") != null, marks)
        // The landing as the watch saw it from the display's side, its stills and the conditions.
        if (served) readLanding(null) else dropLanding()
        val active = activeCoreTab()
        val url = active?.optString("url").orEmpty()
        if (served) {
            check("the fresh profile's window boots into the served new tab page as its first tab (Browser.ensureFirstTab on newTabPage)", url == NEW_TAB_URL, "active url '$url'")
            val id = active?.optString("id")
            if (id != null) {
                check("the served page is loaded before the recording, by the document's own word (readyState complete at zen://newtab)", awaitServedPage(id), "document ${pageJson(id, "[document.readyState,location.href]")}")
                // The fresh tab's reveal on the tablet (Browser.revealFreshTab → newtab.opened
                // with no text): the page comes up BARE – in view, its own field at rest, no URL
                // bar over a cover, no keyboard – where the desktop's rule opens the bar in
                // new-tab mode (newTabRevealOpensUrlbar: the announcement opens none on a touch
                // layout). Then the tap on the page's field: the hand-off to the omnibox popup.
                bareComeUp(id, "the fresh tab")
                SystemClock.sleep(800)
                still("boot-opened-light")
                handOff(id, "the fresh tab's field", frame = null)
                val timing = pageJson(id, "(function(){var t=performance.timing;return [t.domContentLoadedEventEnd-t.navigationStart,t.loadEventEnd-t.navigationStart,document.querySelectorAll('.zen-tile:not(.zen-tile-add)').length,!document.getElementById('zen-empty').hidden]})()")
                finding("  the served page's own clock (performance.timing): navigationStart→DOMContentLoaded ${timing?.opt(0)} ms, →load ${timing?.opt(1)} ms; tiles ${timing?.opt(2)}, the empty line shown ${timing?.opt(3)}")
                check("a fresh profile's page shows the empty state – no tile, the line 'Sites you visit often will appear here'", timing?.optInt(2) == 0 && timing?.optBoolean(3) == true, "tiles ${timing?.opt(2)}, empty ${timing?.opt(3)}")
                check("the pill reads the empty tab's words on the served page", pillText().startsWith("Search"), "pill '${pillText()}'")
                SystemClock.sleep(800)
                still("boot-empty-light")
                if (setScheme("dark", id)) {
                    SystemClock.sleep(800)
                    still("boot-empty-dark")
                    setScheme("light", id)
                }
            }
        } else {
            check("main's tree: the window boots with no tab (Browser.ensureFirstTab opens none without the new tab page), the chrome's own surface", active == null, "active url '$url'")
            SystemClock.sleep(800)
            still("boot-main")
        }
    }

    /** A loopback page loads in well under a second; a visit that does not is noted, not waited out. */
    private fun visit(tabId: String, site: Site) {
        coreInvoke("tab.navigate", JSONObject().put("tabId", tabId).put("input", site.url).toString())
        if (!awaitLoaded(tabId, site.url, 8_000)) finding("  visit of ${site.url} never finished: ${tabUrl(tabId)}")
        SystemClock.sleep(500)
    }

    // --- the landing (NTP-35: the lead's conditions of form on #563) ------------------------------------

    /** One read of the served page's root during the landing, by the page's own word. */
    private class LandingSample(
        /** The document is the served page (`location.href` zen://newtab), not the view's empty first document. */
        val served: Boolean,
        /** The root carries `data-await-state`: the document is filling, transparent (`newTabPage.ts`). */
        val awaiting: Boolean,
        /** The root's computed opacity: 0 while awaiting, between 0 and 1 in the 120 ms fade, 1 whole. */
        val opacity: Double,
        val readyState: String,
        val tiles: Int,
        /** Every tile icon's `<img>` is complete with pixels: the icons in hand, not on their way. */
        val iconsInHand: Boolean,
        val icons: Int,
        /** Letter fallbacks on the page: a tile whose icon failed, or a site with none cached. */
        val letters: Int,
        val emptyShown: Boolean,
        val theme: String,
        /** Uptime when the read was asked. */
        val at: Long
    ) {
        fun describe(): String =
            (if (served) "the served page" else "not the served page") +
                ", ${if (awaiting) "awaiting its state" else "let in"} at opacity $opacity, $readyState, tiles $tiles (icons $icons ${if (iconsInHand) "in hand" else "on their way"}, letters $letters), empty line ${if (emptyShown) "shown" else "hidden"}, theme '$theme'"
    }

    /** One frame of the display during a landing's watch, kept because it differed from the one kept before it. */
    private class Frame(
        /**
         * The capture as taken; null once let go – rolled out of the ring of the [LANDING_FULL_CAP]
         * most recent changed frames' full captures, or handed to the encoder for a still.
         */
        var full: Bitmap?,
        /** The capture at a [LANDING_SCALE]th of its size: the pixels the frames are told apart and classified by. */
        val small: Bitmap,
        /** Uptime the capture was asked. */
        val at: Long
    ) {
        /** The full capture recycled; the small one stays for the read. */
        fun letGo() {
            full?.recycle()
            full = null
        }

        fun recycle() {
            letGo()
            small.recycle()
        }
    }

    /**
     * A launch's landing watched from the DISPLAY's side. An `Instrumentation.ActivityMonitor` on
     * MainActivity hands the activity over the moment `onCreate` has returned (where
     * `startActivitySync` returns at the main looper's first idle – 2.2 s into the fresh boot on
     * the first sample, after the whole relaunch landing), and from then a thread of its own takes
     * SurfaceFlinger's frame (`UiAutomation.takeScreenshot`: no part of the app's UI thread, which
     * the served view's first frame stalls for seconds on the emulator – a poll through
     * `runOnMainSync` sat behind that stall and saw nothing of the landing) as fast as the capture
     * allows, keeping each frame that differs from the one kept before it (a status bar's clock is
     * under the mark; a tile's icon is not), until the window is over: [LANDING_AFTER_FRAME_MS]
     * after the FULLY DRAWN mark at a fresh boot – the hold's 5 s and the page's 5 s cap inside it –
     * or [LANDING_RELAUNCH_MS] from `onCreate` at a relaunch, whose marks are the first boot's. Every
     * kept frame's small copy stays; the full captures ride a ring of the [LANDING_FULL_CAP] most
     * recent – the oldest let go as a newer one comes – so the landing's LAST frames (the ground, the
     * fade, the first paint), which the stills are cut from, always have theirs, however many frames
     * a relaunch's early picture (the old activity, the window animation, the chrome) changed before
     * them. What the frames show is read after the fact, against the slot's own rectangle
     * ([classify]). The captures share the emulator's CPU with the boot they watch.
     */
    private inner class LandingWatch(val scheme: String, val relaunch: Boolean) : Runnable {
        private val monitor = Instrumentation.ActivityMonitor(MainActivity::class.java.name, null, false)
        private val done = CountDownLatch(1)
        val frames = ArrayList<Frame>()
        /** Uptime the monitor handed the activity over (`onCreate` returned); 0 when it never came. */
        var createdAt = 0L
        /** Captures asked for, kept or not. */
        var looked = 0
        var note: String? = null

        fun arm() {
            instrumentation.addMonitor(monitor)
            Thread(this, "landing-watch-$scheme").start()
        }

        override fun run() {
            try {
                val started = monitor.waitForActivityWithTimeout(30_000)
                instrumentation.removeMonitor(monitor)
                if (started == null) {
                    note = "the activity did not come within 30 s of the launch"
                    return
                }
                createdAt = SystemClock.uptimeMillis()
                var last: IntArray? = null
                // The frames still holding their full capture, oldest first: the ring.
                val fulls = ArrayDeque<Frame>()
                while (SystemClock.uptimeMillis() < windowEnd()) {
                    val at = SystemClock.uptimeMillis()
                    val bmp = ui.takeScreenshot()
                    looked++
                    if (bmp == null) {
                        SystemClock.sleep(LANDING_RETRY_MS)
                        continue
                    }
                    val small = Bitmap.createScaledBitmap(bmp, bmp.width / LANDING_SCALE, bmp.height / LANDING_SCALE, true)
                    val px = pixels(small)
                    if (last == null || differing(px, last) > LANDING_KEEP_FRACTION) {
                        val frame = Frame(bmp, small, at)
                        frames += frame
                        fulls.addLast(frame)
                        if (fulls.size > LANDING_FULL_CAP) fulls.removeFirst().letGo()
                        last = px
                    } else {
                        bmp.recycle()
                        small.recycle()
                    }
                    SystemClock.sleep(LANDING_CADENCE_MS)
                }
            } catch (e: Throwable) {
                note = "the watch stopped: $e"
                Log.e(tag, "the landing watch stopped", e)
            } finally {
                done.countDown()
            }
        }

        /** When the watch is over: the fresh boot's from its FULLY DRAWN mark once set, a relaunch's from `onCreate`. */
        private fun windowEnd(): Long {
            if (relaunch) return createdAt + LANDING_RELAUNCH_MS
            val frame = BootMarks.get("frame") ?: return createdAt + LANDING_NO_FRAME_MS
            return Process.getStartUptimeMillis() + frame + LANDING_AFTER_FRAME_MS
        }

        fun await(timeoutMs: Long): Boolean = done.await(timeoutMs, TimeUnit.MILLISECONDS)
    }

    /** What a landing's frames showed, read against the slot ([classify]). */
    private class Landing(
        /** The served view's box on the screen at the read; null when the view was not shown (no classification then). */
        val slot: Rect?,
        /** Uptime of the FULLY DRAWN frame (the `frame` mark) at the fresh boot; null at a relaunch. */
        val frameAt: Long?,
        /** The frames from the FULLY DRAWN frame on (a fresh boot) or all of them (a relaunch), in order. */
        val window: List<Frame>,
        /** The first frame of the run with the slot in one tone that ends at [ground]. */
        val groundFrom: Frame?,
        /** The last frame with the slot in one tone before the page's first paint: the space's ground alone. */
        val ground: Frame?,
        /** The ground's tone (the slot's one colour). */
        val groundTone: Int?,
        /** Frames between the ground and the first paint whose slot lies between the ground and the settled picture: the fade in flight, with its opacity read off the blend. */
        val mids: List<Pair<Frame, Double>>,
        /** The first frame whose slot is the settled picture: the page's first painted frame, whole. */
        val firstPaint: Frame?,
        /** The last frame kept: the settled picture. */
        val settled: Frame?,
        /** Frames between the ground and the first paint that were neither the ground, a blend toward the settled picture nor that picture: a cover, a skeleton, a partial page. */
        val strangers: List<Frame>,
        /** Frames after the first paint whose slot changed from the settled picture by more than [LANDING_LATE_FRACTION]: things arriving after the page showed. */
        val late: List<Frame>
    )

    /**
     * The next launch's landing is watched from its very first moment: the monitor and the watch
     * go on before the intent is handed over ([DemoHarness.onLaunching]).
     */
    override fun onLaunching() {
        val scheme = landingScheme ?: return
        landingScheme = null
        watch = LandingWatch(scheme, landingRelaunch).also { it.arm() }
        landingRelaunch = false
    }

    /** A launch whose landing is not read (main's tree: no served view): the watch's frames let go. */
    private fun dropLanding() {
        val w = watch ?: return
        watch = null
        w.await(LANDING_WAIT_MS)
        w.frames.forEach { it.recycle() }
    }

    /**
     * The landing of the launch that has settled, read: the watch's frames classified against the
     * served view's box ([classify]), the stills cut from the chosen frames (`landing-ground`,
     * `landing-mid-fade` where a capture landed in the fade, `landing-first-paint`), the page's own
     * clock read post hoc (`performance.timeOrigin` – the served document's load began – and the
     * landing's marks: ready, state, icons, in, or the cap), the page's DOM as it stands, and the
     * lead's conditions as checks. `tabId` names the served tab when known (a relaunch's), null
     * for a fresh profile's one tab.
     */
    private fun readLanding(tabId: String?) {
        val w = watch ?: run {
            finding("  landing: no watch was armed for this launch")
            return
        }
        watch = null
        val scheme = w.scheme
        val finished = w.await(LANDING_WAIT_MS)
        if (!finished) finding("  landing ($scheme): the watch had not finished ${LANDING_WAIT_MS / 1000} s after the launch settled; read as it stands")
        w.note?.let { finding("  landing ($scheme): $it") }
        var id = tabId
        if (id == null) {
            awaitUntil(10_000) { onMain { host.tabs.all().firstOrNull()?.tabId }.also { id = it } != null }
        }
        val served = id
        val relaunch = w.relaunch
        val frameAt = if (relaunch) null else BootMarks.get("frame")?.let { Process.getStartUptimeMillis() + it }
        val ref = frameAt ?: w.createdAt
        val refName = if (frameAt != null) "the FULLY DRAWN frame" else "onCreate"
        val cadence = w.frames.zipWithNext { a, b -> b.at - a.at }.sorted().let { if (it.isEmpty()) null else it[it.size / 2] }
        finding(
            "  landing ($scheme): watched from the display's side from onCreate (+${w.createdAt - appLaunchedAt} ms after the launch was asked" +
                (frameAt?.let { "; the FULLY DRAWN frame +${it - w.createdAt} ms after onCreate" } ?: "; a relaunch: the marks are the first boot's, the times from onCreate") +
                "): ${w.looked} frames looked at, ${w.frames.size} kept as changed" +
                (cadence?.let { " (the kept frames' median spacing $it ms)" } ?: "") +
                "; the kept frames at ${w.frames.joinToString(", ") { "+${it.at - ref}" }} ms from $refName"
        )
        val l = classify(w, served, frameAt)
        val slotLine = l.slot?.let { "the slot ${it.width()}x${it.height()} at (${it.left},${it.top})" } ?: "NO SLOT RECT (the served view not shown at the read: the frames are not classified)"
        val groundLine = l.ground?.let { g ->
            "the GROUND: the slot in one tone (${tone(l.groundTone!!)}) from +${(l.groundFrom ?: g).at - ref} to +${g.at - ref} ms after $refName – the space's ground alone"
        } ?: "no frame with the slot in one tone before the page (${if (l.firstPaint != null) "the page's first paint came within one capture of $refName" else "no first paint either"})"
        val midLine = if (l.mids.isEmpty()) {
            "the fade not caught (no capture landed between the ground and the page's first paint)"
        } else {
            "the FADE caught at " + l.mids.joinToString(", ") { (f, alpha) -> "+${f.at - ref} ms at opacity ${"%.2f".format(alpha)}" }
        }
        val paintLine = l.firstPaint?.let { "the page's FIRST PAINT on the display +${it.at - ref} ms after $refName (within one capture), whole: its slot the settled picture's" } ?: "no first paint: no frame whose slot is the settled picture's"
        val afterLine = if (l.late.isEmpty()) "nothing changed in the slot after it" else "the slot CHANGED after it at ${l.late.joinToString(", ") { "+${it.at - ref}" }} ms"
        val strangerLine = if (l.strangers.isEmpty()) "no other picture between the ground and the page" else "OTHER PICTURES between the ground and the page at ${l.strangers.joinToString(", ") { "+${it.at - ref}" }} ms"
        finding("  landing ($scheme): $slotLine; $groundLine; $midLine; $paintLine; $afterLine; $strangerLine")

        // The stills: the chosen frames' captures handed to the encoder (recycled once written);
        // every frame's remains recycled at the end.
        fun cut(state: String, frame: Frame?) {
            if (frame == null) return
            val full = frame.full
            if (full == null) {
                finding("  landing ($scheme): the $state frame's full capture had rolled out of the ring of $LANDING_FULL_CAP (more than $LANDING_FULL_CAP changed frames came after it); no still of it")
                return
            }
            still(state, full)
            frame.full = null
        }
        cut("landing-ground-$scheme", l.ground)
        cut("landing-mid-fade-$scheme", l.mids.getOrNull(l.mids.size / 2)?.first)
        cut("landing-first-paint-$scheme", l.firstPaint)

        // The page's own clock: the served document's load began (timeOrigin) and the landing's marks.
        val page = served?.let { landingSample(it) }
        val clock = served?.let { landingClock(it) }
        val loadAt = clock?.first
        val marks = clock?.second.orEmpty()
        val markAt = { name: String -> marks[name]?.let { it - ref } }
        finding(
            "  landing ($scheme): the page's own clock – " +
                (loadAt?.let { "the served document's load began +${it - ref} ms after $refName (performance.timeOrigin)" } ?: "no timeOrigin read") +
                "; the marks after $refName: ready ${markAt("zen-newtab-ready") ?: "–"}, state ${markAt("zen-newtab-state") ?: "–"}, icons ${markAt("zen-newtab-icons") ?: "–"}, in ${markAt("zen-newtab-in") ?: "–"} ms" +
                (marks["zen-newtab-cap"]?.let { "; THE CAP FIRED +${it - ref} ms (the shell in without its state)" } ?: "; the cap did not fire") +
                (l.firstPaint?.let { p -> marks["zen-newtab-in"]?.let { "; the display's first paint ${p.at - it} ms after the page let itself in" } } ?: "")
        )
        finding("  landing ($scheme): the page after the landing: ${page?.describe() ?: "no served page answered"}")

        // The lead's conditions, as checks.
        check(
            "($scheme) the landing was watched from onCreate and the page's first painted frame found on the display",
            l.firstPaint != null && l.slot != null,
            "frames kept ${w.frames.size}, slot ${l.slot != null}, first paint ${l.firstPaint != null}"
        )
        if (frameAt != null) {
            check(
                "($scheme) the served document began loading AFTER the FULLY DRAWN frame, by its own clock (timeOrigin against the frame mark: the boot hold's order)",
                loadAt != null && loadAt > frameAt,
                loadAt?.let { "load began ${it - frameAt} ms after the frame" } ?: "no timeOrigin"
            )
        }
        // (1) The slot in the space's ground alone while the page is held: one tone until the page,
        // and nothing between that tone and the page but the page's own fade.
        check(
            "($scheme) the slot showed the space's ground and nothing else before the page: one tone from $refName until the page's first paint, no cover, no skeleton, no partial page",
            l.firstPaint != null && l.strangers.isEmpty() && (l.ground != null || !relaunch),
            "ground ${if (l.ground != null) "caught" else "not caught (the page within one capture of $refName)"}, other pictures ${l.strangers.size}"
        )
        // (2) The page arrives whole in one paint: the first painted frame IS the settled picture,
        // nothing arrives after it, and the page says it was filled from the state before it let
        // itself in (the state mark before the in mark, the cap never fired).
        val stateAt = marks["zen-newtab-state"]
        val inAt = marks["zen-newtab-in"]
        check(
            "($scheme) the page came in WHOLE in one paint: its first painted frame the settled picture, nothing arriving in the slot after it, the state applied before the root was let in (the page's marks), the cap unfired, the document complete with its tiles or its empty line",
            l.firstPaint != null && l.late.isEmpty() && page != null && page.served && !page.awaiting && page.readyState == "complete" && (page.tiles > 0 || page.emptyShown) &&
                stateAt != null && inAt != null && stateAt <= inAt && !marks.containsKey("zen-newtab-cap"),
            "late changes ${l.late.size}; marks state ${stateAt?.let { it - ref } ?: "–"} in ${inAt?.let { it - ref } ?: "–"} cap ${marks["zen-newtab-cap"]?.let { it - ref } ?: "none"}; page ${page?.describe() ?: "none"}"
        )
        if (page != null && page.tiles > 0) {
            check(
                "($scheme) the icons were in hand at the first paint: every tile's icon complete, no letter that turned into an icon (no change in the slot after the first paint)",
                page.icons == page.tiles && page.iconsInHand && page.letters == 0 && l.late.isEmpty(),
                "tiles ${page.tiles}, icons ${page.icons} ${if (page.iconsInHand) "in hand" else "on their way"}, letters ${page.letters}, late changes ${l.late.size}"
            )
        }
        // (3) The fade: 120 ms on the root's opacity under full motion (the stylesheet's rule, pinned
        // in vitest); the display's word where a capture landed in it. Not a check: a capture every
        // ~200 ms lands in a 120 ms fade only now and then.
        finding("  ($scheme) the first paint's fade: $midLine; from $refName to the page's first paint on the display: ${l.firstPaint?.let { "${it.at - ref} ms" } ?: "n/a"} (THE EMULATOR's NUMBER; the hardware-equivalent is stated in the PR's body)")
        if (scheme == "dark") check("(dark) the relaunch landed dark: the page's own theme after a landing with no change after its first paint", page?.theme == "dark" && l.late.isEmpty(), "theme '${page?.theme}', late changes ${l.late.size}")

        w.frames.forEach { it.recycle() }
    }

    /**
     * The frames read against the slot. The FULLY DRAWN frame opens the window at a fresh boot (the
     * splash and its exit are before it); a relaunch's window is every frame, the old activity's
     * picture first – so the ground is the LAST frame with the slot in one tone before the first
     * frame whose slot is the settled picture's, and the first paint the first such frame after
     * the ground. A frame between them is the fade where its slot lies between the ground's tone
     * and the settled picture (its opacity read off the blend), a stranger otherwise; a frame after
     * the first paint whose slot differs from the settled picture is a late change.
     */
    private fun classify(w: LandingWatch, tabId: String?, frameAt: Long?): Landing {
        val slot = tabId?.let { pageBox(it) }
        val window = w.frames.filter { frameAt == null || it.at >= frameAt }
        val settled = window.lastOrNull()
        if (slot == null || settled == null || slot.width() < 4 * LANDING_SCALE || slot.height() < 4 * LANDING_SCALE) {
            return Landing(slot, frameAt, window, null, null, null, emptyList(), null, settled, emptyList(), emptyList())
        }
        val settledPx = slotPixels(settled, slot)
        val uniformity = window.map { uniform(slotPixels(it, slot)) }
        val isGround = uniformity.map { it.first >= LANDING_UNIFORM }
        val isSettled = window.map { differing(slotPixels(it, slot), settledPx) <= LANDING_NEAR_FINAL_FRACTION }
        var ground = -1
        var first = -1
        for (i in window.indices) {
            if (isGround[i]) {
                ground = i
            } else if (isSettled[i] && ground >= 0) {
                first = i
                break
            }
        }
        // No frame in one tone before the page (the page came within one capture of the frame):
        // at a fresh boot the window opens at the FULLY DRAWN frame, so the first frame that is
        // the settled picture is still the first paint; a relaunch has no such anchor.
        if (first < 0 && frameAt != null) {
            ground = -1
            first = isSettled.indexOf(true)
        }
        var groundFrom = ground
        while (groundFrom > 0 && isGround[groundFrom - 1]) groundFrom--
        val groundTone = if (ground >= 0) uniformity[ground].second else null
        val mids = ArrayList<Pair<Frame, Double>>()
        val strangers = ArrayList<Frame>()
        if (first >= 0) {
            for (i in (ground + 1) until first) {
                val px = slotPixels(window[i], slot)
                val blend = groundTone?.let { blendToward(px, it, settledPx) }
                if (blend != null && blend.first >= LANDING_BLEND) mids += window[i] to blend.second else strangers += window[i]
            }
        }
        val late = if (first >= 0) window.drop(first + 1).filter { differing(slotPixels(it, slot), settledPx) > LANDING_LATE_FRACTION } else emptyList()
        return Landing(
            slot, frameAt, window,
            if (ground >= 0) window[groundFrom] else null,
            if (ground >= 0) window[ground] else null,
            groundTone, mids,
            if (first >= 0) window[first] else null,
            settled, strangers, late
        )
    }

    /** The pixels of the small frame inside the slot (in screen px), the slot's edge left out. */
    private fun slotPixels(frame: Frame, slot: Rect): IntArray {
        val s = LANDING_SCALE
        val left = (slot.left / s + 1).coerceIn(0, frame.small.width - 1)
        val top = (slot.top / s + 1).coerceIn(0, frame.small.height - 1)
        val right = (slot.right / s - 1).coerceIn(left + 1, frame.small.width)
        val bottom = (slot.bottom / s - 1).coerceIn(top + 1, frame.small.height)
        val w = right - left
        val h = bottom - top
        val px = IntArray(w * h)
        frame.small.getPixels(px, 0, w, left, top, w, h)
        return px
    }

    private fun pixels(bitmap: Bitmap): IntArray {
        val px = IntArray(bitmap.width * bitmap.height)
        bitmap.getPixels(px, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
        return px
    }

    /** The fraction of pixels that differ between two frames of the same size (a channel sum over [LANDING_PIXEL_TOLERANCE]). */
    private fun differing(a: IntArray, b: IntArray): Double {
        if (a.size != b.size || a.isEmpty()) return 1.0
        var n = 0
        for (i in a.indices) if (distance(a[i], b[i]) > LANDING_PIXEL_TOLERANCE) n++
        return n.toDouble() / a.size
    }

    private fun distance(p: Int, q: Int): Int =
        abs(Color.red(p) - Color.red(q)) + abs(Color.green(p) - Color.green(q)) + abs(Color.blue(p) - Color.blue(q))

    /** The fraction of the pixels within [LANDING_TONE] per channel of their most common tone, and that tone. */
    private fun uniform(px: IntArray): Pair<Double, Int> {
        if (px.isEmpty()) return 0.0 to Color.BLACK
        val bins = HashMap<Int, Int>()
        val bin = { p: Int -> ((Color.red(p) shr 3) shl 10) or ((Color.green(p) shr 3) shl 5) or (Color.blue(p) shr 3) }
        for (p in px) bins[bin(p)] = (bins[bin(p)] ?: 0) + 1
        val mode = bins.maxByOrNull { it.value }!!.key
        var r = 0L
        var g = 0L
        var b = 0L
        var n = 0
        for (p in px) if (bin(p) == mode) {
            r += Color.red(p)
            g += Color.green(p)
            b += Color.blue(p)
            n++
        }
        val tone = Color.rgb((r / n).toInt(), (g / n).toInt(), (b / n).toInt())
        val near = px.count { abs(Color.red(it) - Color.red(tone)) <= LANDING_TONE && abs(Color.green(it) - Color.green(tone)) <= LANDING_TONE && abs(Color.blue(it) - Color.blue(tone)) <= LANDING_TONE }
        return near.toDouble() / px.size to tone
    }

    /**
     * How much of a frame's slot lies between the ground's tone and the settled picture, pixel by
     * pixel (a fade in flight), and the opacity the blend reads as, averaged over the pixels the
     * page changes the most.
     */
    private fun blendToward(px: IntArray, ground: Int, settled: IntArray): Pair<Double, Double>? {
        if (px.size != settled.size || px.isEmpty()) return null
        var between = 0
        var alphaSum = 0.0
        var alphaN = 0
        val gr = Color.red(ground)
        val gg = Color.green(ground)
        val gb = Color.blue(ground)
        for (i in px.indices) {
            val p = px[i]
            val f = settled[i]
            val inR = Color.red(p) in (minOf(gr, Color.red(f)) - LANDING_TONE)..(maxOf(gr, Color.red(f)) + LANDING_TONE)
            val inG = Color.green(p) in (minOf(gg, Color.green(f)) - LANDING_TONE)..(maxOf(gg, Color.green(f)) + LANDING_TONE)
            val inB = Color.blue(p) in (minOf(gb, Color.blue(f)) - LANDING_TONE)..(maxOf(gb, Color.blue(f)) + LANDING_TONE)
            if (inR && inG && inB) between++
            val span = abs(Color.red(f) - gr) + abs(Color.green(f) - gg) + abs(Color.blue(f) - gb)
            if (span >= LANDING_BLEND_SPAN) {
                val moved = abs(Color.red(p) - gr) + abs(Color.green(p) - gg) + abs(Color.blue(p) - gb)
                alphaSum += (moved.toDouble() / span).coerceIn(0.0, 1.0)
                alphaN++
            }
        }
        return between.toDouble() / px.size to (if (alphaN > 0) alphaSum / alphaN else Double.NaN)
    }

    private fun tone(color: Int): String = String.format("#%06X", color and 0xFFFFFF)

    /**
     * The served page's own clock: `performance.timeOrigin` (the document's load began) and the
     * landing's marks (`newTabPageScript.ts` LANDING_MARKS), each as uptime – the page's epoch
     * times moved onto the device's uptime clock by the offset between the two as read now.
     */
    private fun landingClock(tabId: String): Pair<Long, Map<String, Long>>? {
        val a = pageJson(
            tabId,
            "(function(){var m={};performance.getEntriesByType('mark').forEach(function(e){if(e.name.indexOf('zen-newtab-')===0&&m[e.name]===undefined)m[e.name]=e.startTime});return [performance.timeOrigin,m]})()"
        ) ?: return null
        if (a.length() < 2) return null
        val epochToUptime = SystemClock.uptimeMillis() - System.currentTimeMillis()
        val origin = a.optDouble(0)
        if (origin.isNaN()) return null
        val marks = a.optJSONObject(1) ?: JSONObject()
        val at = HashMap<String, Long>()
        for (name in marks.keys()) at[name] = (origin + marks.getDouble(name) + epochToUptime).roundToLong()
        return (origin + epochToUptime).roundToLong() to at
    }

    /** The served page's root read after the landing, or null while the view has no document that answers. */
    private fun landingSample(tabId: String): LandingSample? {
        val at = SystemClock.uptimeMillis()
        val a = pageJson(
            tabId,
            "(function(){var r=document.documentElement;var e=document.getElementById('zen-empty');" +
                "var im=Array.prototype.slice.call(document.querySelectorAll('img.zen-ntp-icon'));" +
                "return [location.href,r.hasAttribute('data-await-state'),Number(getComputedStyle(r).opacity),document.readyState," +
                "document.querySelectorAll('$TILE_SELECTOR').length,im.every(function(i){return i.complete&&i.naturalWidth>0}),im.length," +
                "document.querySelectorAll('.zen-ntp-letter').length,!!e&&!e.hidden,r.dataset.theme||'']})()"
        ) ?: return null
        if (a.length() < 10) return null
        return LandingSample(
            served = a.optString(0).removeSuffix("/") == NEW_TAB_URL,
            awaiting = a.optBoolean(1),
            opacity = a.optDouble(2, 1.0),
            readyState = a.optString(3),
            tiles = a.optInt(4),
            iconsInHand = a.optBoolean(5),
            icons = a.optInt(6),
            letters = a.optInt(7),
            emptyShown = a.optBoolean(8),
            theme = a.optString(9),
            at = at
        )
    }

    /**
     * The landing again, in DARK and WITH TILES, off camera in the warm-up: a served tab made in
     * front through the core, the dark scheme through the core's setting, the profile on disk
     * with both, and the activity started again ([launch]: the chrome and the core boot into a
     * new session, the restore coming back on that tab, its tiles the visits') – so the second
     * landing's stills carry the icons condition too, and its ground is the dark space's. Then
     * the light scheme back and the tab closed: the sequence proper starts from the state it had.
     * The boot marks stay the first boot's (the first of a name stands).
     */
    private fun darkLanding() {
        val before = activeTabId()
        coreInvoke("tab.create", JSONObject().put("url", NEW_TAB_URL).put("active", true).toString())
        val id = if (awaitUntil(8_000) { activeTabId().let { it != null && it != before } }) activeTabId() else null
        if (id == null) {
            finding("  (dark landing: no served tab could be made in front; skipped)")
            return
        }
        awaitServedPage(id)
        if (!awaitUntil(15_000) { tileCount(id) >= 4 }) finding("  (dark landing: the tiles did not come before the relaunch: ${tileCaptions(id)})")
        if (!setScheme("dark", id)) finding("  (dark landing: the dark scheme did not take on both the chrome and the page before the relaunch)")
        // The profile on disk with the scheme and the tab: what the restore reads.
        val state = File(app.filesDir, "zen/state.json")
        val written = awaitUntil(10_000) {
            val text = runCatching { state.readText() }.getOrDefault("")
            text.contains(Regex("\"colorScheme\"\\s*:\\s*\"dark\"")) && text.contains("\"$id\"")
        }
        finding("  dark landing: the profile written with the dark scheme and the served tab $id before the relaunch: $written")
        SystemClock.sleep(1_000)
        landingScheme = "dark"
        landingRelaunch = true
        launch()
        readLanding(id)
        // Back to the light scheme and the state the sequence expects.
        val front = activeTabId()
        if (front != null && !setScheme("light", front)) finding("  (dark landing: the light scheme did not come back on both the chrome and the page)")
        coreInvoke("tab.close", JSONObject().put("tabId", id).toString())
        if (!awaitUntil(8_000) { !tabExists(id) }) finding("  (dark landing: the served tab $id is still there)")
        SystemClock.sleep(800)
        ensureForeground()
    }

    // --- the sequence ------------------------------------------------------------------------------

    override fun demo() {
        if (!served) {
            mainsNewTab()
            tail()
            return
        }
        servedPage()
        holdMenuAndPrivateTab()
        copyLink()
        darkAndRemove()
        SystemClock.sleep(800)
        still("end")
        tail()
    }

    // --- main's tree: the 'before' run --------------------------------------------------------------

    /**
     * On main's tree the sidebar's row asks the core for a new tab (`tab.new`) and, the page off,
     * `NewTabService.open` toggles the URL bar in new-tab mode bound to no tab instead: no tab is
     * made until a submit. Recorded as it is; nothing of the served page claimed.
     */
    private fun mainsNewTab() {
        section("1. Main's tree: the sidebar's New Tab row opens the URL bar bound to no tab (no served page on this host)")
        val before = activeTabId()
        val opened = touchUntil("New Tab", { domRect(NEW_TAB_ROW) }, { urlbarOpen() }, waitMs = 8_000)
        check(
            "a touch on the sidebar's New Tab row opens the URL bar in new-tab mode bound to no tab, and no tab is made (NewTabService.open without the page: urlbar.toggle)",
            opened && activeTabId() == before,
            "urlbar.open ${urlbarOpen()}, active ${activeTabId()} (was $before)"
        )
        val url = activeCoreTab()?.optString("url").orEmpty()
        finding("  the active tab stays at '$url'; the served page's scenes need newTabPage on and are skipped here")
        SystemClock.sleep(1_200)
        still("new-tab-main")
        val close = closeUrlField()
        check("a back puts the bar away, the page kept", close.ok, close.describe())
    }

    // --- 1. the served page with its tiles --------------------------------------------------------

    private fun servedPage() {
        section("1. A new tab from the sidebar's row: the served zen://newtab page with the most visited tiles")
        val before = activeTabId()
        val opened = touchUntil("New Tab", { domRect(NEW_TAB_ROW) }, { activeTabId() != null && activeTabId() != before }, waitMs = 8_000)
        check("a touch on the sidebar's New Tab row opens a new tab in front", opened, "active ${activeTabId()}")
        val id = activeTabId() ?: return
        pageTab = id
        check("the new tab is the served page: its URL is zen://newtab", awaitCore { it.getJSONObject("tabs").optJSONObject(id)?.optString("url") == NEW_TAB_URL }, "url ${tabUrl(id)}")
        // NewTabService.open: the tab made and activated, then `newtab.opened` with no text – on
        // the tablet no bar comes of it: the page is up bare, its field at rest (as at boot).
        check("the page's state came down the bridge: the tiles are in the page's DOM (the sites visited)", awaitUntil(15_000) { tileCount(id) >= 4 }, "tiles ${tileCaptions(id)}")
        bareComeUp(id, "the new tab")
        check("the page view is placed, shown and loaded: the document's own location is zen://newtab", awaitServedPage(id) && pageShown(id), "document ${pageJson(id, "[document.readyState,location.href]")}, shown ${pageShown(id)}")
        val captions = tileCaptions(id)
        finding("  tiles in the page's order: $captions")
        check("the tiles are the visited sites, every caption a site's title", captions.isNotEmpty() && captions.all { c -> sites.any { it.title == c } }, "captions $captions")
        icons(id)
        coarseNumbers(id)
        SystemClock.sleep(1_200)
        still("opened-light")
        handOff(id, "the new tab's field", frame = "handoff-light")
        val first = captions.firstOrNull()
        check("the tiles stand in the accessibility tree once the view is shown (the first tile, by its caption, inside the page view's box)", first != null && awaitUntil(15_000) { tileInTree(id, first) }, "first '$first': ${first?.let { describeTileNode(id, it) }}")
        if (first != null) finding("  the first tile's node: ${describeTileNode(id, first)}")
        check("the empty line is hidden once there are tiles", pageJson(id, "[!!document.getElementById('zen-empty').hidden]")?.optBoolean(0) == true, "")
        check("the pill reads the empty tab's words, not an address", pillText().startsWith("Search"), "pill '${pillText()}'")
        check("the page is on the light scheme", pageTheme(id) == "light", "theme '${pageTheme(id)}'")
        SystemClock.sleep(1_200)
        still("tiles-light")
    }

    // --- 2. a tile's hold: the five rows, Open in Private Tab -----------------------------------------

    private fun holdMenuAndPrivateTab() {
        section("2. A REAL HOLD on a tile: the tablet's anchored menu with the five rows; Open in Private Tab")
        val id = pageTab ?: return
        val tile = tileAt(id, TILE) ?: run {
            check("the tile to hold is on the page", false, "tiles ${tileCaptions(id)}")
            return
        }
        val rows = holdTile(id, TILE, tile.title)
        check("the hold on '${tile.title}' raised the menu with the touch template's rows", rows == TOUCH_ROWS, "rows $rows")
        check("one separator stands between the open rows and Remove: five rows in all", rows.size == 4 && jsNumber("document.querySelectorAll('$MENU_SEPARATOR').length") == 1.0, "separators ${jsNumber("document.querySelectorAll('$MENU_SEPARATOR').length")}")
        check("no Edit Shortcut on a most-visited tile; the desktop's window rows are not here", rows.none { it.startsWith("Edit") || it.contains("Window") }, "rows $rows")
        check("the menu is the tablet's anchored popover (`.zen-v2-menu`), not a sheet", inDom(MENU) && !inDom(SHEET), "")
        menuHangsFromTile(lastTileBox, lastHold)
        SystemClock.sleep(1_200)
        still("tile-menu-light")
        val before = privateTabIds().toSet()
        val opened = touchUntil("Open in Private Tab", { menuRow("Open in Private Tab") }, { privateActive() }, waitMs = 10_000)
        check("a touch on Open in Private Tab opens the site in a private tab in front", opened, "active ${activeCoreTab()?.optString("containerId")}")
        val privateId = privateTabIds().firstOrNull { it !in before }
        check("the private tab is the tile's site", privateId != null && awaitLoaded(privateId, tile.url, 15_000), "url ${privateId?.let { tabUrl(it) }}")
        check("the window re-inks private with the private tab in front (§9.19)", awaitJs("document.documentElement.dataset.theme==='dark'", true, 6_000) && privateInk(), "theme '${jsText("document.documentElement.dataset.theme")}'")
        SystemClock.sleep(1_200)
        still("private-tab")
        coreInvoke("tab.closePrivate")
        check("Close Private Tabs ends the session; the served page stands", awaitUntil(10_000) { privateTabIds().isEmpty() } && tabExists(id), "private ${privateTabIds()}")
        coreInvoke("tab.activate", JSONObject().put("tabId", id).toString())
        check("the served page is back in front", awaitUntil(8_000) { activeTabId() == id } && awaitJs("document.documentElement.dataset.theme==='light'", true, 6_000), "active ${activeTabId()}")
        SystemClock.sleep(800)
    }

    // --- 3. Copy Link --------------------------------------------------------------------------------

    private fun copyLink() {
        section("3. The hold again, Copy Link under a finger: the tile's URL on the clipboard")
        val id = pageTab ?: return
        val tile = tileAt(id, TILE) ?: run {
            check("the tile to hold is on the page", false, "tiles ${tileCaptions(id)}")
            return
        }
        onMain { clipboard().setPrimaryClip(ClipData.newPlainText("demo", SENTINEL)) }
        check("the clipboard holds the sentinel before the copy", clipText() == SENTINEL, "clip '${clipText()}'")
        // Setting the clip raises the system's clipboard overlay (and its text classifier), which
        // starves the emulator's UI thread for seconds: the hold waits for it to pass.
        settle("the clipboard sentinel's overlay")
        val rows = holdTile(id, TILE, tile.title)
        check("the menu is up again with the same rows", rows == TOUCH_ROWS, "rows $rows")
        val copied = touchUntil("Copy Link", { menuRow("Copy Link") }, { clipText() == tile.url }, waitMs = 6_000)
        check("a touch on Copy Link puts the tile's URL on the system clipboard", copied, "clip '${clipText()}', tile ${tile.url}")
        check("the menu closed on the pick, the page still in front", awaitJs(MENU_OPEN, false, 4_000) && activeTabId() == id, "menu ${jsText(MENU_OPEN)}")
        SystemClock.sleep(1_500)
        still("copied")
    }

    // --- 4. dark, and Remove ----------------------------------------------------------------------------

    private fun darkAndRemove() {
        section("4. The dark scheme in place: the page and the menu in dark; Remove under a finger")
        val id = pageTab ?: return
        check("the dark scheme through the core re-inks the chrome and the served page without a relaunch", setScheme("dark", id) && activeTabId() == id, "chrome '${jsText("document.documentElement.dataset.theme")}', page '${pageTheme(id)}'")
        SystemClock.sleep(1_200)
        still("tiles-dark")
        val tile = tileAt(id, TILE) ?: run {
            check("the tile to hold is on the page", false, "tiles ${tileCaptions(id)}")
            setScheme("light", id)
            return
        }
        val count = tileCount(id)
        val rows = holdTile(id, TILE, tile.title)
        check("the hold raises the menu in dark with the same rows", rows == TOUCH_ROWS, "rows $rows")
        SystemClock.sleep(1_200)
        still("tile-menu-dark")
        // The grid may fill the gap with the next site (the count holds); the claim is the caption gone.
        val removed = touchUntil("Remove", { menuRow("Remove") }, { !tileCaptions(id).contains(tile.title) }, waitMs = 8_000)
        check("a touch on Remove takes '${tile.title}' off the page (the core's command down the bridge)", removed, "tiles ${tileCaptions(id)} (were $count)")
        SystemClock.sleep(1_200)
        still("removed-dark")
        check("the light scheme back", setScheme("light", id), "chrome '${jsText("document.documentElement.dataset.theme")}'")
    }

    // --- the hold ----------------------------------------------------------------------------------

    /**
     * A real hold on the middle of the tile at `index` (its box read off the served page's DOM,
     * scaled by the page's device pixel ratio, from the page view's own origin) and the menu's
     * rows once it is up; empty when no menu came. The tile's box on the screen is kept
     * ([lastTileBox]) for the anchor's claim: under the menu the page view is hidden (the cover,
     * `overlayCoversContent`), so the box cannot be read once the menu is up. A menu that answers
     * late – past the first attempt's wait, on an emulator whose UI thread is starved (the system's
     * clipboard overlay, a splash) – is still the hold's menu and is read at the next attempt.
     */
    private fun holdTile(tabId: String, index: Int, caption: String): List<String> {
        for (attempt in 1..3) {
            if (attempt > 1 && jsBoolean(MENU_OPEN) && awaitDom(MENU_ITEM, 6_000)) {
                finding("  (the menu came late, past the wait; read at attempt $attempt)")
                SystemClock.sleep(600)
                return textsOf(MENU_ITEM)
            }
            // The live view comes back a beat after a menu or the bar goes (the chrome's layout
            // report, then the host's placement): the tile is waited for on the screen.
            if (!awaitUntil(6_000) { tileOnScreen(tabId, index) != null }) {
                finding("  (the tile '$caption' is not on the screen to hold: page shown ${pageShown(tabId)}, urlbar ${urlbarOpen()}, menu ${jsText(MENU_OPEN)})")
                return emptyList()
            }
            val point = tileOnScreen(tabId, index) ?: return emptyList()
            lastHold = point
            lastTileBox = tileBoxOnScreen(tabId, index)
            finding("  hold at ${point.x.toInt()},${point.y.toInt()} on the tile '$caption' (its box ${lastTileBox?.toShortString()})")
            Finger().apply {
                press(point.x, point.y)
                up()
            }
            if (awaitJs(MENU_OPEN, true, 8_000) && awaitDom(MENU_ITEM, 6_000)) {
                SystemClock.sleep(600)
                return textsOf(MENU_ITEM)
            }
            finding("  (the hold did not bring the menu within the wait, attempt $attempt)")
            if (inDom(MENU)) back()
            SystemClock.sleep(800)
        }
        return emptyList()
    }

    /**
     * Waits for the app's UI thread to answer promptly again – three `onMain` round trips in a row
     * under 50 ms – for up to `timeoutMs`; how long it took is a finding. The emulator's UI thread
     * starves for seconds after `what` (the system's clipboard overlay and its text classifier
     * loading on a two-core emulator), and a hold pressed into that stall is answered late.
     */
    private fun settle(what: String, timeoutMs: Long = 12_000) {
        val start = SystemClock.uptimeMillis()
        var prompt = 0
        while (SystemClock.uptimeMillis() - start < timeoutMs && prompt < 3) {
            val t0 = SystemClock.uptimeMillis()
            onMain { }
            prompt = if (SystemClock.uptimeMillis() - t0 < 50) prompt + 1 else 0
            SystemClock.sleep(150)
        }
        finding("  (the UI thread settled after $what in ${SystemClock.uptimeMillis() - start} ms${if (prompt < 3) " – still stalling at the wait's end" else ""})")
    }

    private fun menuRow(prefix: String) = textRect(MENU_ITEM, prefix)

    // --- the bare come-up, the hand-off, the icons, the numbers, the anchor --------------------------

    /**
     * The bare come-up: `what` (the fresh tab at boot, the new tab from the row) arrives with the
     * served page IN VIEW – the view placed and shown, no URL bar in new-tab mode over a cover –
     * its own field AT REST (not focused) and NO KEYBOARD rising unasked. The arrival's
     * `newtab.opened` carries no `text`, and the renderer's `newTabRevealOpensUrlbar` opens no bar
     * for it on a touch layout (the desktop's reveal – the bar – unchanged). Watched for two
     * seconds past the view's placement, the window in which the desktop's rule brought the bar.
     */
    private fun bareComeUp(tabId: String, what: String) {
        val shown = awaitUntil(8_000) { pageShown(tabId) && !urlbarOpen() }
        var barCame = false
        var covered = false
        val until = SystemClock.uptimeMillis() + 2_000
        while (SystemClock.uptimeMillis() < until) {
            if (urlbarOpen()) barCame = true
            if (!pageShown(tabId)) covered = true
            SystemClock.sleep(150)
        }
        val rest = pageJson(
            tabId,
            "(function(){var i=document.getElementById('zen-search-input');return [document.activeElement===i,document.hasFocus(),i?i.inputMode:'?',window.matchMedia('(pointer: coarse)').matches]})()"
        )
        finding(
            "  $what's come-up: view shown ${pageShown(tabId)}, urlbar.open ${urlbarOpen()} (a bar within 2 s: $barCame; the view covered: $covered), " +
                "the field focused ${rest?.opt(0)} (document focused ${rest?.opt(1)}, inputmode '${rest?.opt(2)}', pointer coarse ${rest?.opt(3)}), keyboard inset ${imeInset()}"
        )
        check(
            "$what comes up BARE: the served page in view – placed and shown, no URL bar in new-tab mode over a cover, none within two seconds (the arrival's newtab.opened opens no bar on the tablet)",
            shown && !barCame && !covered && pageShown(tabId) && !urlbarOpen(),
            "shown ${pageShown(tabId)}, urlbar.open ${urlbarOpen()}, a bar came $barCame, covered $covered"
        )
        check(
            "the page's own field is at rest on arrival – not focused, inputmode none under the coarse pointer – and no keyboard rose unasked",
            rest != null && !rest.optBoolean(0) && rest.optString(2) == "none" && !imeShown(),
            "focused ${rest?.opt(0)}, inputmode '${rest?.opt(2)}', keyboard inset ${imeInset()}"
        )
    }

    /**
     * The served page's field is a hand-off control on the tablet: a REAL TAP on it sends the
     * page's `search` action (`text` '') and the chrome opens the pill's omnibox popup in new-tab
     * mode bound to the tab (`openNewTabPageUrlbar` – on the user's tap now, not on the arrival).
     * On this chassis the pages composite above the chrome, so the popup stands over the tab's
     * cover picture and the live view is hidden under it (`overlayCoversContent`); the chrome's
     * field takes the keyboard. Then a back puts the popup away and the view comes back
     * ([dismissBar]). `frame` names the still of the popup over the cover, when one is wanted.
     */
    private fun handOff(tabId: String, what: String, frame: String?) {
        val point = pagePointOnScreen(tabId, "document.getElementById('zen-search')") ?: run {
            check("$what is on the screen to tap", false, "page shown ${pageShown(tabId)}")
            return
        }
        finding("  tap at ${point.x.toInt()},${point.y.toInt()} on $what")
        Finger().tap(point.x, point.y)
        val opened = awaitUntil(8_000) { urlbarOpen() }
        check(
            "a tap on $what hands off to the pill's omnibox popup: the URL bar opens in new-tab mode bound to the tab (the page's search action → openNewTabPageUrlbar)",
            opened && urlbarMode() == "new-tab" && urlbarTab() == tabId,
            "urlbar.open ${urlbarOpen()}, mode '${urlbarMode()}', tab ${urlbarTab()} (the page's $tabId)"
        )
        check("the popup stands over the tab's cover picture on this chassis, the live view hidden under it (overlayCoversContent)", awaitUntil(4_000) { !pageShown(tabId) }, "shown ${pageShown(tabId)}")
        finding("  the keyboard after the hand-off: ${if (awaitIme(true, 4_000)) "up (the chrome's field took it), inset ${imeInset()}" else "not up within 4 s (inset ${imeInset()})"}")
        if (frame != null) {
            SystemClock.sleep(1_000)
            still(frame)
        }
        dismissBar(tabId, "the omnibox popup")
    }

    /**
     * The tiles' icons are real: every tile's `<img class="zen-ntp-icon">` – its `src` the core's
     * `zen://favicon/<hash>`, answered on the served view alone by `TabWebView.newTabFavicon` from
     * the chrome's favicon store – decoded (`complete`, a `naturalWidth`), and no tile fallen back
     * to its letter (`.zen-ntp-letter`, what an errored `<img>` is replaced with). Every loopback
     * site serves a 64 px PNG at `/icon.png`, so every tile has one to show.
     */
    private fun icons(tabId: String) {
        val loaded = awaitUntil(15_000) { iconRead(tabId)?.let { it.optInt(0) > 0 && it.optInt(1) == it.optInt(0) && it.optInt(2) == 0 } == true }
        val read = iconRead(tabId)
        finding("  the tiles' icons: ${read?.opt(1)} of ${read?.opt(0)} <img> decoded (naturalWidth > 0), ${read?.opt(2)} letter fallbacks; sources ${read?.optJSONArray(3)}; naturalWidths ${read?.optJSONArray(4)}")
        check(
            "every tile's icon is the real one – the <img> loaded from zen://favicon/<hash> through the served view's intercept (complete, naturalWidth > 0) – and no tile fell back to its letter",
            loaded,
            "tiles ${read?.opt(0)}, decoded ${read?.opt(1)}, letters ${read?.opt(2)}, widths ${read?.optJSONArray(4)}"
        )
        check("the icons' sources are the core's zen://favicon/<hash> (the desktop's protocol, answered on this view)", read != null && read.optInt(0) > 0 && read.optBoolean(5), "sources ${read?.optJSONArray(3)}")
    }

    /** `[tiles, decoded, letters, sources (the scheme and path head), naturalWidths, every source zen://favicon/]` off the page. */
    private fun iconRead(tabId: String): JSONArray? = pageJson(
        tabId,
        "(function(){var t=document.querySelectorAll('.zen-tile:not(.zen-tile-add)');var n=t.length,ok=0,letters=0,src=[],w=[],all=n>0;" +
            "for(var i=0;i<n;i++){var img=t[i].querySelector('img.zen-ntp-icon');if(t[i].querySelector('.zen-ntp-letter'))letters++;" +
            "if(img){src.push(img.src.slice(0,14));w.push(img.naturalWidth);if(img.complete&&img.naturalWidth>0)ok++;if(img.src.indexOf('zen://favicon/')!==0)all=false}" +
            "else{src.push('');w.push(-1);all=false}}return [n,ok,letters,src,w,all]})()"
    )

    /**
     * The served page under a coarse pointer takes the touch layouts' numbers: the field 56, the
     * Customise button 40, a tile 64 – read as the page's own CSS px (`getBoundingClientRect`;
     * the boxes are `border-box`), the `(pointer: coarse)` query true on the tablet.
     */
    private fun coarseNumbers(tabId: String) {
        val a = pageJson(
            tabId,
            "(function(){var f=document.getElementById('zen-search'),c=document.getElementById('zen-customize'),t=document.querySelector('.zen-tile:not(.zen-tile-add) .zen-ntp-tile');" +
                "var h=function(e){return e?Math.round(e.getBoundingClientRect().height*100)/100:-1},w=function(e){return e?Math.round(e.getBoundingClientRect().width*100)/100:-1};" +
                "var tops={};Array.prototype.forEach.call(document.querySelectorAll('.zen-tile'),function(e){tops[Math.round(e.getBoundingClientRect().top)]=1});" +
                "return [window.matchMedia('(pointer: coarse)').matches,h(f),h(c),w(t),h(t),window.devicePixelRatio,Object.keys(tops).length,document.querySelectorAll('.zen-tile').length]})()"
        )
        finding("  the page's measures (CSS px, ratio ${a?.opt(5)}): (pointer: coarse) ${a?.opt(0)}, the field ${a?.opt(1)}, Customise ${a?.opt(2)}, a tile ${a?.opt(3)} x ${a?.opt(4)}; ${a?.opt(7)} tiles (the add tile counted) in ${a?.opt(6)} rows")
        check(
            "the tablet's page is under a coarse pointer and takes its numbers: the field 56, Customise 40, a tile 64 x 64",
            a != null && a.optBoolean(0) && a.optDouble(1) == 56.0 && a.optDouble(2) == 40.0 && a.optDouble(3) == 64.0 && a.optDouble(4) == 64.0,
            "coarse ${a?.opt(0)}, field ${a?.opt(1)}, Customise ${a?.opt(2)}, tile ${a?.opt(3)} x ${a?.opt(4)}"
        )
    }

    /**
     * The hold menu hangs from the TILE's BOX, not from the finger: the `tile-menu` action carries
     * the tile's rect (`.zen-tile`: the square and its caption) up the bridge, the core puts it on
     * the anchor's `rect` on a touch layout and the tablet's `placeRootMenu` sets the popover
     * flush under it, start-aligned, above it when the room below runs out (§9.20). Read as
     * screen px on both sides: the tile's box off the page at the hold (its CSS px by the page's
     * ratio, from the view's origin – read then because under the menu the page view is hidden,
     * the cover in its place), the menu's off the chrome ([screen]) once it holds still. `hold` is
     * where the finger was: the tile's middle, which no edge of the menu may sit at.
     */
    private fun menuHangsFromTile(tile: RectF?, hold: PointF?) {
        val menu = steady { screen(domRect(MENU))?.let { RectF(it) } }
        if (tile == null || menu == null) {
            check("the tile's box (read at the hold) and the menu (on the screen) are both there to compare", false, "tile $tile, menu $menu")
            return
        }
        val startAligned = abs(menu.left - tile.left) <= SLACK
        val below = abs(menu.top - tile.bottom) <= SLACK
        val above = abs(menu.bottom - tile.top) <= SLACK
        finding(
            "  the tile's box on the screen ${tile.toShortString()}, the menu's ${menu.toShortString()} (${menu.width().toInt()} wide), the finger at ${hold?.x?.toInt()},${hold?.y?.toInt()}: " +
                "start edges ${menu.left} / ${tile.left}, the menu's top ${menu.top} at the box's bottom ${tile.bottom}${if (above) " (flipped above: its bottom ${menu.bottom} at the box's top ${tile.top})" else ""}"
        )
        check(
            "the menu hangs from the tile's box: its start edge level with the tile's (start-aligned) and its top flush at the box's bottom – or its bottom at the box's top when the room below ran out",
            startAligned && (below || above),
            "start ${menu.left} vs ${tile.left}; top ${menu.top} vs the box's bottom ${tile.bottom}; bottom ${menu.bottom} vs the box's top ${tile.top}"
        )
        check(
            "the menu is not at the finger's point: no edge of it sits at the hold (the tile's middle)",
            hold != null && abs(menu.left - hold.x) > SLACK && abs(menu.right - hold.x) > SLACK && abs(menu.top - hold.y) > SLACK && abs(menu.bottom - hold.y) > SLACK,
            "menu ${menu.toShortString()}, finger ${hold?.x},${hold?.y}"
        )
        check(
            "the menu carries the page as its source and the box as its anchor (`data-source=\"page\"`, `data-anchor=\"box\"`: the tile's menu, hung from the rect the page sent)",
            inDom("$MENU[data-source=\"page\"][data-anchor=\"box\"]"),
            "source / anchor: ${jsText("(function(){var m=document.querySelector('$MENU');return m?m.getAttribute('data-source')+' / '+m.getAttribute('data-anchor'):'no menu'})()")}"
        )
    }

    /** A box read twice 300 ms apart that agrees (a popover popping in moves on each frame); the last read when three seconds pass without one. */
    private fun steady(read: () -> RectF?): RectF? {
        var last = read()
        val deadline = SystemClock.uptimeMillis() + 3_000
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(300)
            val next = read()
            if (last != null && next != null && abs(next.left - last.left) < 0.5f && abs(next.top - last.top) < 0.5f && abs(next.right - last.right) < 0.5f && abs(next.bottom - last.bottom) < 0.5f) return next
            last = next
        }
        return last
    }

    private fun urlbarMode(): String = jsText("((((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).urlbar||{}).mode||''")

    private fun urlbarTab(): String = jsText("((((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).urlbar||{}).tabId||''")

    // --- the served page's DOM -------------------------------------------------------------------

    private class TileRead(val title: String, val url: String)

    /** The JSON value `code` evaluates to in the tab's own page, as an array; null when it never answered. */
    private fun pageJson(tabId: String, code: String): JSONArray? {
        val raw = pageJs(tabId, "JSON.stringify($code)")
        val text = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: return null
        return runCatching { JSONArray(text) }.getOrNull()
    }

    private fun tileCount(tabId: String): Int = pageJson(tabId, "[document.querySelectorAll('$TILE_SELECTOR').length]")?.optInt(0) ?: -1

    private fun tileCaptions(tabId: String): List<String> =
        pageJson(tabId, "Array.prototype.map.call(document.querySelectorAll('$TILE_SELECTOR .zen-ntp-caption'),function(e){return e.textContent.trim()})")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()

    private fun tileAt(tabId: String, index: Int): TileRead? {
        val a = pageJson(tabId, "(function(){var t=document.querySelectorAll('$TILE_SELECTOR')[$index];if(!t)return null;var c=t.querySelector('.zen-ntp-caption');return [c?c.textContent.trim():'',t.href]})()") ?: return null
        if (a.length() < 2) return null
        return TileRead(a.getString(0), a.getString(1))
    }

    /**
     * The served document complete in the tab's view, by its own word (`document.readyState`,
     * `location.href`): WebView may report a `loadDataWithBaseURL` document's URL as its `data:`
     * header, so the view's `url` is not read for it.
     */
    private fun awaitServedPage(tabId: String, timeoutMs: Long = 15_000): Boolean = awaitUntil(timeoutMs) {
        val a = pageJson(tabId, "[document.readyState,location.href]")
        a != null && a.optString(0) == "complete" && a.optString(1).removeSuffix("/") == NEW_TAB_URL
    }

    private fun pageTheme(tabId: String): String = pageJson(tabId, "[document.documentElement.dataset.theme||'']")?.optString(0).orEmpty()

    /** Where the tile at `index` is on the screen: the middle of its link's box in the page's CSS px scaled by the page's ratio, from the view's origin. */
    private fun tileOnScreen(tabId: String, index: Int): PointF? = pagePointOnScreen(tabId, "document.querySelectorAll('$TILE_SELECTOR')[$index]")

    /** Where the middle of the element the JS expression `element` names is on the screen; null when there is none or the view is not shown. */
    private fun pagePointOnScreen(tabId: String, element: String): PointF? {
        val a = pageJson(
            tabId,
            "(function(){var t=$element;if(!t)return null;var r=t.getBoundingClientRect();" +
                "var d=window.devicePixelRatio;return [(r.left+r.width/2)*d,(r.top+r.height/2)*d]})()"
        ) ?: return null
        if (a.length() < 2) return null
        val origin = viewOrigin(tabId) ?: return null
        return PointF(origin[0] + a.getDouble(0).toFloat(), origin[1] + a.getDouble(1).toFloat())
    }

    /** The box of the tile at `index` – `.zen-tile`, the square and its caption: the rect the page sends with `tile-menu` – on the screen. */
    private fun tileBoxOnScreen(tabId: String, index: Int): RectF? {
        val a = pageJson(
            tabId,
            "(function(){var t=document.querySelectorAll('$TILE_SELECTOR')[$index];var b=t&&t.closest('.zen-tile');if(!b)return null;var r=b.getBoundingClientRect();" +
                "var d=window.devicePixelRatio;return [r.left*d,r.top*d,r.right*d,r.bottom*d]})()"
        ) ?: return null
        if (a.length() < 4) return null
        val origin = viewOrigin(tabId) ?: return null
        return RectF(origin[0] + a.getDouble(0).toFloat(), origin[1] + a.getDouble(1).toFloat(), origin[0] + a.getDouble(2).toFloat(), origin[1] + a.getDouble(3).toFloat())
    }

    /** The page view's origin on the screen; null while the view is not placed and shown (a hidden view is not there to touch). */
    private fun viewOrigin(tabId: String): IntArray? = onMain {
        val view = host.tabs.get(tabId)
        if (view == null || !view.isShown) null else IntArray(2).also(view::getLocationOnScreen)
    }

    /**
     * The tile with `caption` in the accessibility tree: a node named by the caption (the link's
     * text – Chromium names the link node itself or its text child, so the click is read off the
     * node or one above it, not asked of the named one) whose centre lies inside the page view's
     * box on the screen (the sidebar names a tab after its page, so the box is what tells a tile
     * from a tab row). Null while the view is hidden: a hidden view has no nodes.
     */
    private fun tileNode(tabId: String, caption: String): AccessibilityNodeInfo? {
        val box = pageBox(tabId) ?: return null
        val bounds = Rect()
        return findNodeWhere { node ->
            val named = node.text?.toString()?.trim() == caption || node.contentDescription?.toString()?.trim() == caption
            named && run {
                node.getBoundsInScreen(bounds)
                box.contains(bounds.centerX(), bounds.centerY())
            }
        }
    }

    private fun tileInTree(tabId: String, caption: String): Boolean = tileNode(tabId, caption) != null

    /** The named node for the finding: its class, its name, and where the click is (itself, a node above it, or nowhere within four). */
    private fun describeTileNode(tabId: String, caption: String): String {
        val node = tileNode(tabId, caption) ?: return "no node named '$caption' inside the page view (shown ${pageShown(tabId)})"
        var clickable = if (node.isClickable) "itself" else "no"
        var up = node.parent
        var hops = 0
        while (clickable == "no" && up != null && hops < 4) {
            hops++
            if (up.isClickable) clickable = "$hops up"
            up = up.parent
        }
        val bounds = Rect().also { node.getBoundsInScreen(it) }
        return "${node.className} '${node.text ?: node.contentDescription}' at $bounds, clickable $clickable"
    }

    /** The page view's box on the screen; null while it is not shown. */
    private fun pageBox(tabId: String): Rect? = onMain {
        val view = host.tabs.get(tabId)
        if (view == null || !view.isShown) {
            null
        } else {
            val origin = IntArray(2)
            view.getLocationOnScreen(origin)
            Rect(origin[0], origin[1], origin[0] + view.width, origin[1] + view.height)
        }
    }

    // --- the chrome and the core ---------------------------------------------------------------------

    /**
     * Whether the tab's page view is placed and shown (VISIBLE up its tree): the host hides every
     * page view while a chrome surface covers the content (`overlayCoversContent` – the URL bar
     * in new-tab mode, a menu), and shows the tab's cover picture in its place.
     */
    private fun pageShown(tabId: String): Boolean = onMain { host.tabs.get(tabId)?.isShown == true }

    /**
     * The omnibox popup away with a back ([closeUrlField]: the keyboard first when it is up, never
     * a second back blind, the page read before and after) and the tab's live view back on the
     * screen once the popup's cover is gone – the claim each hand-off ends on, before the scene
     * reads the page's tree or holds a tile.
     */
    private fun dismissBar(tabId: String, what: String) {
        val close = closeUrlField()
        val shown = close.ok && awaitUntil(8_000) { pageShown(tabId) }
        check("a back dismisses $what and the live page view comes back, placed and shown", shown, "${close.describe()}; shown ${pageShown(tabId)}")
        awaitIme(false)
        SystemClock.sleep(600)
    }

    /**
     * The colour scheme through the core's setting, as Settings would set it; true once the
     * chrome's root and the served page both carry it (the page's own `data-theme`, set from the
     * state pushed down the bridge).
     */
    private fun setScheme(scheme: String, tabId: String): Boolean {
        coreInvoke("settings.update", JSONObject().put("colorScheme", scheme).toString())
        val chrome = awaitJs("document.documentElement.dataset.theme==='$scheme'", true, 8_000)
        val page = awaitUntil(8_000) { pageTheme(tabId) == scheme }
        if (!chrome || !page) finding("  (scheme '$scheme': chrome ${jsText("document.documentElement.dataset.theme")}, page '${pageTheme(tabId)}')")
        return chrome && page
    }

    private fun pillText(): String = jsString("(function(){var p=document.querySelector('$ADDRESS_PILL');return p?p.textContent.trim():''})()")

    private fun privateInk(): Boolean = jsBoolean("(function(){var r=document.querySelector('$CHROME_ROOT');return !!r&&r.hasAttribute('data-private')})()")

    private fun privateActive(): Boolean = activeCoreTab()?.optString("containerId") == Profiles.PRIVATE_CONTAINER

    private fun privateTabIds(state: JSONObject = coreState()): List<String> {
        val tabs = state.optJSONObject("tabs") ?: return emptyList()
        return tabs.keys().asSequence().filter { tabs.optJSONObject(it)?.optString("containerId") == Profiles.PRIVATE_CONTAINER }.toList()
    }

    private fun clipboard(): ClipboardManager = app.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

    private fun clipText(): String? = onMain {
        clipboard().primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(app)?.toString()
    }

    private fun summarise(topSites: String): String = runCatching {
        val list = JSONArray(topSites)
        (0 until list.length()).joinToString(", ") { i ->
            val s = list.getJSONObject(i)
            "${s.optString("title")} (${"%.2f".format(s.optDouble("score"))}${if (s.isNull("favicon")) ", no icon" else ""})"
        }
    }.getOrElse { topSites.take(200) }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    // --- the sites ---------------------------------------------------------------------------------

    private fun siteHtml(site: Site): String {
        val hex = String.format("#%06X", site.color and 0xFFFFFF)
        return "<!doctype html><html><head><meta charset=utf-8>" +
            "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>${site.title}</title>" +
            "<link rel=icon type=image/png href=/icon.png>" +
            "<style>body{margin:0;font-family:sans-serif;color:#15141a;background:#fff}" +
            "header{background:$hex;color:#fff;padding:56px 24px 40px}h1{margin:0;font-size:32px}" +
            "p{padding:24px;font-size:19px;line-height:1.5;color:#3c3c43}</style></head>" +
            "<body><header><h1>${site.title}</h1></header>" +
            "<p>One of the eight sites the demo visits so the tablet's new tab page has most visited tiles to show.</p>" +
            "</body></html>"
    }

    /** A 64 px icon: the site's colour with its initial in white. */
    private fun iconPng(site: Site): ByteArray {
        val size = 64
        val bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        paint.color = site.color
        canvas.drawRoundRect(0f, 0f, size.toFloat(), size.toFloat(), 14f, 14f, paint)
        paint.color = Color.WHITE
        paint.textSize = 40f
        paint.textAlign = Paint.Align.CENTER
        paint.isFakeBoldText = true
        val baseline = size / 2f - (paint.descent() + paint.ascent()) / 2f
        canvas.drawText(site.title.substring(0, 1), size / 2f, baseline, paint)
        return ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
    }

    private companion object {
        /** Beside the base's server (127.0.0.1:18168): the eight sites, one loopback host each. */
        private const val SITE_PORT = 18173
        private const val NEW_TAB_URL = "zen://newtab"
        private const val SENTINEL = "nothing copied yet"
        /** The tile the holds land on: the third, as the phone's demo holds its third. */
        private const val TILE = 2
        private const val TILE_SELECTOR = ".zen-tile:not(.zen-tile-add) a.zen-v2-shortcut"
        /** The landing watch's frames are told apart and classified at this fraction of the display's size (1280x800 → 320x200). */
        private const val LANDING_SCALE = 4
        /** A pause between captures: the capture itself is the cadence's bulk (some 100–300 ms on the emulator). */
        private const val LANDING_CADENCE_MS = 30L
        private const val LANDING_RETRY_MS = 200L
        /** The fresh boot's window after its FULLY DRAWN frame: the hold's 5 s fail-safe, the page's 5 s cap and the fade inside it. */
        private const val LANDING_AFTER_FRAME_MS = 9_000L
        /** A fresh boot whose FULLY DRAWN frame never comes. */
        private const val LANDING_NO_FRAME_MS = 25_000L
        /** A relaunch's window from `onCreate` (a warm process boots in a fraction of the fresh boot's time). */
        private const val LANDING_RELAUNCH_MS = 12_000L
        /** How long the read waits for the watch once the launch has settled. */
        private const val LANDING_WAIT_MS = 30_000L
        /**
         * Full captures held at once (4 MB each at 1280x800): the ring of the MOST RECENT changed
         * frames' – the landing's own frames are a handful and come last, so they always have theirs.
         * (A first-come cap of the same size lost sample 1′'s dark first paint: its relaunch changed
         * 14 frames and the first paint was the 13th.)
         */
        private const val LANDING_FULL_CAP = 12
        /** Two pixels differ when their channel differences sum past this. */
        private const val LANDING_PIXEL_TOLERANCE = 24
        /** A frame is kept when this fraction of its (small) pixels differ from the last kept: an icon's swap is over it, a clock's digit under. */
        private const val LANDING_KEEP_FRACTION = 0.0005
        /** A pixel is of a tone when each channel is within this of it. */
        private const val LANDING_TONE = 10
        /** A slot is in one tone when this fraction of its pixels are of its most common tone. */
        private const val LANDING_UNIFORM = 0.995
        /** A slot is the settled picture when no more than this fraction of its pixels differ from it (a fresh page is sparse: its field's words and its sentence are a percent or two of the slot). */
        private const val LANDING_NEAR_FINAL_FRACTION = 0.002
        /** A change after the first paint: more than this fraction of the slot differing from the settled picture (one tile's icon swapped for a letter is over it). */
        private const val LANDING_LATE_FRACTION = 0.0005
        /** A frame is the fade in flight when this fraction of its slot lies between the ground's tone and the settled picture. */
        private const val LANDING_BLEND = 0.98
        /** The opacity is read off pixels the page changes at least this much (a channel sum). */
        private const val LANDING_BLEND_SPAN = 40
        /** The touch template's rows (`Menus.showNewTabTileMenu`: Open in Private Tab on `privateTabs && !windows`, Copy Link on `!windows`), the separator between them not a row. */
        private val TOUCH_ROWS = listOf("Open in New Tab", "Open in Private Tab", "Copy Link", "Remove")
        /** How far (screen px) a menu's edge may sit from the tile box's it is read against: a rounding each side. */
        private const val SLACK = 3f

        private const val CHROME_ROOT = "[data-testid=\"chrome-root\"]"
        private const val SIDEBAR = ".zen-tablet-sidebar"
        private const val ADDRESS_PILL = ".zen-tablet-toolbar [data-address-pill]"
        private const val MENU_BUTTON = ".zen-tablet-toolbar [data-zen-nav-row] > button[aria-haspopup=\"menu\"]"
        private const val NEW_TAB_ROW = "$SIDEBAR [data-new-tab]"
        private const val MENU = ".zen-v2-menu"
        private const val MENU_ITEM = ".zen-v2-menu-item"
        private const val MENU_SEPARATOR = ".zen-v2-menu-separator"
        /** A row of the phone's menu sheet (`MenuSheet`), which the tablet never draws (§9.36). */
        private const val SHEET = ".zen-sheet-item"
    }
}
