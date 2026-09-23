package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records the request blocking UI on the phone: the blocked count climbing as the demo page asks
 * nine real ad and tracking hosts again – spoken at the pill's address stop and read on the
 * shield's row of the site-information sheet, whose finger leads to Settings (the pill carries no
 * shield on the phone, v2 §9.29 / OMN-02) – then the Settings tab's Privacy
 * and Security section (`pages/settings/tracking.tsx`: the master switch, the level as a picker
 * sheet, the counter, the filter lists as item rows with a sheet each, the sites without
 * blocking), a level change the Kotlin engine follows, the current site excepted from its switch
 * row and blocked again from its item's sheet, and the master switch off and on.
 *
 * Every row is found through the chrome's accessibility tree the way a screen reader would (a
 * row is one button whose text runs its label and description together) and pressed with a real
 * injected touch; the outcome is checked against the core's state through `window.zen` and the
 * engine's snapshot, and written to `<shotPrefix>-notes.txt` next to the screenshots. The page
 * comes from a loopback server in this process, as in [BlockingDemo].
 *
 * The rule in [DemoHarness] (the audit after #194): every sheet flow here – the app menu's
 * Settings row, the level picker's option (both ways), the list sheet's "Use this list" switch
 * (off, then on again), the excepted site's "Block on this site again" – puts a finger on a
 * control inside the sheet and asserts what the control did against the core's state (the
 * level, the list's state, the exception's absence, the Settings tab coming up), with the Kotlin
 * engine's filter count following as the second reading; a touch that did not take is a
 * [touchFault] the run fails on at its end, and the command or the accessibility click is only
 * the way on so the recording covers the rest. The rows on the page (the level row, a list's
 * row, the site's switch row, the master switch) are touched too ([tapRow]), with a second
 * finger at the row's own rectangle in the chrome when the tree's bounds trailed a scroll.
 */
@RunWith(AndroidJUnit4::class)
class BlockingUiDemo : DemoHarness("blocking-demo-state.json", "services-blocking-android-ui", "blocking-ui-demo") {
    override val tag = "BlockingUiDemo"
    private lateinit var server: LoopbackPage
    private lateinit var notes: File

    @Test
    fun record() {
        server = LoopbackPage(readAsset("blocking-demo-page.html"), PORT).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
    }

    override fun warmUp() {
        notes = File(out, "services-blocking-android-ui-notes.txt")
        notes.writeText("Zenium Android blocking UI demo\n\n")
        note("demo server: ${server.selfCheck()}")
        // The bundled snapshot is installed by the core after boot and the Kotlin engine follows
        // the index; wait for every enabled list to have its filters and the snapshot to settle.
        val deadline = SystemClock.uptimeMillis() + 150_000
        var status = blockingStatus()
        var lastReport = 0L
        while (SystemClock.uptimeMillis() < deadline && !(status.getBoolean("ready") && enabledListsHaveFilters(status))) {
            if (SystemClock.uptimeMillis() - lastReport > 10_000) {
                lastReport = SystemClock.uptimeMillis()
                note("waiting: ${describeLists(status)} | kotlin ${describeEngine()}")
            }
            SystemClock.sleep(1_000)
            status = blockingStatus()
        }
        val enabledCount = enabledListCount(status)
        var stable = 0
        var lastFilterCount = -1
        while (SystemClock.uptimeMillis() < deadline && stable < 3) {
            val snap = engine.snapshot
            if (snap.setCount >= enabledCount && snap.filterCount > 0 && snap.filterCount == lastFilterCount) stable++ else stable = 0
            lastFilterCount = snap.filterCount
            SystemClock.sleep(1_000)
        }
        note("engine ready=${status.getBoolean("ready")} enabled=${status.getBoolean("enabled")} level=${level()}")
        note("lists: ${describeLists(status)}")
        note("kotlin engine: ${describeEngine()}")
        for (attempt in 1..3) {
            coreInvoke("tab.reload", """{"tabId":"$DEMO_TAB","skipCache":true}""")
            val tab = waitForTitle("9/9", 15_000).getJSONObject("tabs").optJSONObject(DEMO_TAB)
            if (tab?.optString("title")?.startsWith("9/9") == true) break
            Log.w(tag, "attempt $attempt: page settled at '${tab?.optString("title")}'")
            SystemClock.sleep(3_000)
        }
        // The Settings page is a chunk of its own that loads on its first open: pay for it off
        // camera, then put the profile back as seeded (the warm tab closed, the demo page active).
        val warm = coreInvoke("page.open", """{"id":"settings","section":"privacy"}""")
        val painted = awaitChrome("document.querySelector('[data-row=\"tracking-enabled\"]')", 15_000)
        SystemClock.sleep(800)
        coreInvoke("tab.close", """{"tabId":$warm}""")
        SystemClock.sleep(800)
        ensureDemoTab()
        note("warm-up: the Settings chunk ${if (painted) "painted" else "did NOT paint"} off camera")
        val close = closeUrlField()
        if (!close.ok) note("warm-up: ${close.describe()}")
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        // 1. The count: nine requests blocked on the page. The pill carries no shield on the phone
        //    (v2 §9.29, OMN-02): its address stop speaks the count, and the count sits on the
        //    shield's row inside the site-information sheet.
        note("\n1. the blocked count at the address")
        var s = waitForBlocked(9)
        note("  ${describeTab(s)}")
        note("  address stop: ${addressSpoken() ?: "(not in the accessibility tree)"}")
        shot("01-page-count-9")
        beat()

        // 1b. The shield's row: the site icon opens the sheet, the row reads the count, and a
        //     finger on it leads to Settings > Privacy and Security (the lists and the site
        //     exceptions), the sheet leaving for the tab; then back to the page as it was.
        note("\n1b. the shield's row in the site-information sheet")
        openSiteInfo()
        note("  shield row: ${rowText("Requests blocked") ?: "(not in the accessibility tree)"}")
        shot("01b-siteinfo-shield-9")
        beat()
        if (touchTapLabelExpecting("Requests blocked", "the Settings tab is at $SECTION", prefix = true) {
                atPrivacy()
            }
        ) {
            awaitSurface(up = true, timeoutMs = 6_000)
            SystemClock.sleep(800)
            shot("01c-shield-row-to-privacy")
            activeCoreTab()?.optString("id")?.takeIf { it != DEMO_TAB }?.let { coreInvoke("tab.close", """{"tabId":"$it"}""") }
            SystemClock.sleep(600)
        } else {
            closeSheets()
        }
        ensureDemoTab()
        beat()

        // 2. The counter rises: the page asks the same hosts again, twice.
        note("\n2. the counter rising")
        askAgain()
        s = waitForBlocked(18)
        note("  ${describeTab(s)}")
        note("  address stop: ${addressSpoken() ?: "(not in the accessibility tree)"}")
        shot("02-page-count-18")
        askAgain()
        s = waitForBlocked(27)
        note("  ${describeTab(s)}")
        shot("03-page-count-27")
        beat()

        // 3. Settings > Privacy and Security from the app menu (a finger on the menu's Settings
        // row, the tab coming up on it asserted), then the section from the landing.
        note("\n3. Settings > Privacy and Security")
        if (!openPrivacySettings(throughMenu = true)) {
            note("  Settings did not open; the rest of the sequence needs it")
            touchFault("the Settings tab never came to the Privacy and Security section")
            return
        }
        note("  counter row: ${rowText("Blocked since Zenium started") ?: "(not in the accessibility tree)"}")
        shot("04-settings-privacy")
        beat()

        // 4. The level: the picker sheet, Balanced -> Strict adds uBlock Origin's privacy list; the engine
        // follows, its filter count growing (the sets are the same files, one of them turned on).
        // The option is the picker's injected touch: the core's level must flip on it.
        note("\n4. level Balanced -> Strict through the picker sheet")
        val before = engine.snapshot.filterCount
        if (openPicker("Level", "tracking-level", "Strict")) {
            SystemClock.sleep(600)
            shot("05-level-picker")
            beat()
            if (pickOption("Strict", "the core's level is strict") { level() == "strict" }) {
                note("  level=${level()} engine followed in ${waitForEngine { it.filterCount > before }} ms (${describeEngine()})")
                awaitNoSheet()
                revealRow("Level")
                SystemClock.sleep(600)
                shot("06-level-strict")
                beat()
            } else {
                note("  the Strict option did not take (level=${level()})")
                closeSheets()
            }
        } else {
            note("  the Level row did not open its picker")
        }
        note("\n   level Strict -> Balanced")
        val strictFilters = engine.snapshot.filterCount
        if (openPicker("Level", "tracking-level", "Balanced") &&
            pickOption("Balanced", "the core's level is balanced") { level() == "balanced" }
        ) {
            note("  level=${level()} engine followed in ${waitForEngine { it.filterCount < strictFilters }} ms (${describeEngine()})")
            awaitNoSheet()
        } else {
            note("  the Balanced option did not take (level=${level()}); setting it through the command")
            closeSheets()
            setLevel("balanced")
        }

        // 5. The filter lists as item rows, and one list's sheet.
        note("\n5. filter lists")
        if (revealRow("Filter lists") != null) {
            SystemClock.sleep(600)
            note("  lists: ${describeLists(blockingStatus())}")
            shot("07-filter-lists")
            beat()
        }
        if (tapRow("EasyList", "tracking-list:easylist") { rowBounds("Use this list", 0) != null }) {
            SystemClock.sleep(800)
            shot("08-list-sheet")
            beat()
            // The list sheet's injected touch: a finger on its "Use this list" switch row turns
            // EasyList off – the core's lists must say so, and the Kotlin engine follows with
            // fewer filters – and a second finger turns it on again, the engine back where it was.
            val withList = engine.snapshot.filterCount
            if (touchTapLabelExpecting("Use this list", "EasyList is off in the core's lists") { !listEnabled("easylist") }) {
                note("  Use this list off: ${describeLists(blockingStatus())}")
                note("  engine followed in ${waitForEngine { it.filterCount < withList }} ms (${describeEngine()})")
                SystemClock.sleep(600)
                shot("08b-list-sheet-off")
                beat()
                if (touchTapLabelExpecting("Use this list", "EasyList is on again in the core's lists") { listEnabled("easylist") }) {
                    note("  Use this list on again: engine followed in ${waitForEngine { it.filterCount >= withList }} ms (${describeEngine()})")
                } else {
                    note("  the second touch did not turn the list on again; restoring it through the command")
                    restoreListDefault("easylist")
                }
            } else {
                note("  the switch row did not take under a finger (${describeLists(blockingStatus())})")
                restoreListDefault("easylist")
            }
            SystemClock.sleep(600)
            closeSheets()
        } else {
            note("  the EasyList row did not open its sheet")
        }

        // 6. Sites without blocking: the current site's switch row, off to except it.
        note("\n6. per-site exception from the current site's row")
        // Should the section have been left (a back too many), come back to it before looking for its rows.
        if (!atPrivacy() && !openPrivacySettings(throughMenu = false)) {
            note("  the section is not up; skipping the row")
        }
        if (revealRow("Sites without blocking") != null) {
            SystemClock.sleep(600)
            shot("09-sites")
            beat()
        }
        if (setSiteRow(excepted = true)) {
            note("  siteExceptions=${blockingStatus().getJSONArray("siteExceptions")}")
            revealRow("Block on $DEMO_SITE")
            SystemClock.sleep(1_200)
            shot("10-site-excepted")
            beat()
        } else {
            note("  the row did not toggle; excepting through the command")
            coreInvoke("blocking.setSiteException", """{"site":"$DEMO_ORIGIN","excepted":true}""")
        }

        // 7. The page again: nothing blocked, the address stop and the shield's row say so.
        note("\n7. the excepted page")
        ensureDemoTab()
        coreInvoke("tab.reload", """{"tabId":"$DEMO_TAB","skipCache":true}""")
        s = waitForTitle("0/9", 25_000)
        note("  ${describeTab(s)}")
        note("  address stop: ${addressSpoken() ?: "(not in the accessibility tree)"}")
        shot("11-page-excepted")
        beat()
        openSiteInfo()
        note("  shield row: ${rowText("Requests blocked") ?: "(not in the accessibility tree)"}")
        shot("11b-siteinfo-shield-excepted")
        beat()
        closeSheets()
        SystemClock.sleep(800)

        // 8. Back in Settings the site is an item row; its sheet's action blocks on it again.
        note("\n8. the exception's row and its sheet")
        if (openPrivacySettings(throughMenu = false) && revealRow("Sites without blocking") != null) {
            SystemClock.sleep(600)
            shot("12-sites-excepted-row")
            beat()
            if (tapRow(DEMO_SITE, "tracking-site:$DEMO_ORIGIN") { rowBounds("Block on this site again", 0) != null }) {
                SystemClock.sleep(800)
                shot("13-site-sheet")
                beat()
                // The site sheet's injected touch: a finger on its action, and the exception must
                // leave the core's list on it (the sheet closes with its row, which is not the claim).
                if (touchTapLabelExpecting("Block on this site again", "the site's exception is gone from the core") { !siteExcepted() }) {
                    note("  after the sheet's action: siteExceptions=${blockingStatus().getJSONArray("siteExceptions")}")
                    awaitNoSheet()
                    SystemClock.sleep(1_200)
                    shot("14-sites-blocked-again")
                    beat()
                } else {
                    note("  the sheet's action did not take under a finger; resetting through the command")
                    closeSheets()
                    coreInvoke("blocking.setSiteException", """{"site":"$DEMO_ORIGIN","excepted":false}""")
                }
            } else {
                note("  the site's row did not open its sheet; resetting through the command")
                coreInvoke("blocking.setSiteException", """{"site":"$DEMO_ORIGIN","excepted":false}""")
            }
        }

        // 9. The master switch: off (the dependent rows dim to 40 %), on again.
        note("\n9. master switch")
        if (setMasterSwitch(enabled = false)) {
            note("  enabled=${blockingStatus().getBoolean("enabled")} engine followed in ${waitForEngine { it.filterCount == 0 }} ms")
            revealRow("Block ads and trackers")
            SystemClock.sleep(1_200)
            note("  counter row: ${rowText("Blocked since Zenium started")}")
            shot("15-master-off")
            beat()
            if (setMasterSwitch(enabled = true)) {
                note("  enabled=${blockingStatus().getBoolean("enabled")} engine followed in ${waitForEngine { it.filterCount > 0 }} ms")
                SystemClock.sleep(1_200)
                note("  counter row: ${rowText("Blocked since Zenium started")}")
                shot("16-master-on")
                beat()
            }
        } else {
            note("  the master switch row did not toggle")
        }

        // 10. The page once more: blocked again, the session total higher than before.
        note("\n10. the page, blocked again")
        ensureDemoTab()
        coreInvoke("tab.reload", """{"tabId":"$DEMO_TAB","skipCache":true}""")
        s = waitForTitle("9/9", 25_000)
        note("  ${describeTab(s)}")
        shot("17-page-blocked-again")
        note("\ndone")
    }

    // --- the Settings tab through the accessibility tree ------------------------------------------

    private val host: Host get() = (activity as MainActivity).host

    /**
     * The Privacy and Security section of the Settings tab: from the app menu (Settings, then the
     * category row on the landing) the first time, through `page.open` – which reuses the tab and
     * takes it to the section – after. True once the section's first row is in the tree.
     *
     * The menu is a sheet flow: the harness puts the finger on its Settings row once the row's
     * bounds hold still ([openMenuItem]), and the Settings tab must come up on it – else a
     * [touchFault] the run fails on at its end, and `page.open` is the way on so the recording
     * goes on. The category row on the landing is a page row: a finger, and the tab must come
     * to the section on it, the core's command standing in when it did not.
     */
    private fun openPrivacySettings(throughMenu: Boolean): Boolean {
        ensureForeground()
        if (throughMenu) {
            if (!openMenuItem("Settings")) {
                touchFault("no Settings row in the app menu to touch")
                closeSheets()
                coreInvoke("page.open", """{"id":"settings"}""")
            } else if (awaitPage(SETTINGS_URL, 12_000) == null) {
                touchFault("the touch on the app menu's Settings row did not open the Settings tab")
                closeSheets()
                coreInvoke("page.open", """{"id":"settings"}""")
            } else {
                Log.i(tag, "the touch on the menu's Settings row took: the Settings tab is up")
            }
            if (awaitPage(SETTINGS_URL, 12_000) == null) {
                Log.w(tag, "Settings did not come up")
                return false
            }
            SystemClock.sleep(1_200)
            if (rowBounds(SECTION, 8_000) == null) {
                Log.w(tag, "no $SECTION category on the landing")
            } else if (!touchTapLabelExpecting(SECTION, "the tab is at the section", prefix = true) {
                    atPrivacy()
                }
            ) {
                Log.w(tag, "the landing's $SECTION row did not take the tab to the section")
            }
            if (!atPrivacy()) {
                coreInvoke("page.open", """{"id":"settings","section":"privacy"}""")
            }
        } else {
            coreInvoke("page.open", """{"id":"settings","section":"privacy"}""")
        }
        if (awaitPage("$SETTINGS_URL/privacy", 12_000) == null) {
            Log.w(tag, "the tab did not come to the section")
            return false
        }
        awaitSurface(up = true, timeoutMs = 6_000)
        val there = rowBounds("Block ads and trackers", 10_000) != null
        SystemClock.sleep(800)
        return there
    }

    /** Back to the demo page's tab through the core (the Settings tab stays open behind it). */
    private fun ensureDemoTab() {
        if (activeCoreTab()?.optString("id") == DEMO_TAB) return
        coreInvoke("tab.activate", """{"tabId":"$DEMO_TAB"}""")
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline && activeCoreTab()?.optString("id") != DEMO_TAB) SystemClock.sleep(250)
        SystemClock.sleep(1_000)
    }

    /** Poll until the active tab shows `url`; that tab, or null when it does not come in time. */
    private fun awaitPage(url: String, timeoutMs: Long): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab != null && pageIs(tab.optString("url"), url)) return tab
            SystemClock.sleep(250)
        }
        Log.w(tag, "the active tab did not come to $url")
        return null
    }

    /**
     * Whether a tab's address is the page `url`, its query aside: since #305 the shield row
     * opens Privacy on the site's group, `zen://settings/privacy?site=<origin>`
     * (`internalPageUrl`), and the landing reached from a tab already at a section keeps the
     * tab's address. The nightly's run matched the whole string and read every Settings step
     * as not taken.
     */
    private fun pageIs(address: String, url: String): Boolean =
        address == url || address.startsWith("$url?") || (url == SETTINGS_URL && address.startsWith("$url/"))

    /** The Settings tab stands at Privacy and Security: the tab's address, or the page's own word (`data-section`). */
    private fun atPrivacy(): Boolean =
        activeCoreTab()?.optString("url")?.let { pageIs(it, "$SETTINGS_URL/privacy") } == true || settingsSectionIs(PRIVACY_SECTION)

    /**
     * The bounds of the first node whose accessible text reads `text` – exactly or as a prefix: a
     * Settings row is one button whose text runs its label and description together, and a
     * label's own span answers too. Polls, since the tree trails the screen on the emulator; a
     * node the list holds below the fold is scrolled into view first.
     */
    private fun rowBounds(text: String, timeoutMs: Long): Rect? {
        // The chrome's document first (the tree trails the screen by seconds here; a row it has
        // and the tree has not yet is a row all the same), the tree's node after.
        settingsRowRect(text)?.let { return it }
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var revealed = false
        do {
            val node = findNode { it == text || it.startsWith(text) }
            if (node != null) {
                val bounds = Rect().also { node.getBoundsInScreen(it) }
                val onScreen = bounds.width() > 0 && bounds.height() > 0 &&
                    bounds.centerY() in 0 until height && bounds.centerX() in 0 until width
                if (onScreen) return bounds
                if (!revealed) {
                    revealed = true
                    node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
                    SystemClock.sleep(1_000)
                    continue
                }
            }
            SystemClock.sleep(200)
        } while (SystemClock.uptimeMillis() < deadline)
        return null
    }

    /** Scroll the row reading `text` into view; where it is then, or null when it is not there. */
    private fun revealRow(text: String): Rect? = rowBounds(text, 6_000)

    /** The whole text of the row reading `text` (its label and description as the tree runs them). */
    private fun rowText(text: String): String? =
        findNode { it.startsWith(text) }?.let { it.text ?: it.contentDescription }?.toString()

    /**
     * Press the row reading `label` on the PAGE (the section's own rows, never a sheet's) and
     * wait for `settled`. The finger goes in once the row is scrolled into view and its bounds
     * hold still, inside the touchable window ([touchTapLabel]); when the change never comes,
     * a second finger at the row's own rectangle in the chrome (`data-row` is the row's id): the
     * tree trails the screen by seconds on the software-rendered emulator and reports a scrolled
     * row where it was, the stated reason a page row keeps a second touch – a real one, never a
     * click through the tree, and noted when it was needed. The controls inside a sheet go
     * through [touchTapLabelExpecting] and [pickOption], whose miss is a fault of the run. False
     * when the row is not there or the change never came.
     */
    private fun tapRow(label: String, rowId: String, settled: () -> Boolean): Boolean {
        if (settled()) return true
        if (rowBounds(label, 8_000) == null) Log.w(tag, "no row reading '$label' in the tree") else {
            SystemClock.sleep(400)
            if (touchTapLabel(label, prefix = true) && awaitSettled(settled, 5_000)) return true
            Log.w(tag, "'$label' did not take at the tree's bounds; tapping the chrome's own rectangle")
            note("  ('$label' did not take at the tree's bounds; a second finger at the chrome's rectangle)")
        }
        val point = chromePoint("[data-row=${JSONObject.quote(rowId)}]") ?: run {
            Log.w(tag, "no row $rowId in the chrome")
            return false
        }
        Finger().tap(point.x, point.y)
        return awaitSettled(settled, 5_000)
    }

    /** Open a value row's picker sheet; true once the option reading `option` is in the tree. */
    private fun openPicker(label: String, rowId: String, option: String): Boolean =
        tapRow(label, rowId) { optionNode(option) != null }

    /**
     * The picker's checkable row whose text starts with `option`: the radio, not the sheet's
     * description, which starts with "Strict" too and is not checkable.
     */
    private fun optionNode(option: String): AccessibilityNodeInfo? =
        findNodeWhere { n -> n.isCheckable && (n.text?.toString() ?: n.contentDescription?.toString())?.startsWith(option) == true }

    /**
     * A finger on the picker's option reading `option` – the picker sheet's injected touch (the
     * rule in [DemoHarness]) – and the core must report the change (`settled`, named by
     * `effect`): true once it does. The finger goes in where the option's bounds have held still
     * and inside the touchable window ([touchTap]), once more when the node was replaced under
     * the first read. An option that did not apply under the finger is the sheet not taking the
     * touch – a [touchFault] the run fails on at its end – and the accessibility click is then
     * the way on so the recording goes on. False when nothing in the picker reads `option`, or
     * the change never comes either way.
     */
    private fun pickOption(option: String, effect: String, settled: () -> Boolean): Boolean {
        var node = optionNode(option) ?: run {
            Log.w(tag, "no option reading '$option' in the picker")
            return false
        }
        var touched = touchTap(node)
        if (!touched) {
            SystemClock.sleep(500)
            node = optionNode(option) ?: node
            touched = touchTap(node)
        }
        if (touched) {
            if (awaitSettled(settled, 5_000)) {
                Log.i(tag, "the touch on the '$option' option took: $effect")
                return true
            }
            touchFault("the touch on the picker's '$option' option did not take: not $effect within 5000 ms")
        } else {
            touchFault("the picker's '$option' option has no bounds on screen to touch")
        }
        Log.w(tag, "'$option' did not take under a finger; clicking it through the tree so the demo goes on")
        (optionNode(option) ?: node).performAction(AccessibilityNodeInfo.ACTION_CLICK)
        return awaitSettled(settled, 5_000)
    }

    private fun awaitSettled(settled: () -> Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (settled()) return true
            SystemClock.sleep(250)
        }
        return false
    }

    /** How many sheets the chrome has mounted (a closing one counts until its spring has carried it out). */
    private fun sheetCount(): Int = chromeValue("String(document.querySelectorAll('.zen-sheet').length)").toIntOrNull() ?: -1

    /** Wait for the last sheet to leave (a picker closes on its pick, an item's sheet with its row). */
    private fun awaitNoSheet() {
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (SystemClock.uptimeMillis() < deadline && sheetCount() != 0) SystemClock.sleep(200)
    }

    /**
     * Back out of the sheets that are up, a few at most; the section itself stays. Each back is
     * given until the closing sheet has left the tree before the count is read again: a sheet on
     * its way out still counts, and a back pressed on top of it would take the section itself back
     * to the landing (run 35418016367 lost the exception rows to that).
     */
    private fun closeSheets() {
        var count = sheetCount()
        repeat(3) {
            if (count <= 0) return
            back()
            val deadline = SystemClock.uptimeMillis() + 6_000
            while (SystemClock.uptimeMillis() < deadline && sheetCount() >= count) SystemClock.sleep(200)
            count = sheetCount()
        }
    }

    /** The master switch through its row; true once the core reports `enabled`. */
    private fun setMasterSwitch(enabled: Boolean): Boolean =
        tapRow("Block ads and trackers", "tracking-enabled") { blockingStatus().getBoolean("enabled") == enabled }

    /** The current site's switch row; true once the core lists (or no longer lists) the site's exception. */
    private fun setSiteRow(excepted: Boolean): Boolean =
        tapRow("Block on $DEMO_SITE", "tracking-site-current") { siteExcepted() == excepted }

    private fun setLevel(level: String) {
        val b = coreState().getJSONObject("settings").getJSONObject("blocking")
        b.put("level", level)
        coreInvoke("settings.update", JSONObject().put("blocking", b).toString())
    }

    /** Whether the core lists the filter list `id` as enabled right now (`state.blocking.lists`). */
    private fun listEnabled(id: String): Boolean {
        val lists = blockingStatus().getJSONArray("lists")
        for (i in 0 until lists.length()) {
            val l = lists.getJSONObject(i)
            if (l.getString("id") == id) return l.getBoolean("enabled")
        }
        return false
    }

    /**
     * Drop the per-list override for `id` through the settings command, so the level's own
     * choice for the list stands again (what the sheet's switch does when a touch on it did not).
     */
    private fun restoreListDefault(id: String) {
        val b = coreState().getJSONObject("settings").getJSONObject("blocking")
        val lists = b.optJSONObject("lists") ?: JSONObject()
        lists.remove(id)
        b.put("lists", lists)
        coreInvoke("settings.update", JSONObject().put("blocking", b).toString())
    }

    private fun siteExcepted(): Boolean {
        val sites = blockingStatus().getJSONArray("siteExceptions")
        return (0 until sites.length()).any { sites.getString(it) == DEMO_ORIGIN }
    }

    /**
     * The pill's address stop as TalkBack reads it: the host, then the shield's state the pill no
     * longer draws (v2 §9.29: the shield and its count are the site-information sheet's row) –
     * `Address, <host>, <n> requests blocked`, `…, Blocking off for this site`, `…, Blocking off`;
     * the host alone on a quiet page (`pillChipsSpoken` in components/phone/pillChips.tsx).
     */
    private fun addressSpoken(): String? =
        findNode { it.startsWith("Address,") }?.let { it.contentDescription ?: it.text }?.toString()

    /**
     * The pill's site icon opens the site-information sheet, where the shield's row is (its name
     * runs its label and the count together: "Requests blocked, 9"; `SheetRow` in
     * components/siteinfo/SiteInfoSheet.tsx). A finger on the icon; the start of the pill when
     * the tree does not carry the icon (the other demos' fallback).
     */
    private fun openSiteInfo() {
        val icon = findByLabel(SITE_ICON_LABEL)?.takeIf { it.top > height * 0.6 }
        if (icon != null) Finger().tap(icon.exactCenterX(), icon.exactCenterY())
        else {
            note("  (site icon not in the accessibility tree; tapping the start of the pill)")
            Finger().tap(pill.left + 22 * density, pill.exactCenterY())
        }
        SystemClock.sleep(2_500)
    }

    // --- the chrome's bridge --------------------------------------------------------------------

    /** Evaluate in the chrome; the value as text ("" when it never answered). */
    private fun chromeValue(code: String): String =
        runCatching { org.json.JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    /** Poll the chrome until the expression `code` is true; false when it is not in time. */
    private fun awaitChrome(code: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (chromeValue("String(!!($code))") == "true") return true
            SystemClock.sleep(200)
        }
        return chromeValue("String(!!($code))") == "true"
    }

    /** Where the middle of the first chrome element matching `selector` is on screen, or null. */
    private fun chromePoint(selector: String): PointF? {
        val raw = chromeJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        var origin = IntArray(2)
        instrumentation.runOnMainSync { origin = IntArray(2).also(host.chrome::getLocationOnScreen) }
        SystemClock.sleep(400)
        return PointF(origin[0] + point.getDouble(0).toFloat() * density, origin[1] + point.getDouble(1).toFloat() * density)
    }

    private fun blockingStatus(): JSONObject = coreState().getJSONObject("blocking")

    private fun level(): String = coreState().getJSONObject("settings").getJSONObject("blocking").optString("level")

    private val engine: app.zen.chromium.blocking.Blocking get() = host.blocking

    /** Milliseconds until the Kotlin engine's snapshot satisfies `ready`; gives up after 20 s and says so. */
    private fun waitForEngine(ready: (app.zen.chromium.blocking.EngineSnapshot) -> Boolean): Long {
        val started = SystemClock.uptimeMillis()
        while (SystemClock.uptimeMillis() - started < 20_000) {
            if (ready(engine.snapshot)) return SystemClock.uptimeMillis() - started
            SystemClock.sleep(50)
        }
        note("  (the engine's snapshot did not follow: ${describeEngine()})")
        return SystemClock.uptimeMillis() - started
    }

    /** The demo page asks its nine third-party hosts again (cache-busted), the way it did on load. */
    private fun askAgain() {
        val tab = host.tabs.get(DEMO_TAB) ?: run {
            note("  no WebView for $DEMO_TAB")
            return
        }
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            tab.evaluateJavascript(ASK_AGAIN_JS) { latch.countDown() }
        }
        latch.await(5, TimeUnit.SECONDS)
    }

    /** Poll the tab's blocked count up to `n` and hand back the state then. */
    private fun waitForBlocked(n: Int, timeoutMs: Long = 20_000): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = coreState()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = s.getJSONObject("tabs").optJSONObject(DEMO_TAB)
            if (tab != null && tab.optInt("blockedCount") >= n) {
                SystemClock.sleep(1_000)
                return coreState()
            }
            SystemClock.sleep(400)
            s = coreState()
        }
        Log.w(tag, "blockedCount never reached $n")
        return s
    }

    /** Poll the tab's title (the page writes its tally into it) and hand back the state then. */
    private fun waitForTitle(prefix: String, timeoutMs: Long = 20_000): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = coreState()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = s.getJSONObject("tabs").optJSONObject(DEMO_TAB)
            if (tab != null && tab.optString("title").startsWith(prefix) && !tab.optBoolean("loading")) {
                SystemClock.sleep(1_200)
                return coreState()
            }
            SystemClock.sleep(500)
            s = coreState()
        }
        Log.w(tag, "title '$prefix' never showed up")
        return s
    }

    private fun enabledListsHaveFilters(status: JSONObject): Boolean {
        val lists = status.getJSONArray("lists")
        var enabled = 0
        for (i in 0 until lists.length()) {
            val l = lists.getJSONObject(i)
            if (!l.getBoolean("enabled")) continue
            enabled++
            if (l.getInt("filterCount") == 0) return false
        }
        return enabled > 0
    }

    private fun enabledListCount(status: JSONObject): Int {
        val lists = status.getJSONArray("lists")
        return (0 until lists.length()).count { lists.getJSONObject(it).getBoolean("enabled") }
    }

    private fun describeLists(status: JSONObject): String {
        val lists = status.getJSONArray("lists")
        return (0 until lists.length()).joinToString(", ") {
            val l = lists.getJSONObject(it)
            "${l.getString("id")}(${if (l.getBoolean("enabled")) "on" else "off"}, ${l.getInt("filterCount")} filters)"
        }
    }

    private fun describeEngine(): String =
        "${engine.snapshot.filterCount} network filters from ${engine.snapshot.setCount} sets, " +
            "last build ${engine.lastBuildMs} ms (${engine.builds} builds)"

    /** The tab's url, title and counter plus the session total. */
    private fun describeTab(s: JSONObject): String {
        val tab = s.getJSONObject("tabs").optJSONObject(DEMO_TAB) ?: return "$DEMO_TAB gone"
        return "url=${tab.optString("url")} title=\"${tab.optString("title")}\" " +
            "blockedCount=${tab.optInt("blockedCount")} sessionBlocked=${s.getJSONObject("blocking").optInt("sessionBlocked")}"
    }

    private fun note(line: String) {
        Log.i(tag, line)
        notes.appendText(line + "\n")
    }

    // --- the page's server ----------------------------------------------------------------------

    /** Serves the demo page on the IPv4 loopback: `/` is the page, `/ok.js` and `/ok.png` its own resources. */
    private class LoopbackPage(private val page: String, port: Int) : Thread("blocking-ui-demo-server") {
        private val socket = ServerSocket(port, 16, InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1)))
        @Volatile private var closed = false

        fun selfCheck(): String = runCatching {
            Socket("127.0.0.1", socket.localPort).use { s ->
                s.soTimeout = 5_000
                s.getOutputStream().write("GET / HTTP/1.1\r\nHost: 127.0.0.1:${socket.localPort}\r\n\r\n".toByteArray())
                s.getOutputStream().flush()
                "listening on ${socket.localSocketAddress}, GET / -> ${s.getInputStream().bufferedReader().readLine()}"
            }
        }.getOrElse { e -> "listening on ${socket.localSocketAddress}, GET / failed: $e" }

        override fun run() {
            while (!closed) {
                val client = try {
                    socket.accept()
                } catch (_: Exception) {
                    if (closed) return else continue
                }
                Thread { serve(client) }.start()
            }
        }

        private fun serve(client: Socket) {
            client.use {
                val request = it.getInputStream().bufferedReader()
                val line = request.readLine() ?: return
                while (true) {
                    val header = request.readLine()
                    if (header.isNullOrEmpty()) break
                }
                val path = line.split(' ').getOrNull(1) ?: "/"
                val (type, body) = when (path.substringBefore('?')) {
                    "/ok.js" -> "text/javascript" to "window.__ok = true\n".toByteArray()
                    "/ok.png" -> "image/png" to PIXEL
                    else -> "text/html; charset=utf-8" to page.toByteArray()
                }
                val out = it.getOutputStream()
                out.write(
                    ("HTTP/1.1 200 OK\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\n" +
                        "Cache-Control: no-store\r\nConnection: close\r\n\r\n").toByteArray()
                )
                out.write(body)
                out.flush()
            }
        }

        fun close() {
            closed = true
            runCatching { socket.close() }
        }

        companion object {
            /** A 1x1 transparent PNG. */
            private val PIXEL = android.util.Base64.decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
                android.util.Base64.DEFAULT
            )
        }
    }

    companion object {
        /** The port the seeded tab's URL names (`blocking-demo-state.json`). */
        private const val PORT = 18123
        private const val DEMO_ORIGIN = "http://127.0.0.1:$PORT"
        private const val DEMO_TAB = "tab_demo"
        /** How Settings names the site (`exceptionHost`: scheme and host for anything but https). */
        private const val DEMO_SITE = DEMO_ORIGIN
        private const val SECTION = "Privacy and Security"
        private const val SITE_ICON_LABEL = "Site information"
        private const val SETTINGS_URL = "zen://settings"

        /** The page's nine third-party resources once more, as the page itself asks for them. */
        private val ASK_AGAIN_JS = """
            (function () {
              var again = Date.now()
              var r = [
                ['s', 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'],
                ['s', 'https://static.doubleclick.net/instream/ad_status.js'],
                ['s', 'https://cdn.taboola.com/libtrc/unip/1/tfa.js'],
                ['s', 'https://c.amazon-adsystem.com/aax2/apstag.js'],
                ['s', 'https://www.googletagmanager.com/gtag/js?id=G-DEMO'],
                ['s', 'https://www.google-analytics.com/analytics.js'],
                ['s', 'https://connect.facebook.net/en_US/fbevents.js'],
                ['s', 'https://static.hotjar.com/c/hotjar-1.js?sv=6'],
                ['i', 'https://sb.scorecardresearch.com/p?c1=2&c2=1']
              ]
              r.forEach(function (x) {
                var url = x[1] + (x[1].indexOf('?') < 0 ? '?' : '&') + 'again=' + again
                if (x[0] === 's') { var el = document.createElement('script'); el.async = true; el.src = url; document.body.appendChild(el) }
                else { new Image().src = url }
              })
              return r.length
            })()
        """.trimIndent()
    }
}
