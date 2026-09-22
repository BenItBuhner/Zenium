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
 * Records the phone overview's tab search (matrix TAB-21; v2 §9.3, §9.12, §9.34, §11.4) with its
 * reach into History's two groups, and those groups on the phone History page (TAB-02; §9.17,
 * §10.1, §10.3, §10.4; the #316 gate: no Recent pane – the recently closed tabs and the other
 * devices' tabs are History's groups, and the search lists what it finds of them as rows under
 * headings beneath the matching cards), every press a real touch and every outcome read off the
 * chrome's DOM or the core's state, never off the chrome's word alone:
 *
 *  1. the overview opens with the search closed: no field, no keyboard, no field focused; the
 *     segment is Tabs | Groups (| Private where the WebView has multi-profile), no Recent;
 *  2. the header's magnifier opens the §9.12 field pinned under the header, focused, the
 *     keyboard up with it (the tap is the user's ask; nothing else ever focuses it);
 *  3. typing narrows the pane's cards by TITLE ("wiki": Damping, Tea, Coffee stay; the
 *     Research group's card stays, narrowed to Damping), the dropped cards departing in place
 *     (counted as they mount) and the survivors gliding (traced: `search-filter-overview`), the
 *     New Tab card leaving with the dropped cards (§9.34: it is no match), the status region
 *     told "3 tabs found";
 *  4. a query nothing matches leaves "No tabs found" where the grid was, no New Tab card under
 *     it, the group's card dissolved with its last match, the region told;
 *  5. the field's X clears the query: every card back, the New Tab card last, the field and
 *     the keyboard staying, the X now reading Close search;
 *  6. typing narrows by ADDRESS ("cern": World Wide Web alone, in its group's card, its title
 *     saying nothing of it);
 *  7. the system back: with the keyboard up it is the keyboard's (Android's rule, Chrome's
 *     omnibox the same), then it clears the query, then closes the field, the overview staying;
 *  8. Escape (a hardware keyboard's) clears then closes the same way, the soft keyboard put
 *     away first;
 *  9. a card closed by touch, then the search reaches it: "coffee" keeps the RFC 2324 card
 *     (its title) and lists the closed Coffee under a Recently closed heading beneath the grid,
 *     the region told "2 tabs found";
 * 10. the History page (the app menu's row) with sync off: Recently closed lists Coffee; the
 *     "From your other devices" heading stands over §9.17's sentence and the Turn on sync row;
 * 11. the row leaves the page for Settings › Sync;
 * 12. sync set up (the engine's own, over a plain directory: [FileTree] on the host's debug hook)
 *     with Open tabs among what syncs and no other device publishing: the group STEPS ASIDE –
 *     no heading, no sentence, Recently closed meeting the days (§10.1's `none`);
 * 13. Open tabs taken out of what syncs: the heading over the scope sentence and the Open sync
 *     settings row, which opens Settings › Sync with its What you sync group on screen (the
 *     Open tabs switch the row's subject); the scope put back;
 * 14. two other devices' `open-tabs` documents seeded into the folder; Sync now reads them;
 * 15. the History page lists each device as its own group, most recently published first, the
 *     heading its name with "Last active …" as the aside and no heading over them (§10.1), each
 *     tab a row with favicon, title and host;
 * 16. a device's row opens its page in a new active tab and the page leaves;
 * 17. a device heading held: the device's sheet; Hide Device takes the device off the page and
 *     Show hidden devices brings it back; with every device hidden the heading stands over
 *     "You've hidden every device" and the same row;
 * 18. the search reaches the other devices: "figma" (the laptop's alone) empties the grid – the
 *     §9.17 sentence "No open tabs found" over the From your other devices rows – and the row
 *     opens the page in a new tab, the overview leaving;
 * 19. the search's Recently closed row restores Coffee and the overview leaves on it.
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
            "Zenium Android tab search and History groups checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
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
        closedTabReachedBySearch()
        historyWithSyncOff()
        rowToSyncSettings()
        syncOnWithNothingPublished()
        openTabsOutOfScope()
        seedTwoDevices()
        historyWithDevices()
        openRemoteTab()
        hideAndShowDevice()
        devicesReachedBySearch()
        restoreClosedFromSearch()

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
        // The header's three segments at most (§9.34): Tabs | Groups | Private, the Private one drawing
        // only where the WebView has multi-profile (`capabilities.privateTabs`; the Google APIs image's
        // has not). No Recent segment on either: the recently closed and the other devices' tabs are
        // History's groups.
        val segments = segmentLabels()
        expect("the segment is Tabs | Groups (| Private), no Recent: $segments", segments == listOf("Tabs", "Groups") || segments == listOf("Tabs", "Groups", "Private"))
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
        watchAnnouncements()
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
        expect("the dropped cards departed in place over the grid (§11.4): ${exits.cards} exit(s) drawn", exits.cards >= 1)
        expect("the New Tab card left with them (§9.34): off the grid, its exit drawn where it stood (${exits.newTab})", !inDom(NEW_TAB) && exits.newTab >= 1)
        expect("the survivors glided from where they stood (Tea moved ${moved(before, after)} of 3)", moved(before, after) >= 1)
        expect("the status region told '3 tabs found'", awaitAnnouncement("3 tabs found"))
        expect("the X reads Clear search on a query", jsString(clearLabelJs()) == "Clear search")
        expect("the field holds the query: '${value()}'", value() == "wiki")
        still("search-wiki")
    }

    /** 4. A query nothing matches: "No tabs found" where the grid was, no New Tab card. */
    private fun nothingFound() {
        finding("\n4. Nothing found: 'wikiz'")
        watchAnnouncements()
        keys("z")
        expect("no card stands", awaitUntil(4_000) { cardBoxes().isEmpty() })
        expect("the group dissolved with its last match (no group card)", awaitDom("!document.querySelector('$GROUP')"))
        expect("'No tabs found' reads where the grid was (§9.17)", awaitDom("document.querySelector('$EMPTY')&&document.querySelector('$EMPTY').textContent.trim()==='No tabs found'"))
        expect("the New Tab card is off the grid with the rest (§9.34)", !inDom(NEW_TAB))
        expect("nothing closed and sync off: no lists under the sentence", !inDom(REACH))
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
        expect("the New Tab card is back, the grid's last cell", awaitDom("!!document.querySelector('$NEW_TAB')") && lastCellIsNewTab())
        expect("the field stays, focused, the keyboard up", inDom(FIELD) && activeElement() == "INPUT" && imeShown())
        expect("the X reads Close search again", jsString(clearLabelJs()) == "Close search")
        still("search-cleared")
    }

    /** 6. "cern" narrows by address: World Wide Web's title says nothing of it. */
    private fun typingNarrowsByAddress() {
        finding("\n6. Typing narrows by address: 'cern' (info.cern.ch)")
        watchAnnouncements()
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
        expect("every card is back, the New Tab card with them", awaitCards(REGULAR.toSet()).size == CARDS && inDom(NEW_TAB))
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

    /** 9. Coffee closed by touch; the search reaches it under a Recently closed heading beneath the cards. */
    private fun closedTabReachedBySearch() {
        finding("\n9. A tab closed, then the search reaches it: 'coffee'")
        val closed = touchUntil("Coffee's close", { show(card(COFFEE)); domRect("${card(COFFEE)} .zen-overview-card-close") }, { !tabExists(COFFEE) }, waitMs = 4_000)
        expect("Coffee's card closes the tab by touch", closed)
        awaitToastGone()
        openSearch()
        watchAnnouncements()
        keys("coffee")
        val after = awaitCards(setOf(RFC))
        expect("RFC 2324 alone stays a card (Coffee in its title): ${after.keys}", after.keys == setOf(RFC))
        expect("the New Tab card is off the grid under the query", !inDom(NEW_TAB))
        expect("the closed Coffee is listed beneath the cards", awaitUntil(8_000) { reachClosedTitles().any { it.startsWith("Coffee") } })
        expect("under one heading, Recently closed: ${reachHeadings()}", reachHeadings() == listOf("Recently closed"))
        expect("the row reads its host: '${reachSubtitles().firstOrNull()}'", reachSubtitles().firstOrNull()?.startsWith("en.wikipedia.org") == true)
        expect("the lists stand below the grid's cards", (domRect(REACH)?.top ?: 0) > (after[RFC]?.bottom ?: Int.MAX_VALUE))
        expect("no empty sentence with a card standing", !inDom(EMPTY))
        expect("the status region counted the row with the card: '2 tabs found'", awaitAnnouncement("2 tabs found"))
        still("search-reach-closed")
        leaveOverview()
    }

    /** 10. The History page with sync off: Coffee under Recently closed; the umbrella heading over §9.17's sentence and the row. */
    private fun historyWithSyncOff() {
        finding("\n10. The History page with sync off")
        openHistory()
        expect("Recently closed lists Coffee", awaitUntil(8_000) { historyClosedTitles().any { it.startsWith("Coffee") } })
        expect("the From your other devices group reads §9.17's sentence: '${textOf(SYNC_OFF)}'", textOf(SYNC_OFF) == "Turn on sync to see tabs from your other devices")
        expect("with the row to Settings › Sync: 'Turn on sync'", textRect(ACTION, "Turn on sync") != null)
        val headings = listHeadings()
        expect("the headings read Recently closed, From your other devices, then the days: $headings", headings.take(2) == listOf("Recently closed", "From your other devices"))
        expect("no device group with sync off", !inDom(DEVICE))
        still("history-sync-off")
    }

    /** 11. The Turn on sync row leaves the page for Settings › Sync. */
    private fun rowToSyncSettings() {
        finding("\n11. The row to Settings › Sync")
        val left = touchUntil("the Turn on sync row", { textRect(ACTION, "Turn on sync") }, { activeCoreTab()?.optString("url") == SYNC_SETTINGS_URL }, waitMs = 8_000)
        expect("the row opens Settings › Sync in the active tab: ${activeCoreTab()?.optString("url")}", left)
        expect("the History page left", awaitUntil(6_000) { !inDom(HISTORY) })
        still("sync-settings")
    }

    /** The folder sync runs over: the app's own files, the host's debug hook standing it in for a picked tree. */
    private val syncFolder: File get() = File(app.filesDir, SYNC_DIR)

    /**
     * 12. Sync on, over a plain directory (the host's debug hook), Open tabs among what syncs and
     * no other device publishing: the History page's group steps aside (§10.1's `none`).
     */
    private fun syncOnWithNothingPublished() {
        finding("\n12. Sync set up, nothing published by another device: the group steps aside")
        val folder = syncFolder.apply { deleteRecursively(); mkdirs() }
        instrumentation.runOnMainSync { (activity as MainActivity).host.syncTreeOverride = { FileTree(folder) } }
        chromeJs(
            "window.zen.invoke('sync.setup',{folder:${JSONObject.quote(folder.absolutePath)},passphrase:${JSONObject.quote(PASSPHRASE)}," +
                "deviceName:${JSONObject.quote(THIS_DEVICE)},scope:{settings:false,spaces:false,bookmarks:false,credentials:false,history:false,openTabs:true}})"
        )
        val on = awaitUntil(90_000) { syncStatus().optBoolean("enabled") && !syncStatus().optBoolean("busy") }
        val status = syncStatus()
        expect("sync is on (device '${status.optString("deviceName")}', ${status.optString("deviceId")}) with Open tabs among what syncs", on && status.optJSONObject("scope")?.optBoolean("openTabs") == true)
        expect("no other device has published: ${remoteLists().size} list(s)", remoteLists().isEmpty())
        openHistory()
        SystemClock.sleep(1_500)
        expect("Recently closed lists Coffee", awaitUntil(8_000) { historyClosedTitles().any { it.startsWith("Coffee") } })
        expect("no From your other devices group: no heading, no sentence, no row", !inDom(DEVICES) && !inDom(DEVICE) && !inDom(ACTION))
        val headings = listHeadings()
        expect("Recently closed meets the days: $headings", "From your other devices" !in headings && headings.firstOrNull() == "Recently closed" && headings.size >= 2)
        still("history-none")
        leaveHistory()
    }

    /**
     * 13. Open tabs taken out of what syncs: the heading over the scope sentence and the Open
     * sync settings row, which lands on Settings › Sync's What you sync group; the scope put back.
     */
    private fun openTabsOutOfScope() {
        finding("\n13. Open tabs out of what syncs: the sentence and the Open sync settings row")
        coreInvoke("sync.setScope", "{\"openTabs\":false}")
        expect("Open tabs is out of the scope", awaitUntil(8_000) { syncStatus().optJSONObject("scope")?.optBoolean("openTabs") == false })
        openHistory()
        expect("the group reads the scope sentence: '${textOf(TABS_OFF)}'", awaitUntil(6_000) { textOf(TABS_OFF) == "Turn on Open tabs in What you sync to see them" })
        expect("with the row to the setting: 'Open sync settings'", textRect(ACTION, "Open sync settings") != null)
        val headings = listHeadings()
        expect("the heading stands over it, after Recently closed: $headings", headings.take(2) == listOf("Recently closed", "From your other devices"))
        expect("no device group while the scope is off", !inDom(DEVICE))
        still("history-scope-off")
        val left = touchUntil("the Open sync settings row", { textRect(ACTION, "Open sync settings") }, { activeCoreTab()?.optString("url") == SYNC_SCOPE_URL }, waitMs = 8_000)
        expect("the row opens Settings › Sync asking for the Open tabs switch: ${activeCoreTab()?.optString("url")}", left)
        expect("the History page left", awaitUntil(6_000) { !inDom(HISTORY) })
        val onScreen = awaitUntil(8_000) {
            val row = domRect(SCOPE_ROW)
            row != null && row.top >= 0 && row.bottom <= height
        }
        val row = domRect(SCOPE_ROW)
        expect("the Open tabs switch is on screen with its group (top ${row?.top}, bottom ${row?.bottom} of $height)", onScreen)
        expect("the switch reads off", jsString("(function(){var r=document.querySelector('$SCOPE_ROW');return r?String(r.getAttribute('aria-checked')):''})()") == "false")
        still("sync-settings-scope")
        coreInvoke("sync.setScope", "{\"openTabs\":true}")
        expect("Open tabs is back in the scope", awaitUntil(8_000) { syncStatus().optJSONObject("scope")?.optBoolean("openTabs") == true })
    }

    /** 14. Two other devices' open tabs in the folder, read by Sync now. */
    private fun seedTwoDevices() {
        finding("\n14. Two devices' open tabs seeded")
        val status = syncStatus()
        val dir = File(syncFolder, SyncPeer.DIR_NAME)
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

    /** 15. The History page with both devices: each its own group headed by its name, no heading over them. */
    private fun historyWithDevices() {
        finding("\n15. The History page with both devices")
        openHistory()
        expect("both devices are listed", awaitUntil(8_000) { deviceNames().size == 2 })
        val names = deviceNames()
        expect("most recently published first: $names", names == listOf(DESKTOP, LAPTOP))
        val asides = jsList("Array.prototype.map.call(document.querySelectorAll('.zen-device-heading-aside'),function(e){return e.textContent.trim()})")
        expect("each heading says when the device was last active: $asides", asides.size == 2 && asides.all { it.startsWith("Last active ") })
        val headings = listHeadings()
        expect("no umbrella heading: the devices are the page's groups after Recently closed (§10.1): $headings", "From your other devices" !in headings && headings.size >= 3 && headings[0] == "Recently closed" && headings[1].startsWith(DESKTOP) && headings[2].startsWith(LAPTOP))
        val rows = remoteRowTitles()
        expect("the rows are the devices' tabs, newest activity first: $rows", rows == listOf("Web browser - Wikipedia", "Software Library : Free Software : Internet Archive", "Pull requests · BenItBuhner/Zenium", "Web Share API - Web APIs | MDN", "Recents – Figma", "Hacker News"))
        val hosts = jsList("Array.prototype.map.call(document.querySelectorAll('$DEVICE .zen-list-subtitle'),function(e){return e.textContent.trim()})")
        expect("each row shows its host: $hosts", hosts.firstOrNull() == "en.wikipedia.org" && hosts.size == 6)
        expect("a row without a favicon draws the globe", jsString("(function(){var r=document.querySelectorAll('$DEVICE .zen-v2-row')[1];return r&&r.querySelector('svg')?'yes':''})()") == "yes")
        expect("Recently closed still lists Coffee", historyClosedTitles().any { it.startsWith("Coffee") })
        val heading = jsString("(function(){var b=document.querySelector('$DEVICE_HEADING');return b?b.getAttribute('aria-label'):''})()")
        expect("TalkBack reads a device heading with both lines: '$heading'", heading.startsWith("$DESKTOP, Last active "))
        val height = domRect(DEVICE_HEADING)?.height()?.let { it / density }
        expect("the heading's touch target is 44 dp tall (${height?.roundToInt()})", height != null && abs(height - 44f) <= 2f)
        still("history-devices")
    }

    /** 16. A device's row opens the page in a new tab; the History page leaves. */
    private fun openRemoteTab() {
        finding("\n16. A remote tab's row on the History page")
        val tabsBefore = coreState().getJSONObject("tabs").length()
        val opened = touchUntil("the Hacker News row of the laptop", { textRect(REMOTE_TITLE, "Hacker News") }, { coreState().getJSONObject("tabs").length() == tabsBefore + 1 }, waitMs = 6_000)
        val tab = activeCoreTab()
        expect("the row opened one new tab: ${tabsBefore} -> ${coreState().getJSONObject("tabs").length()}", opened)
        expect("the new tab is active with the row's address: ${tab?.optString("url")}", tab?.optString("url") == LAPTOP_HN_URL)
        expect("the History page left", awaitUntil(8_000) { !inDom(HISTORY) })
        still("remote-opened")
    }

    /** Hold `device`'s heading until its sheet is up with Hide Device. */
    private fun holdDeviceHeading(device: String): Boolean {
        val heading = steadyRect { textRect(DEVICE_HEADING, device) } ?: error("no heading for $device")
        val point = touchPoint(heading) ?: error("the heading is off the touchable window")
        finding("  hold at ${point.x.roundToInt()},${point.y.roundToInt()} on the heading of $device")
        val f = Finger()
        f.down(point.x, point.y)
        f.hold(HOLD_MS)
        f.up()
        return awaitUntil(SHEET_WAIT) { menuRow("Hide Device") != null }
    }

    /** 17. A device heading held: Hide Device, then Show hidden devices; every device hidden keeps the heading, its sentence and the row. */
    private fun hideAndShowDevice() {
        finding("\n17. Hide Device from the heading's hold")
        openHistory()
        awaitUntil(8_000) { deviceNames().size == 2 }
        val sheet = holdDeviceHeading(LAPTOP)
        expect("the hold opens the device's sheet with Hide Device: ${sheetRows()}", sheet && sheetRows() == listOf("Hide Device"))
        expect("the sheet is titled with the device: '${sheetTitle()}'", sheetTitle().startsWith(LAPTOP))
        still("hide-device-sheet")
        touchUntil("Hide Device", { steadyRect { menuRow("Hide Device") } }, { deviceNames() == listOf(DESKTOP) }, waitMs = SHEET_WAIT)
        expect("the laptop is off the page: ${deviceNames()}", deviceNames() == listOf(DESKTOP))
        expect("the way back is a row: 'Show hidden devices'", awaitUntil(4_000) { textOf(SHOW_HIDDEN) == "Show hidden devices" })
        expect("the desktop keeps its own group, still with no heading over it: ${listHeadings()}", "From your other devices" !in listHeadings())
        still("device-hidden")
        // The desktop hidden too: the state the user made keeps the group, with its way back.
        val second = holdDeviceHeading(DESKTOP)
        expect("the desktop's heading held opens its sheet too: '${sheetTitle()}'", second && sheetTitle().startsWith(DESKTOP))
        touchUntil("Hide Device", { steadyRect { menuRow("Hide Device") } }, { deviceNames().isEmpty() }, waitMs = SHEET_WAIT)
        expect("no device group is left: ${deviceNames()}", deviceNames().isEmpty())
        expect("the heading stands over the sentence: '${textOf(ALL_HIDDEN)}'", awaitUntil(4_000) { textOf(ALL_HIDDEN) == "You've hidden every device" })
        val headings = listHeadings()
        expect("From your other devices stands after Recently closed, before the days: $headings", headings.take(2) == listOf("Recently closed", "From your other devices"))
        expect("the row that shows them again stands under it", textOf(SHOW_HIDDEN) == "Show hidden devices")
        still("devices-all-hidden")
        touchUntil("Show hidden devices", { domRect(SHOW_HIDDEN) }, { deviceNames().size == 2 })
        expect("both devices are back, in their order: ${deviceNames()}", deviceNames() == listOf(DESKTOP, LAPTOP))
        expect("the row is gone with nothing hidden, the heading with it", !inDom(SHOW_HIDDEN) && "From your other devices" !in listHeadings())
        leaveHistory()
    }

    /** 18. The search reaches the other devices: a query only the laptop answers, the sentence over the rows, the row opening the page. */
    private fun devicesReachedBySearch() {
        finding("\n18. The search reaches the other devices: 'figma'")
        openOverview()
        openSearch()
        watchAnnouncements()
        keys("figma")
        expect("no card stands", awaitUntil(4_000) { cardBoxes().isEmpty() })
        expect("the New Tab card is off the grid", !inDom(NEW_TAB))
        expect("the laptop's Figma tab is listed", awaitUntil(8_000) { reachRemoteTitles() == listOf("Recents – Figma") })
        expect("under one heading, From your other devices: ${reachHeadings()}", reachHeadings() == listOf("From your other devices"))
        expect("the row reads its host and the device: '${reachSubtitles().firstOrNull()}'", reachSubtitles().firstOrNull() == "figma.com · $LAPTOP")
        expect("the grid's sentence names the open tabs (§9.34): '${textOf(EMPTY)}'", textOf(EMPTY) == "No open tabs found")
        expect("the sentence stands over the lists", (domRect(EMPTY)?.bottom ?: Int.MAX_VALUE) <= (domRect(REACH)?.top ?: 0))
        expect("the status region told '1 tab found'", awaitAnnouncement("1 tab found"))
        still("search-reach-devices")
        val tabsBefore = coreState().getJSONObject("tabs").length()
        val opened = touchUntil("the Figma row", { textRect(REACH_REMOTE_TITLE, "Recents") }, { coreState().getJSONObject("tabs").length() == tabsBefore + 1 }, waitMs = 6_000)
        expect("the row opened one new tab: ${tabsBefore} -> ${coreState().getJSONObject("tabs").length()}", opened)
        expect("the new tab is active with the row's address: ${activeCoreTab()?.optString("url")}", activeCoreTab()?.optString("url") == LAPTOP_FIGMA_URL)
        expect("the overview left", awaitUntil(8_000) { !inDom(".zen-overview") })
        awaitIme(false, 6_000)
        still("search-remote-opened")
    }

    /** 19. The search's Recently closed row restores the tab; the overview leaves. */
    private fun restoreClosedFromSearch() {
        finding("\n19. Restore from the search's Recently closed row")
        openOverview()
        openSearch()
        keys("coffee")
        expect("Coffee is listed under Recently closed", awaitUntil(8_000) { reachClosedTitles().any { it.startsWith("Coffee") } })
        val restored = touchUntil("Coffee's closed row", { textRect(REACH_CLOSED_TITLE, "Coffee") }, { tabExists(COFFEE) || coreTabWithUrl(COFFEE_URL) != null }, waitMs = 8_000)
        expect("the row brings the tab back", restored)
        expect("the restored tab is the active one: ${activeCoreTab()?.optString("url")}", awaitUntil(6_000) { activeCoreTab()?.optString("url") == COFFEE_URL })
        expect("the overview left", awaitUntil(8_000) { !inDom(".zen-overview") })
        expect("Recently closed is empty again", awaitUntil(6_000) { JSONArray(coreInvoke("session.recentlyClosed")).length() == 0 })
        awaitIme(false, 6_000)
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

    /** The app menu's History row (real touches, [openMenuItem]) until the History page is up. */
    private fun openHistory() {
        if (inDom(HISTORY)) return
        for (attempt in 1..OPEN_ATTEMPTS) {
            if (openMenuItem(MENU_HISTORY) && awaitUntil(8_000) { inDom(HISTORY) && textOf(".zen-phone-title") == "History" }) {
                SystemClock.sleep(1_500)
                return
            }
            finding("  (the History page did not come from the menu, attempt $attempt)")
            back()
            SystemClock.sleep(1_000)
        }
        error("the History page never opened from the menu")
    }

    /** The system back until the overview is gone: the keyboard's, the query's, the field's, then the overview's. */
    private fun leaveOverview() {
        for (attempt in 1..6) {
            if (!inDom(".zen-overview")) break
            back()
            awaitUntil(3_000) { !inDom(".zen-overview") }
            SystemClock.sleep(700)
        }
        if (inDom(".zen-overview")) error("the overview never left")
        awaitIme(false, 6_000)
        SystemClock.sleep(600)
    }

    /** The system back until the History page is gone. */
    private fun leaveHistory() {
        for (attempt in 1..3) {
            if (!inDom(HISTORY)) break
            back()
            awaitUntil(3_000) { !inDom(HISTORY) }
            SystemClock.sleep(700)
        }
        if (inDom(HISTORY)) error("the History page never left")
        SystemClock.sleep(600)
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
            "var g=e.closest('.zen-overview-grid, .zen-phone-panel .zen-phone-list');" +
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
                    "var g=e.closest('.zen-overview-grid, .zen-phone-panel .zen-phone-list');if(g){var gr=g.getBoundingClientRect(),er=e.getBoundingClientRect();" +
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
     * grid, fixed, over it) as they mount – the page cards and, apart, the New Tab card's own
     * exit – through an observer in the page: an exit lasts a few frames, too few for a poll
     * over the bridge to be sure of catching one.
     */
    private fun watchExits() {
        chromeJs(
            "(function(){var s='$EXIT',t='$NEW_TAB_EXIT';window.__zenExits=0;window.__zenNewTabExits=0;if(window.__zenExitWatch)window.__zenExitWatch.disconnect();" +
                "var o=new MutationObserver(function(ms){ms.forEach(function(m){m.addedNodes.forEach(function(n){if(n.nodeType!==1)return;" +
                "window.__zenExits+=(n.matches(s)?1:0)+n.querySelectorAll(s).length;" +
                "window.__zenNewTabExits+=(n.matches(t)?1:0)+n.querySelectorAll(t).length})})});" +
                "o.observe(document.body,{childList:true,subtree:true});window.__zenExitWatch=o;return 'ok'})()"
        )
    }

    private class Exits(val cards: Int, val newTab: Int)

    /** How many exits mounted since [watchExits], the cards' and the New Tab card's; the observer is taken down. */
    private fun exitsSeen(): Exits {
        val raw = jsString("(function(){if(window.__zenExitWatch)window.__zenExitWatch.disconnect();return String(window.__zenExits||0)+','+String(window.__zenNewTabExits||0)})()")
        val parts = raw.split(',')
        return Exits(parts.getOrNull(0)?.toIntOrNull() ?: 0, parts.getOrNull(1)?.toIntOrNull() ?: 0)
    }

    /** Whether the grid's last `data-cell` is the New Tab card (its place when it is back). */
    private fun lastCellIsNewTab(): Boolean =
        jsString("(function(){var c=document.querySelectorAll('.zen-overview-grid [data-cell]');var l=c[c.length-1];return l&&l.getAttribute('data-cell')==='new-tab'?'yes':''})()") == "yes"

    /** How many cards of `before` stand elsewhere in `after` (a pixel of tolerance for rounding). */
    private fun moved(before: Map<String, Rect>, after: Map<String, Rect>): Int =
        before.count { (id, b) -> after[id]?.let { a -> abs(a.left - b.left) > 1 || abs(a.top - b.top) > 1 } ?: false }

    private fun texts(selector: String): List<String> =
        jsList("Array.prototype.map.call(document.querySelectorAll(${JSONObject.quote(selector)}),function(e){return e.textContent.trim()})")

    /** The History page's Recently closed rows, by title. */
    private fun historyClosedTitles(): List<String> = texts(HISTORY_CLOSED_TITLE)

    /** The History page's device rows, by title, in page order. */
    private fun remoteRowTitles(): List<String> = texts(REMOTE_TITLE)

    /** The History page's device headings' names, in page order. */
    private fun deviceNames(): List<String> = texts("$DEVICE_HEADING > span:first-child")

    /** The History page's group headings, in page order (a device's with its aside run on). */
    private fun listHeadings(): List<String> = texts(".zen-phone-panel .zen-phone-list .zen-list-heading")

    /** The search's reach: its headings, its rows' titles and second lines. */
    private fun reachHeadings(): List<String> = texts("$REACH .zen-list-heading")
    private fun reachClosedTitles(): List<String> = texts(REACH_CLOSED_TITLE)
    private fun reachRemoteTitles(): List<String> = texts(REACH_REMOTE_TITLE)
    private fun reachSubtitles(): List<String> = texts("$REACH .zen-list-subtitle")

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
     * Start recording what the chrome's status region (`Announcer`, `role="status"`, one node
     * for the whole chrome) is given, through an observer in the page: a count is announced once
     * the typing has paused (500 ms) and the region is emptied 7 s later, and a trace's pull
     * between the typing and the check can outlast that – a poll after it finds the region empty
     * (the first retry did), though the words were said.
     */
    private fun watchAnnouncements() {
        chromeJs(
            "(function(){var r=document.querySelector('[data-announcer]');if(!r)return '';window.__zenSaid=[];" +
                "if(window.__zenSaidWatch)window.__zenSaidWatch.disconnect();" +
                "var note=function(){var t=r.textContent.trim();if(t&&window.__zenSaid[window.__zenSaid.length-1]!==t)window.__zenSaid.push(t)};" +
                "var o=new MutationObserver(note);o.observe(r,{childList:true,subtree:true,characterData:true});" +
                "window.__zenSaidWatch=o;note();return 'ok'})()"
        )
    }

    /** What the status region has been given since [watchAnnouncements], in order. */
    private fun announcements(): List<String> = jsList("(window.__zenSaid||[])")

    /**
     * Whether the status region reads `text` now, or was given it since [watchAnnouncements],
     * within `timeoutMs`.
     */
    private fun awaitAnnouncement(text: String, timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last = ""
        while (SystemClock.uptimeMillis() < deadline) {
            last = textOf("[data-announcer]")
            if (last == text || text in announcements()) return true
            SystemClock.sleep(100)
        }
        finding("  (the status region read '$last', not '$text'; said so far: ${announcements()})")
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
        remoteTab("l-3", LAPTOP_FIGMA_URL, "Recents – Figma", now - 5 * HOUR, disc("#a259ff")),
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
        private const val NEW_TAB_EXIT = ".zen-overview-new.fixed.pointer-events-none"
        /** The search's reach under the grid: its two sections by their headings. */
        private const val REACH = "[data-testid=\"overview-search-reach\"]"
        private const val REACH_CLOSED_TITLE = "$REACH section[aria-label=\"Recently closed\"] .zen-list-title"
        private const val REACH_REMOTE_TITLE = "$REACH section[aria-label=\"From your other devices\"] .zen-list-title"
        /** The History page (the app menu's row) and its groups. */
        private const val MENU_HISTORY = "History"
        /** The page itself: its group may be absent (§10.1's `none`), so the page is not read off the group. */
        private const val HISTORY = ".zen-phone-panel"
        private const val HISTORY_CLOSED_TITLE = ".zen-phone-panel section[aria-label=\"Recently closed\"] .zen-list-title"
        private const val DEVICES = "[data-testid=\"history-other-devices\"]"
        private const val DEVICE = "[data-testid=\"history-device\"]"
        private const val DEVICE_HEADING = ".zen-device-heading-button"
        private const val SYNC_OFF = "[data-testid=\"history-devices-sync-off\"]"
        private const val TABS_OFF = "[data-testid=\"history-devices-tabs-off\"]"
        private const val ALL_HIDDEN = "[data-testid=\"history-devices-hidden\"]"
        private const val SHOW_HIDDEN = "[data-testid=\"history-devices-show-hidden\"]"
        private const val ACTION = "$DEVICES .zen-list-action-row"
        private const val REMOTE_TITLE = "$DEVICE .zen-list-title"
        private const val SYNC_SETTINGS_URL = "zen://settings/sync"
        /** Settings › Sync asked for its Open tabs switch (`?row=`, the id `URLSearchParams` encodes). */
        private const val SYNC_SCOPE_URL = "zen://settings/sync?row=sync-scope%3AopenTabs"
        private const val SCOPE_ROW = "[data-row=\"sync-scope:openTabs\"]"

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
        private const val LAPTOP_FIGMA_URL = "https://www.figma.com/files/recent"
    }
}
