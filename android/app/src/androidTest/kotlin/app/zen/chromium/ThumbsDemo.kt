package app.zen.chromium

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import kotlin.math.abs
import kotlin.math.max

/**
 * The tab cards' pictures (TAB-26; BH-14 a card showing the page a tab left, BH-33 placeholder
 * cards after a restart), proved in two acts around a process death, because the driver shares
 * the app's process and cannot outlive `am force-stop`:
 *
 *  - [ThumbsDemo], the first act: three pages of one colour each, served by the driver on the
 *    loopback, visited by flinging the pill (a picture is taken of each page on its way off the
 *    screen); the overview pulled in and every card read against its page's colour; a card
 *    tapped with a real touch; the red tab navigated to purple while another tab is on screen
 *    (its card must show the placeholder, never red: BH-14), then shown and left (its card is
 *    purple); the app sent home and brought back (the picture on the way to the background);
 *    the cost of each picture in the log and the process's memory before and after.
 *  - [ThumbsRestoreDemo], the second act, after the workflow script force-stopped the process:
 *    the same pages answered 40 s late, so no page can have painted when the restored overview
 *    is pulled in – the purple and green cards must already show their pages from disk (BH-33:
 *    the files stamped with their documents, read for them), while the blue tab's file, replaced
 *    before the launch by a copy of the green one (a picture of a page the tab is not on, as a
 *    kill between a navigation and the next capture leaves), must be refused for the placeholder
 *    (BH-14 across the kill) and replaced once the blue page has been seen and left; a stale
 *    picture planted under a tab id the session does not have must be gone (the sweep at boot).
 *
 * Driven by `.github/scripts/android-thumbs-demo.sh` through the `android-thumbs-demo` workflow.
 * See [DemoHarness] for the plumbing.
 */
