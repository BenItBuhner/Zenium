package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import android.view.InputDevice
import android.view.KeyCharacterMap
import android.view.KeyEvent
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.WebViewCompat
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Drives the TABLET SIDEBAR's private mode (W4-11; the private-browsing rule of
 * `docs/project-context.md`, design language v2 §9.36, §9.19; INC-05 / #250's lock) on the
 * `pixel_tablet` AVD laid out at 1280 x 800 dp, one px per dp (`DEMO_DISPLAY=1280x800@160`), on
 * the engine the private tabs demos run on (a Chromium snapshot WebView on the AOSP image:
 * private tabs need multi-profile WebView), with a device PIN set for the run so the lock has a
 * screen lock to arm on. Every press a real touch, every claim read off the chrome's DOM, its
 * stores or the core's state:
 *
 *  1. the REGULAR POSE: the seeded space's rows – Home, the group Research with Alpha and Beta,
 *     Gamma, Delta – no private header, the window on the scheme's ink;
 *  2. the app menu's New Private Tab: the sidebar turns to its PRIVATE POSE – the window
 *     re-inked private (dark whatever the scheme, §9.19), the mask's header "Private" with the
 *     count, the one private row, New Private Tab as its row, no space row at the foot, the
 *     mask in the pill's leading slot – and not one regular row; the tab sent to the ledger
 *     page, its row reads the page's title;
 *  3. the sidebar's own New Private Tab row: a second private tab, the header counting two, the
 *     rows in the session's order;
 *  4. the overview's Tabs pane and Home's card: the REGULAR POSE again with the private session
 *     open behind it – THE LEAK'S CLAIM: nothing of a private tab in the regular sidebar – no
 *     private row, no private title in the sidebar's text, no "Private" header, the scheme's ink;
 *  5. the overview's Private pane and the ledger's card: the private pose again, both rows;
 *  6. the rail: the mask alone for the header, the rows compressed; the expanded sidebar back;
 *  7. Home and back: the lock armed as the window left, and on return the frame's cover over
 *     the page with the sidebar's rows under the VEIL – every row "Private tab" behind the mask,
 *     no favicon, the list inert and hidden from accessibility, the pill reading "Private tab",
 *     nothing of the page in the accessibility tree, the header still counting two;
 *  8. Unlock under a finger and the PIN: the cover and the veil lift, the titles come back,
 *     the list is reachable again, the pill reads the address;
 *  9. the app menu's Close Private Tabs: the session ends, the regular pose with the seeded rows.
 *
 * The credential prompt is answered as the passwords and private lock demos answer it
 * (`PrivateLockDemo.answerPin`: the emulator has no biometric, `BiometricPrompt` falls back to
 * SystemUI's PIN view, the digits go in as key events). Findings in
 * `tablet-private-findings.txt`, stills `tablet-private-NN-<state>.png`. Driven by
 * `android-tablet-private-demo.yml`; the nightly's `tablet-webview` shard. See [GroupsDemoBase]
 * (the seeded Work space is the regular pose's) and [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class TabletPrivateDemo : GroupsDemoBase("tablet-private", "tablet-private-demo") {
    override val tag = "TabletPrivateDemo"
    override val findingsFile = "tablet-private-findings.txt"
    override val title = "Zenium Android tablet sidebar: the private pose, the regular pose, the lock's veil"

    private val host get() = (activity as MainActivity).host
    private var pinSet = false

    /** The scheme's ink before any private tab, as the chrome's root reads it (`data-theme`). */
    private var regularTheme = ""

    /** The two private tabs, once open: the ledger's (the app menu's) and the receipts' (the sidebar row's). */
    private var ledgerId: String? = null
    private var receiptsId: String? = null

    @Test
    fun record() {
        try {
            recordDemo(PRIVATE_PAGES)
        } finally {
            PrivateBrowsing.captureForRecording = false
            if (pinSet) shellCommand("locksettings clear --old $PIN")
        }
    }

    /** The recording must show the private surface (FLAG_SECURE would black it out); the PIN is the screen lock the lock arms on. */
    override fun beforeLaunch() {
        PrivateBrowsing.captureForRecording = true
        Log.i(tag, "set-pin: ${shellCommand("locksettings set-pin $PIN").trim()}")
        pinSet = true
        shellCommand("wm dismiss-keyguard")
    }

    override fun warmUp() {
        ensureForeground()
        head()
        finding(
            "multi-profile WebView: ${onMain { Profiles.supported }} (${WebViewCompat.getCurrentWebViewPackage(app)?.versionName ?: "?"}); " +
                "device PIN set: $pinSet; screen lock per the host: ${onMain { host.reauth.available() }}"
        )
        check("the chrome laid the window out as the tablet", awaitJs("document.documentElement.dataset.formFactor==='tablet'", true, 10_000), "form factor ${jsText("document.documentElement.dataset.formFactor")}")
        check("the sidebar is docked expanded at 1280 wide", awaitJs("(document.querySelector('$CHROME_ROOT')||{dataset:{}}).dataset.sidebar==='expanded'", true, 8_000), "data-sidebar ${sidebarMode()}")
        check("private tabs are on offer (multi-profile WebView)", onMain { Profiles.supported }, "")
        awaitLoaded(HOME, "$ORIGIN/")
        calibrate(ADDRESS_PILL, PILL_LABEL, prefix = true)
        // Pay for the first layout of a popover menu and of the overview off camera (the emulator
        // compiles and lays each out slowly the first time), and for the private profile's
        // creation (the first private tab's is the slow one): opened and closed through the core.
        touch(domRect(MENU_BUTTON), "the toolbar's menu button")
        if (awaitJs(MENU_OPEN, true, 4_000)) {
            SystemClock.sleep(800)
            back()
            awaitJs(MENU_OPEN, false)
        }
        if (pullOverview()) {
            SystemClock.sleep(1_000)
            back()
            awaitJs("$OVERVIEW_PHASE==='closed'", true, 5_000)
        }
        coreInvoke("tab.newPrivate", "{}")
        awaitUntil(10_000) { privateActive() }
        SystemClock.sleep(1_500)
        coreInvoke("tab.closePrivate")
        awaitUntil(8_000) { privateTabIds().isEmpty() }
        coreInvoke("tab.activate", JSONObject().put("tabId", HOME).toString())
        awaitUntil(5_000) { activeTabId() == HOME }
        // The switch (SET-17, "Lock private tabs when you leave Zenium"): on for the run through
        // the core, as Settings' row would set it; the lock itself is the host's ([PrivateLock]).
        coreInvoke("private.setLockOnLeave", "{\"enabled\":true}")
        check("the lock switch is on for the run (the core and the host)", awaitCore { it.optBoolean("privateLockOnLeave") } && awaitUntil(3_000) { host.privateLock.enabled }, "core ${coreState().optBoolean("privateLockOnLeave")}, host ${host.privateLock.enabled}")
        awaitDomGone(POSE_STILL, 3_000)
        SystemClock.sleep(1_500)
        finding("warm-up done: ${describeSpace()}, sidebar ${sidebarMode()}, pose ${pose()}")
    }

    override fun demo() {
        regularPose()
        enterPrivate()
        secondPrivateTab()
        regularBehindPrivate()
        privateAgain()
        rail()
        lock()
        unlock()
        closePrivateTabs()
        still("end")
        tail()
    }

    // --- 1. the regular pose ---------------------------------------------------------------------

    private fun regularPose() {
        section("1. The regular pose: the space's rows, nothing private (§9.36)")
        regularTheme = chromeScheme()
        check("the sidebar stands in its regular pose", pose() == "regular", "pose '${pose()}'")
        check("the seeded rows are there: Home, Alpha, Beta, Gamma, Delta under the group", SEEDED.all { inDom(row(it)) } && inDom(GROUP_ROW), "rows ${sidebarTabIds()}")
        check("no private header, no private row", !inDom(PRIVATE_HEADER) && !inDom(PRIVATE_LIST) && privateTabIds().isEmpty(), "header ${inDom(PRIVATE_HEADER)}, private tabs ${privateTabIds()}")
        check("the spaces row is at the foot", inDom(SPACE_STRIP), "")
        check("the window is on the scheme's ink, not the private theme", !privateInk() && regularTheme == "light", "data-private ${privateInk()}, theme '$regularTheme'")
        SystemClock.sleep(800)
        still("regular-pose")
    }

    // --- 2. New Private Tab from the app menu ---------------------------------------------------

    private fun enterPrivate() {
        section("2. New Private Tab from the app menu: the sidebar's private pose")
        if (!openAppMenu()) return
        check("the menu offers New Private Tab, and Close Private Tabs greyed with no private tab open", menuRow("New Private Tab") != null && menuDisabled("Close Private Tabs"), "items ${textsOf(MENU_ITEM)}")
        SystemClock.sleep(800)
        still("app-menu")
        val opened = touchUntil("New Private Tab", { menuRow("New Private Tab") }, { privateActive() }, waitMs = 8_000)
        check("a touch on New Private Tab opens a private tab in front", opened, "active ${activeCoreTab()?.optString("containerId")}")
        check("the sidebar turns to its private pose", awaitJs("$POSE==='private'", true, 6_000), "pose '${pose()}'")
        awaitDomGone(POSE_STILL, 3_000)
        check("the window re-inks private: dark whatever the scheme (§9.19)", awaitJs("document.documentElement.dataset.theme==='dark'", true, 4_000) && privateInk(), "theme '${chromeScheme()}', data-private ${privateInk()}")
        check("the header reads Private with the mask, counting one", awaitDom(PRIVATE_HEADER, 3_000) && textOf(PRIVATE_HEADER).startsWith("Private") && headerCount() == "1" && inDom("$PRIVATE_HEADER svg"), "header '${textOf(PRIVATE_HEADER)}'")
        ledgerId = privateTabIds().firstOrNull()
        check("the one private tab is the list's row, active", ledgerId != null && awaitDom(row(ledgerId!!), 3_000) && attrOf(row(ledgerId!!), "aria-selected") == "true" && sidebarTabIds() == listOf(ledgerId), "rows ${sidebarTabIds()}")
        check("not one regular row: the space's tabs are not this pose's", SEEDED.none { inDom(row(it)) } && !inDom(GROUP_ROW), "rows ${sidebarTabIds()}")
        check("New Private Tab is the list's row", awaitDom(NEW_TAB_ROW, 2_000) && textOf(NEW_TAB_ROW) == "New Private Tab", "row '${textOf(NEW_TAB_ROW)}'")
        check("no spaces row, no Essentials: the session is not a workspace", !inDom(SPACE_STRIP) && !inDom(ESSENTIALS), "strip ${inDom(SPACE_STRIP)}")
        check("the mask stands in the pill's leading slot", inDom(PILL_MASK), "")
        // The ledger page: what the lock must hide later, readable at a glance meanwhile.
        val id = ledgerId ?: return
        coreInvoke("tab.navigate", JSONObject().put("tabId", id).put("input", LEDGER_URL).toString())
        check("the tab shows the ledger page", awaitLoaded(id, LEDGER_URL), "url ${tabUrl(id)}")
        check("its row reads the page's title", awaitJs("(document.querySelector('${rowTitle(id)}')||{textContent:''}).textContent.trim()==='$LEDGER_TITLE'", true, 8_000), "title '${textOf(rowTitle(id))}'")
        SystemClock.sleep(1_200)
        still("private-pose")
    }

    // --- 3. the sidebar's New Private Tab row -------------------------------------------------------

    private fun secondPrivateTab() {
        section("3. The sidebar's New Private Tab row: a second private tab")
        val before = privateTabIds().toSet()
        val added = touchUntil("New Private Tab", { domRect(NEW_TAB_ROW) }, { privateTabIds().size == before.size + 1 }, waitMs = 8_000)
        check("a touch on the row opens a second private tab", added, "private tabs ${privateTabIds()}")
        receiptsId = privateTabIds().firstOrNull { it !in before }
        val id = receiptsId ?: return
        check("the new tab is the active row", awaitDom(row(id), 4_000) && awaitJs("(document.querySelector('${row(id)}')||{getAttribute:function(){return ''}}).getAttribute('aria-selected')==='true'", true, 4_000), "active ${activeTabId()}")
        check("the header counts two", awaitJs("(document.querySelector('$PRIVATE_HEADER_COUNT')||{textContent:''}).textContent.trim()==='2'", true, 3_000), "header '${textOf(PRIVATE_HEADER)}'")
        coreInvoke("tab.navigate", JSONObject().put("tabId", id).put("input", RECEIPTS_URL).toString())
        check("the second tab shows the receipts page", awaitLoaded(id, RECEIPTS_URL), "url ${tabUrl(id)}")
        check("the rows stand in the session's order: the ledger, the receipts", awaitJs("(document.querySelector('${rowTitle(id)}')||{textContent:''}).textContent.trim()==='$RECEIPTS_TITLE'", true, 8_000) && sidebarTabIds() == listOf(ledgerId, id), "rows ${sidebarTabIds()}")
        check("still the private pose, the private ink", pose() == "private" && privateInk(), "pose '${pose()}'")
        SystemClock.sleep(1_200)
        still("two-private-tabs")
    }

    // --- 4. the regular pose with the session behind it ---------------------------------------------

    private fun regularBehindPrivate() {
        section("4. Home's card on the overview's Tabs pane: the regular pose over an open private session – the leak's claim")
        if (!openOverview()) return
        check("the overview opens on the Private pane from a private tab", awaitPane("private"), "pane '${pane()}'")
        SystemClock.sleep(1_000)
        still("overview-private-pane")
        val toTabs = touchUntil("the Tabs segment", { domRect(SEGMENT_TABS) }, { pane() == "tabs" }, waitMs = 4_000)
        check("a touch on Tabs shows the regular pane", toTabs, "pane '${pane()}'")
        SystemClock.sleep(800)
        val toHome = touchUntil("Home's card", { domRect(card(HOME)) }, { activeTabId() == HOME }, waitMs = 8_000)
        check("a touch on Home's card brings the regular tab to the front", toHome && awaitJs("$OVERVIEW_PHASE==='closed'", true, 8_000), "active ${activeTabId()}, overview ${jsText(OVERVIEW_PHASE)}")
        check("the sidebar is back in its regular pose", awaitJs("$POSE==='regular'", true, 6_000), "pose '${pose()}'")
        awaitDomGone(POSE_STILL, 3_000)
        check("the window is back on the scheme's ink", awaitJs("document.documentElement.dataset.theme==='$regularTheme'", true, 4_000) && !privateInk(), "theme '${chromeScheme()}', data-private ${privateInk()}")
        val ids = sidebarTabIds()
        val text = sidebarText()
        val privateIds = privateTabIds()
        check(
            "THE LEAK: a private tab is not a row of the regular sidebar – neither of the two open private tabs has a row",
            privateIds.size == 2 && ids.none { it in privateIds } && ids.containsAll(SEEDED),
            "rows $ids, private tabs $privateIds"
        )
        check("no private title in the sidebar's text, no Private header, no private list", !text.contains(LEDGER_TITLE) && !text.contains(RECEIPTS_TITLE) && !inDom(PRIVATE_HEADER) && !inDom(PRIVATE_LIST), "text '${text.take(120)}'")
        check("no private mark on any row either: the regular rows are the space's, unmasked", jsBoolean("[...document.querySelectorAll('$SIDEBAR [data-tab-id]')].every(function(r){return !r.hasAttribute('data-masked')})"), "")
        check("the spaces row is back at the foot, New Tab as the row", inDom(SPACE_STRIP) && textOf(NEW_TAB_ROW) == "New Tab", "row '${textOf(NEW_TAB_ROW)}'")
        check("the session stays open behind the pose (the core keeps both tabs)", privateIds.all { tabExists(it) }, "private tabs $privateIds")
        SystemClock.sleep(1_200)
        still("regular-pose-session-behind")
    }

    // --- 5. the private pose again, from the Private pane ------------------------------------------

    private fun privateAgain() {
        section("5. The ledger's card on the Private pane: the private pose again")
        if (!openOverview()) return
        check("the overview opens on the Tabs pane from a regular tab", awaitPane("tabs"), "pane '${pane()}'")
        val toPrivate = touchUntil("the Private segment", { domRect(SEGMENT_PRIVATE) }, { pane() == "private" }, waitMs = 4_000)
        check("a touch on Private shows the private pane", toPrivate, "pane '${pane()}'")
        SystemClock.sleep(800)
        val id = ledgerId ?: return
        val toLedger = touchUntil("the ledger's card", { domRect(card(id)) }, { activeTabId() == id }, waitMs = 8_000)
        check("a touch on the ledger's card brings it to the front", toLedger && awaitJs("$OVERVIEW_PHASE==='closed'", true, 8_000), "active ${activeTabId()}")
        check("the sidebar turns private again", awaitJs("$POSE==='private'", true, 6_000), "pose '${pose()}'")
        awaitDomGone(POSE_STILL, 3_000)
        check("both rows, the ledger's active", awaitJs("document.querySelectorAll('$SIDEBAR [data-tab-id]').length===2", true, 4_000) && sidebarTabIds() == listOf(ledgerId, receiptsId) && attrOf(row(id), "aria-selected") == "true", "rows ${sidebarTabIds()}")
        check("the private ink again", privateInk() && chromeScheme() == "dark", "theme '${chromeScheme()}'")
        SystemClock.sleep(1_200)
        still("private-pose-again")
    }

    // --- 6. the rail -------------------------------------------------------------------------------

    private fun rail() {
        section("6. The rail: the mask alone for the header")
        val toRail = touchUntil("the sidebar toggle", { domRect(SIDEBAR_TOGGLE) }, { sidebarMode() == "rail" }, waitMs = 4_000)
        check("the toggle collapses the sidebar to the rail", toRail, "data-sidebar ${sidebarMode()}")
        SystemClock.sleep(1_000)
        check("the header is the mask alone, named Private", inDom("$PRIVATE_HEADER svg") && textOf(PRIVATE_HEADER) == "" && attrOf(PRIVATE_HEADER, "title") == "Private", "header '${textOf(PRIVATE_HEADER)}'")
        check("the rows stay, compressed to their favicons", sidebarTabIds() == listOf(ledgerId, receiptsId) && jsBoolean("[...document.querySelectorAll('$SIDEBAR [data-tab-id]')].every(function(r){return !r.querySelector('[data-testid=\"tab-title\"]')})"), "rows ${sidebarTabIds()}")
        still("private-rail")
        val toExpanded = touchUntil("the sidebar toggle", { domRect(SIDEBAR_TOGGLE) }, { sidebarMode() == "expanded" }, waitMs = 4_000)
        check("the toggle brings the expanded sidebar back", toExpanded, "data-sidebar ${sidebarMode()}")
        SystemClock.sleep(1_000)
    }

    // --- 7. the lock --------------------------------------------------------------------------------

    private fun lock() {
        section("7. Home and back: the lock's veil over the private pose (INC-05, #250)")
        check("set-up: the ledger is in front, the lock switch on, nothing locked", activeTabId() == ledgerId && host.privateLock.enabled && !host.privateLock.locked, "active ${activeTabId()}, enabled ${host.privateLock.enabled}, locked ${host.privateLock.locked}")
        home()
        check("Home puts Zenium in the background", awaitFront(ours = false), "front ${frontPackage()}")
        val armed = awaitUntil(4_000) { host.privateLock.locked }
        SystemClock.sleep(1_500)
        returnToApp()
        check("Zenium is back in front", awaitFront(ours = true), "front ${frontPackage()}")
        check("the lock armed as the window left", armed, "locked ${host.privateLock.locked}")
        check("the frame's cover is over the page on return", awaitCover(FRAME_COVER, 12_000), "cover ${coverState(FRAME_COVER)}")
        check("the host holds the lock and the chrome's store agrees", host.privateLock.locked && storeLocked(), "store ${storeField("locked")}")
        check("the sidebar keeps its private pose, under the veil", pose() == "private" && awaitCover(VEIL, 6_000), "pose '${pose()}', veil ${coverState(VEIL)}")
        check("every row reads Private tab behind the mask, no favicon, no control", awaitJs(ROWS_MASKED, true, 4_000), "rows ${rowTitles()}")
        check("the list and its New Private Tab lie inert, hidden from accessibility", listInert(), "")
        check("the header stays, counting two", textOf(PRIVATE_HEADER_COUNT) == "2", "header '${textOf(PRIVATE_HEADER)}'")
        check("the pill reads Private tab and asks for the unlock", awaitDom(PILL_LOCKED, 4_000) && textOf(PILL_LOCKED) == "Private tab" && findByLabel(PILL_LOCKED_LABEL) != null, "pill '${textOf(PILL_LOCKED)}'")
        check("no Site information control under the lock", findByLabel("Site information") == null, "")
        val leaked = findNode { it.contains(LEDGER_TITLE, ignoreCase = true) || it.contains(RECEIPTS_TITLE, ignoreCase = true) || it.contains(LEDGER_PATH) }
        check("the accessibility tree carries nothing of the pages under the lock", leaked == null, "node ${leaked?.text ?: leaked?.contentDescription ?: ""}")
        finding("  cover: ${coverState(FRAME_COVER)}; veil: ${coverState(VEIL)}; rows ${rowTitles()}; pill '${textOf(PILL_LOCKED)}'")
        SystemClock.sleep(1_200)
        still("locked")
    }

    // --- 8. the unlock -------------------------------------------------------------------------------

    private fun unlock() {
        section("8. Unlock under a finger: the PIN lifts the cover and the veil, the titles come back")
        val prompted = touchUntil("Unlock", { domRect(UNLOCK) }, { credentialPromptShowing() }, waitMs = 6_000)
        check("a finger on Unlock brings the credential prompt", prompted, "prompt ${credentialPromptShowing()}")
        SystemClock.sleep(1_200)
        still("unlock-prompt")
        check("the PIN is accepted", answerPin("unlock"), "")
        check("the lock comes off: the host and the chrome's store", awaitUntil(5_000) { !host.privateLock.locked && !storeLocked() }, "host ${host.privateLock.locked}, store ${storeField("locked")}")
        check("the frame's cover lifts and goes", awaitDomGone(FRAME_COVER, 10_000), "cover ${coverState(FRAME_COVER)}")
        check("the veil lifts with it", awaitDomGone(VEIL, 6_000), "veil ${coverState(VEIL)}")
        check("the rows read their titles again, the favicons back", awaitJs(ROWS_UNMASKED, true, 6_000) && rowTitles() == listOf(LEDGER_TITLE, RECEIPTS_TITLE), "rows ${rowTitles()}")
        check("the list is reachable again", !listInert(), "")
        check("the pill reads the address again", awaitDomGone(PILL_LOCKED, 4_000) && pillText().contains("ledger"), "pill '${pillText()}'")
        check("the private pose and its ink stay", pose() == "private" && privateInk(), "pose '${pose()}'")
        SystemClock.sleep(1_200)
        still("unlocked")
    }

    // --- 9. Close Private Tabs ---------------------------------------------------------------------

    private fun closePrivateTabs() {
        section("9. Close Private Tabs from the app menu: the session ends, the regular pose")
        if (!openAppMenu()) return
        check("the menu's Close Private Tabs is live with two private tabs open", menuRow("Close Private Tabs") != null && !menuDisabled("Close Private Tabs"), "items ${textsOf(MENU_ITEM)}")
        val closed = touchUntil("Close Private Tabs", { menuRow("Close Private Tabs") }, { privateTabIds().isEmpty() }, waitMs = 10_000)
        check("a touch on Close Private Tabs ends the session", closed, "private tabs ${privateTabIds()}")
        check("the sidebar is back in its regular pose", awaitJs("$POSE==='regular'", true, 6_000), "pose '${pose()}'")
        awaitDomGone(POSE_STILL, 3_000)
        check("the window is back on the scheme's ink", awaitJs("document.documentElement.dataset.theme==='$regularTheme'", true, 4_000) && !privateInk(), "theme '${chromeScheme()}'")
        check("the seeded rows and nothing else", sidebarTabIds().containsAll(SEEDED) && sidebarTabIds().none { it == ledgerId || it == receiptsId } && !inDom(PRIVATE_HEADER), "rows ${sidebarTabIds()}")
        check("nothing left to lock: the host's lock is off", !host.privateLock.locked, "locked ${host.privateLock.locked}")
        SystemClock.sleep(1_200)
        still("session-closed")
    }

    // --- the app menu ------------------------------------------------------------------------------

    /** The ⋯'s popover up with its rows in the DOM; a failed claim (and false) when it never comes. */
    private fun openAppMenu(): Boolean {
        for (attempt in 1..3) {
            touch(domRect(MENU_BUTTON), "the toolbar's menu button") ?: break
            if (awaitJs(MENU_OPEN, true, 3_000) && awaitDom(MENU_ITEM, 3_000)) {
                SystemClock.sleep(600)
                return true
            }
            finding("  (the touch did not bring the app menu, attempt $attempt)")
            if (inDom(MENU)) back()
            SystemClock.sleep(600)
        }
        check("a touch on the ⋯ brings the app menu", false, "menu ${jsText(MENU_OPEN)}")
        return false
    }

    private fun menuRow(prefix: String) = textRect(MENU_ITEM, prefix)

    private fun menuDisabled(prefix: String): Boolean = jsBoolean(
        "(function(){var e=Array.prototype.find.call(document.querySelectorAll('$MENU_ITEM'),function(n){return n.textContent.trim().indexOf(${JSONObject.quote(prefix)})===0});" +
            "return !!e&&(e.disabled===true||e.getAttribute('aria-disabled')==='true')})()"
    )

    // --- the overview ------------------------------------------------------------------------------

    /** A pull down the address pill (the tablet's way in); whether the overview opened. */
    private fun pullOverview(): Boolean {
        val pill = screen(steadyRect { domRect(ADDRESS_PILL) }) ?: return false
        val f = Finger()
        f.down(pill.exactCenterX(), pill.exactCenterY())
        f.moveBy(0f, 0.55f * height, 700)
        f.up()
        return awaitJs("$OVERVIEW_PHASE==='open'", true, 6_000)
    }

    private fun openOverview(): Boolean {
        for (attempt in 1..2) {
            if (pullOverview()) {
                SystemClock.sleep(1_200)
                return true
            }
            finding("  (the pull did not open the overview, attempt $attempt)")
            SystemClock.sleep(800)
        }
        check("a pull down the pill opens the tab overview", false, "phase ${jsText(OVERVIEW_PHASE)}")
        return false
    }

    private fun pane(): String = jsString("(function(){var p=document.querySelector('.zen-overview-pane [data-pane]');return p?(p.getAttribute('data-pane')||''):''})()")

    private fun awaitPane(pane: String, timeoutMs: Long = 6_000): Boolean = awaitUntil(timeoutMs) { pane() == pane }

    // --- the chrome's state -------------------------------------------------------------------------

    private fun pose(): String = jsText(POSE)

    private fun sidebarMode(): String = jsText("(document.querySelector('$CHROME_ROOT')||{dataset:{}}).dataset.sidebar")

    private fun chromeScheme(): String = jsString("document.documentElement.dataset.theme||''")

    /** The window on the private theme: the chrome root's `data-private` (`usePrivateSurface`). */
    private fun privateInk(): Boolean = jsBoolean("(function(){var r=document.querySelector('$CHROME_ROOT');return !!r&&r.hasAttribute('data-private')})()")

    private fun headerCount(): String = textOf(PRIVATE_HEADER_COUNT)

    /** The sidebar's tab rows in order, by id. */
    private fun sidebarTabIds(): List<String> = jsArray("Array.prototype.map.call(document.querySelectorAll('$SIDEBAR [data-tab-id]'),function(e){return e.getAttribute('data-tab-id')})").strings()

    private fun rowTitles(): List<String> = textsOf("$SIDEBAR [data-tab-id] [data-testid=\"tab-title\"]")

    private fun sidebarText(): String = jsString("(function(){var s=document.querySelector('$SIDEBAR');return s?s.textContent:''})()")

    /** The private list's scroller is `inert` and `aria-hidden` (the rows and New Private Tab under the veil). */
    private fun listInert(): Boolean = jsBoolean(
        "(function(){var l=document.querySelector('$PRIVATE_LIST');var s=l&&l.closest('[data-tab-scroller]');return !!s&&s.hasAttribute('inert')&&s.getAttribute('aria-hidden')==='true'})()"
    )

    private fun pillText(): String = jsString("(function(){var p=document.querySelector('$ADDRESS_PILL');return p?p.textContent.trim():''})()")

    /** A lock cover at rest in the DOM (the frame's or the veil), not one on its way out. */
    private fun coverUp(selector: String): Boolean =
        jsBoolean("(function(){var e=document.querySelector(${JSONObject.quote(selector)});return !!e&&!e.hasAttribute('data-leaving')})()")

    private fun awaitCover(selector: String, timeoutMs: Long): Boolean = awaitUntil(timeoutMs) { coverUp(selector) }

    private fun coverState(selector: String): String = jsString(
        "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return 'none';return 'up'+(e.hasAttribute('data-leaving')?' leaving':'')+' p='+(e.style.getPropertyValue('--zen-lock-p')||'rest')})()"
    )

    /** A field of the chrome's `privateLockStore` (`window.__zenStores['private-lock']`), as text. */
    private fun storeField(name: String): String =
        jsString("(function(){var s=(window.__zenStores||{})['private-lock'];return s?String(s.get()[${JSONObject.quote(name)}]):'?'})()")

    private fun storeLocked(): Boolean = storeField("locked") == "true"

    // --- the core's private session -----------------------------------------------------------------

    private fun privateActive(): Boolean = activeCoreTab()?.optString("containerId") == Profiles.PRIVATE_CONTAINER

    /**
     * The private tabs the core holds, in the Private pane's order (`privateTabsOf`: the spaces
     * in their order, each space's tabs in theirs) – the order the sidebar's private pose lists.
     */
    private fun privateTabIds(state: JSONObject = coreState()): List<String> {
        val tabs = state.optJSONObject("tabs") ?: return emptyList()
        val isPrivate = { id: String -> tabs.optJSONObject(id)?.optString("containerId") == Profiles.PRIVATE_CONTAINER }
        val order = LinkedHashSet<String>()
        val spaces = state.optJSONArray("spaces")
        if (spaces != null) {
            for (i in 0 until spaces.length()) {
                val ids = spaces.getJSONObject(i).optJSONArray("tabIds") ?: continue
                for (j in 0 until ids.length()) ids.getString(j).takeIf(isPrivate)?.let(order::add)
            }
        }
        for (id in tabs.keys()) if (isPrivate(id)) order.add(id)
        return order.toList()
    }

    // --- Home and back ----------------------------------------------------------------------------

    private fun home() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
    }

    /**
     * Zenium back in front through the shell (`am start` of the running singleTask activity: the
     * task comes forward, nothing re-created); an in-process start is the fallback, as the private
     * lock demo has it.
     */
    private fun returnToApp() {
        val started = shellCommand("am start -W -a android.intent.action.MAIN -f 0x20000000 -n ${app.packageName}/${MainActivity::class.java.name}")
        if (!started.contains("Status: ok")) {
            finding("  am start: ${started.trim().lines().joinToString(" | ")}; starting from the process instead")
            app.startActivity(Intent(app, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    private fun frontPackage(): String? = ui.rootInActiveWindow?.packageName?.toString()

    private fun awaitFront(ours: Boolean, timeoutMs: Long = 10_000): Boolean =
        awaitUntil(timeoutMs) { frontPackage()?.let { (it == app.packageName) == ours } == true }

    // --- the credential prompt ----------------------------------------------------------------------

    /** BiometricPrompt fallen back to the device credential: a system window with a text field for the PIN. */
    private fun credentialPromptShowing(): Boolean = nodesInWindows { node ->
        node.packageName?.toString() in CREDENTIAL_PACKAGES && node.className?.toString() == "android.widget.EditText"
    }.isNotEmpty()

    /** The PIN as key events through UiAutomation, then Enter; true once the prompt has gone. */
    private fun answerPin(why: String): Boolean {
        if (!credentialPromptShowing()) {
            finding("  no credential prompt to answer for $why")
            return false
        }
        keys(PIN)
        pressKey(KeyEvent.KEYCODE_ENTER)
        val gone = awaitUntil(10_000) { !credentialPromptShowing() }
        finding("  credential prompt for $why: ${if (gone) "accepted the PIN" else "still up after the PIN"}")
        SystemClock.sleep(800)
        return gone
    }

    /** One character's events at a time, each stamped as it goes (a burst is dropped as stale on the slow emulator). */
    private fun keys(text: String) {
        val map = KeyCharacterMap.load(KeyCharacterMap.VIRTUAL_KEYBOARD)
        for (char in text) {
            val events = map.getEvents(charArrayOf(char)) ?: error("no key events for '$char'")
            for (event in events) {
                ui.injectInputEvent(event, true)
                SystemClock.sleep(25)
            }
        }
        SystemClock.sleep(200)
    }

    private fun pressKey(keyCode: Int) {
        val now = SystemClock.uptimeMillis()
        for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            val event = KeyEvent(now, SystemClock.uptimeMillis(), action, keyCode, 0, 0, KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD)
            ui.injectInputEvent(event, true)
            SystemClock.sleep(30)
        }
        SystemClock.sleep(300)
    }

    private fun nodesInWindows(predicate: (AccessibilityNodeInfo) -> Boolean): List<AccessibilityNodeInfo> {
        val roots = ArrayList<AccessibilityNodeInfo>()
        for (window in ui.windows) window.root?.let(roots::add)
        if (roots.isEmpty()) ui.rootInActiveWindow?.let(roots::add)
        val found = ArrayList<AccessibilityNodeInfo>()
        for (root in roots) {
            val queue = ArrayDeque<AccessibilityNodeInfo>()
            queue.add(root)
            var visited = 0
            while (queue.isNotEmpty() && visited < 3_000) {
                val node = queue.removeFirst()
                visited++
                if (predicate(node)) found += node
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
        }
        return found
    }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private companion object {
        /** Set with `locksettings set-pin` before the app starts; cleared at the end. */
        private const val PIN = "1234"
        private val CREDENTIAL_PACKAGES = setOf("com.android.systemui", "com.android.settings")

        private val SEEDED = listOf(HOME, ALPHA, BETA, GAMMA, DELTA)

        /** The private session's pages: large, readable – what the regular pose must not list and the lock must hide. */
        private const val LEDGER_PATH = "/ledger.html"
        private const val LEDGER_URL = "$ORIGIN$LEDGER_PATH"
        private const val LEDGER_TITLE = "Harbour ledger"
        private const val RECEIPTS_PATH = "/receipts.html"
        private const val RECEIPTS_URL = "$ORIGIN$RECEIPTS_PATH"
        private const val RECEIPTS_TITLE = "Receipts, March"
        private val PRIVATE_PAGES: Map<String, Pair<String, ByteArray>> = mapOf(
            LEDGER_PATH to DemoServer.page(
                LEDGER_TITLE,
                "<p style=\"font-size:22px\">Only a private tab reads this. Berth fees for the outer harbour: the Kestrel, 40 nights; the Marram, 12.</p>" +
                    "<p style=\"font-size:22px\">The lock cover and the sidebar's veil must hide every word of this page until the screen lock is passed; the regular sidebar must never list its title.</p>"
            ),
            RECEIPTS_PATH to DemoServer.page(RECEIPTS_TITLE, "<p style=\"font-size:22px\">The second private tab's page: a receipt for the blue kettle, and the dentist on Thursday at 9.</p>")
        )

        private const val CHROME_ROOT = "[data-testid=\"chrome-root\"]"
        private const val SIDEBAR = ".zen-tablet-sidebar"
        private const val ADDRESS_PILL = ".zen-tablet-toolbar [data-address-pill]"
        private const val SIDEBAR_TOGGLE = ".zen-tablet-toolbar [data-tablet-sidebar-toggle]"
        private const val MENU_BUTTON = ".zen-tablet-toolbar [data-zen-nav-row] > button[aria-haspopup=\"menu\"]"
        private const val MENU = ".zen-v2-menu"
        private const val MENU_ITEM = ".zen-v2-menu-item"
        private const val GROUP_ROW = "$SIDEBAR .zen-group-row[data-tab-folder=\"$FOLDER\"]"
        private const val PRIVATE_HEADER = "$SIDEBAR [data-testid=\"sidebar-private-header\"]"
        private const val PRIVATE_HEADER_COUNT = "$PRIVATE_HEADER .zen-group-row-count"
        private const val PRIVATE_LIST = "$SIDEBAR [data-tab-list=\"private\"]"
        private const val NEW_TAB_ROW = "$SIDEBAR [data-new-tab]"
        private const val SPACE_STRIP = "$SIDEBAR [data-space-target]"
        private const val ESSENTIALS = "$SIDEBAR [data-essentials]"
        /** The cross-fade's still of the pose that left (`PaneSlot`): gone before a claim reads the sidebar's text. */
        private const val POSE_STILL = "$SIDEBAR [data-testid=\"pane-still\"]"
        /** The mask in the pill's leading slot on a private tab (`NavRow`'s `data-private-mark`). */
        private const val PILL_MASK = "$ADDRESS_PILL [data-private-mark]"
        /** The pill's field under the lock: "Private tab" (`data-private-locked`), its button named for the unlock. */
        private const val PILL_LOCKED = "$ADDRESS_PILL [data-private-locked]"
        private const val PILL_LOCKED_LABEL = "Private tab locked, unlock"
        /** The content frame's lock cover (the blurred picture, the veil, Unlock) and the sidebar's veil form. */
        private const val FRAME_COVER = "[data-testid=\"private-lock-cover\"]:not([data-variant])"
        private const val VEIL = "$SIDEBAR [data-testid=\"private-lock-cover\"][data-variant=\"veil\"]"
        private const val UNLOCK = "$FRAME_COVER [data-testid=\"private-lock-unlock\"]"
        private const val SEGMENT_TABS = "[data-testid=\"overview-pane-tabs\"]"
        private const val SEGMENT_PRIVATE = "[data-testid=\"overview-pane-private\"]"

        /** Reads off the chrome's stores (`lib/store.ts` registers them on `window.__zenStores`). */
        private const val OVERVIEW_PHASE = "window.__zenStores.stage.get().overview.phase"
        /** The sidebar's pose, off its `<aside>` (`Sidebar`'s `data-pose`; the column around it is the toolbar's). */
        private const val POSE = "(document.querySelector('$SIDEBAR [data-pose]')||{dataset:{}}).dataset.pose"
        /**
         * Every sidebar row masked: "Private tab" for the title, the mask glyph (an `svg`) in the
         * favicon's slot where the page's picture – an `img`, or the letter tile of a page without
         * one (the demo server's) – would stand, no close button.
         */
        private const val ROWS_MASKED = "(function(){var rs=[...document.querySelectorAll('$SIDEBAR [data-tab-id]')];return rs.length>0&&rs.every(function(r){" +
            "var f=r.querySelector('.zen-tab-favicon');return r.getAttribute('data-masked')==='true'&&(r.querySelector('[data-testid=\"tab-title\"]')||{textContent:''}).textContent.trim()==='Private tab'" +
            "&&!!f&&f.tagName.toLowerCase()==='svg'&&!r.querySelector('img')&&!r.querySelector('.zen-tab-close')})})()"
        /** Every row unmasked: no `data-masked`, the page's own picture (never the mask glyph) in the favicon's slot. */
        private const val ROWS_UNMASKED = "[...document.querySelectorAll('$SIDEBAR [data-tab-id]')].every(function(r){var f=r.querySelector('.zen-tab-favicon');return !r.hasAttribute('data-masked')&&!!f&&f.tagName.toLowerCase()!=='svg'})"

        private fun row(tabId: String) = "$SIDEBAR [data-tab-id=\"$tabId\"]"
        private fun rowTitle(tabId: String) = "${row(tabId)} [data-testid=\"tab-title\"]"
        private fun card(tabId: String) = ".zen-overview [data-tab-id=\"$tabId\"]"
    }
}
