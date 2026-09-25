package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.Build
import android.os.Process
import android.os.SystemClock
import android.util.Log
import androidx.lifecycle.Lifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.PI
import kotlin.math.sin

/**
 * Wave 6's memory-pressure row (W6-6, OS-37) under the platform's own signals, for the
 * `android-memory-pressure-demo` workflow to record. Thirty fixture pages are opened in the
 * background, each holding a few megabytes; `am send-trim-memory` delivers the trims the
 * platform grades ([MemoryPressure]); every claim is read off the core's state, the host
 * ([MemoryPressureMonitor.trims], [RestoredPictures.isShowing], the WebViews' renderer
 * priorities) and `dumpsys meminfo`, never off a still, and the run FAILS when one does not hold.
 *
 * The scenes, in order:
 *  1. the tabs: a page scrolled and left (the tab the return comes back to, the oldest), thirty
 *     background pages, a page playing audio, the front page in front;
 *  2. RUNNING_MODERATE right away: every page was shown within the minute, nothing sleeps – the
 *     recency guard;
 *  3. the memory table's first row: the app's and the renderer's PSS / RSS with everything
 *     loaded (`dumpsys meminfo`), the system's `MemoryInfo` beside it;
 *  4. the minute out, RUNNING_LOW: half of what may sleep, the pages shown longest ago first
 *     (the scrolled page and the first fifteen), the front page and the audible page untouched;
 *     then RUNNING_CRITICAL: the rest; the table's rows after each;
 *  5. the overview: thirty-one sleeping cards;
 *  6. the return: the scrolled page shown again gets its last picture until its first commit,
 *     then reloads at its scroll – the sequence read off the host thirty times a second, the
 *     still `frames-return-<theme>` taken while the picture stands;
 *  7. the renderer's weight: the shown page IMPORTANT, a hidden one WAIVED when not visible, the
 *     chrome IMPORTANT and unwaived while the audio plays, waived once it stops;
 *  8. Home: twelve sleeping pages reloaded hidden first; the poll stops with the window; what
 *     the platform delivers by itself on this API is recorded; then BACKGROUND, graded with the
 *     `MemoryInfo` reading beside it, sleeps its share in one pass; the process list read for
 *     the two processes' standing; back to the app, the poll running again.
 *
 * Two acts, light and dark, chosen by the `theme` argument. The recording, the stills
 * (`android-memory-pressure-*.png`) and the findings file (the memory table) are the evidence.
 */
@RunWith(AndroidJUnit4::class)
class MemoryPressureDemo : DemoHarness("memory-pressure-demo-state.json", "android-memory-pressure", "memory-pressure-demo") {
    override val tag = "MemoryPressureDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private val table = ArrayList<MemoryRow>()

    private val mainActivity: MainActivity get() = activity as MainActivity
    private val host: Host get() = mainActivity.host