abstract class ThumbsDemoBase(
    stateAsset: String?,
    shotPrefix: String,
    handshakeDir: String,
    keepProfile: Boolean,
    private val pageDelayMs: Long
) : DemoHarness(stateAsset, shotPrefix, handshakeDir, keepProfile = keepProfile) {
    private lateinit var server: DemoServer
    protected val findings = StringBuilder()
    protected val failures = ArrayList<String>()
    private val startedAt = SystemClock.uptimeMillis()

    @Test
    fun record() {
        val routes = PAGES.associate { it.path to (HTML to html(it)) }
        val delays = if (pageDelayMs > 0) PAGES.associate { it.path to pageDelayMs } else emptyMap()
        server = DemoServer(PORT, routes, delays = delays).also { it.start() }
        note("server: ${server.selfCheck()}")
        try {
            runDemo()
        } finally {
            server.close()
            // Whatever cut the sequence short, what was judged up to then is worth having.
            File(out, "thumbs-findings.txt").writeText(findings.toString())
            Log.i(tag, "findings:\n$findings")
        }
    }

    override fun warmUp() {}

    // --- judging ---------------------------------------------------------------------------------

    protected fun note(line: String) {
        Log.i(tag, line)
        findings.append("[${SystemClock.uptimeMillis() - startedAt} ms] ").append(line).append('\n')
    }

    /** A judgement: PASS or FAIL in the findings; a failure fails the run once the sequence is over. */
    protected fun check(name: String, ok: Boolean, detail: String) {
        note("${if (ok) "PASS" else "FAIL"} $name: $detail")
        if (!ok) failures.add(name)
    }

    protected fun finish() {
        if (failures.isNotEmpty()) error("${failures.size} judgement(s) failed: ${failures.joinToString()}")
    }

    /** A screenshot kept for the artifact and handed back for its pixels. */
    protected fun capture(name: String): Bitmap {
        val bitmap = ui.takeScreenshot() ?: error("no screenshot for $name")
        File(out, "$shotName-$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return bitmap
    }

    protected abstract val shotName: String

    /** The mean colour of a 7 x 7 block around the point (`fx`, `fy`) of `bounds`, as fractions. */
    protected fun sample(shot: Bitmap, bounds: Rect, fx: Float, fy: Float): Int {
        val cx = (bounds.left + bounds.width() * fx).toInt().coerceIn(3, shot.width - 4)
        val cy = (bounds.top + bounds.height() * fy).toInt().coerceIn(3, shot.height - 4)
        var r = 0
        var g = 0
        var b = 0
        var n = 0
        for (y in cy - 3..cy + 3) {
            for (x in cx - 3..cx + 3) {
                val c = shot.getPixel(x, y)
                r += Color.red(c)
                g += Color.green(c)
                b += Color.blue(c)
                n++
            }
        }
        return Color.rgb(r / n, g / n, b / n)
    }

    /** The page area's colour: the middle of the window above the pill. */
    protected fun pageColor(shot: Bitmap): Int = sample(shot, Rect(0, 0, width, pill.top), 0.5f, 0.45f)

    protected fun near(a: Int, b: Int, tolerance: Int = TOLERANCE): Boolean =
        max(abs(Color.red(a) - Color.red(b)), max(abs(Color.green(a) - Color.green(b)), abs(Color.blue(a) - Color.blue(b)))) <= tolerance

    protected fun hex(c: Int): String = "#%02x%02x%02x".format(Color.red(c), Color.green(c), Color.blue(c))

    protected fun pageOf(color: Int): String = PAGES.firstOrNull { near(it.color, color) }?.name ?: "none of the pages"

    /**
     * The card of the tab titled `label`: the clickable node whose name is the card's ("Green
     * page, tab 2 of 3, …" since #237: the title, its place and its state – matched by the shared
     * [tabCard] on the title alone), not the title text inside it.
     */
    protected fun card(label: String): Rect? {
        val reads = tabCard(label)
        val node = findNodeWhere {
            it.isClickable && (it.contentDescription?.toString()?.let(reads) == true || it.text?.toString()?.let(reads) == true)
        } ?: return findByLabel(reads)
        return Rect().also { node.getBoundsInScreen(it) }
    }

    /**
     * What a card shows in its picture (below the 40 CSS px title row): two points in the lower
     * half, away from the placeholder's centred favicon and title, averaged.
     */
    protected fun cardColor(shot: Bitmap, card: Rect): Int {
        val a = sample(shot, card, 0.28f, 0.78f)
        val b = sample(shot, card, 0.72f, 0.78f)
        return Color.rgb((Color.red(a) + Color.red(b)) / 2, (Color.green(a) + Color.green(b)) / 2, (Color.blue(a) + Color.blue(b)) / 2)
    }

    /** Read the card titled `label` off `shot` and judge it against `expected` (null: it must show no page). */
    protected fun judgeCard(shot: Bitmap, label: String, expected: Int?, name: String) {
        val bounds = card(label)
        if (bounds == null) {
            check(name, false, "no card titled $label on screen")
            return
        }
        val color = cardColor(shot, bounds)
        if (expected != null) {
            check(name, near(color, expected), "card $label shows ${hex(color)} (${pageOf(color)}), expected ${hex(expected)}")
        } else {
            check(name, PAGES.none { near(it.color, color) }, "card $label shows ${hex(color)} (${pageOf(color)}), expected the placeholder")
        }
    }

    // --- the chrome --------------------------------------------------------------------------------

    /** Pull the overview in from the pill and let go, then wait for it to be at rest. */
    protected fun openOverview() {
        val f = Finger()
        f.down(pillCenterX, pillY)
        f.settleIn(0f, -NUDGE)
        f.moveBy(0f, -0.75f * overviewTravel + NUDGE, 400)
        f.up()
        waitFor("Spaces", 8_000) ?: error("the overview never showed")
        SystemClock.sleep(3_500)
    }

    /** Tap a card with a real touch (the overview closes to that tab) and wait for the page. */
    protected fun tapCard(label: String) {
        val bounds = card(label) ?: error("no card titled $label to tap")
        Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
        SystemClock.sleep(4_000)
    }

    protected fun tabState(tabId: String): JSONObject? = coreState().getJSONObject("tabs").optJSONObject(tabId)

    protected fun activeTabId(): String = activeCoreTab()?.optString("id", "") ?: ""

    protected fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).use { it.readBytes().toString(Charsets.UTF_8) }.also { fd.close() }
    }

    /** The process's memory as `dumpsys meminfo` sums it: total PSS and the graphics share. */
    protected fun memory(): String {
        val lines = shell("dumpsys meminfo ${app.packageName}").lineSequence().map { it.trim() }
        val kept = lines.filter { it.startsWith("TOTAL PSS:") || it.startsWith("TOTAL:") || it.startsWith("Graphics:") || it.startsWith("Java Heap:") || it.startsWith("Native Heap:") }
        return kept.joinToString(" | ").ifEmpty { "meminfo unavailable" }
    }

    /** The pictures on disk, by tab id with their sizes. */
    protected fun pictures(): String {
        val dir = File(app.cacheDir, Thumbnails.DIR)
        val files = dir.listFiles()?.sortedBy { it.name } ?: return "no ${Thumbnails.DIR} directory"
        return files.joinToString(", ") { "${it.name} ${it.length()} B" }.ifEmpty { "empty" }
    }

    class Page(val name: String, val path: String, val title: String, val color: Int)

    companion object {
        const val PORT = 8137
        const val HTML = "text/html; charset=utf-8"
        /** Judging tolerance per channel: JPEG at quality 80 moves a flat colour by a few steps. */
        const val TOLERANCE = 40
        val RED = Color.rgb(214, 58, 58)
        val GREEN = Color.rgb(47, 158, 91)
        val BLUE = Color.rgb(47, 111, 214)
        val PURPLE = Color.rgb(139, 63, 201)
        val PAGES = listOf(
            Page("red", "/red.html", "Red page", RED),
            Page("green", "/green.html", "Green page", GREEN),
            Page("blue", "/blue.html", "Blue page", BLUE),
            Page("purple", "/purple.html", "Purple page", PURPLE)
        )
        fun url(page: Page): String = "http://127.0.0.1:$PORT${page.path}"

        fun html(page: Page): ByteArray {
            val css = "#%02x%02x%02x".format(Color.red(page.color), Color.green(page.color), Color.blue(page.color))
            return """<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${page.title}</title>
<style>html,body{margin:0;height:100%;background:$css;color:#fff;font:700 40px system-ui,sans-serif}
main{display:flex;height:100%;align-items:center;justify-content:center}</style></head>
<body><main>${page.title}</main></body></html>
""".toByteArray()
        }
    }
}

