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
import org.json.JSONArray
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
 * Two SEQUENCE claims named at the design gate (read per frame off the chrome's DOM by a
 * `requestAnimationFrame` probe, never off the recording's clock): (a) across the pose switch –
 * §11.4's 120 ms cross-fade under §11.6's 240 ms theme blend, scenes 2 and 9 – no frame draws
 * the pose that leaves in the ink of the one arriving nor the one arriving in an ink the window
 * is not in: the still of the leaving pose keeps its rows to its last frame, fades out under
 * the polarity it left in and is gone before the blend flips the ink, and both layers read the
 * one ink the window paints that frame ([readPoseSwitch]); (b) across the lock – Home, the
 * return, Unlock, the lift, scenes 7 and 8 – the rows stay masked until the lock cover LANDS:
 * the first frame back has every row "Private tab", no frame between the lock's arming and the
 * veil's landing shows a private title, and the titles come back only as the veil and the
 * frame's cover rest at 0 ([readLockSpan]).
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
        check("the per-frame probes are installed in the chrome", chromeJs(PROBES) == "\"installed\"", "")
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
        // Claim (a), this way: the probe samples every frame from before the touch until the
        // blend has settled; the frames before the switch are its baseline.
        poseProbe("start")
        val opened = touchUntil("New Private Tab", { menuRow("New Private Tab") }, { privateActive() }, waitMs = 8_000)
        check("a touch on New Private Tab opens a private tab in front", opened, "active ${activeCoreTab()?.optString("containerId")}")
        check("the sidebar turns to its private pose", awaitJs("$POSE==='private'", true, 6_000), "pose '${pose()}'")
        awaitDomGone(POSE_STILL, 3_000)
        check("the window re-inks private: dark whatever the scheme (§9.19)", awaitJs("document.documentElement.dataset.theme==='dark'", true, 4_000) && privateInk(), "theme '${chromeScheme()}', data-private ${privateInk()}")
        SystemClock.sleep(600)
        readPoseSwitch("regular → private", from = "regular", to = "private", privateTitles = emptyList())
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
        // Claim (b): the probe samples every frame the chrome draws from here – across the
        // departure (no frames while the window is away), the return, the lock, Unlock and the
        // lift – until scene 8 reads it after the veil has landed.
        lockProbe("start")
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
        SystemClock.sleep(600)
        readLockSpan()
        SystemClock.sleep(600)
        still("unlocked")
    }

    // --- 9. Close Private Tabs ---------------------------------------------------------------------

    private fun closePrivateTabs() {
        section("9. Close Private Tabs from the app menu: the session ends, the regular pose")
        if (!openAppMenu()) return
        check("the menu's Close Private Tabs is live with two private tabs open", menuRow("Close Private Tabs") != null && !menuDisabled("Close Private Tabs"), "items ${textsOf(MENU_ITEM)}")
        // Claim (a), the other way: the private pose leaves as a still – the direction the leak
        // would take, its rows the private titles – under the blend back to the scheme.
        poseProbe("start")
        val closed = touchUntil("Close Private Tabs", { menuRow("Close Private Tabs") }, { privateTabIds().isEmpty() }, waitMs = 10_000)
        check("a touch on Close Private Tabs ends the session", closed, "private tabs ${privateTabIds()}")
        check("the sidebar is back in its regular pose", awaitJs("$POSE==='regular'", true, 6_000), "pose '${pose()}'")
        awaitDomGone(POSE_STILL, 3_000)
        check("the window is back on the scheme's ink", awaitJs("document.documentElement.dataset.theme==='$regularTheme'", true, 4_000) && !privateInk(), "theme '${chromeScheme()}'")
        SystemClock.sleep(600)
        readPoseSwitch("private → regular", from = "private", to = "regular", privateTitles = listOf(LEDGER_TITLE, RECEIPTS_TITLE))
        check("the seeded rows and nothing else", sidebarTabIds().containsAll(SEEDED) && sidebarTabIds().none { it == ledgerId || it == receiptsId } && !inDom(PRIVATE_HEADER), "rows ${sidebarTabIds()}")
        check("nothing left to lock: the host's lock is off", !host.privateLock.locked, "locked ${host.privateLock.locked}")
        SystemClock.sleep(1_200)
        still("session-closed")
    }

    // --- the two claims' probes (the design gate's) -------------------------------------------------

    /** `start` / `stop` on the switch's probe; a start that did not take is a failed claim. */
    private fun poseProbe(op: String): String {
        val answer = jsString("window.__pose?window.__pose.$op():''")
        if (op == "start") check("(a) the switch's probe is sampling", answer == "started", "answer '$answer'")
        return answer
    }

    private fun lockProbe(op: String): String {
        val answer = jsString("window.__veil?window.__veil.$op():''")
        if (op == "start") check("(b) the lock's probe is sampling", answer == "started", "answer '$answer'")
        return answer
    }

    /** One layer of the switch as a frame saw it: the wrapper's opacity, its tab rows, their titles, the first row's ink. */
    private class Layer(val opacity: Double, val rows: Int, val titles: List<String>, val ink: String) {
        override fun toString() = "%.2f/%d%s %s".format(opacity, rows, if (titles.isEmpty()) "" else " '${titles.first()}'", ink.ifEmpty { "-" })
    }

    private class PoseFrame(val t: Int, val pose: String, val theme: String, val privateOn: Boolean, val fg: String, val bg: String, val switching: Boolean, val still: Layer?, val live: Layer)

    private fun layerOf(o: JSONObject?): Layer? {
        if (o == null) return null
        val titles = o.optJSONArray("t")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
        return Layer(o.optDouble("o", Double.NaN), o.optInt("n"), titles, o.optString("c"))
    }

    /** `#rrggbb` as Chromium's computed `rgb(r, g, b)`, so a painted token compares with a row's colour. */
    private fun rgbOf(hex: String): String {
        val h = hex.trim().removePrefix("#")
        if (h.length != 6) return hex.trim()
        return runCatching { "rgb(${h.substring(0, 2).toInt(16)}, ${h.substring(2, 4).toInt(16)}, ${h.substring(4, 6).toInt(16)})" }.getOrDefault(hex.trim())
    }

    /**
     * CLAIM (a), one direction of the switch: the frames the probe recorded from before the
     * trigger to the blend's rest, read for sequence and state. `from` → `to` are the poses;
     * `privateTitles` the private pages' titles as of the switch (what the regular pose's rows
     * must never carry). Six checks, then the frame table into the findings.
     */
    private fun readPoseSwitch(label: String, from: String, to: String, privateTitles: List<String>) {
        val raw = poseProbe("stop")
        val array = runCatching { JSONArray(raw) }.getOrNull()
        if (array == null || array.length() == 0) {
            check("(a) $label: the probe recorded the switch", false, "no frames")
            return
        }
        val frames = (0 until array.length()).map { i ->
            val f = array.getJSONObject(i)
            PoseFrame(
                f.optInt("t"), f.optString("pose"), f.optString("theme"), f.optBoolean("priv"), f.optString("fg"), f.optString("bg"), f.optBoolean("sw"),
                layerOf(f.optJSONObject("still")), layerOf(f.optJSONObject("live")) ?: Layer(Double.NaN, 0, emptyList(), "")
            )
        }
        // The switch's first frame: the pose changed or the still came (both in one commit: the still
        // is taken as the pose goes and drawn in the same paint the arriving pose first has).
        val start = frames.indexOfFirst { it.still != null || it.pose != frames[0].pose }
        if (start < 0 || frames[0].pose != from) {
            check("(a) $label: the probe caught the switch", false, "first pose '${frames[0].pose}', switch frame $start of ${frames.size}")
            return
        }
        val base = frames[maxOf(0, start - 1)]
        val leavingPolarity = base.theme
        val arrivingPolarity = if (leavingPolarity == "dark") "light" else "dark"
        val leavingInk = base.live.ink
        val stillFrames = frames.mapNotNull { f -> f.still?.let { f to it } }
        val lastVisibleStill = frames.indexOfLast { (it.still?.opacity ?: 0.0) > 0.02 }
        val flip = frames.indexOfFirst { it.theme != leavingPolarity }
        val settled = frames.last().theme == arrivingPolarity && frames.last().pose == to && frames.last().still == null
        // The blend at rest: the painted background stops moving.
        val lastMove = (1..frames.lastIndex).lastOrNull { frames[it].bg != frames[it - 1].bg } ?: frames.lastIndex
        val rest = minOf(frames.lastIndex, lastMove + 2)

        if (stillFrames.isEmpty()) {
            check("(a) $label: the probe caught the still of the pose that left", false, "switch at frame $start of ${frames.size}, no still in any frame")
            return
        }
        val visibleStills = stillFrames.filter { (_, s) -> s.opacity > 0.02 }
        val lastStill = stillFrames.last().first
        check("(a) $label: the switch was recorded frame by frame – the still came with the arriving pose in one frame, and the blend settled", frames[start].pose == to && frames[start].still != null && settled,
            "frames ${frames.size}, switch at frame $start (+${frames[start].t} ms), stills ${stillFrames.size} frames, flip at ${if (flip < 0) "never" else "frame $flip (+${frames[flip].t} ms)"}, at rest by +${frames[rest].t} ms")
        check("(a) $label: the still is a still – the leaving pose's rows, unchanged, to its last frame", stillFrames.all { (_, s) -> s.titles == base.live.titles && s.rows == base.live.rows },
            "leaving rows ${base.live.titles}; the still's ${stillFrames.map { (_, s) -> s.titles }.distinct()}")
        check("(a) $label: no frame draws the leaving pose's rows in the arriving pose's ink – the still fades out under the polarity it left in, in the ink it left in, and is gone before the flip",
            visibleStills.all { (f, s) -> f.theme == leavingPolarity && s.ink == leavingInk } && (flip < 0 || flip > lastVisibleStill),
            "still visible through frame $lastVisibleStill (+${if (lastVisibleStill >= 0) frames[lastVisibleStill].t else 0} ms), flip at frame $flip; inks under the still ${stillFrames.map { (_, s) -> s.ink }.distinct()} vs left in $leavingInk")
        val pairs = stillFrames.filter { (f, _) -> f.live.rows > 0 }
        check("(a) $label: one ink per frame – the still, the arriving rows and the window's painted token agree in every frame both layers are up",
            pairs.all { (f, s) -> s.ink == f.live.ink } && frames.filter { it.live.rows > 0 && it.live.ink.isNotEmpty() }.all { it.live.ink == rgbOf(it.fg) },
            "pairs ${pairs.map { (f, s) -> "${s.ink}|${f.live.ink}|${rgbOf(f.fg)}" }.distinct()}")
        val stillOpacities = stillFrames.map { (_, s) -> s.opacity }
        val liveWhileStill = stillFrames.map { (f, _) -> f.live.opacity }.filter { !it.isNaN() }
        check("(a) $label: one cross-fade – the still's opacity only falls, the arriving pose's only rises meanwhile, and the still is gone within its 120 ms and a few frames",
            stillOpacities.zipWithNext().all { (a, b) -> b <= a + 0.05 } && liveWhileStill.zipWithNext().all { (a, b) -> b >= a - 0.05 } &&
                (lastStill.t - frames[start].t) <= 400,
            "still ${stillOpacities.map { "%.2f".format(it) }}, arriving ${liveWhileStill.map { "%.2f".format(it) }}, still gone by +${lastStill.t} ms")
        if (from == "private") {
            check("(a) $label: no frame draws a private title anywhere but in the private still under the private ink – the arriving regular rows never carry one, and the still is gone before the scheme's ink returns",
                frames.drop(start).all { f -> f.live.titles.none { it in privateTitles } } && visibleStills.all { (f, s) -> f.theme == "dark" && s.ink == leavingInk },
                "arriving rows ${frames.drop(start).map { it.live.titles }.distinct().take(3)}")
        } else {
            check("(a) $label: the regular pose's rows never carry a private title – the still lists the space's tabs alone to its last frame", stillFrames.all { (_, s) -> s.titles.none { it in privateTitles } && s.titles == base.live.titles }, "")
        }
        // The fact for the lead's reading, not a claim: the arriving rows come up in the ink the window
        // paints that frame, which §11.6 keeps the leaving polarity's until the blend's midpoint – the
        // cross-fade's last frame – where the whole window flips.
        val arrivingUnderLeaving = frames.drop(start).count { it.live.opacity > 0.02 && it.theme == leavingPolarity && it.live.rows > 0 }
        finding("  (a) $label: arriving rows visible under the leaving polarity's ink for $arrivingUnderLeaving frame(s) before the flip (§11.6: the ink flips at the blend's midpoint, the cross-fade's end); the still visible for ${stillOpacities.count { it > 0.02 }} frame(s), all under the leaving polarity")
        finding("  (a) $label: frame table (t from the probe's start; still = opacity/rows 'first title' ink; live = the arriving pose the same; bg = the painted --zen-bg-solid)")
        val first = maxOf(0, start - 1)
        for (i in first..minOf(rest, first + 40)) {
            val f = frames[i]
            finding("    f$i +${f.t} ms pose=${f.pose} theme=${f.theme} private=${if (f.privateOn) "on" else "off"} bg=${f.bg.ifEmpty { "-" }} fg=${f.fg.ifEmpty { "-" }} still=${f.still ?: "-"} live=${f.live}${if (f.switching) " switching" else ""}")
        }
    }

    /**
     * CLAIM (b): the frames the probe recorded from before Home to after the veil landed, run-length
     * coded by state in the chrome (one entry per change), read for sequence: the first frame back
     * masked, no private title until the veil's landing, the titles back only as both covers rest.
     */
    private fun readLockSpan() {
        val raw = lockProbe("stop")
        val array = runCatching { JSONArray(raw) }.getOrNull()
        if (array == null || array.length() == 0) {
            check("(b) the probe recorded the lock's span", false, "no frames")
            return
        }
        class Entry(val t0: Int, val t1: Int, val n: Int, val event: String, val visible: Boolean, val locked: Boolean, val lifting: Boolean, val cover: String, val veil: String, val rows: Int, val masked: Int, val leak: List<String>) {
            /** A cover's lift value: 1 while up, its `--zen-lock-p` while leaving, 0 when gone. */
            fun p(s: String): Double = when {
                s == "none" -> 0.0
                s == "up" -> 1.0
                s.startsWith("p=") -> s.removePrefix("p=").toDoubleOrNull() ?: 1.0
                else -> 1.0
            }
            val veilP get() = p(veil)
            val coverP get() = p(cover)
            override fun toString() = "+$t0..$t1 ms x$n${if (event.isNotEmpty()) " [$event]" else ""} ${if (visible) "visible" else "hidden"} locked=$locked lifting=$lifting cover=$cover veil=$veil rows=$rows masked=$masked${if (leak.isNotEmpty()) " TITLES=$leak" else ""}"
        }
        val entries = (0 until array.length()).map { i ->
            val e = array.getJSONObject(i)
            val leak = e.optJSONArray("leak")?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: emptyList()
            Entry(e.optInt("t0"), e.optInt("t1"), e.optInt("n"), e.optString("ev"), e.optString("vis") == "visible", e.optBoolean("locked"), e.optBoolean("lifting"), e.optString("cover"), e.optString("veil"), e.optInt("rows"), e.optInt("masked"), leak)
        }
        val frames = entries.filter { it.event.isEmpty() }
        val away = entries.indexOfFirst { it.event == "hidden" }
        val back = if (away < 0) -1 else (away + 1..entries.lastIndex).firstOrNull { entries[it].event == "visible" } ?: -1
        // The first frame drawn back: the one after the document's `visible` event – or, should the
        // WebView not fire the events, the first frame after the gap the departure leaves (no frame
        // runs while the window is away).
        val gapAt = (1..entries.lastIndex).firstOrNull { entries[it].event.isEmpty() && entries[it].t0 - entries[it - 1].t1 > 1_500 } ?: -1
        val firstBack = if (back >= 0) (back + 1..entries.lastIndex).firstOrNull { entries[it].event.isEmpty() } ?: -1 else gapAt
        val firstLocked = frames.indexOfFirst { it.locked }
        val landing = frames.indexOfLast { it.veilP > 0.02 }
        val titlesBack = if (firstLocked < 0) -1 else (firstLocked + 1..frames.lastIndex).firstOrNull { frames[it].leak.isNotEmpty() } ?: -1
        check("(b) the span was recorded: the departure, the return, the lock, the lift", (back > away || gapAt > 0) && firstBack > 0 && firstLocked >= 0 && landing >= 0 && titlesBack > landing,
            "entries ${entries.size}, frames ${frames.sumOf { it.n }}, hidden event at entry $away, visible at $back, gap at $gapAt, first locked frame $firstLocked, veil's last visible frame $landing, titles back at frame $titlesBack")
        if (firstBack > 0) {
            val f = entries[firstBack]
            check("(b) the first frame back has every row masked – Private tab behind the mask, the lock in the store – before anything else is drawn", f.locked && f.rows > 0 && f.masked == f.rows && f.leak.isEmpty(), "first frame back: $f")
        }
        val span = if (firstLocked >= 0 && landing >= firstLocked) frames.subList(firstLocked, landing + 1) else emptyList()
        check("(b) no frame between the lock's arming and the veil's landing shows a private title – every row Private tab through the lift", span.isNotEmpty() && span.all { it.leak.isEmpty() && it.masked == it.rows }, "span ${span.size} entries, ${span.sumOf { it.n }} frames; titles seen ${span.flatMap { it.leak }.distinct()}")
        check("(b) the veil's lift is one spring – its value only falls, from 1 to rest at 0, no step over 0.2",
            frames.filter { it.veil.startsWith("p=") }.map { it.veilP }.let { ps -> ps.isNotEmpty() && ps.zipWithNext().all { (a, b) -> b <= a + 0.001 && a - b <= 0.2 } && ps.last() <= 0.02 },
            "values ${frames.filter { it.veil.startsWith("p=") }.map { "%.3f".format(it.veilP) }.take(40)}")
        if (titlesBack >= 0) {
            val f = frames[titlesBack]
            check("(b) the titles come back only as the covers land – the veil and the frame's cover at rest (≤ 0.02) or gone, the lift over, in the frame the first title returns", f.veilP <= 0.02 && f.coverP <= 0.02 && !f.lifting && !f.locked, "titles back at: $f")
        }
        finding("  (b) state table (t from the probe's start, run-length coded by state; the window draws no frame while away):")
        for ((i, e) in entries.withIndex()) {
            if (i > 80) { finding("    … ${entries.size - i} more"); break }
            finding("    e$i $e")
        }
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

        /**
         * The two claims' probes, installed once in the chrome. `window.__pose` (claim a) samples
         * every animation frame while started: the pose, the painted polarity (`data-theme`), the
         * private surface, the painted ink and background tokens, and per layer – the still of the
         * pose that left (`PaneSlot`'s `[data-testid="pane-still"]`, its rows the clone's `.zen-tab`s,
         * hooks stripped) and the pose arriving (`.zen-sidebar-pose`) – the wrapper's computed
         * opacity, the tab rows, their titles and the first row's computed colour (`.zen-tab` reads
         * `--zen-fg`). `window.__veil` (claim b) samples every frame the lock's store, the frame's
         * cover and the sidebar's veil (up / leaving at `--zen-lock-p` / none), the rows, how many
         * are masked and any title that is not "Private tab", run-length coded by state, with the
         * document's visibilitychange events as entries of their own (no frame runs while the
         * window is away).
         */
        private val PROBES = """
            (function(){
              var SB='.zen-tablet-sidebar';
              var q=function(s,r){return (r||document).querySelector(s)};
              var qa=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};
              var r2=function(x){return Math.round(x*100)/100};
              var op=function(e){return e?r2(parseFloat(getComputedStyle(e).opacity)):null};
              var layer=function(wrap,root){
                if(!root)return null;
                var rows=qa('.zen-tab[role="tab"]',root);
                var titles=rows.map(function(r){var t=q('.zen-tab-title',r);return t?t.textContent.trim():''});
                return {o:op(wrap),n:rows.length,t:titles.slice(0,8),c:rows.length?getComputedStyle(rows[0]).color:''};
              };
              var store=function(){var s=(window.__zenStores||{})['private-lock'];return s?s.get():{}};
              var pf=[],pr=0,pt=0;
              var psample=function(){
                var root=document.documentElement,cr=q('[data-testid="chrome-root"]');
                var aside=q(SB+' [data-pose]');
                var stillWrap=q(SB+' [data-testid="pane-still"]');
                var live=qa(SB+' .zen-sidebar-pose').filter(function(e){return !e.closest('[data-testid="pane-still"]')})[0]||null;
                pf.push({t:Math.round(performance.now()-pt),pose:aside?(aside.dataset.pose||''):'',theme:root.dataset.theme||'',
                  priv:!!(cr&&cr.hasAttribute('data-private')),fg:root.style.getPropertyValue('--zen-fg').trim(),bg:root.style.getPropertyValue('--zen-bg-solid').trim(),
                  sw:!!(live&&live.hasAttribute('data-switching')),still:stillWrap?layer(stillWrap,stillWrap):null,live:layer(live,live)});
                if(pf.length<900)pr=requestAnimationFrame(psample);else pr=0;
              };
              window.__pose={
                start:function(){if(pr)cancelAnimationFrame(pr);pf=[];pt=performance.now();pr=requestAnimationFrame(psample);return 'started'},
                stop:function(){if(pr)cancelAnimationFrame(pr);pr=0;var out=JSON.stringify(pf);pf=[];return out}
              };
              var vf=[],vr=0,vt=0,vlast=null;
              var coverState=function(sel){var e=q(sel);if(!e)return 'none';if(!e.hasAttribute('data-leaving'))return 'up';var p=e.style.getPropertyValue('--zen-lock-p');return 'p='+(p?r2(parseFloat(p)):1)};
              var vstate=function(ev){
                var s=store();
                var rows=qa(SB+' [data-tab-id]');
                var leak=[];
                rows.forEach(function(r){var t=q('[data-testid="tab-title"]',r);var x=t?t.textContent.trim():'';if(x&&x!=='Private tab'&&leak.indexOf(x)<0)leak.push(x)});
                return {ev:ev||'',vis:document.visibilityState,locked:!!s.locked,lifting:!!s.lifting,
                  cover:coverState('[data-testid="private-lock-cover"]:not([data-variant])'),veil:coverState(SB+' [data-testid="private-lock-cover"][data-variant="veil"]'),
                  rows:rows.length,masked:rows.filter(function(r){return r.getAttribute('data-masked')==='true'}).length,leak:leak};
              };
              var sig=function(s){return JSON.stringify([s.ev,s.vis,s.locked,s.lifting,s.cover,s.veil,s.rows,s.masked,s.leak])};
              var vpush=function(s){var t=Math.round(performance.now()-vt);if(!s.ev&&vlast&&vlast.k===sig(s)){vlast.t1=t;vlast.n++;return}s.t0=t;s.t1=t;s.n=1;s.k=sig(s);vf.push(s);vlast=s.ev?null:s};
              var vsample=function(){vpush(vstate(''));if(vf.length<3000)vr=requestAnimationFrame(vsample);else vr=0};
              var vvis=function(){vpush(vstate(document.visibilityState))};
              window.__veil={
                start:function(){if(vr)cancelAnimationFrame(vr);document.removeEventListener('visibilitychange',vvis);vf=[];vlast=null;vt=performance.now();document.addEventListener('visibilitychange',vvis);vr=requestAnimationFrame(vsample);return 'started'},
                stop:function(){if(vr)cancelAnimationFrame(vr);vr=0;document.removeEventListener('visibilitychange',vvis);
                  var out=JSON.stringify(vf.map(function(s){return {t0:s.t0,t1:s.t1,n:s.n,ev:s.ev,vis:s.vis,locked:s.locked,lifting:s.lifting,cover:s.cover,veil:s.veil,rows:s.rows,masked:s.masked,leak:s.leak}}));vf=[];vlast=null;return out}
              };
              return 'installed';
            })()
        """.trimIndent()
    }
}