    @Test
    fun record() {
        server = DemoServer(PORT, routes(), delays = mapOf("/scroll" to SCROLL_DELAY_MS)).also { it.start() }
        try {
            runDemo()
        } finally {
            if (THEME == "dark") shell("cmd uimode night no")
            server.close()
        }
        if (failures.isNotEmpty()) error("the memory-pressure row did not hold up: ${failures.joinToString("; ")}")
    }

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    /** The system's colour scheme before the app starts, so the app is born in it. */
    override fun beforeLaunch() {
        shell("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        SystemClock.sleep(1_500)
    }

    override fun warmUp() {
        findings = File(out, "android-memory-pressure-findings.txt")
        findings.writeText(
            "Zenium Android memory pressure check (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, $THEME)\n" +
                "site: ${server.selfCheck()}\n" +
                "webview: ${runCatching { android.webkit.WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } }.getOrNull() ?: "unknown"}\n\n"
        )
        claim(awaitPage(TAB_FRONT, "/front", 25_000), "warm-up: the seeded front page is up")
        finding("warm-up: ${memoryInfo()}; poll running=${onMain { host.memoryPressure.running }}")
        SystemClock.sleep(1_500)
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        val leftScrollAt = openTabs()
        recencyScene()
        row("all loaded")
        openOverview()
        shot("01-overview-loaded")
        leaveOverview()
        foregroundTrims(leftScrollAt)
        overviewScene()
        returnScene()
        priorityScene()
        backgroundScene()
        finding("trims this boot heard: ${trimsRecord()}")
        finding("done: ${failures.size} claim(s) failed")
        writeTable()
    }

    // --- 1: the tabs --------------------------------------------------------------------------------

    /** Opens the pages; the uptime at which the scrolled page was left (the oldest `lastActiveAt`). */
    private fun openTabs(): Long {
        // The scrolled page first: shown, scrolled, left – the tab the return comes back to,
        // and the one shown longest ago once the thirty follow it.
        coreInvoke("tab.create", """{"url":"${server.origin}/scroll","active":true,"id":"$TAB_SCROLL"}""")
        claim(awaitPage(TAB_SCROLL, "/scroll", 25_000), "the scrolled page is up")
        val scrolled = pageJs(TAB_SCROLL, "(function(){window.scrollTo(0,$SCROLL_Y);return String(Math.round(window.scrollY))})()")
        claim(scrolled.toIntOrNull()?.let { it >= SCROLL_Y - 2 } == true, "the page is scrolled to $SCROLL_Y (reads $scrolled)")
        // The engine writes the scroll into the history entry a moment after the scroll; the
        // saved list the discard keeps is read from it.
        SystemClock.sleep(2_000)
        coreInvoke("tab.activate", """{"tabId":"$TAB_FRONT"}""")
        val leftAt = SystemClock.uptimeMillis()
        claim(awaitTrue(8_000) { onMain { host.tabs.get(TAB_SCROLL)?.isShown == false } }, "the scrolled page left the screen")

        // Thirty pages in the background, each with its ballast.
        val started = SystemClock.uptimeMillis()
        for (i in 1..TABS) {
            coreInvoke("tab.create", """{"url":"${server.origin}/page/$i","active":false,"id":"${tabId(i)}"}""")
        }
        val loaded = awaitTrue(90_000) { loadedPages() >= TABS }
        finding("thirty pages created in ${SystemClock.uptimeMillis() - started} ms; ${loadedPages()} of them loaded after ${SystemClock.uptimeMillis() - started} ms")
        claim(loaded, "the thirty background pages loaded (${loadedPages()} loaded, ${onMain { host.tabs.all().size }} views)")

        // The audible page: shown, a finger on it starts the tone, the core hears it play.
        coreInvoke("tab.create", """{"url":"${server.origin}/audio","active":true,"id":"$TAB_AUDIO"}""")
        claim(awaitPage(TAB_AUDIO, "/audio", 25_000), "the audio page is up")
        SystemClock.sleep(800)
        Finger().tap(width / 2f, height / 2f)
        val audible = awaitTrue(12_000) { coreTab(TAB_AUDIO)?.optBoolean("audible") == true }
        claim(audible, "the core hears the audio page play (audible=${coreTab(TAB_AUDIO)?.optBoolean("audible")})")
        coreInvoke("tab.activate", """{"tabId":"$TAB_FRONT"}""")
        claim(awaitTrue(8_000) { activeCoreTab()?.optString("id") == TAB_FRONT }, "the front page is in front again")
        SystemClock.sleep(1_000)
        return leftAt
    }

    // --- 2: the recency guard -----------------------------------------------------------------------

    private fun recencyScene() {
        val before = discardedIds()
        val lastActive = coreTabsLastActive()
        val now = System.currentTimeMillis()
        val recent = lastActive.filterValues { now - it < RECENTLY_SHOWN_MS }.keys
        val delivered = trim("RUNNING_MODERATE")
        SystemClock.sleep(2_500)
        val slept = discardedIds() - before
        claim(delivered, "RUNNING_MODERATE reached the host")
        finding("RUNNING_MODERATE with ${recent.size} of ${lastActive.size} pages shown within the minute: ${slept.size} slept (${describeIds(slept)})")
        claim(slept.none { it in recent }, "no page shown within the minute slept under it (${describeIds(slept.filter { it in recent }.toSet())} did)")
        // Every page but the scrolled one was created within the last minute, as a rule: the
        // guard alone answers the trim. The scrolled page is the one that may be past it when the
        // thirty took long to load, and then it is the oldest quarter of one.
        claim(slept.size <= 1, "at most the scrolled page, past the minute, slept (${slept.size} slept)")
    }

    // --- 4: the foreground trims ------------------------------------------------------------------------

    private fun foregroundTrims(leftScrollAt: Long) {
        // Every page must be past the minute's guard for the shares to be exact: the youngest of
        // the thirty was created last, after the scrolled page was left.
        val lastActive = coreTabsLastActive()
        val youngest = lastActive.filterKeys { it != TAB_FRONT && it != TAB_AUDIO }.values.maxOrNull() ?: 0L
        val now = System.currentTimeMillis()
        val wait = (youngest + RECENTLY_SHOWN_MS + 1_500) - now
        finding("waiting ${wait.coerceAtLeast(0)} ms for the recency guard to pass (scrolled page left ${SystemClock.uptimeMillis() - leftScrollAt} ms ago)")
        if (wait > 0) SystemClock.sleep(wait)

        // RUNNING_LOW: half of what may sleep (the scrolled page and the thirty, less any the
        // recency scene took), the pages shown longest ago first.
        val candidates = (listOf(TAB_SCROLL) + (1..TABS).map { tabId(it) }).toSet()
        var asleepBefore = discardedIds()
        val awake = candidates - asleepBefore
        val half = (awake.size + 1) / 2
        val expectedOldest = awake.sortedBy { lastActive[it] ?: 0L }.take(half).toSet()
        var delivered = trim("RUNNING_LOW")
        claim(delivered, "RUNNING_LOW reached the host")
        var settled = awaitTrue(15_000) { (discardedIds() - asleepBefore).size >= half }
        SystemClock.sleep(1_500)
        var slept = discardedIds() - asleepBefore
        claim(settled && slept.size == half, "RUNNING_LOW slept half of the ${awake.size} pages that may sleep: ${slept.size} (expected $half)")
        claim(slept == expectedOldest, "the pages shown longest ago went first (${describeIds(slept - expectedOldest)} unexpected, ${describeIds(expectedOldest - slept)} missing)")
        claim(coreTab(TAB_FRONT)?.optBoolean("discarded") == false, "the front page is untouched after RUNNING_LOW")
        claim(coreTab(TAB_AUDIO)?.optBoolean("discarded") == false && coreTab(TAB_AUDIO)?.optBoolean("audible") == true, "the audible page is untouched after RUNNING_LOW")
        row("after RUNNING_LOW")

        // RUNNING_CRITICAL: the rest; the two exempt pages still stand.
        asleepBefore = discardedIds()
        val rest = candidates - asleepBefore
        delivered = trim("RUNNING_CRITICAL")
        claim(delivered, "RUNNING_CRITICAL reached the host")
        val started = SystemClock.uptimeMillis()
        settled = awaitTrue(15_000) { discardedIds().containsAll(candidates) }
        val took = SystemClock.uptimeMillis() - started
        SystemClock.sleep(1_500)
        slept = discardedIds() - asleepBefore
        claim(settled && slept == rest, "RUNNING_CRITICAL slept the rest: ${rest.size} more, ${candidates.size} asleep in all (${slept.size} slept; the last batch $took ms after the trim)")
        claim(coreTab(TAB_FRONT)?.optBoolean("discarded") == false, "the front page is untouched after RUNNING_CRITICAL")
        claim(coreTab(TAB_AUDIO)?.optBoolean("discarded") == false && coreTab(TAB_AUDIO)?.optBoolean("audible") == true, "the audible page is untouched after RUNNING_CRITICAL")
        val views = onMain { host.tabs.all().map { it.tabId }.sorted() }
        claim(views == listOf(TAB_AUDIO, TAB_FRONT), "two views stand on the host: the front page's and the audible page's ($views)")
        row("after RUNNING_CRITICAL")
    }

    // --- 5: the overview's sleeping cards -----------------------------------------------------------

    private fun overviewScene() {
        openOverview()
        val sleeping = domCount(".zen-overview .zen-overview-card[data-discarded]")
        val cards = domCount(".zen-overview .zen-overview-card")
        claim(sleeping == TABS + 1, "the overview shows ${TABS + 1} sleeping cards ($sleeping of $cards cards sleep)")
        SystemClock.sleep(1_000)
        shot("02-overview-sleeping")
        leaveOverview()
    }

    // --- 6: the return ------------------------------------------------------------------------------

    private fun returnScene() {
        val samples = ArrayList<String>()
        var sawPicture = false
        var pictureUpAt = -1L
        var pictureDownAt = -1L
        var paintedAt = -1L
        var loadedAt = -1L
        val t0 = SystemClock.uptimeMillis()
        val stop = CountDownLatch(1)
        val sampler = Thread {
            var last = ""
            while (stop.count > 0 && SystemClock.uptimeMillis() - t0 < RETURN_WATCH_MS) {
                val at = SystemClock.uptimeMillis() - t0
                val read = onMain {
                    val view = host.tabs.get(TAB_SCROLL)
                    Triple(host.restoredPictures.isShowing(TAB_SCROLL), view?.hasPaintedDocument == true, view?.progress ?: -1)
                }
                val (picture, painted, progress) = read
                if (picture && !sawPicture) {
                    sawPicture = true
                    pictureUpAt = at
                }
                if (sawPicture && !picture && pictureDownAt < 0) pictureDownAt = at
                if (painted && paintedAt < 0) paintedAt = at
                if (progress == 100 && painted && loadedAt < 0) loadedAt = at
                val line = "picture=$picture painted=$painted progress=$progress"
                if (line != last) {
                    samples += "+${at} ms $line"
                    last = line
                }
                if (loadedAt >= 0 && !picture && at - loadedAt > 1_000) break
                SystemClock.sleep(30)
            }
        }.also { it.start() }
        coreInvoke("tab.activate", """{"tabId":"$TAB_SCROLL"}""")
        // The still while the picture stands (the page's server holds its document back): the
        // picture is decoded off the main thread and placed a moment after the list is restored.
        val pictureUp = awaitFine(2_500) { onMain { host.restoredPictures.isShowing(TAB_SCROLL) } }
        if (pictureUp) shot("frames-return-$THEME")
        else Log.w(tag, "no picture up within 2.5 s of the return; no still of it")
        sampler.join(RETURN_WATCH_MS + 2_000)
        stop.countDown()
        finding("return sequence: ${samples.joinToString(" | ")}")
        claim(sawPicture, "the sleeping page's last picture stood on its return (up at +$pictureUpAt ms)")
        claim(pictureDownAt >= 0 && paintedAt >= 0 && pictureDownAt <= paintedAt + 200, "the picture left at the page's first commit (down +$pictureDownAt ms, painted +$paintedAt ms)")
        claim(loadedAt >= 0, "the page reloaded (progress 100 at +$loadedAt ms)")
        val restored = awaitValue(8_000) { pageJs(TAB_SCROLL, "String(Math.round(window.scrollY))").toIntOrNull()?.takeIf { it >= SCROLL_Y - 2 } }
        claim(restored != null, "the page came back at its scroll (${restored ?: pageJs(TAB_SCROLL, "String(Math.round(window.scrollY))")} for $SCROLL_Y)")
        claim(coreTab(TAB_SCROLL)?.optBoolean("discarded") == false, "the core has the page awake again")
        SystemClock.sleep(1_000)
        shot("03-returned-at-scroll")
        val saver = coreTab(TAB_SCROLL)?.opt("memorySaver")
        finding("the woken tab's memorySaver: ${saver ?: "none (no governor memory reading on this host)"}")
    }

    // --- 7: the renderer's weight ---------------------------------------------------------------------

    private fun priorityScene() {
        val shown = onMain { host.tabs.get(TAB_SCROLL)?.let { it.rendererRequestedPriority to it.rendererPriorityWaivedWhenNotVisible } }
        val hidden = onMain { host.tabs.get(TAB_FRONT)?.let { it.rendererRequestedPriority to it.rendererPriorityWaivedWhenNotVisible } }
        var chrome = onMain { host.chrome.rendererRequestedPriority to host.chrome.rendererPriorityWaivedWhenNotVisible }
        var held = onMain { host.rendererHeld() }
        finding("renderer priority: shown page $shown, hidden page $hidden, chrome $chrome, held=$held (IMPORTANT=${RendererPriorities.IMPORTANT}, WAIVED=${RendererPriorities.WAIVED})")
        claim(shown == (RendererPriorities.IMPORTANT to true), "the shown page's view asks IMPORTANT ($shown)")
        claim(hidden == (RendererPriorities.WAIVED to true), "a hidden page's view is WAIVED when not visible ($hidden)")
        claim(held && chrome == (RendererPriorities.IMPORTANT to false), "the chrome holds the renderer IMPORTANT, unwaived, while the audio plays ($chrome, held=$held)")

        // The audio stops: the hold lifts, the chrome waives with the window.
        pageJs(TAB_AUDIO, "(function(){var a=document.querySelector('audio');if(a)a.pause();return 'paused'})()")
        val quiet = awaitTrue(10_000) { coreTab(TAB_AUDIO)?.optBoolean("audible") == false && !onMain { host.rendererHeld() } }
        chrome = onMain { host.chrome.rendererRequestedPriority to host.chrome.rendererPriorityWaivedWhenNotVisible }
        held = onMain { host.rendererHeld() }
        claim(quiet && chrome == (RendererPriorities.IMPORTANT to true), "the audio paused, the chrome waives when not visible ($chrome, held=$held)")
        finding("process list, window up: ${processStanding()}")
    }

    // --- 8: the background --------------------------------------------------------------------------

    private fun backgroundScene() {
        // Twelve sleeping pages back, hidden: their `lastActiveAt` is the old one, so they may sleep.
        for (i in 1..BACKGROUND_TABS) coreInvoke("tab.reload", """{"tabId":"${tabId(i)}"}""")
        claim(awaitTrue(60_000) { loadedPages() >= BACKGROUND_TABS }, "$BACKGROUND_TABS sleeping pages reloaded hidden (${loadedPages()} loaded)")
        SystemClock.sleep(1_000)
        val trimsBefore = onMain { host.memoryPressure.trims.size }
        row("twelve reloaded, window up")

        pressHome()
        val stopped = awaitTrue(10_000) { onMain { !mainActivity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) } }
        claim(stopped, "the activity stopped behind Home")
        claim(!onMain { host.memoryPressure.running }, "the MemoryInfo poll stopped with the window")
        // What the platform delivers by itself on this API when the app goes to the cached state.
        SystemClock.sleep(4_000)
        val own = onMain { host.memoryPressure.trims.drop(trimsBefore) }
        finding("trims the platform delivered by itself at Home (API ${Build.VERSION.SDK_INT}): ${if (own.isEmpty()) "none" else own.joinToString { describeTrim(it) }}")
        finding("process list, window away: ${processStanding()}")
        val asleepBefore = discardedIds()

        // What may sleep now: the reloaded pages the platform's own trim at Home (if any) left.
        val reloaded = (1..BACKGROUND_TABS).map { tabId(it) }.toSet()
        val awake = reloaded - asleepBefore
        finding("${awake.size} of the $BACKGROUND_TABS reloaded pages still awake behind Home (${(reloaded - awake).size} slept at Home itself)")
        val delivered = trim("BACKGROUND")
        claim(delivered, "BACKGROUND reached the host with the window away")
        val graded = onMain { host.memoryPressure.trims.lastOrNull()?.graded }
        val expected = when (graded) {
            MemoryPressure.Level.MODERATE -> (awake.size + 3) / 4
            MemoryPressure.Level.LOW -> (awake.size + 1) / 2
            MemoryPressure.Level.CRITICAL -> awake.size
            null -> 0
        }
        // One pass, no batches: the plan is in the state as soon as the core answers.
        val settled = awaitTrue(10_000) { (discardedIds() - asleepBefore).size >= expected }
        SystemClock.sleep(1_000)
        val slept = discardedIds() - asleepBefore
        finding("BACKGROUND graded ${graded?.wire ?: "none"} (${memoryInfo()}): $expected of ${awake.size} expected, ${slept.size} slept: ${describeIds(slept)}")
        claim(graded != null, "BACKGROUND was graded (${graded?.wire})")
        claim(settled && slept.size == expected, "the background trim slept its share in one pass ($expected expected, ${slept.size} slept)")
        claim(slept.none { it == TAB_SCROLL || it == TAB_FRONT || it == TAB_AUDIO }, "the page in front, the page just left and the page just quiet stood")
        row("after BACKGROUND, window away")
        finding("process list after the trim: ${processStanding()}")

        returnToApp()
        claim(awaitTrue(15_000) { onMain { mainActivity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) } }, "the app is back in front")
        SystemClock.sleep(2_000)
        claim(awaitTrue(8_000) { onMain { host.memoryPressure.running } }, "the MemoryInfo poll runs again with the window")
        claim(runCatching { coreState() }.isSuccess, "the core answers after the return")
        shot("04-back-from-home")
    }

    // --- the trims ----------------------------------------------------------------------------------

    /**
     * `am send-trim-memory` for `level`, waited for on the host's record (the platform delivers
     * it through `ActivityThread.handleTrimMemory` to every `ComponentCallbacks2`). When the
     * shell refuses – a level no higher than the one the system last set on the process, or a
     * cached level on a foreground process – or the platform does not deliver it, the host is
     * given the trim directly on the main thread (`Host.onTrimMemory`, MainActivity's own path
     * minus the platform), and the findings say so. True when the host heard the level.
     */
    private fun trim(level: String): Boolean {
        val before = onMain { host.memoryPressure.trims.size }
        val out = shell("am send-trim-memory ${app.packageName} $level").trim()
        val heard = awaitTrue(6_000) { onMain { host.memoryPressure.trims.size } > before }
        if (heard) {
            val last = onMain { host.memoryPressure.trims.last() }
            finding("am send-trim-memory $level: delivered as ${describeTrim(last)}${if (out.isNotEmpty()) " (shell: ${out.lines().first()})" else ""}")
            return true
        }
        finding("am send-trim-memory $level: NOT delivered by the platform (shell: ${out.ifEmpty { "no output" }.lines().joinToString(" | ")}); given to the host directly")
        val code = TRIM_LEVELS[level] ?: return false
        onMain { host.onTrimMemory(code) }
        return awaitTrue(3_000) { onMain { host.memoryPressure.trims.size } > before }
    }

    private fun describeTrim(trim: MemoryPressureMonitor.Trim): String =
        "${MemoryPressure.nameOf(trim.level)} → ${trim.graded?.wire ?: "not pressure"} at uptime ${trim.atUptimeMs}"

    private fun trimsRecord(): String = onMain { host.memoryPressure.trims }.joinToString(", ") { describeTrim(it) }

    // --- the memory table ---------------------------------------------------------------------------

    private class MemoryRow(val label: String, val appPss: Int, val appRss: Int, val rendererPss: Int, val rendererRss: Int, val renderers: Int, val info: String, val loaded: Int, val asleep: Int)

    /** One row of the table: the app's and the renderer's PSS / RSS (kB) from `dumpsys meminfo`, the system's word beside them. */
    private fun row(label: String) {
        val app = meminfo(Process.myPid())
        val renderers = rendererPids()
        var rendererPss = 0
        var rendererRss = 0
        for (pid in renderers) {
            val (pss, rss) = meminfo(pid)
            rendererPss += pss
            rendererRss += rss
        }
        val row = MemoryRow(label, app.first, app.second, rendererPss, rendererRss, renderers.size, memoryInfo(), loadedPages(), discardedIds().size)
        table += row
        finding("memory [$label]: app PSS ${row.appPss} kB RSS ${row.appRss} kB; renderer PSS ${row.rendererPss} kB RSS ${row.rendererRss} kB (${row.renderers} process(es)); ${row.info}; ${row.loaded} pages loaded, ${row.asleep} asleep")
    }

    /** `TOTAL PSS` and `TOTAL RSS` in kB from `dumpsys meminfo -s <pid>`; 0 when unreadable. */
    private fun meminfo(pid: Int): Pair<Int, Int> {
        val dump = shell("dumpsys meminfo -s $pid")
        val pss = Regex("""TOTAL PSS:\s+(\d+)""").find(dump)?.groupValues?.get(1)?.toIntOrNull() ?: 0
        val rss = Regex("""TOTAL RSS:\s+(\d+)""").find(dump)?.groupValues?.get(1)?.toIntOrNull() ?: 0
        return pss to rss
    }

    /** The WebView's sandboxed renderer processes (`ps`): the one process every page and the chrome share, as a rule. */
    private fun rendererPids(): List<Int> =
        shell("ps -A -o PID,NAME").lineSequence()
            .filter { it.contains("sandboxed_process") }
            .mapNotNull { it.trim().split(Regex("\\s+")).firstOrNull()?.toIntOrNull() }
            .toList()

    private fun memoryInfo(): String = onMain { host.memoryPressure.describe(host.memoryPressure.read()) }

    /** The two processes' standing in `dumpsys activity processes`' LRU list (oom adj, state). */
    private fun processStanding(): String {
        val dump = shell("dumpsys activity processes")
        val lines = dump.lineSequence()
            .filter { (it.contains(app.packageName) || it.contains("sandboxed_process")) && it.contains("Proc #") }
            .map { it.trim() }
            .toList()
        return if (lines.isEmpty()) "no LRU lines for the two processes" else lines.joinToString(" | ")
    }

    private fun writeTable() {
        val sb = StringBuilder("\nMEMORY TABLE (kB; dumpsys meminfo -s; the renderer is the WebView's sandboxed process)\n")
        sb.append(String.format("%-32s %10s %10s %13s %13s %7s %7s\n", "row", "app PSS", "app RSS", "renderer PSS", "renderer RSS", "loaded", "asleep"))
        for (r in table) sb.append(String.format("%-32s %10d %10d %13d %13d %7d %7d\n", r.label, r.appPss, r.appRss, r.rendererPss, r.rendererRss, r.loaded, r.asleep))
        val first = table.firstOrNull()
        val critical = table.firstOrNull { it.label == "after RUNNING_CRITICAL" }
        if (first != null && critical != null) {
            sb.append("delta all loaded → after RUNNING_CRITICAL: app PSS ${critical.appPss - first.appPss} kB, renderer PSS ${critical.rendererPss - first.rendererPss} kB, total PSS ${(critical.appPss + critical.rendererPss) - (first.appPss + first.rendererPss)} kB\n")
        }
        for (r in table) sb.append("[${r.label}] ${r.info}\n")
        findings.appendText(sb.toString())
    }

    // --- the core's word ----------------------------------------------------------------------------

    private fun coreTab(tabId: String): JSONObject? = coreState().getJSONObject("tabs").optJSONObject(tabId)

    private fun discardedIds(): Set<String> {
        val tabs = coreState().getJSONObject("tabs")
        val out = HashSet<String>()
        for (key in tabs.keys()) if (tabs.getJSONObject(key).optBoolean("discarded")) out += key
        return out
    }

    private fun coreTabsLastActive(): Map<String, Long> {
        val tabs = coreState().getJSONObject("tabs")
        val out = HashMap<String, Long>()
        for (key in tabs.keys()) out[key] = tabs.getJSONObject(key).optLong("lastActiveAt")
        return out
    }

    /** Pages of the driver's site with a view that finished loading, per the host. */
    private fun loadedPages(): Int = onMain {
        host.tabs.all().count { (it.url ?: "").contains("/page/") && it.progress == 100 }
    }

    private fun describeIds(ids: Set<String>): String = if (ids.isEmpty()) "none" else ids.sorted().joinToString(",")

    private fun tabId(i: Int): String = "tab_mp_${i.toString().padStart(2, '0')}"

    /** The tab's view is up on `path` and done loading. */
    private fun awaitPage(tabId: String, path: String, timeoutMs: Long): Boolean = awaitTrue(timeoutMs) {
        onMain {
            val view = host.tabs.get(tabId)
            view != null && (view.url ?: "").contains(path) && view.progress == 100 && view.hasPaintedDocument
        }
    }

    /** A JS expression in the tab's own page (its result as a plain string; "" when the view is gone or silent). */
    private fun pageJs(tabId: String, code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(tabId)
            if (view == null) {
                latch.countDown()
            } else {
                view.evaluateJavascript(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return (runCatching { JSONTokener(result).nextValue() }.getOrNull() as? String) ?: result.trim('"')
    }

    /** [awaitTrue] at a finer step, for what stands a second or two. */
    private fun awaitFine(timeoutMs: Long, holds: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (holds()) return true
            SystemClock.sleep(25)
        }
        return holds()
    }

    private fun <T> awaitValue(timeoutMs: Long, read: () -> T?): T? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            read()?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(200)
        }
    }

    private fun <T> onMain(read: () -> T): T {
        var out: T? = null
        instrumentation.runOnMainSync { out = read() }
        @Suppress("UNCHECKED_CAST")
        return out as T
    }

    // --- the overview and Home ----------------------------------------------------------------------

    private fun openOverview() {
        ensureForeground()
        for (attempt in 1..3) {
            val tabs = tabsButton() ?: error("no Tabs button on the bar")
            Finger().tap(tabs.exactCenterX(), tabs.exactCenterY())
            if (awaitTrue(8_000) { overviewOpen() }) {
                SystemClock.sleep(1_500)
                return
            }
            back()
            SystemClock.sleep(800)
        }
        error("the overview never opened")
    }

    private fun overviewOpen(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()") == "scale(1)"

    private fun leaveOverview() {
        for (attempt in 1..6) {
            if (!inDom(".zen-overview")) break
            back()
            awaitTrue(4_000) { !inDom(".zen-overview") }
            SystemClock.sleep(700)
        }
        if (inDom(".zen-overview")) error("the overview never left")
        SystemClock.sleep(600)
    }

    private fun pressHome() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
    }

    /** Zenium back in front through the shell; the in-process start is the fallback. */
    private fun returnToApp() {
        val started = shell("am start -W -a android.intent.action.MAIN -f 0x20000000 -n ${app.packageName}/${MainActivity::class.java.name}")
        if (!started.contains("Status: ok")) {
            finding("  am start: ${started.trim().lines().joinToString(" | ")}; starting from the process instead")
            app.startActivity(Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    // --- the chrome's DOM -----------------------------------------------------------------------------

    private fun jsString(code: String): String =
        (runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull() as? String).orEmpty()

    private fun inDom(selector: String): Boolean =
        jsString("(function(){return document.querySelector(${JSONObject.quote(selector)})?'yes':''})()") == "yes"

    private fun domCount(selector: String): Int =
        jsString("String(document.querySelectorAll(${JSONObject.quote(selector)}).length)").toIntOrNull() ?: -1

    // --- evidence -----------------------------------------------------------------------------------

    private fun claim(ok: Boolean, text: String) {
        finding("${if (ok) "OK  " else "FAIL"} $text")
        if (!ok) failures += text
    }

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.appendText(line + "\n")
    }

    override fun noteLine(line: String) = finding(line)

    private fun shell(command: String): String = shellCommand(command)

    // --- the site -----------------------------------------------------------------------------------

    /**
     * The driver's pages on the loopback: thirty with a few megabytes of ballast each (touched,
     * so the memory is committed), a long page for the scroll and the return (its document held
     * back [SCROLL_DELAY_MS] by the server so the picture stands to be seen), a page that plays a
     * tone under a finger, and the front page.
     */
    private fun routes(): Map<String, Pair<String, ByteArray>> {
        val routes = HashMap<String, Pair<String, ByteArray>>()
        routes["/front"] = DemoServer.page("In front", "<p>The page in front while the others sleep. Nothing here is asked to give anything back.</p>")
        for (i in 1..TABS) {
            routes["/page/$i"] = DemoServer.page(
                "Page $i of $TABS",
                "<p>A hidden page holding ${BALLAST_MB} MB, shown once at its creation and not since.</p>" +
                    "<script>(function(){var b=new Uint8Array(${BALLAST_MB}*1048576);for(var i=0;i<b.length;i+=4096)b[i]=i&255;window.__ballast=b})()</script>"
            )
        }
        routes["/scroll"] = DemoServer.page(
            "The long page",
            (1..120).joinToString("") { "<p style=\"padding:12px 24px;border-bottom:1px solid #ddd\">Paragraph $it of the long page. The return finds this page at the paragraph it was left on.</p>" }
        )
        routes["/audio"] = DemoServer.page(
            "Playing",
            "<p>A finger anywhere starts a looping tone; the core hears the page play and no pressure sleeps it.</p>" +
                "<audio id=a loop src=/tone.wav></audio>" +
                "<script>document.body.style.minHeight='100vh';document.body.addEventListener('click',function(){document.getElementById('a').play()})</script>"
        )
        routes["/tone.wav"] = "audio/wav" to tone()
        return routes
    }

    /** Twenty seconds of a quiet 220 Hz tone, 8 kHz mono 16-bit: a small file, looped by the page. */
    private fun tone(): ByteArray {
        val rate = 8_000
        val samples = rate * 20
        val data = ByteArray(samples * 2)
        for (i in 0 until samples) {
            val v = sin(2 * PI * 220.0 * i / rate) * 0.3
            val s = (v * Short.MAX_VALUE).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            data[i * 2] = (s and 0xff).toByte()
            data[i * 2 + 1] = ((s shr 8) and 0xff).toByte()
        }
        val out = ByteArrayOutputStream(44 + data.size)
        fun ascii(s: String) = out.write(s.toByteArray(Charsets.US_ASCII))
        fun int32(v: Int) { out.write(v and 0xff); out.write((v shr 8) and 0xff); out.write((v shr 16) and 0xff); out.write((v shr 24) and 0xff) }
        fun int16(v: Int) { out.write(v and 0xff); out.write((v shr 8) and 0xff) }
        ascii("RIFF"); int32(36 + data.size); ascii("WAVE")
        ascii("fmt "); int32(16); int16(1); int16(1); int32(rate); int32(rate * 2); int16(2); int16(16)
        ascii("data"); int32(data.size)
        out.write(data)
        return out.toByteArray()
    }

    companion object {
        private const val PORT = 18190
        private const val TAB_FRONT = "tab_front"
        private const val TAB_SCROLL = "tab_scroll"
        private const val TAB_AUDIO = "tab_audio"
        private const val TABS = 30
        /** The sleeping pages the background scene reloads hidden. */
        private const val BACKGROUND_TABS = 12
        private const val BALLAST_MB = 2
        private const val SCROLL_Y = 2_400
        /** The long page's document held back by the server, so the return's picture stands to be seen. */
        private const val SCROLL_DELAY_MS = 1_200L
        private const val RETURN_WATCH_MS = 12_000L
        /** `RECENTLY_SHOWN_MS` in `src/core/memoryPressure.ts`. */
        private const val RECENTLY_SHOWN_MS = 60_000L
        /** `am send-trim-memory`'s names for `ComponentCallbacks2`'s levels. */
        private val TRIM_LEVELS = mapOf(
            "HIDDEN" to HostLifecycle.TRIM_MEMORY_UI_HIDDEN,
            "RUNNING_MODERATE" to HostLifecycle.TRIM_MEMORY_RUNNING_MODERATE,
            "BACKGROUND" to HostLifecycle.TRIM_MEMORY_BACKGROUND,
            "RUNNING_LOW" to HostLifecycle.TRIM_MEMORY_RUNNING_LOW,
            "MODERATE" to HostLifecycle.TRIM_MEMORY_MODERATE,
            "RUNNING_CRITICAL" to HostLifecycle.TRIM_MEMORY_RUNNING_CRITICAL,
            "COMPLETE" to HostLifecycle.TRIM_MEMORY_COMPLETE
        )
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
    }
}