/** The first act: pictures taken, judged, invalidated and refreshed. */
@RunWith(AndroidJUnit4::class)
class ThumbsDemo : ThumbsDemoBase("thumbs-demo-state.json", "thumbs", "thumbs-demo", keepProfile = false, pageDelayMs = 0) {
    override val tag = "ThumbsDemo"
    override val shotName = "thumbs"

    override fun warmUp() {
        // The red page painted: the pictures below are of pages, not of white.
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < deadline) {
            val shot = ui.takeScreenshot() ?: break
            val color = pageColor(shot)
            shot.recycle()
            if (near(color, RED)) return
            SystemClock.sleep(500)
        }
        Log.w(tag, "the red page did not paint in time")
    }

    override fun demo() {
        note("pictures on disk at the start: ${pictures()}")
        note("memory before: ${memory()}")

        // 1. Visit the three pages by flinging the pill: each page is captured on its way out.
        var shot = capture("01-red-page")
        check("red page painted", near(pageColor(shot), RED), "page shows ${hex(pageColor(shot))}")
        shot.recycle()
        flingLeft(); settle()
        shot = capture("02-green-page")
        check("green page after a fling", near(pageColor(shot), GREEN), "page shows ${hex(pageColor(shot))}, active ${activeTabId()}")
        shot.recycle()
        flingLeft(); settle()
        shot = capture("03-blue-page")
        check("blue page after a fling", near(pageColor(shot), BLUE), "page shows ${hex(pageColor(shot))}, active ${activeTabId()}")
        shot.recycle()
        note("pictures on disk after two switches: ${pictures()}")

        // 2. The overview: every card shows its own page (the active one's from the cover).
        openOverview()
        shot = capture("04-overview-three-cards")
        judgeCard(shot, "Red page", RED, "red card")
        judgeCard(shot, "Green page", GREEN, "green card")
        judgeCard(shot, "Blue page", BLUE, "blue card")
        shot.recycle()

        // 3. A real touch on the green card: the overview closes to the green page.
        tapCard("Green page")
        shot = capture("05-green-after-card-tap")
        check("card tap (touch) switched to green", activeTabId() == "tab_green" && near(pageColor(shot), GREEN), "active ${activeTabId()}, page shows ${hex(pageColor(shot))}")
        shot.recycle()

        // 4. BH-14: the red tab navigates while green is on screen. Its card must not show red.
        coreInvoke("tab.navigate", """{"tabId":"tab_red","input":${JSONObject.quote(url(PAGES[3]))}}""")
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (SystemClock.uptimeMillis() < deadline && tabState("tab_red")?.optString("url")?.endsWith("/purple.html") != true) SystemClock.sleep(250)
        SystemClock.sleep(2_500)
        val red = tabState("tab_red")
        note("red tab after the navigation: url ${red?.optString("url")}, title ${red?.optString("title")}, loading ${red?.optBoolean("loading")}")
        note("pictures on disk after the navigation: ${pictures()}")
        openOverview()
        shot = capture("06-overview-after-background-navigation")
        val navigatedLabel = if (card("Purple page") != null) "Purple page" else "Red page"
        judgeCard(shot, navigatedLabel, null, "navigated card shows no stale page (BH-14)")
        judgeCard(shot, "Green page", GREEN, "green card after the navigation")
        shot.recycle()

        // 5. Show the navigated tab (touch), leave it by a fling: its card is purple now.
        tapCard(navigatedLabel)
        shot = capture("07-purple-page")
        check("navigated tab shows purple", near(pageColor(shot), PURPLE), "page shows ${hex(pageColor(shot))}, active ${activeTabId()}")
        shot.recycle()
        flingLeft(); settle()
        openOverview()
        shot = capture("08-overview-card-refreshed")
        judgeCard(shot, "Purple page", PURPLE, "navigated card refreshed (BH-14)")
        judgeCard(shot, "Blue page", BLUE, "blue card kept")
        shot.recycle()
        tapCard("Green page")

        // 6. Home and back: the page on screen is captured on the way to the background.
        val before = File(File(app.cacheDir, Thumbnails.DIR), "tab_green${Thumbnails.SUFFIX}").lastModified()
        shell("input keyevent KEYCODE_HOME")
        SystemClock.sleep(3_000)
        val after = File(File(app.cacheDir, Thumbnails.DIR), "tab_green${Thumbnails.SUFFIX}").lastModified()
        check("picture taken on the way to the background", after > before, "tab_green.jpg modified ${if (after > before) "${after - before} ms after" else "no later than"} the one before")
        shell("am start -W -n ${activity.componentName.flattenToString()}")
        SystemClock.sleep(4_000)
        ensureForeground()
        shot = capture("09-back-from-home")
        shot.recycle()

        note("pictures on disk at the end: ${pictures()}")
        note("memory after: ${memory()}")
        finish()
    }
}

