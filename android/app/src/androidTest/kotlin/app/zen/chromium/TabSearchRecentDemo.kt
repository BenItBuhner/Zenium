package app.zen.chromium

import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Records the phone overview's tab search (matrix TAB-21; v2 §9.3, §9.12, §11.4) and its Recent
 * pane (TAB-02; §9.17, §9.27, §10.3), every press a real touch and every outcome read off the
 * chrome's DOM or the core's state, never off the chrome's word alone:
 *
 *  1. the overview opens with the search closed: no field, no keyboard, no field focused;
 *  2. the header's magnifier opens the §9.12 field pinned under the header, focused, the
 *     keyboard up with it (the tap is the user's ask; nothing else ever focuses it);
 *  3. typing narrows the pane's cards by TITLE ("wiki": Damping, Tea, Coffee stay; the
 *     Research group's card stays, narrowed to Damping), the dropped cards departing in place
 *     (counted as they mount) and the survivors gliding (traced: `search-filter-overview`), the
 *     status region told "3 tabs found";
 *  4. a query nothing matches leaves "No tabs found" over the New Tab card, the group's card
 *     dissolved with its last match, the region told;
 *  5. the field's X clears the query: every card back, the field and the keyboard staying, the
 *     X now reading Close search;
 *  6. typing narrows by ADDRESS ("cern": World Wide Web alone, in its group's card, its title
 *     saying nothing of it);
 *  7. the system back: with the keyboard up it is the keyboard's (Android's rule, Chrome's
 *     omnibox the same), then it clears the query, then closes the field, the overview staying;
 *  8. Escape (a hardware keyboard's) clears then closes the same way, the soft keyboard put
 *     away first;
 *  9. a card closed by touch, then the Recent segment: Recently closed lists it; From your other
 *     devices, with sync off, reads §9.17's sentence and the row to Settings › Sync;
 * 10. the row leaves the overview for Settings › Sync;
 * 11. sync set up (the engine's own, over a plain directory: [FileTree] on the host's debug hook)
 *     and two other devices' `open-tabs` documents seeded into the folder; Sync now reads them;
 * 12. the Recent pane lists both devices, most recently published first, each heading the
 *     device's name with "Last active …", each tab a row with favicon, title and host;
 * 13. a remote row opens its page in a new active tab and the overview leaves;
 * 14. a device heading held: the Hide device sheet; Hide device takes the device off the list
 *     and Show 1 hidden device brings it back;
 * 15. a Recently closed row restores the tab and the overview leaves.
 *
 * Positions come from the chrome's DOM (`getBoundingClientRect`, checked once against the
 * accessibility bounds of the overview's Spaces button), because the WebView's accessibility
 * tree trails the software-rendered emulator by seconds; typing is injected key by key
 * ([keys]). Findings go to `tab-search-recent-findings.txt` next to the stills (one PASS or
 * FAIL per claim, ALL CHECKS PASSED at the end); the run fails on any FAIL. Profile
 * `overview-demo-state.json` (the select-tabs demo's): the Work space with the group Research
 * [World Wide Web, Damping] and the loose tabs example.com (active), Hacker News, RFC 2324,
 * Tea, Coffee, plus three Essentials. Driven by `android-tab-search-recent-demo.yml`. See
 * [DemoHarness] and [SelectTabsDemo], whose touch discipline this follows.
 */
@RunWith(AndroidJUnit4::class)
class TabSearchRecentDemo : DemoHarness("overview-demo-state.json", "tab-search-recent", "tabsearch-demo") {
    override val tag = "TabSearchRecentDemo"
    private lateinit var findings: File
    private var failures = 0
    private var shots = 0
    /** Set once the engine has this device's file in the folder: its salt, shared with the seeded devices. */
    private var salt: String? = null

    @Test
    fun record() {
        runDemo()
        if (failures > 0) error("$failures check(s) failed; see tab-search-recent-findings.txt")
    }

    /** Visit the next tab and come back so the two front cards have thumbnails. */
    override fun warmUp() {
        findings = File(out, "tab-search-recent-findings.txt")
        findings.writeText(
            "Zenium Android tab search and Recent pane checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        flingLeft(); settle()
        touchWithoutGesture(); settle()
        flingRight(); settle()
        touchWithoutGesture(); settle()
        watchToasts()
    }

    override fun demo() {
        openOverview()
        still("grid")
        openedClosed()
        searchOpensFromTheHeader()
        typingNarrowsByTitle()
        nothingFound()
        clearByX()
        typingNarrowsByAddress()
        backClearsThenCloses()
        escapeClearsThenCloses()
        recentWithSyncOff()
        rowToSyncSettings()
        setUpSyncWithTwoDevices()
        recentWithDevices()
        openRemoteTab()
        hideAndShowDevice()
        restoreClosedTab()

        finding(if (failures == 0) "\nALL CHECKS PASSED" else "\n$failures CHECK(S) FAILED")
    }

    // --- the scenarios ---------------------------------------------------------------------------

    /** 1. The overview opens with the search closed and the keyboard down. */
    private fun openedClosed() {
        finding("\n1. The overview opens with the search closed")
        expect("no field under the header", !inDom(FIELD))
        expect("the magnifier stands in the header, collapsed: ${headerLabels()}", headerLabels() == listOf("Search tabs", "Spaces", "More"))
        // The Tabs button that was touched may hold the focus; what matters is that no field does.
        expect("no field has the focus and the keyboard is down (active element: '${activeElement()}')", activeElement() != "INPUT" && !imeShown())
        // The Private segment draws only where the WebView has multi-profile (`capabilities.privateTabs`);
        // the Google APIs image's WebView has not, so the recipe reads Tabs | Recent.
        val segments = segmentLabels()
        expect("the segment reads Tabs | Recent (| Private where the WebView has profiles): $segments", segments == listOf("Tabs", "Recent") || segments == listOf("Tabs", "Recent", "Private"))
    }

    /** 2. The magnifier opens the field, focused, the keyboard with it. */
    private fun searchOpensFromTheHeader() {
        finding("\n2. The magnifier opens the field")
        openSearch()
        val field = domRect(FIELD)
        val header = domRect(".zen-overview > header")
        expect("the field is pinned under the header (field $field, header $header)", field != null && header != null && field.top >= header.bottom - 2 && field.top - header.bottom < 12 * density)
        val input = domRect(INPUT)
        expect("the field is the phone field: ${input?.height()?.let { (it / density).roundToInt() }} dp tall (40)", input != null && abs(input.height() / density - 40f) <= 2f)
        expect("the input has the focus", awaitUntil(3_000) { activeElement() == "INPUT" })
        expect("the keyboard came up with it", awaitIme(true, 8_000))
        expect("the magnifier reads expanded, controlling the field", jsString("(function(){var b=document.querySelector('$TOGGLE');return b&&b.getAttribute('aria-expanded')==='true'&&b.getAttribute('aria-controls')==='overview-search'?'yes':''})()") == "yes")
        expect("the X reads Close search while the field is empty", jsString(clearLabelJs()) == "Close search")
        expect("the placeholder is the omnibox's: '${placeholder()}'", placeholder() == "Title or address")
        still("search-open")
    }

    /** 3. "wiki" narrows the grid by title; the survivors glide, the rest depart; the count told. */
    private fun typingNarrowsByTitle() {
        finding("\n3. Typing narrows by title: 'wiki'")
        val before = cardBoxes()
        expect("every card stands before the query (${before.size} regular, ${essentialCount()} essentials)", before.size == CARDS && essentialCount() == ESSENTIALS)
        expect("the Research group stands as a group card with both its tabs: ${groupCards()}", groupCards().toSet() == setOf(WWW, DAMPING))
        watchExits()
        traceFrames("search-filter-overview", JankBudget.Kind.SPRING) {
            keys("wiki")
            // The dropped cards leave in place (§11.4) while the survivors glide on the same frames.
            SystemClock.sleep(1_600)
        }
        val after = awaitCards(setOf(DAMPING, TEA, COFFEE))
        expect("Damping, Tea and Coffee stay, the four others go: ${after.keys}", after.keys == setOf(DAMPING, TEA, COFFEE))
        expect("the group stays a group card, narrowed to its one match: ${groupCards()}", inDom(GROUP) && groupCards() == listOf(DAMPING))
        expect("the essentials narrowed too (none match)", essentialCount() == 0)
        val exits = exitsSeen()
        expect("the dropped cards departed in place over the grid (§11.4): $exits exit(s) drawn", exits >= 1)
        expect("the survivors glided from where they stood (Tea moved ${moved(before, after)} of 3)", moved(before, after) >= 1)
        expect("the status region told '3 tabs found'", awaitAnnouncement("3 tabs found"))
        expect("the X reads Clear search on a query", jsString(clearLabelJs()) == "Clear search")
        expect("the field holds the query: '${value()}'", value() == "wiki")
        still("search-wiki")
    }

    /** 4. A query nothing matches: "No tabs found" over the New Tab card. */
    private fun nothingFound() {
        finding("\n4. Nothing found: 'wikiz'")
        keys("z")
        expect("no card stands", awaitUntil(4_000) { cardBoxes().isEmpty() })
        expect("the group dissolved with its last match (no group card)", awaitDom("!document.querySelector('$GROUP')"))
        expect("'No tabs found' reads over the grid", awaitDom("document.querySelector('$EMPTY')&&document.querySelector('$EMPTY').textContent.trim()==='No tabs found'"))
        expect("the New Tab card stays", inDom(NEW_TAB))
        expect("the status region told 'No tabs found'", awaitAnnouncement("No tabs found"))
        still("search-none")
    }

    /** 5. The X clears the query; the field and the keyboard stay. */
    private fun clearByX() {
        finding("\n5. The X clears the query")
        touchUntil("the field's X", { domRect(CLEAR) }, { value().isEmpty() })
        expect("the query is gone", value().isEmpty())
        val cards = awaitCards((0 until CARDS).map { REGULAR[it] }.toSet())
        expect("every card is back: ${cards.size} regular, ${essentialCount()} essentials", cards.size == CARDS && essentialCount() == ESSENTIALS)
        expect("the group is a group card again", awaitDom("!!document.querySelector('$GROUP')"))
        expect("the field stays, focused, the keyboard up", inDom(FIELD) && activeElement() == "INPUT" && imeShown())
        expect("the X reads Close search again", jsString(clearLabelJs()) == "Close search")
        still("search-cleared")
    }

    /** 6. "cern" narrows by address: World Wide Web's title says nothing of it. */
    private fun typingNarrowsByAddress() {
        finding("\n6. Typing narrows by address: 'cern' (info.cern.ch)")
        keys("cern")
        val after = awaitCards(setOf(WWW))
        expect("World Wide Web alone stays: ${after.keys}", after.keys == setOf(WWW))
        expect("its title has no 'cern' in it: '${coreTitle(WWW)}'", !coreTitle(WWW).contains("cern", ignoreCase = true))
        expect("it stands in its group's card, the group narrowed to it: ${groupCards()}", groupCards() == listOf(WWW))
        expect("the status region told '1 tab found'", awaitAnnouncement("1 tab found"))
        still("search-cern")
    }

    /**
     * 7. The system back: with the keyboard up it is the keyboard's (Android's rule – the IME
     * window takes the key and hides; Chrome's omnibox behaves the same), then the chrome's:
     * the query first, the field second.
     */
    private fun backClearsThenCloses() {
        finding("\n7. The system back: the keyboard, the query, the field")
        expect("the keyboard is up with the query", imeShown())
        back()
        val keyboardFirst = awaitUntil(8_000) { !imeShown() || value().isEmpty() } && value().isNotEmpty()
        expect("with the keyboard up the back is the keyboard's: it goes, the query ('${value()}') and the field stay", keyboardFirst && !imeShown() && inDom(FIELD))
        if (keyboardFirst) back()
        expect("the next back clears the query, the field stays", awaitUntil(4_000) { value().isEmpty() } && inDom(FIELD))
        expect("every card is back", awaitCards(REGULAR.toSet()).size == CARDS)
        back()
        expect("the next back closes the field", awaitUntil(4_000) { !inDom(FIELD) })
        expect("the overview stays up", overviewOpen() || inDom(".zen-overview"))
        expect("the keyboard is down", awaitIme(false, 8_000))
        expect("the magnifier reads collapsed again", jsString("(function(){var b=document.querySelector('$TOGGLE');return b&&b.getAttribute('aria-expanded')==='false'?'yes':''})()") == "yes")
        still("search-closed")
    }

    /**
     * 8. Escape does what back does – a hardware keyboard's key, so the soft keyboard has no
     * part in it: it is put away first (on this image Gboard takes an Escape as a back, hiding
     * itself; a hardware keyboard would have kept it down), then Escape clears, and closes.
     */
    private fun escapeClearsThenCloses() {
        finding("\n8. Escape: the query first, the field second")
        openSearch()
        keys("tea")
        expect("'tea' leaves Tea alone", awaitCards(setOf(TEA)).keys == setOf(TEA))
        if (imeShown()) {
            pressKey(KeyEvent.KEYCODE_ESCAPE)
            val keyboardFirst = awaitUntil(6_000) { !imeShown() || value().isEmpty() } && value().isNotEmpty()
            finding("  (the keyboard was up: ${if (keyboardFirst) "the first Escape was its, the query stays" else "the chrome took the first Escape"})")
            if (!keyboardFirst) {
                expect("Escape cleared the query, the field stays", value().isEmpty() && inDom(FIELD))
                pressKey(KeyEvent.KEYCODE_ESCAPE)
                expect("the next Escape closes the field", awaitUntil(4_000) { !inDom(FIELD) })
                expect("the overview stays up", overviewOpen() || inDom(".zen-overview"))
                awaitIme(false, 6_000)
                return
            }
        }
        pressKey(KeyEvent.KEYCODE_ESCAPE)
        expect("Escape clears the query, the field stays", awaitUntil(4_000) { value().isEmpty() } && inDom(FIELD))
        pressKey(KeyEvent.KEYCODE_ESCAPE)
        expect("the next Escape closes the field", awaitUntil(4_000) { !inDom(FIELD) })
        expect("the overview stays up", overviewOpen() || inDom(".zen-overview"))
        awaitIme(false, 6_000)
    }

    /** 9. Coffee closed by touch; the Recent segment: the closed tab listed, sync off in the second group. */
    private fun recentWithSyncOff() {
        finding("\n9. A tab closed, then the Recent pane with sync off")
        val closed = touchUntil("Coffee's close", { show(card(COFFEE)); domRect("${card(COFFEE)} .zen-overview-card-close") }, { !tabExists(COFFEE) }, waitMs = 4_000)
        expect("Coffee's card closes the tab by touch", closed)
        awaitToastGone()
        toRecent()
        expect("the header reads Recent, without a count or a magnifier: ${headerLabels()}", headerTitle() == "Recent" && !inDom("[data-testid=\"overview-count\"]") && headerLabels() == listOf("Spaces"))
        expect("Recently closed lists Coffee", awaitUntil(6_000) { closedTitles().any { it.startsWith("Coffee") } })
        expect("the second group reads §9.17's sentence: '${textOf(SYNC_OFF)}'", textOf(SYNC_OFF) == "Turn on sync to see tabs from your other devices")
        expect("with the row to Settings › Sync: 'Turn on sync'", textRect(ACTION, "Turn on sync") != null)
        expect("the headings read Recently closed, From your other devices: ${headings()}", headings() == listOf("Recently closed", "From your other devices"))
        still("recent-sync-off")
    }

    /** 10. The Turn on sync row leaves the overview for Settings › Sync. */
    private fun rowToSyncSettings() {
        finding("\n10. The row to Settings › Sync")
        val left = touchUntil("the Turn on sync row", { textRect(ACTION, "Turn on sync") }, { activeCoreTab()?.optString("url") == SYNC_SETTINGS_URL }, waitMs = 8_000)
        expect("the row opens Settings › Sync in the active tab: ${activeCoreTab()?.optString("url")}", left)
        expect("the overview left", awaitUntil(6_000) { !inDom(".zen-overview") })
        still("sync-settings")
    }

    /**
     * 11. Sync on, over a plain directory (the host's debug hook), and two other devices' open
     * tabs in the folder, read by Sync now.
     */
    private fun setUpSyncWithTwoDevices() {
        finding("\n11. Sync set up and two devices' open tabs seeded")
        val folder = File(app.filesDir, SYNC_DIR).apply { deleteRecursively(); mkdirs() }
        instrumentation.runOnMainSync { (activity as MainActivity).host.syncTreeOverride = { FileTree(folder) } }
        chromeJs(
            "window.zen.invoke('sync.setup',{folder:${JSONObject.quote(folder.absolutePath)},passphrase:${JSONObject.quote(PASSPHRASE)}," +
                "deviceName:${JSONObject.quote(THIS_DEVICE)},scope:{settings:false,spaces:false,bookmarks:false,credentials:false,history:false,openTabs:true}})"
        )
        val on = awaitUntil(90_000) { syncStatus().optBoolean("enabled") && !syncStatus().optBoolean("busy") }
        val status = syncStatus()
        expect("sync is on (device '${status.optString("deviceName")}', ${status.optString("deviceId")})", on)
        val dir = File(folder, SyncPeer.DIR_NAME)
        val mine = File(dir, SyncPeer.deviceFileName(status.optString("deviceId")))
        expect("the engine wrote this device's file into the folder: ${dir.list()?.sorted()}", awaitUntil(15_000) { mine.isFile })
        if (!mine.isFile) return
        val folderSalt = SyncPeer.saltOf(mine.readText())
        salt = folderSalt
        val key = SyncPeer.deriveKey(PASSPHRASE, folderSalt)
        val now = System.currentTimeMillis()
        writeOpenTabs(dir, key, folderSalt, DESKTOP_ID, DESKTOP, now - 3 * MINUTE, desktopTabs(now))
        writeOpenTabs(dir, key, folderSalt, LAPTOP_ID, LAPTOP, now - 2 * HOUR, laptopTabs(now))
        val version = status.optInt("remoteTabsVersion")
        coreInvoke("sync.now")
        val read = awaitUntil(30_000) { syncStatus().optInt("remoteTabsVersion") != version && remoteLists().size == 2 }
        val lists = remoteLists()
        expect("Sync now read both devices' documents: ${lists.map { "${it.getString("deviceName")} (${it.getJSONArray("tabs").length()})" }}", read && lists.size == 2)
        expect("the desktop, published last, comes first", lists.firstOrNull()?.optString("deviceName") == DESKTOP)
    }

    /** 12. The Recent pane with both groups: the devices as headings, their tabs as rows. */
    private fun recentWithDevices() {
        finding("\n12. The Recent pane with both devices")
        openOverview()
        toRecent()
        expect("both devices are listed", awaitUntil(8_000) { deviceNames().size == 2 })
        val names = deviceNames()
        expect("most recently published first: $names", names == listOf(DESKTOP, LAPTOP))
        val asides = jsList("Array.prototype.map.call(document.querySelectorAll('.zen-recent-device-aside'),function(e){return e.textContent.trim()})")
        expect("each heading says when the device was last active: $asides", asides.size == 2 && asides.all { it.startsWith("Last active ") })
        val rows = remoteRowTitles()
        expect("the rows are the devices' tabs, newest activity first: $rows", rows == listOf("Web browser - Wikipedia", "Software Library : Free Software : Internet Archive", "Pull requests · BenItBuhner/Zenium", "Web Share API - Web APIs | MDN", "Recents – Figma", "Hacker News"))
        val hosts = jsList("Array.prototype.map.call(document.querySelectorAll('[data-testid=\"overview-recent-device\"] .zen-list-subtitle'),function(e){return e.textContent.trim()})")
        expect("each row shows its host: $hosts", hosts.firstOrNull() == "en.wikipedia.org" && hosts.size == 6)
        expect("a row without a favicon draws the globe", jsString("(function(){var r=document.querySelectorAll('[data-testid=\"overview-recent-device\"] .zen-v2-row')[1];return r&&r.querySelector('svg')?'yes':''})()") == "yes")
        expect("Recently closed still lists Coffee", closedTitles().any { it.startsWith("Coffee") })
        val heading = jsString("(function(){var b=document.querySelector('.zen-recent-device-button');return b?b.getAttribute('aria-label'):''})()")
        expect("TalkBack reads a device heading with both lines: '$heading'", heading.startsWith("$DESKTOP, Last active "))
        val height = domRect(".zen-recent-device-button")?.height()?.let { it / density }
        expect("the heading's touch target is 44 dp tall (${height?.roundToInt()})", height != null && abs(height - 44f) <= 2f)
        still("recent-devices")
    }

    /** 13. A remote row opens the page in a new tab; the overview leaves. */
    private fun openRemoteTab() {
        finding("\n13. A remote tab's row")
        val tabsBefore = coreState().getJSONObject("tabs").length()
        val opened = touchUntil("the Hacker News row of the laptop", { textRect(REMOTE_TITLE, "Hacker News") }, { coreState().getJSONObject("tabs").length() == tabsBefore + 1 }, waitMs = 6_000)
        val tab = activeCoreTab()
        expect("the row opened one new tab: ${tabsBefore} -> ${coreState().getJSONObject("tabs").length()}", opened)
        expect("the new tab is active with the row's address: ${tab?.optString("url")}", tab?.optString("url") == LAPTOP_HN_URL)
        expect("the overview left", awaitUntil(8_000) { !inDom(".zen-overview") })
        still("remote-opened")
    }

    /** 14. A device heading held: Hide device, then Show hidden devices. */
    private fun hideAndShowDevice() {
        finding("\n14. Hide device from the heading's hold")
        openOverview()
        toRecent()
        awaitUntil(8_000) { deviceNames().size == 2 }
        val heading = steadyRect { textRect(".zen-recent-device-button", LAPTOP) } ?: error("no heading for $LAPTOP")
        val point = touchPoint(heading) ?: error("the heading is off the touchable window")
        finding("  hold at ${point.x.roundToInt()},${point.y.roundToInt()} on the laptop's heading")
        val f = Finger()
        f.down(point.x, point.y)
        f.hold(HOLD_MS)
        f.up()
        val sheet = awaitUntil(SHEET_WAIT) { menuRow("Hide device") != null }
        expect("the hold opens the device's sheet with Hide device: ${sheetRows()}", sheet && sheetRows() == listOf("Hide device"))
        expect("the sheet is titled with the device: '${sheetTitle()}'", sheetTitle().startsWith(LAPTOP))
        still("hide-device-sheet")
        touchUntil("Hide device", { steadyRect { menuRow("Hide device") } }, { deviceNames() == listOf(DESKTOP) }, waitMs = SHEET_WAIT)
        expect("the laptop is off the list: ${deviceNames()}", deviceNames() == listOf(DESKTOP))
        expect("the way back is a row: 'Show 1 hidden device'", awaitUntil(4_000) { textOf(SHOW_HIDDEN) == "Show 1 hidden device" })
        still("device-hidden")
        touchUntil("Show 1 hidden device", { domRect(SHOW_HIDDEN) }, { deviceNames().size == 2 })
        expect("the laptop is back, in its place: ${deviceNames()}", deviceNames() == listOf(DESKTOP, LAPTOP))
        expect("the row is gone with nothing hidden", !inDom(SHOW_HIDDEN))
    }

    /** 15. A Recently closed row restores the tab; the overview leaves. */
    private fun restoreClosedTab() {
        finding("\n15. Restore from Recently closed")
        val restored = touchUntil("Coffee's closed row", { textRect(CLOSED_TITLE, "Coffee") }, { tabExists(COFFEE) || coreTabWithUrl(COFFEE_URL) != null }, waitMs = 8_000)
        expect("the row brings the tab back", restored)
        expect("the restored tab is the active one: ${activeCoreTab()?.optString("url")}", awaitUntil(6_000) { activeCoreTab()?.optString("url") == COFFEE_URL })
        expect("the overview left", awaitUntil(8_000) { !inDom(".zen-overview") })
        expect("Recently closed is empty again", awaitUntil(6_000) { JSONArray(coreInvoke("session.recentlyClosed")).length() == 0 })
        still("restored")
    }

    // --- moves -----------------------------------------------------------------------------------

    /** Touch the header's magnifier until the field is there. */
    private fun openSearch() {
        if (inDom(FIELD)) return
        val opened = touchUntil("the header's magnifier", { domRect(TOGGLE) }, { inDom(FIELD) }, waitMs = SHEET_WAIT)
        if (!opened) error("the search field never came from the magnifier")
        SystemClock.sleep(600)
    }

    /** Touch the segment's Recent until the Recent pane is there. */
    private fun toRecent() {
        if (inDom(RECENT)) return
        val came = touchUntil("the segment's Recent", { textRect(".zen-v2-segment [role=\"tab\"]", "Recent") }, { inDom(RECENT) }, waitMs = SHEET_WAIT)
        if (!came) error("the Recent pane never came from the segment")
        SystemClock.sleep(900)
    }

    /**
     * Type into the focused field, one character's events at a time so each carries the time it
     * is injected (the events of one `getEvents` call all carry the time it was made; on the
     * software-rendered emulator the tail of a string can land past the dispatcher's window).
     */
    private fun keys(text: String) {
        val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        for (char in text) {
            val events = map.getEvents(charArrayOf(char)) ?: error("no key events for '$char'")
            for (event in events) {
                ui.injectInputEvent(event, true)
                SystemClock.sleep(25)
            }
            SystemClock.sleep(80)
        }
        finding("  typed '$text'")
    }

    private fun pressKey(keyCode: Int) {
        val now = SystemClock.uptimeMillis()
        for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            val event = KeyEvent(now, SystemClock.uptimeMillis(), action, keyCode, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD)
            ui.injectInputEvent(event, true)
            SystemClock.sleep(30)
        }
        finding("  key ${KeyEvent.keyCodeToString(keyCode)}")
        SystemClock.sleep(300)
    }

    /**
     * A real touch on the middle of `box` (screen px), logged: the finger's down and up
     * [TAP_HOLD_MS] apart (a frame, so the two queue together under load and the WebView's
     * gesture detector never reads a long task between them as a long press).
     */
    private fun touch(box: Rect, what: String) {
        val point = touchPoint(box) ?: error("$what at $box is out of the touchable window $touchable")
        finding("  touch at ${point.x.roundToInt()},${point.y.roundToInt()} on $what")
        val f = Finger()
        f.down(point.x, point.y)
        f.hold(TAP_HOLD_MS)
        f.up()
    }

    /**
     * A touch that has to take: touch `what` where `read` finds it, watch `took` for `waitMs`,
     * and when nothing came of it read the box again (it may have moved) and touch again, up to
     * `attempts` times. Whether it took in the end.
     */
    private fun touchUntil(
        what: String,
        read: () -> Rect?,
        took: () -> Boolean,
        attempts: Int = TOUCH_ATTEMPTS,
        waitMs: Long = TOUCH_TOOK_WAIT
    ): Boolean {
        for (attempt in 1..attempts) {
            val box = read() ?: run {
                finding("  ($what is not there to touch)")
                return took()
            }
            if (touchPoint(box) == null) {
                finding("  ($what is off the screen at $box, attempt $attempt)")
                SystemClock.sleep(STEADY_MS)
                continue
            }
            touch(box, what)
            if (awaitUntil(waitMs, took)) return true
            if (attempt < attempts) finding("  (the touch on $what did not take, attempt $attempt: touching again)")
        }
        return took()
    }

    /** A box read from the DOM once two reads [STEADY_MS] apart agree; the last read when they never do. */
    private fun steadyRect(read: () -> Rect?): Rect? {
        var last = awaitRect(read, LOOKUP_WAIT) ?: return null
        val deadline = SystemClock.uptimeMillis() + LOOKUP_WAIT
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(STEADY_MS)
            val again = read() ?: return last
            if (again == last) return again
            last = again
        }
        finding("  (still moving after $LOOKUP_WAIT ms: $last)")
        return last
    }

    /** Open the overview with a touch on the bar's Tabs button; a touch read as a hold is dismissed and tried again. */
    private fun openOverview() {
        ensureForeground()
        for (attempt in 0 until OPEN_ATTEMPTS) {
            val close = closeUrlField()
            if (!close.ok) finding("  (attempt ${attempt + 1}: ${close.describe()})")
            val tabs = findNode { it.startsWith("Tabs (") }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }
                ?: domRect("[aria-label^=\"Tabs (\"]")
            if (tabs != null) {
                Finger().tap(tabs.exactCenterX(), tabs.exactCenterY())
            } else {
                val f = Finger()
                f.down(pillCenterX, pillY)
                f.settleIn(0f, -NUDGE)
                f.moveBy(0f, -0.75f * overviewTravel + NUDGE, 400)
                f.up()
            }
            val deadline = SystemClock.uptimeMillis() + 8_000
            while (!overviewOpen() && SystemClock.uptimeMillis() < deadline) {
                if (heldInstead()) {
                    finding("  (the tap on Tabs was read as a hold, attempt ${attempt + 1}: dismissed, trying again)")
                    back()
                    val gone = SystemClock.uptimeMillis() + 4_000
                    while (heldInstead() && SystemClock.uptimeMillis() < gone) SystemClock.sleep(200)
                    SystemClock.sleep(1_000)
                    break
                }
                SystemClock.sleep(200)
            }
            if (overviewOpen()) {
                SystemClock.sleep(2_000)
                calibrate()
                return
            }
        }
        error("the overview never opened")
    }

    private fun heldInstead(): Boolean =
        jsString("(function(){return document.querySelector('.zen-quick-menu, .zen-sheet') ? 'held' : ''})()") == "held"

    /** The overview is on screen and has finished growing in (its root at scale 1). */
    private fun overviewOpen(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-overview');return e?e.style.transform:''})()") == "scale(1)"

    // --- where things are: the chrome's DOM ----------------------------------------------------

    private var originX = 0f
    private var originY = 0f
    private var calibrated = false

    private fun card(tabId: String) = "[data-tab-id=\"$tabId\"]"

    /** A JS expression's string result ("" when it never answered or returned nothing). */
    private fun jsString(code: String): String = (JSONTokener(chromeJs(code)).nextValue() as? String).orEmpty()

    /** A JS expression's array of strings (empty when it never answered). */
    private fun jsList(expression: String): List<String> {
        val raw = jsString("(function(){return JSON.stringify($expression)})()")
        if (raw.isEmpty()) return emptyList()
        val arr = JSONArray(raw)
        return (0 until arr.length()).map { arr.getString(it) }
    }

    private fun rectFrom(text: String): Rect? {
        if (text.isEmpty()) return null
        val o = JSONObject(text)
        val d = o.getDouble("d")
        return Rect(
            (o.getDouble("l") * d + originX).roundToInt(),
            (o.getDouble("t") * d + originY).roundToInt(),
            (o.getDouble("r") * d + originX).roundToInt(),
            (o.getDouble("b") * d + originY).roundToInt()
        )
    }

    /** The on-screen box of the first element `selector` matches, null when nothing does; scrolled into its list's viewport first when asked. */
    private fun domRect(selector: String, scrollIntoView: Boolean = false): Rect? {
        val scroll = if (!scrollIntoView) "" else
            "var g=e.closest('.zen-overview-grid, .zen-overview-recent');" +
                "if(g){var gr=g.getBoundingClientRect(),er=e.getBoundingClientRect();" +
                "if(er.top<gr.top||er.bottom>gr.bottom)e.scrollIntoView({block:'nearest'});}"
        return rectFrom(jsString("(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';$scroll$RECT_JS})()"))
    }

    /** The box of the first element matching `selector` whose text starts with `prefix` (any, when `prefix` is empty), scrolled into its list first. */
    private fun textRect(selector: String, prefix: String): Rect? =
        rectFrom(
            jsString(
                "(function(){var p=${JSONObject.quote(prefix)};var e=Array.prototype.find.call(document.querySelectorAll(${JSONObject.quote(selector)})," +
                    "function(n){return n.textContent.trim().indexOf(p)===0});if(!e)return '';" +
                    "var g=e.closest('.zen-overview-grid, .zen-overview-recent');if(g){var gr=g.getBoundingClientRect(),er=e.getBoundingClientRect();" +
                    "if(er.top<gr.top||er.bottom>gr.bottom)e.scrollIntoView({block:'nearest'});}$RECT_JS})()"
            )
        )

    private fun textOf(selector: String): String =
        jsString("(function(){var e=document.querySelector(${JSONObject.quote(selector)});return e?e.textContent.trim():''})()")

    private fun inDom(selector: String): Boolean =
        jsString("(function(){return document.querySelector(${JSONObject.quote(selector)})?'yes':''})()") == "yes"

    /** The box of `selector`, waiting for it to be in the DOM. */
    private fun box(selector: String): Rect =
        awaitRect({ domRect(selector) }, LOOKUP_WAIT) ?: error("nothing matches $selector")

    /** Like [box], after scrolling the element fully into its list's viewport when it is not. */
    private fun show(selector: String): Rect {
        val before = box(selector)
        val after = domRect(selector, scrollIntoView = true) ?: before
        if (after != before) SystemClock.sleep(1_200)
        return domRect(selector) ?: after
    }

    /** The tag name of the focused element (`BODY` when nothing is focused). */
    private fun activeElement(): String =
        jsString("(function(){var e=document.activeElement;return e?e.tagName:''})()")

    private fun value(): String = jsString("(function(){var e=document.querySelector('$INPUT');return e?e.value:''})()")

    private fun placeholder(): String = jsString("(function(){var e=document.querySelector('$INPUT');return e?e.getAttribute('placeholder')||'':''})()")

    private fun clearLabelJs(): String = "(function(){var e=document.querySelector('$CLEAR');return e?e.getAttribute('aria-label')||'':''})()"

    /** The header's buttons by label, in order. */
    private fun headerLabels(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('.zen-overview > header button'),function(b){return b.getAttribute('aria-label')||b.textContent.trim()})")

    private fun headerTitle(): String = textOf(".zen-overview > header .zen-title")

    private fun segmentLabels(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('.zen-v2-segment [role=\"tab\"]'),function(b){return b.textContent.trim()})")

    /** Every regular card's box by its tab id (the essentials are not cards). */
    private fun cardBoxes(): Map<String, Rect> {
        val raw = jsString(
            "(function(){var d=window.devicePixelRatio;return JSON.stringify(Array.prototype.map.call(document.querySelectorAll('.zen-overview-grid [data-tab-id]')," +
                "function(e){var r=e.getBoundingClientRect();return {id:e.getAttribute('data-tab-id'),l:r.left,t:r.top,r:r.right,b:r.bottom,d:d}}))})()"
        )
        if (raw.isEmpty()) return emptyMap()
        val arr = JSONArray(raw)
        return (0 until arr.length()).map { arr.getJSONObject(it) }.associate { it.getString("id") to rectFrom(it.toString())!! }
    }

    /** The cards once the grid holds exactly `ids` (or the last read when it never does in time). */
    private fun awaitCards(ids: Set<String>, timeoutMs: Long = 6_000): Map<String, Rect> {
        var boxes = cardBoxes()
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (boxes.keys != ids && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(POLL_MS)
            boxes = cardBoxes()
        }
        // The survivors' glide: let the spring land before the boxes are read against the start.
        SystemClock.sleep(1_200)
        return cardBoxes()
    }

    private fun essentialCount(): Int =
        jsString("(function(){return String(document.querySelectorAll('.zen-overview-grid .zen-essential').length)})()").toIntOrNull() ?: 0

    /** The tab ids of the cards inside the group card, in order (none when there is no group card). */
    private fun groupCards(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('$GROUP [data-tab-id]'),function(e){return e.getAttribute('data-tab-id')})")

    /**
     * Start counting the cards drawn on their way out (`Departures`: rendered apart from the
     * grid, fixed, over it) as they mount, through an observer in the page: an exit lasts a few
     * frames, too few for a poll over the bridge to be sure of catching one.
     */
    private fun watchExits() {
        chromeJs(
            "(function(){var s='$EXIT';window.__zenExits=0;if(window.__zenExitWatch)window.__zenExitWatch.disconnect();" +
                "var o=new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){if(n.nodeType!==1)return;" +
                "window.__zenExits+=(n.matches(s)?1:0)+n.querySelectorAll(s).length})})});" +
                "o.observe(document.body,{childList:true,subtree:true});window.__zenExitWatch=o;return 'ok'})()"
        )
    }

    /** How many exits mounted since [watchExits]; the observer is taken down. */
    private fun exitsSeen(): Int =
        jsString("(function(){if(window.__zenExitWatch)window.__zenExitWatch.disconnect();return String(window.__zenExits||0)})()").toIntOrNull() ?: 0

    /** How many cards of `before` stand elsewhere in `after` (a pixel of tolerance for rounding). */
    private fun moved(before: Map<String, Rect>, after: Map<String, Rect>): Int =
        before.count { (id, b) -> after[id]?.let { a -> abs(a.left - b.left) > 1 || abs(a.top - b.top) > 1 } ?: false }

    private fun closedTitles(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('$CLOSED_TITLE'),function(e){return e.textContent.trim()})")

    private fun remoteRowTitles(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('$REMOTE_TITLE'),function(e){return e.textContent.trim()})")

    private fun deviceNames(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('.zen-recent-device-button > span:first-child'),function(e){return e.textContent.trim()})")

    private fun headings(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('$RECENT .zen-list-heading:not(.zen-recent-device)'),function(e){return e.textContent.trim()})")

    /** A row of the sheet that is up by the start of its label. */
    private fun menuRow(row: String): Rect? = textRect(".zen-sheet-item", row)

    private fun sheetRows(): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll('.zen-sheet .zen-sheet-item'),function(n){return n.textContent.trim()})")

    private fun sheetTitle(): String = textOf(".zen-sheet .zen-sheet-title")

    private fun awaitRect(read: () -> Rect?, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            read()?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(POLL_MS)
        }
    }

    private fun awaitUntil(timeoutMs: Long, test: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (test()) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(POLL_MS)
        }
    }

    private fun awaitDom(expression: String, timeoutMs: Long = 8_000): Boolean =
        awaitUntil(timeoutMs) { jsString("(function(){return ($expression)?'yes':''})()") == "yes" }

    /**
     * Whether the chrome's status region (`Announcer`, `role="status"`) reads `text` within
     * `timeoutMs`: the count is announced once the typing has paused (500 ms), and the region
     * is emptied seconds later, so it is read often.
     */
    private fun awaitAnnouncement(text: String, timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last = ""
        while (SystemClock.uptimeMillis() < deadline) {
            last = textOf("[data-announcer]")
            if (last == text) return true
            SystemClock.sleep(100)
        }
        finding("  (the status region read '$last', not '$text')")
        return false
    }

    private fun awaitToastGone() {
        if (!awaitDom("!document.querySelector('.zen-message-toast')", 9_000)) finding("  (a toast is still up)")
        SystemClock.sleep(500)
    }

    /** Check the DOM's coordinates against the accessibility tree once (the Spaces button never moves). */
    private fun calibrate() {
        if (calibrated) return
        val fromDom = domRect("[aria-label=\"Spaces\"]") ?: return
        val fromTree = waitFor("Spaces", 4_000) ?: return
        val dx = fromTree.exactCenterX() - fromDom.exactCenterX()
        val dy = fromTree.exactCenterY() - fromDom.exactCenterY()
        finding("coordinates: Spaces button at $fromDom from the DOM, $fromTree from the accessibility tree (offset ${dx.roundToInt()}, ${dy.roundToInt()})")
        if (abs(dx) <= MAX_OFFSET && abs(dy) <= MAX_OFFSET) {
            originX = dx
            originY = dy
        }
        calibrated = true
    }

    // --- the core's state ------------------------------------------------------------------------

    private fun tabExists(tabId: String, state: JSONObject = coreState()): Boolean = state.getJSONObject("tabs").has(tabId)

    private fun coreTitle(tabId: String): String = coreState().getJSONObject("tabs").optJSONObject(tabId)?.optString("title") ?: ""

    /** A tab with `url` per the core, null when none. */
    private fun coreTabWithUrl(url: String, state: JSONObject = coreState()): JSONObject? {
        val tabs = state.getJSONObject("tabs")
        for (key in tabs.keys()) {
            val tab = tabs.getJSONObject(key)
            if (tab.optString("url") == url) return tab
        }
        return null
    }

    private fun syncStatus(): JSONObject = coreState().optJSONObject("sync") ?: JSONObject()

    private fun remoteLists(): List<JSONObject> {
        val arr = JSONArray(coreInvoke("sync.tabsFromDevices"))
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    // --- the other devices -----------------------------------------------------------------------

    /**
     * Another device's `open-tabs` document into the folder's `zenium-sync` directory, as its
     * Zenium would write it ([SyncPeer.document]: the kind and the writer's identity in the
     * clear, `{ v: 1, tabs }` sealed under the folder's key; the name the engine reads it by).
     */
    private fun writeOpenTabs(dir: File, key: ByteArray, salt: String, deviceId: String, deviceName: String, updatedAt: Long, tabs: List<JSONObject>) {
        val envelope = SyncPeer.encrypt(key, salt, SyncPeer.openTabsPayload(tabs))
        val name = SyncPeer.openTabsName(deviceId)
        File(dir, name).writeText(SyncPeer.document("open-tabs", deviceId, deviceName, updatedAt, envelope))
        finding("  '$deviceName' published ${tabs.size} open tabs as $name")
    }

    private fun remoteTab(id: String, url: String, title: String, lastActive: Long, favicon: String? = null): JSONObject =
        SyncPeer.remoteTab(id, url, title, lastActive, favicon)

    /** A favicon the emulator can draw offline: a 16 px disc in the site's colour. */
    private fun disc(fill: String): String =
        "data:image/svg+xml," + java.net.URLEncoder.encode("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"><circle cx=\"8\" cy=\"8\" r=\"7\" fill=\"$fill\"/></svg>", "UTF-8").replace("+", "%20")

    /** The desktop's two tabs (the preview host's `sync=tabs` fixture): one without a favicon, for the globe. */
    private fun desktopTabs(now: Long): List<JSONObject> = listOf(
        remoteTab("d-1", "https://en.wikipedia.org/wiki/Web_browser", "Web browser - Wikipedia", now - 4 * MINUTE, disc("#3366cc")),
        remoteTab("d-2", "https://archive.org/details/software", "Software Library : Free Software : Internet Archive", now - 50 * MINUTE)
    )

    private fun laptopTabs(now: Long): List<JSONObject> = listOf(
        remoteTab("l-1", "https://github.com/BenItBuhner/Zenium/pulls", "Pull requests · BenItBuhner/Zenium", now - 2 * HOUR, disc("#24292f")),
        remoteTab("l-2", "https://developer.mozilla.org/en-US/docs/Web/API/Web_Share_API", "Web Share API - Web APIs | MDN", now - 3 * HOUR, disc("#000000")),
        remoteTab("l-3", "https://www.figma.com/files/recent", "Recents – Figma", now - 5 * HOUR, disc("#a259ff")),
        remoteTab("l-4", LAPTOP_HN_URL, "Hacker News", now - 26 * HOUR, disc("#ff6600"))
    )

    // --- findings --------------------------------------------------------------------------------

    private fun expect(label: String, ok: Boolean) = record("  $label", ok)

    private fun record(line: String, ok: Boolean) {
        if (!ok) failures++
        finding("$line ${if (ok) "PASS" else "FAIL"}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    /** Numbered stills: `tab-search-recent-NN-<state>.png`. */
    private fun still(state: String) {
        shots++
        shot("%02d-%s".format(shots, state))
    }

    private companion object {
        /** The regular cards of the seeded space's Work pane: two in Research and five loose. */
        private const val CARDS = 7
        private const val ESSENTIALS = 3
        private const val LOOKUP_WAIT = 8_000L
        private const val POLL_MS = 200L
        private const val STEADY_MS = 350L
        private const val MAX_OFFSET = 200f
        private const val OPEN_ATTEMPTS = 4
        private const val TOUCH_ATTEMPTS = 4
        private const val TAP_HOLD_MS = 16L
        private const val TOUCH_TOOK_WAIT = 900L
        private const val SHEET_WAIT = 5_000L
        /** A heading's hold: past the row gestures' long press with room for the emulator's lag. */
        private const val HOLD_MS = 800L
        private const val MINUTE = 60_000L
        private const val HOUR = 60 * MINUTE
        private const val RECT_JS = "var r=e.getBoundingClientRect();" +
            "return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom,d:window.devicePixelRatio})"

        private const val TOGGLE = "[data-testid=\"overview-search-toggle\"]"
        private const val FIELD = "[data-testid=\"overview-search\"]"
        private const val INPUT = "#overview-search"
        private const val CLEAR = "[data-testid=\"overview-search-clear\"]"
        private const val EMPTY = "[data-testid=\"overview-search-empty\"]"
        private const val NEW_TAB = "[data-testid=\"overview-new-tab\"]"
        private const val GROUP = ".zen-overview-grid [data-cell^=\"group:\"]"
        private const val EXIT = ".zen-overview-card.fixed.pointer-events-none"
        private const val RECENT = "[data-testid=\"overview-recent\"]"
        private const val SYNC_OFF = "[data-testid=\"overview-recent-sync-off\"]"
        private const val SHOW_HIDDEN = "[data-testid=\"overview-recent-show-hidden\"]"
        private const val ACTION = "$RECENT .zen-recent-action"
        private const val CLOSED_TITLE = "$RECENT section:first-of-type .zen-list-title"
        private const val REMOTE_TITLE = "[data-testid=\"overview-recent-device\"] .zen-list-title"
        private const val SYNC_SETTINGS_URL = "zen://settings/sync"

        // The seeded profile's ids.
        private const val WWW = "tab_www"
        private const val DAMPING = "tab_damping"
        private const val EXAMPLE = "tab_example"
        private const val HN = "tab_hn"
        private const val RFC = "tab_rfc"
        private const val TEA = "tab_tea"
        private const val COFFEE = "tab_coffee"
        private const val COFFEE_URL = "https://en.wikipedia.org/wiki/Coffee"
        private val REGULAR = listOf(WWW, DAMPING, EXAMPLE, HN, RFC, TEA, COFFEE)

        // Sync, over the app's own files.
        private const val SYNC_DIR = "demo-sync-folder"
        private const val PASSPHRASE = "orbit-lantern-42"
        private const val THIS_DEVICE = "Pixel (demo)"
        private const val DESKTOP_ID = "device_homedesktop"
        private const val DESKTOP = "Home desktop"
        private const val LAPTOP_ID = "device_worklaptop"
        private const val LAPTOP = "Work laptop"
        private const val LAPTOP_HN_URL = "https://news.ycombinator.com/"
    }
}
