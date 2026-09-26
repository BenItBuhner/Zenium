package app.zen.chromium

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PointF
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsCallback
import androidx.browser.customtabs.CustomTabsClient
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsServiceConnection
import androidx.browser.customtabs.CustomTabsSession
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Collections
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Drives the custom tab's menu as Chrome 152 has it (CCT-03) and the caller's START animations
 * (CCT-08) so the `android-customtabs-menu-demo` workflow can record them. "Nimbus News"
 * ([CustomTabCallerActivity], the instrumentation APK's own package and process) opens pages this
 * driver serves on the loopback ([DemoServer]) in custom tabs prepared as a real client's are:
 * a session, two caller menu items, a toolbar colour, and – on two of the tabs – the caller's
 * `EXTRA_DISABLE_BOOKMARKS_BUTTON` / `EXTRA_DISABLE_DOWNLOAD_BUTTON`.
 *
 * What it reads and asserts:
 *  - the START animation: the caller sets `setStartAnimations` (a two-second slide in from the
 *    right of its own resources) and starts the tab with the options bundle `launchUrl` passes;
 *    the tab's OPEN transition is read from WindowManager's log (how long the shell animated it:
 *    the caller's two seconds, or the theme's 300 ms slide-up) and the toolbar's landing from a
 *    screenshot, so the run says whether the slide ran through the provider's trampoline
 *    (`LinkDispatchActivity`, `Theme.NoDisplay`) or the theme's own animation took its place;
 *  - the menu's ICON ROW on the native sheet: Forward, Bookmark, Download Page, Page Info, Reload
 *    with the caller's two disabled buttons gone from a tab that disabled them; Forward disabled on
 *    a fresh tab and enabled after a navigation and a back step, then taken under a finger;
 *  - the rows: the caller's two, Share, Copy Link, Find in Page, Add to Home Screen, Desktop Site
 *    (a check row), Open in Zenium;
 *  - the star: a tap files the page in the tab's inbox document (`bookmarks-inbox.json`; the
 *    browser's core owns the bookmarks) and the star fills, reading Edit Bookmark; a second tap
 *    withdraws it; a page the browser already holds as a bookmark (seeded in the profile) opens
 *    with the star filled from the core's `state.json`, and its tap opens the page in Zenium;
 *  - Desktop Site: the user agent changes to the desktop one and back, the row reads checked;
 *  - Page Info: the v2 prompt sheet with the host and the Connection row (a loopback page reads
 *    Local site, as the browser's sheet does);
 *  - Add to Home Screen: the name prompt with the page's title prefilled, then the launcher's pin;
 *  - Download Page: the archive lands in Downloads (the toast, a MediaStore row).
 *
 * The stills `customtabs-menu-*.png` are the design gate's (the sheet with and without the
 * caller's disabled buttons, light and dark) and the rest of the evidence.
 */
@RunWith(AndroidJUnit4::class)
class CustomTabMenuDemo : DemoHarness("customtabs-demo-state.json", "customtabs-menu", "customtabs-menu-demo") {
    override val tag = "CustomTabMenuDemo"

    private val callerPackage: String = instrumentation.context.packageName
    private var client: CustomTabsClient? = null
    private var session: CustomTabsSession? = null
    private val events: MutableList<String> = Collections.synchronizedList(ArrayList())
    private val callerHits: MutableList<String> = Collections.synchronizedList(ArrayList())
    private var receiver: BroadcastReceiver? = null
    private lateinit var server: DemoServer
    private lateinit var findings: File
    /** The frames after the caller's button: (ms since the press, the toolbar's left edge in px, -1 without a toolbar). */
    private val startFrames = ArrayList<Pair<Long, Int>>()
    /** Per sampled frame, the bitmap's shape and two probe pixels through the toolbar's band – the sampler's own evidence. */
    private val startProbes = ArrayList<String>()

    @Test
    fun record() = runDemo()

    /** The seeded profile holds one bookmark: the page the store-read step opens. */
    override fun patchState(json: String): String {
        val state = JSONObject(json)
        state.remove("bookmarks")
        val nodes = JSONArray()
            .put(folder("1", "Bookmarks bar", 0))
            .put(folder("2", "Other bookmarks", 1))
            .put(folder("3", "Mobile bookmarks", 2))
            .put(
                JSONObject()
                    .put("id", "b_cct").put("parentId", "3").put("index", 0).put("type", "url")
                    .put("title", BOOKMARKED_TITLE).put("url", bookmarkedUrl()).put("dateAdded", 1_788_438_400_000L)
            )
        state.put("bookmarkTree", JSONObject().put("schemaVersion", 1).put("nodes", nodes))
        return state.toString()
    }

    private fun folder(id: String, title: String, index: Int): JSONObject =
        JSONObject().put("id", id).put("parentId", JSONObject.NULL).put("index", index).put("type", "folder").put("title", title).put("dateAdded", 0)

    override fun warmUp() {
        findings = File(out, "findings.txt")
        findings.writeText("Zenium Android custom tab menu (CCT-03) and start animations (CCT-08), API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density\n\n")
        server = DemoServer(PORT, routes()).also { it.start() }
        Log.i(tag, "server: ${server.selfCheck()}")
        connect()
        listenForCallerActions()
        showCaller(customTabIntent(dark = false, disabled = false), startOptions = true)
    }

    override fun demo() {
        // 1. The other app; its button opens the story with the caller's start animation.
        shot("01-caller")
        beat()
        openCustomTabReadingStart()
        shot("02-toolbar-light")
        beat()

        // 2. The menu on a fresh tab: the full icon row (Forward disabled, the star empty), the rows.
        openMenu()
        readIconRow("a fresh light tab", bookmark = true, download = true)
        readRows()
        assertFalse("Forward is disabled on a fresh tab (no forward history)", iconEnabled(FORWARD_LABEL))
        assertTrue("the star reads Bookmark (the page is in no store)", findNode { it == BOOKMARK_LABEL } != null)
        shot("03-icon-row-light")
        beat()
        dismissSheet()

        // 3. A link followed, a back step, Forward enabled and taken under a finger.
        val page = customTab()?.page ?: error("no custom tab page")
        plantLink(page)?.let { p ->
            Finger().tap(p.x, p.y)
            waitForPath(SECOND_PATH)
        }
        back()
        waitForPath(STORY_PATH)
        SystemClock.sleep(800)
        openMenu()
        assertTrue("Forward is enabled after a back step", iconEnabled(FORWARD_LABEL))
        assertTrue(
            "Forward under a finger went forward to the second page",
            touchTapLabelExpecting(FORWARD_LABEL, "the second page is up", timeoutMs = 10_000) { pathOf(customTab()?.page) == SECOND_PATH }
        )
        SystemClock.sleep(1_200)
        shot("04-forward")
        beat()
        back()
        waitForPath(STORY_PATH)
        SystemClock.sleep(800)

        // 4. The star: a tap files the page in the tab's inbox and fills the star; a second tap withdraws it.
        openMenu()
        assertTrue(
            "the star under a finger filed the page in the inbox document",
            touchTapLabelExpecting(BOOKMARK_LABEL, "the inbox holds the page", timeoutMs = 8_000) { inboxUrls().contains(storyUrl()) }
        )
        note("star: inbox after the tap = ${inboxUrls()}")
        SystemClock.sleep(1_500)
        openMenu()
        assertTrue("the star reads Edit Bookmark once the page is filed", findNode { it == EDIT_BOOKMARK_LABEL } != null)
        shot("05-star-filled-light")
        beat()
        assertTrue(
            "a second tap on the star withdrew the filing",
            touchTapLabelExpecting(EDIT_BOOKMARK_LABEL, "the inbox no longer holds the page", timeoutMs = 8_000) { !inboxUrls().contains(storyUrl()) }
        )
        note("star: inbox after the second tap = ${inboxUrls()}")
        SystemClock.sleep(1_500)

        // 5. Desktop Site: the user agent turns desktop, the row reads checked; a second tap turns it back.
        val mobileAgent = userAgent()
        assertTrue("the tab starts on the mobile user agent: $mobileAgent", mobileAgent.contains(MOBILE_TOKEN))
        openMenu()
        assertTrue(
            "Desktop Site under a finger switched the user agent",
            touchTapLabelExpecting(DESKTOP_LABEL, "the desktop user agent is in force", timeoutMs = 12_000) {
                userAgent().let { it.contains(DESKTOP_TOKEN) && !it.contains(MOBILE_TOKEN) }
            }
        )
        note("desktop site: ${userAgent()}")
        SystemClock.sleep(1_500)
        shot("06-desktop-site")
        openMenu()
        assertEquals("the Desktop Site row reads checked while it is on", true, checkRowChecked(DESKTOP_LABEL))
        shot("07-desktop-site-checked")
        beat()
        assertTrue(
            "Desktop Site under a second finger switched the user agent back",
            touchTapLabelExpecting(DESKTOP_LABEL, "the mobile user agent is back", timeoutMs = 12_000) { userAgent().contains(MOBILE_TOKEN) }
        )
        SystemClock.sleep(1_500)

        // 6. Page Info: the v2 prompt sheet – the host, the Connection row (a loopback page is a local site), Done.
        openMenu()
        assertTrue(
            "Page Info under a finger brought the sheet up",
            touchTapLabelExpecting(INFO_LABEL, "the Page Info sheet is up", timeoutMs = 8_000) { findNode { it == LOCAL_SITE_LABEL } != null }
        )
        assertTrue("the Page Info sheet names the host", findNode { it == HOST } != null)
        SystemClock.sleep(1_200)
        shot("08-page-info-light")
        beat()
        assertTrue("Done took a finger", touchTapLabel(DONE_LABEL))
        SystemClock.sleep(1_000)

        // 7. Add to Home Screen: the name prompt with the title prefilled, then the launcher's pin dialog.
        openMenu()
        assertTrue(
            "Add to Home Screen under a finger brought the name prompt up",
            touchTapLabelExpecting(ADD_HOME_LABEL, "the name prompt is up", timeoutMs = 8_000) { findNode { it == ADD_LABEL } != null }
        )
        assertTrue("the name field is on the sheet, prefilled with the page's title", awaitTrue(4_000) { nameField() != null })
        note("add to home screen: the field reads '${nameField()?.text}'")
        SystemClock.sleep(1_000)
        shot("09-add-to-home-light")
        beat()
        assertTrue("Add took a finger", touchTapLabel(ADD_LABEL))
        val pinShown = awaitTrue(8_000) { pinDialogUp() }
        note("add to home screen: the launcher's pin dialog ${if (pinShown) "came up" else "did not come up"}; windows: ${windowLabels()}")
        SystemClock.sleep(1_500)
        shot("10-pin-dialog")
        if (pinShown) {
            back()
            SystemClock.sleep(1_200)
        }
        ensureCustomTab()

        // 8. Download Page: the archive lands in Downloads.
        openMenu()
        val archivesBefore = archives()
        assertTrue(
            "Download Page under a finger saved the archive",
            touchTapLabelExpecting(DOWNLOAD_LABEL, "a new MHTML archive is in Downloads", timeoutMs = 15_000) { archives().size > archivesBefore.size }
        )
        note("download page: archives in Downloads = ${archives()}")
        SystemClock.sleep(1_500)
        shot("11-downloaded")
        beat()

        // 9. Close back to the caller.
        clickByLabel(CLOSE_LABEL)
        assertTrue("closing the custom tab returned to the caller", waitForWindow(callerPackage, 8_000))
        SystemClock.sleep(1_500)

        // 10. A light tab whose caller disabled the Bookmark and Download buttons: the row respreads without them.
        showCaller(customTabIntent(dark = false, disabled = true))
        openCustomTab()
        openMenu()
        readIconRow("a light tab with the caller's two buttons disabled", bookmark = false, download = false)
        readRows()
        shot("12-disabled-buttons-light")
        beat()
        dismissSheet()
        clickByLabel(CLOSE_LABEL)
        assertTrue("closing the second custom tab returned to the caller", waitForWindow(callerPackage, 8_000))
        SystemClock.sleep(1_200)

        // 11. The dark scheme: the full row and the sheets, then the disabled row.
        showCaller(customTabIntent(dark = true, disabled = false))
        openCustomTab()
        openMenu()
        readIconRow("a dark tab", bookmark = true, download = true)
        shot("13-icon-row-dark")
        beat()
        assertTrue(
            "Page Info (dark) under a finger brought the sheet up",
            touchTapLabelExpecting(INFO_LABEL, "the Page Info sheet is up", timeoutMs = 8_000) { findNode { it == LOCAL_SITE_LABEL } != null }
        )
        SystemClock.sleep(1_200)
        shot("14-page-info-dark")
        beat()
        touchTapLabel(DONE_LABEL)
        SystemClock.sleep(1_000)
        openMenu()
        assertTrue(
            "Add to Home Screen (dark) under a finger brought the name prompt up",
            touchTapLabelExpecting(ADD_HOME_LABEL, "the name prompt is up", timeoutMs = 8_000) { findNode { it == ADD_LABEL } != null }
        )
        SystemClock.sleep(1_000)
        shot("15-add-to-home-dark")
        beat()
        touchTapLabel(CANCEL_LABEL)
        SystemClock.sleep(1_000)
        clickByLabel(CLOSE_LABEL)
        assertTrue("closing the dark custom tab returned to the caller", waitForWindow(callerPackage, 8_000))
        SystemClock.sleep(1_200)
        showCaller(customTabIntent(dark = true, disabled = true))
        openCustomTab()
        openMenu()
        readIconRow("a dark tab with the caller's two buttons disabled", bookmark = false, download = false)
        shot("16-disabled-buttons-dark")
        beat()
        dismissSheet()
        clickByLabel(CLOSE_LABEL)
        assertTrue("closing the fourth custom tab returned to the caller", waitForWindow(callerPackage, 8_000))
        SystemClock.sleep(1_200)

        // 12. A page the browser holds as a bookmark: the star is filled from the core's state.json
        //     at open, reads Edit Bookmark, and its tap opens the page in Zenium.
        showCaller(customTabIntent(dark = false, disabled = false, url = bookmarkedUrl()))
        openCustomTab(BOOKMARKED_PATH)
        openMenu()
        assertTrue("the star is filled from the browser's store (Edit Bookmark)", findNode { it == EDIT_BOOKMARK_LABEL } != null)
        assertTrue("no empty star on a bookmarked page", findNode { it == BOOKMARK_LABEL } == null)
        shot("17-star-from-store")
        beat()
        assertTrue(
            "Edit Bookmark under a finger opened the page in Zenium",
            touchTapLabelExpecting(EDIT_BOOKMARK_LABEL, "the browser's window with its address pill is up", timeoutMs = 12_000) {
                findByLabelPrefix(PILL_LABEL) != null
            }
        )
        SystemClock.sleep(4_000)
        shot("18-edit-in-zenium")
        note("edit bookmark: the browser shows ${findByLabelPrefix(PILL_LABEL)}")

        Log.i(tag, "session events: $events; caller hits: $callerHits")
        note("session events: $events")
        note("start animation frames (ms since the press -> toolbar left edge px, -1 none): $startFrames")
        val honoured = startAnimationHonoured()
        note("start animation ${if (honoured) "HONOURED: the caller's two-second slide ran" else "NOT SEEN: the tab arrived without the caller's slide"}")
        if (PIN_START_ANIMATION) {
            assertTrue(
                "the caller's start animation ran (setStartAnimations, CCT-08): the tab's OPEN transition animated for the caller's two seconds; " +
                    "transition ${startTransition?.line}; frames $startFrames",
                honoured
            )
        }
    }

    // --- the start animation (CCT-08) ------------------------------------------------------------

    /**
     * Press the caller's button and read how the custom tab arrived. The read that carries the
     * verdict is the platform's own: WindowManager logs every shell transition, and the OPEN
     * transition that brings [CustomTabActivity] closes with a `Finish Transition #n: ...
     * sent=Xms finished=Yms` line whose two stamps bound the animation – the caller's slide is
     * two seconds, the theme's own slide-up 300 ms, the platform's default open under half a
     * second ([readStartTransition]). The frames sampled meanwhile ([toolbarLeftEdge]) are the
     * second witness: run 1 showed a display screenshot does not render the transition's leash
     * (the toolbar was in none of the frames taken while the recording shows it sliding), so
     * they say where the toolbar stands once the transition is over, not how it moved.
     */
    private fun openCustomTabReadingStart() {
        startFrames.clear()
        startProbes.clear()
        startTransition = null
        val before = System.currentTimeMillis()
        assertTrue("the caller's button is on screen", clickByLabel(READ_LABEL))
        val pressed = SystemClock.uptimeMillis()
        while (SystemClock.uptimeMillis() - pressed < START_SAMPLE_MS) {
            val at = SystemClock.uptimeMillis() - pressed
            val bitmap = ui.takeScreenshot() ?: continue
            startFrames += at to toolbarLeftEdge(bitmap)
            startProbes += frameProbe(at, bitmap)
            bitmap.recycle()
        }
        Log.i(tag, "start frames: $startFrames")
        Log.i(tag, "start probes: $startProbes")
        assertTrue("the custom tab came up", waitForWindow(app.packageName, 15_000))
        assertTrue("the custom tab's toolbar is up", waitFor(CLOSE_LABEL, 10_000) != null)
        waitForPath(STORY_PATH)
        startTransition = readStartTransition(before, 10_000)
        Log.i(tag, "start transition: $startTransition")
        SystemClock.sleep(1_000)
        landedEdge = ui.takeScreenshot()?.let { bitmap -> toolbarLeftEdge(bitmap).also { bitmap.recycle() } } ?: -1
        val honoured = startAnimationHonoured()
        note(
            "start transition: " + (startTransition?.let { "#${it.id} OPEN ${it.animationMs?.let { ms -> "animated $ms ms" } ?: "animation length not logged"} (${it.line})" } ?: "not found in WindowManager's log")
        )
        note(
            "start animation: ${startFrames.size} frames in $START_SAMPLE_MS ms; " +
                "toolbar edge ${startFrames.map { "${it.first}ms=${it.second}" }}; landed edge $landedEdge; " +
                if (honoured) "the caller's slide was HONOURED through the trampoline" else "the caller's slide was NOT SEEN"
        )
        note("start frames probed: $startProbes")
        // The verdict is asserted at the end of the sequence (PIN_START_ANIMATION), once the rest
        // of the evidence is on disk: what the platform does with the options through the
        // trampoline is a reading first, a pin second.
    }

    /** The OPEN transition that brought the custom tab: its id, how long its animation ran, and the line that said so. */
    private data class StartTransition(val id: Int, val animationMs: Long?, val line: String)

    private var startTransition: StartTransition? = null
    /** The toolbar's left edge once the tab has landed (a screenshot after the transition), -1 without a toolbar. */
    private var landedEdge = -1

    /**
     * WindowManager's account of the custom tab's OPEN transition, read through the shell's
     * logcat (the instrumentation's shell can read every process's log): the `info={id=n t=OPEN
     * ... m=OPEN ... CustomTabActivity ...}` line names the transition, and its `Finish
     * Transition #n: ... sent=Xms finished=Yms` line stamps when the animation was handed to the
     * shell and when the shell reported it done. The shell's own `Playing animation for (#n)` /
     * `Transition animation finished ... (#n)` pair is the fallback. Polled, since the finish line
     * lands when the animation ends and the emulator's log buffer is small.
     */
    private fun readStartTransition(sinceEpochMs: Long, timeoutMs: Long): StartTransition? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var id: Int? = null
        while (SystemClock.uptimeMillis() < deadline) {
            val lines = shellCommand("logcat -d -v epoch -s WindowManager:V WindowManagerShell:V").lines()
            if (id == null) {
                id = lines.firstOrNull { line ->
                    epochMsOf(line) >= sinceEpochMs - 1_000 && "t=OPEN" in line && "m=OPEN" in line && "CustomTabActivity" in line && "info={id=" in line
                }?.let { Regex("info=\\{id=(\\d+)").find(it)?.groupValues?.get(1)?.toIntOrNull() }
            }
            val found = id
            if (found != null) {
                lines.firstOrNull { "Finish Transition #$found:" in it }?.let { finish ->
                    val sent = Regex("sent=([\\d.]+)ms").find(finish)?.groupValues?.get(1)?.toDoubleOrNull()
                    val finished = Regex("finished=([\\d.]+)ms").find(finish)?.groupValues?.get(1)?.toDoubleOrNull()
                    val ms = if (sent != null && finished != null) (finished - sent).toLong() else null
                    return StartTransition(found, ms, finish.substringAfter("WindowManager:").trim())
                }
                val playing = lines.firstOrNull { "Playing animation for (#$found)" in it }
                val done = lines.firstOrNull { "Transition animation finished" in it && "(#$found)" in it }
                if (playing != null && done != null) {
                    return StartTransition(found, epochMsOf(done) - epochMsOf(playing), "shell: playing ${epochMsOf(playing)} finished ${epochMsOf(done)}")
                }
            }
            SystemClock.sleep(300)
        }
        return id?.let { StartTransition(it, null, "no finish line for #$it within $timeoutMs ms") }
    }

    /** The stamp of a `logcat -v epoch` line in ms (0 for a line without one). */
    private fun epochMsOf(line: String): Long =
        line.trim().substringBefore(' ').toDoubleOrNull()?.let { (it * 1_000).toLong() } ?: 0L

    /**
     * The caller's slide is honoured when the tab's OPEN transition animated for at least
     * [CALLER_SLIDE_MIN_MS] – the caller's two seconds, against the theme's 300 ms slide-up and
     * the platform's default open under half a second – and the toolbar stands home once the
     * tab has landed ([landedEdge] at the screen's edge). Without the transition in the log the
     * frames decide: a toolbar still well inside the screen 400 ms after the press, then home.
     */
    private fun startAnimationHonoured(): Boolean {
        val home = landedEdge in 0..2
        val animated = startTransition?.animationMs
        if (animated != null) return animated >= CALLER_SLIDE_MIN_MS && home
        val sliding = startFrames.any { (at, edge) -> at >= 400 && edge >= width / 8 }
        return sliding && home
    }

    /**
     * The leftmost pixel of the custom tab's toolbar colour in the band where the toolbar stands
     * (from the status bar's middle to 52 dp under it, every sixth row), -1 when no row has it.
     * The colour is this driver's own (a green no other surface on screen wears: the caller is
     * blue and white, the page white).
     */
    private fun toolbarLeftEdge(bitmap: Bitmap): Int {
        val statusBar = statusBarPx()
        val bottom = minOf(bitmap.height - 1, statusBar + (52 * density).toInt())
        var edge = -1
        var y = statusBar / 2
        while (y <= bottom) {
            val limit = if (edge < 0) bitmap.width else edge
            for (x in 0 until limit) {
                if (isToolbarColour(bitmap.getPixel(x, y))) {
                    edge = x
                    break
                }
            }
            y += 6
        }
        return edge
    }

    /** What a sampled frame was: its shape, and the pixels at the band's right end and middle, as hex. */
    private fun frameProbe(at: Long, bitmap: Bitmap): String {
        val y = minOf(bitmap.height - 1, statusBarPx() + (24 * density).toInt())
        val right = bitmap.getPixel(bitmap.width - 8, y) and 0xFFFFFF
        val mid = bitmap.getPixel(bitmap.width / 2, y) and 0xFFFFFF
        return "${at}ms ${bitmap.width}x${bitmap.height} ${bitmap.config} ${bitmap.colorSpace?.name} y=$y right=#%06x mid=#%06x".format(right, mid)
    }

    private fun isToolbarColour(pixel: Int): Boolean =
        abs(Color.red(pixel) - Color.red(TOOLBAR)) <= 24 &&
            abs(Color.green(pixel) - Color.green(TOOLBAR)) <= 24 &&
            abs(Color.blue(pixel) - Color.blue(TOOLBAR)) <= 24

    private fun statusBarPx(): Int {
        val id = app.resources.getIdentifier("status_bar_height", "dimen", "android")
        return if (id != 0) app.resources.getDimensionPixelSize(id) else (24 * density).toInt()
    }

    // --- the menu's reads --------------------------------------------------------------------------

    /** The icon row as the sheet shows it: the five, less the caller's disabled two. */
    private fun readIconRow(where: String, bookmark: Boolean, download: Boolean) {
        val present = listOf(FORWARD_LABEL, BOOKMARK_LABEL, EDIT_BOOKMARK_LABEL, DOWNLOAD_LABEL, INFO_LABEL, RELOAD_LABEL, STOP_LABEL)
            .filter { findNode { text -> text == it } != null }
        note("icon row on $where: $present")
        assertTrue("Forward is in the icon row on $where", FORWARD_LABEL in present)
        assertTrue("Page Info is in the icon row on $where", INFO_LABEL in present)
        assertTrue("Reload (or Stop) is in the icon row on $where", RELOAD_LABEL in present || STOP_LABEL in present)
        assertEquals("the star is ${if (bookmark) "in" else "out of"} the icon row on $where", bookmark, BOOKMARK_LABEL in present || EDIT_BOOKMARK_LABEL in present)
        assertEquals("Download Page is ${if (download) "in" else "out of"} the icon row on $where", download, DOWNLOAD_LABEL in present)
    }

    /** The rows under the icon row: the caller's two, then Zenium's, then Open in Zenium. */
    private fun readRows() {
        val expected = listOf(SAVE_LABEL, OPEN_IN_APP_LABEL, SHARE_LABEL, COPY_LINK_LABEL, FIND_LABEL, ADD_HOME_LABEL, DESKTOP_LABEL, OPEN_IN_ZENIUM_LABEL)
        val missing = expected.filter { findNode { text -> text == it } == null }
        note("rows: ${expected - missing.toSet()}${if (missing.isNotEmpty()) "; MISSING $missing" else ""}")
        assertTrue("every row of Chrome's custom tab menu is on the sheet; missing: $missing", missing.isEmpty())
        // The icon row's button is the one clickable Reload (or Stop) on the sheet: no Reload text row (§9.13).
        assertEquals("Reload reads once, in the icon row", 1, clickables(RELOAD_LABEL) + clickables(STOP_LABEL))
    }

    private fun clickables(label: String): Int = findNodes(label).count { it.isClickable }

    /** The Add to Home Screen prompt's field: the editable node holding the page's title. */
    private fun nameField(): AccessibilityNodeInfo? = findNodeWhere { it.isEditable && it.text?.toString() == STORY_TITLE }

    /** Whether the icon row's button reading `label` is enabled (the button node itself, not a row's text). */
    private fun iconEnabled(label: String): Boolean {
        val node = awaitNode(5_000) { it == label } ?: error("no '$label' on the sheet")
        return node.isEnabled
    }

    /** The check row's tick, read from the checkable node (the row; its label's text node is not checkable). */
    private fun checkRowChecked(label: String): Boolean? {
        val deadline = SystemClock.uptimeMillis() + 5_000
        while (SystemClock.uptimeMillis() < deadline) {
            findNodes(label).firstOrNull { it.isCheckable }?.let { return it.isChecked }
            SystemClock.sleep(200)
        }
        return null
    }

    /** The launcher's pin confirmation is up: a window of another package reading its title or button. */
    private fun pinDialogUp(): Boolean {
        val top = topPackage() ?: return false
        if (top == app.packageName || top == callerPackage) {
            // Some launchers show the confirmation over the requesting app's window: look at every window.
            return findInWindows(null) { it.contains("Home screen", ignoreCase = true) || it == "Add automatically" } != null
        }
        return true
    }

    /** What the windows on screen say (a few labels each), for the findings when a look fails. */
    private fun windowLabels(): String = ui.windows.mapNotNull { window ->
        val root = window.root ?: return@mapNotNull null
        val labels = ArrayList<String>()
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < 300 && labels.size < 10) {
            val node = queue.removeFirst()
            visited++
            val text = (node.contentDescription ?: node.text)?.toString()?.trim()
            if (!text.isNullOrEmpty()) labels += text.take(40)
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        "${root.packageName}=$labels"
    }.joinToString("; ")

    /** The tab's inbox document's URLs (the star's filings), read from the profile directory the driver shares. */
    private fun inboxUrls(): List<String> {
        val file = File(app.filesDir, "zen/${CustomTabBookmarks.INBOX}")
        if (!file.isFile) return emptyList()
        return CustomTabBookmarks.entries(runCatching { file.readText() }.getOrNull()).map { it.url }
    }

    /** The MHTML archives this app put in MediaStore Downloads (the rows it owns), by display name. */
    private fun archives(): List<String> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            val dir = app.getExternalFilesDir(android.os.Environment.DIRECTORY_DOWNLOADS) ?: return emptyList()
            return dir.listFiles()?.filter { it.name.endsWith(".${SavePageLogic.EXTENSION}") }?.map { it.name } ?: emptyList()
        }
        val names = ArrayList<String>()
        app.contentResolver.query(
            MediaStore.Downloads.EXTERNAL_CONTENT_URI,
            arrayOf(MediaStore.MediaColumns.DISPLAY_NAME),
            "${MediaStore.MediaColumns.DISPLAY_NAME} LIKE ?",
            arrayOf("%.${SavePageLogic.EXTENSION}"),
            null
        )?.use { c -> while (c.moveToNext()) names += c.getString(0) }
        return names
    }

    private fun userAgent(): String = customTab()?.page?.let { evalJs(it, "navigator.userAgent") } ?: ""

    private fun note(line: String) {
        Log.i(tag, line)
        if (::findings.isInitialized) findings.appendText(line + "\n")
    }

    override fun noteLine(line: String) = note(line)

    // --- the client side -------------------------------------------------------------------------

    /** Bind the provider service as a client app does, and prepare a session with a callback. */
    private fun connect() {
        val latch = CountDownLatch(1)
        val bound = CustomTabsClient.bindCustomTabsService(app, app.packageName, object : CustomTabsServiceConnection() {
            override fun onCustomTabsServiceConnected(name: ComponentName, connected: CustomTabsClient) {
                client = connected
                latch.countDown()
            }

            override fun onServiceDisconnected(name: ComponentName?) {
                client = null
            }
        })
        assertTrue("bindCustomTabsService(${app.packageName})", bound)
        assertTrue("the Custom Tabs service connected", latch.await(15, TimeUnit.SECONDS))
        val c = client ?: error("no client after connecting")
        Log.i(tag, "warmup: ${c.warmup(0)}")
        session = c.newSession(object : CustomTabsCallback() {
            override fun onNavigationEvent(navigationEvent: Int, extras: Bundle?) {
                val name = when (navigationEvent) {
                    NAVIGATION_STARTED -> "NAVIGATION_STARTED"
                    NAVIGATION_FINISHED -> "NAVIGATION_FINISHED"
                    NAVIGATION_FAILED -> "NAVIGATION_FAILED"
                    NAVIGATION_ABORTED -> "NAVIGATION_ABORTED"
                    TAB_SHOWN -> "TAB_SHOWN"
                    TAB_HIDDEN -> "TAB_HIDDEN"
                    else -> "event $navigationEvent"
                }
                events.add(name)
            }
        }) ?: error("newSession returned null")
    }

    /** The caller's side of its two menu items: broadcasts received here, logged as the caller's hits. */
    private fun listenForCallerActions() {
        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                callerHits.add("${intent.action?.substringAfterLast('.')}:${intent.dataString}")
                Log.i(tag, "caller received ${intent.action} for ${intent.dataString}")
            }
        }
        val filter = IntentFilter().apply {
            addAction(ACTION_SAVE)
            addAction(ACTION_OPEN_IN_APP)
            addDataScheme("http")
            addDataScheme("https")
        }
        ContextCompat.registerReceiver(app, r, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        receiver = r
    }

    private fun callerAction(action: String, requestCode: Int): PendingIntent {
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
        return PendingIntent.getBroadcast(app, requestCode, Intent(action).setPackage(app.packageName), flags)
    }

    /**
     * What a client builds: the session, the title, share on, two menu items, this driver's own
     * toolbar colour (light) or Zenium's (dark); with `disabled`, the two extras that take the
     * Bookmark and Download buttons off the menu's icon row; and the caller's start animations
     * (the slide of `res/anim/cct_demo_start_enter.xml`, resolved in the caller's own package).
     */
    private fun customTabIntent(dark: Boolean, disabled: Boolean, url: String = storyUrl()): CustomTabsIntent {
        val s = session ?: error("no session")
        val builder = CustomTabsIntent.Builder(s)
            .setShowTitle(true)
            .setShareState(CustomTabsIntent.SHARE_STATE_ON)
            .addMenuItem(SAVE_LABEL, callerAction(ACTION_SAVE, 1))
            .addMenuItem(OPEN_IN_APP_LABEL, callerAction(ACTION_OPEN_IN_APP, 2))
            .setBookmarksButtonEnabled(!disabled)
            .setDownloadButtonEnabled(!disabled)
            .setStartAnimations(instrumentation.context, callerAnim("cct_demo_start_enter"), callerAnim("cct_demo_start_exit"))
            .setExitAnimations(instrumentation.context, android.R.anim.fade_in, android.R.anim.slide_out_right)
        if (dark) {
            builder.setColorScheme(CustomTabsIntent.COLOR_SCHEME_DARK)
        } else {
            builder.setColorScheme(CustomTabsIntent.COLOR_SCHEME_LIGHT)
                .setDefaultColorSchemeParams(CustomTabColorSchemeParams.Builder().setToolbarColor(TOOLBAR).build())
        }
        val built = builder.build()
        built.intent.data = Uri.parse(url)
        // Clients aim the intent at the provider they bound (CustomTabsClient.getPackageName).
        built.intent.setPackage(app.packageName)
        return built
    }

    /** An animation of the caller's own resources (the instrumentation APK's), by name. */
    private fun callerAnim(name: String): Int {
        val id = instrumentation.context.resources.getIdentifier(name, "anim", callerPackage)
        check(id != 0) { "the caller's animation $name is missing from the instrumentation APK" }
        return id
    }

    // --- the caller ------------------------------------------------------------------------------

    /**
     * Bring Nimbus News up (or forward) holding the custom tab for its button – with `startOptions`
     * the intent's `startAnimationBundle` too, which the caller passes to `startActivity` as
     * `CustomTabsIntent.launchUrl` does.
     */
    private fun showCaller(launch: CustomTabsIntent, startOptions: Boolean = true) {
        val intent = Intent()
            .setClassName(callerPackage, CALLER_ACTIVITY)
            .putExtra(CustomTabCallerActivity.EXTRA_LAUNCH, launch.intent)
            .putExtra(CustomTabCallerActivity.EXTRA_BROWSER, app.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        if (startOptions) launch.startAnimationBundle?.let { intent.putExtra(CustomTabCallerActivity.EXTRA_LAUNCH_OPTIONS, it) }
        app.startActivity(intent)
        assertTrue("the caller app came up", waitForWindow(callerPackage, 15_000))
        SystemClock.sleep(2_000)
    }

    /** Press the caller's button and wait for the custom tab and its page. */
    private fun openCustomTab(path: String = STORY_PATH) {
        assertTrue("the caller's button is on screen", clickByLabel(READ_LABEL))
        assertTrue("the custom tab came up", waitForWindow(app.packageName, 15_000))
        assertTrue("the custom tab's toolbar is up", waitFor(CLOSE_LABEL, 10_000) != null)
        waitForPath(path)
        SystemClock.sleep(2_500)
    }

    /** Back in the custom tab after a system surface (the launcher's dialog) may have covered it. */
    private fun ensureCustomTab() {
        if (topPackage() == app.packageName) return
        Log.w(tag, "the custom tab is not in front (${topPackage()}); pressing back")
        back()
        waitForWindow(app.packageName, 5_000)
        SystemClock.sleep(800)
    }

    // --- moves -----------------------------------------------------------------------------------

    private fun openMenu() {
        ensureForeground()
        assertTrue("the menu button is on screen", clickByLabel(MENU_LABEL))
        assertTrue("the menu sheet came up", waitFor(OPEN_IN_ZENIUM_LABEL, 6_000) != null)
        SystemClock.sleep(1_200)
    }

    private fun dismissSheet() {
        if (findByLabel(OPEN_IN_ZENIUM_LABEL) != null) {
            back()
            SystemClock.sleep(1_200)
        }
    }

    private fun topPackage(): String? = ui.rootInActiveWindow?.packageName?.toString()

    private fun waitForWindow(packageName: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (topPackage() == packageName) return true
            SystemClock.sleep(200)
        }
        Log.w(tag, "window of $packageName never came up; top is ${topPackage()}")
        return false
    }

    // --- the page --------------------------------------------------------------------------------

    /** The custom tab that is resumed, if one is (the driver shares Zenium's process). */
    private fun customTab(): CustomTabActivity? {
        var found: CustomTabActivity? = null
        instrumentation.runOnMainSync {
            found = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<CustomTabActivity>().firstOrNull()
        }
        return found
    }

    private fun pathOf(page: TabWebView?): String? = page?.let { evalJs(it, "location.pathname + ':' + document.readyState") }?.substringBefore(':')

    /** Wait until the custom tab's page is at `path` and has finished loading. */
    private fun waitForPath(path: String) {
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < deadline) {
            val page = customTab()?.page
            val state = if (page != null) evalJs(page, "location.pathname + ':' + document.readyState") else null
            if (state == "$path:complete") return
            SystemClock.sleep(400)
        }
        Log.w(tag, "the page never reported $path complete")
    }

    /** Where the story's link to the second page is on screen. */
    private fun plantLink(page: TabWebView): PointF? {
        val text = evalJs(page, LINK_POINT_JS) ?: run {
            Log.w(tag, "the link's point came back empty")
            return null
        }
        val origin = IntArray(2)
        instrumentation.runOnMainSync { page.getLocationOnScreen(origin) }
        val point = JSONObject(text)
        return PointF(origin[0] + point.getDouble("x").toFloat(), origin[1] + point.getDouble("y").toFloat())
    }

    private fun evalJs(page: TabWebView, script: String): String? {
        val latch = CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            page.evaluateJavascript(script) {
                result = it
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return runCatching { JSONTokener(result ?: "null").nextValue() as? String }.getOrNull()
    }

    // --- the pages -------------------------------------------------------------------------------

    private fun storyUrl() = "http://$HOST:$PORT$STORY_PATH"
    private fun bookmarkedUrl() = "http://$HOST:$PORT$BOOKMARKED_PATH"

    private fun routes(): Map<String, Pair<String, ByteArray>> = mapOf(
        STORY_PATH to (HTML to page(STORY_TITLE, "Every long span has a note of its own. Engineers tune it out with dampers.", link = true).toByteArray()),
        SECOND_PATH to (HTML to page("Tuned mass dampers", "A second page of the story, one step forward in the tab's history.").toByteArray()),
        BOOKMARKED_PATH to (HTML to page(BOOKMARKED_TITLE, "A page the browser already holds as a bookmark.").toByteArray())
    )

    private fun page(title: String, body: String, link: Boolean = false): String = """
        <!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
        <title>$title</title>
        <style>body{margin:0;padding:24px 20px;font:17px/1.5 system-ui,sans-serif;color:#1d1d2c;background:#fff}
        h1{font-size:26px;line-height:1.2;margin:0 0 14px}p{margin:0 0 18px}
        a.next{display:block;padding:20px 18px;border-radius:14px;background:#eef2ff;color:#1d1d2c;text-decoration:none;font-weight:600;margin-top:28px}</style></head>
        <body><h1>$title</h1><p>$body</p><p>$body</p>
        ${if (link) """<a class="next" id="next" href="$SECOND_PATH">Continue to the second page →</a>""" else ""}
        </body></html>
    """.trimIndent()

    companion object {
        private const val CALLER_ACTIVITY = "app.zen.chromium.CustomTabCallerActivity"
        private const val HOST = "127.0.0.1"
        private const val PORT = 8137
        private const val HTML = "text/html; charset=utf-8"
        private const val STORY_PATH = "/story.html"
        private const val SECOND_PATH = "/second.html"
        private const val BOOKMARKED_PATH = "/bookmarked.html"
        private const val STORY_TITLE = "Why suspension bridges hum"
        private const val BOOKMARKED_TITLE = "Damping, bookmarked"
        /** This driver's toolbar colour: a green nothing else on screen wears, so the start frames can find the toolbar. */
        private const val TOOLBAR = 0xFF0E8A5F.toInt()
        /**
         * How long the frames are sampled after the caller's button: the launch (run 1 took
         * a second from the press to the transition's start on the CI emulator), the caller's
         * two-second slide and its landing.
         */
        private const val START_SAMPLE_MS = 4_200L
        /**
         * The least an OPEN transition must animate to be the caller's two-second slide rather
         * than the theme's 300 ms slide-up or the platform's default open (under half a second).
         */
        private const val CALLER_SLIDE_MIN_MS = 1_200L
        /**
         * Whether the run fails when the caller's start animation is not seen. Off for the first
         * reading (what the platform does with the caller's options across the provider's
         * trampoline is the question the run answers); on once a run has read it honoured, so a
         * change of the provider's that clobbers it fails the nightly.
         */
        private const val PIN_START_ANIMATION = false
        private const val ACTION_SAVE = "app.zen.chromium.demo.SAVE"
        private const val ACTION_OPEN_IN_APP = "app.zen.chromium.demo.OPEN_IN_APP"

        private const val READ_LABEL = "Read the story"
        private const val SAVE_LABEL = "Save for later"
        private const val OPEN_IN_APP_LABEL = "Open in Nimbus News"
        private const val CLOSE_LABEL = "Close"
        private const val MENU_LABEL = "Menu"
        private const val SHARE_LABEL = "Share…"
        private const val COPY_LINK_LABEL = "Copy Link"
        private const val FIND_LABEL = "Find in Page"
        private const val ADD_HOME_LABEL = "Add to Home Screen"
        private const val DESKTOP_LABEL = "Desktop Site"
        private const val OPEN_IN_ZENIUM_LABEL = "Open in Zenium"
        private const val FORWARD_LABEL = "Forward"
        private const val BOOKMARK_LABEL = "Bookmark"
        private const val EDIT_BOOKMARK_LABEL = "Edit Bookmark"
        private const val DOWNLOAD_LABEL = "Download Page"
        private const val INFO_LABEL = "Page Info"
        private const val RELOAD_LABEL = "Reload"
        private const val STOP_LABEL = "Stop"
        private const val LOCAL_SITE_LABEL = "Local site"
        private const val DONE_LABEL = "Done"
        private const val ADD_LABEL = "Add"
        private const val CANCEL_LABEL = "Cancel"
        private const val MOBILE_TOKEN = " Mobile Safari/"
        private const val DESKTOP_TOKEN = "X11; Linux x86_64"

        /** The story's link's centre in device pixels relative to the WebView. */
        private val LINK_POINT_JS = """
            (function () {
              var a = document.getElementById('next');
              if (!a) return null;
              a.scrollIntoView({block: 'center'});
              var vv = window.visualViewport;
              var scale = (vv ? vv.scale : 1) * (window.devicePixelRatio || 1);
              var r = a.getBoundingClientRect();
              return JSON.stringify({
                x: (r.left + r.width / 2 - (vv ? vv.offsetLeft : 0)) * scale,
                y: (r.top + r.height / 2 - (vv ? vv.offsetTop : 0)) * scale
              });
            })()
        """.trimIndent()
    }
}