/**
 * The second act, after `am force-stop`: the restored session's cards show their pictures before
 * any page has painted (the stamped files read for their documents), a file of another page
 * under a live tab's id is refused and then replaced, and the sweep at boot removed the picture
 * of a tab the session lacks.
 */
@RunWith(AndroidJUnit4::class)
class ThumbsRestoreDemo : ThumbsDemoBase(null, "thumbs-restore", "thumbs-restore-demo", keepProfile = true, pageDelayMs = 40_000) {
    override val tag = "ThumbsRestoreDemo"
    override val shotName = "thumbs-restore"
    private var launchedAt = 0L

    override fun beforeLaunch() {
        val dir = File(app.cacheDir, Thumbnails.DIR).apply { mkdirs() }
        val live = File(dir, "tab_green${Thumbnails.SUFFIX}")
        // A picture under an id the session does not have: the sweep at boot must take it.
        val stale = File(dir, "tab_stale${Thumbnails.SUFFIX}")
        if (live.isFile) live.copyTo(stale, overwrite = true) else stale.writeBytes(ByteArray(64))
        // The green page's picture under the blue tab's id: what a kill between a navigation and
        // the next capture leaves under a live tab. Its stamp names the green page, the tab is on
        // the blue one: the read must refuse it, and the card show the placeholder, never green.
        val planted = File(dir, "tab_blue${Thumbnails.SUFFIX}")
        if (live.isFile) live.copyTo(planted, overwrite = true) else note("no tab_green picture to plant under tab_blue")
        note("pictures on disk before the relaunch: ${pictures()}")
        launchedAt = SystemClock.uptimeMillis()
    }

    override fun demo() {
        note("the pill came up ${SystemClock.uptimeMillis() - launchedAt} ms after the launch (the harness waits 4 s past it)")
        var shot = capture("01-restored-page-still-loading")
        val page = pageColor(shot)
        val active = activeCoreTab()
        note("restored active tab ${active?.optString("id")}: loading ${active?.optBoolean("loading")}, page area shows ${hex(page)} (${pageOf(page)})")
        check("no page painted yet", PAGES.none { near(it.color, page) }, "page area shows ${hex(page)} while the server holds every page 40 s")
        shot.recycle()

        // The overview at once: the cards from disk, before any page could have painted (BH-33) –
        // the stamped files read for their documents; the blue tab's, of the green page, refused.
        openOverview()
        shot = capture("02-restored-overview-pictures-before-pages")
        judgeCard(shot, "Purple page", PURPLE, "restored purple card from its stamped file (BH-33)")
        judgeCard(shot, "Green page", GREEN, "restored green card from its stamped file (BH-33)")
        judgeCard(shot, "Blue page", null, "blue card refuses the file of another page (the stamp; BH-14 across a kill)")
        shot.recycle()
        val now = activeCoreTab()
        note("while the overview is up: active ${now?.optString("id")} loading ${now?.optBoolean("loading")}, ${SystemClock.uptimeMillis() - launchedAt} ms after the launch")
        val onDisk = pictures()
        check("sweep at boot", !onDisk.contains("tab_stale") && onDisk.contains("tab_green"), onDisk)

        // A real touch on the blue card, then the page arrives: the placeholder stood in until it did.
        tapCard("Blue page")
        check("card tap (touch) switched to blue", activeTabId() == "tab_blue", "active ${activeTabId()}")
        val deadline = SystemClock.uptimeMillis() + 60_000
        var painted = false
        while (SystemClock.uptimeMillis() < deadline) {
            shot = ui.takeScreenshot() ?: break
            painted = near(pageColor(shot), BLUE)
            shot.recycle()
            if (painted) break
            SystemClock.sleep(1_000)
        }
        note("the blue page painted ${SystemClock.uptimeMillis() - launchedAt} ms after the launch: $painted")
        shot = capture("03-blue-page-painted")
        shot.recycle()

        // The blue page seen and left: its picture replaces the refused file, and the card shows it.
        flingRight(); settle()
        openOverview()
        shot = capture("04-overview-blue-card-replaced")
        judgeCard(shot, "Blue page", BLUE, "blue card replaced after the refused file")
        shot.recycle()
        note("pictures on disk at the end: ${pictures()}")
        note("memory after the restore: ${memory()}")
        finish()
    }
}
