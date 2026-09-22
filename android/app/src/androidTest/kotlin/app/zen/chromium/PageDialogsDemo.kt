package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.KeyCharacterMap
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Records a page's dialogs on the phone (matrix PUI-27, PUI-28; v2 draft §9.11, §9.12, §9.14,
 * §9.22, §9.23): `alert` / `confirm` / `prompt` as Zenium's own sheet – the §9.23 chassis
 * ([NativePromptSheet]) drawn natively over the page ([PageDialogSheet]), titled after the site –
 * and a `beforeunload` objection as "Leave site?" / "Reload site?". Every press is a real touch,
 * and every outcome is read off what the page's call returned (`window.__log` in the page, read
 * once its dialog has gone) and off the core's state – never off the chrome's word alone:
 *
 *  1. `alert`: the sheet with "127.0.0.1:18138 says" as its title, the message as body copy, OK
 *     alone in the footer; a touch on OK returns the call to the page;
 *  2. `confirm`, the page's second dialog of the visit: Chrome's "Don't let this page create
 *     more dialogs" check row, unticked; Cancel | OK as peers; OK returns true;
 *  3. `confirm` on a new visit (a reload): Cancel returns false, the system back cancels too,
 *     and so does a touch on the scrim over the page;
 *  4. `prompt`: the message as the §9.12 field's label, the field prefilled with the default and
 *     its value selected, the focus on the sheet until a tap moves it into the field with the
 *     keyboard (§9.22), the sheet standing on the keyboard, the typed name returned to the page;
 *  5. a long `alert`: the title block and the footer pinned, the message scrolling between them
 *     under §9.7's hairline;
 *  6. an `alert` from a frame of another origin: "An embedded page at 127.0.0.1:18139 says";
 *  7. the check row ticked with an `alert`: the page's next `confirm` and `alert` are answered at
 *     once with no sheet, until a reload starts a new visit, whose first dialog shows again
 *     without the row;
 *  8. an `alert` a background tab raises (a 12 s timer the page armed on a touch, a pill swipe to
 *     the other tab in between) is answered as a dismissal at once – nothing shows on the other
 *     tab, the call returns – since the WebView's one renderer waits in the call for every page
 *     and for the chrome;
 *  9. the sheet is modal and the chrome waits with the page: while the sheet is up the chrome's
 *     JavaScript does not answer (the §9.23 proof), a touch on the page under the scrim is the
 *     scrim's – the dialog cancelled, the page's button under it not pressed – and the chrome
 *     answers again once the sheet has gone;
 * 10. `beforeunload` on a link: "Leave site?" with Chrome's line and Cancel | Leave; Cancel
 *     keeps the page (its URL and its script state), Leave lets the navigation go;
 * 11. `beforeunload` on a reload the core asked for: "Reload site?" with Cancel | Reload; Cancel
 *     keeps the page;
 * 12. `beforeunload` on the overview card's X: the same question over the overview; Cancel
 *     keeps the tab, its card standing where it was; Leave closes the tab, the card with it.
 *
 * The sheet is read from the accessibility tree: a native `BottomSheetDialog` is a window of its
 * own whose title is the sheet's ([AccessibilityWindowInfo.getTitle]), and its views report at
 * once – unlike the WebViews' trees, which trail the software-rendered emulator by seconds. The
 * chrome's DOM (`getBoundingClientRect`, checked once against the accessibility bounds of the
 * bar's Menu button) gives the overview card's X; page positions come from the page's own DOM and
 * its view's place on screen. Nothing is asked of the chrome or of the page while a sheet is up:
 * the renderer that would answer waits in the page's call. Findings go to
 * `page-dialogs-findings.txt` next to the stills (one PASS or FAIL per claim, ALL CHECKS PASSED
 * at the end); the run fails on any FAIL. The pages come from two loopback servers in this
 * process ([DemoServer]: the site on 18138, the frame's origin on 18139); the profile
 * (`page-dialogs-demo-state.json`) holds the demo page (active) and one other tab, in the
 * colour scheme the `theme` argument names (`DEMO_THEME`: the workflow runs light and dark).
 * Driven by `android-page-dialogs-demo.yml`. See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class PageDialogsDemo : DemoHarness("page-dialogs-demo-state.json", "page-dialogs", "page-dialogs-demo") {
    override val tag = "PageDialogsDemo"
    private lateinit var server: DemoServer
    private lateinit var frameServer: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private var shots = 0
    private val host get() = (activity as MainActivity).host

    /** The seeded profile's colour scheme, from the `theme` argument. */
    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    @Test
    fun record() {
        val page = readAsset("page-dialogs-demo-page.html")
        server = DemoServer(
            PORT,
            mapOf(
                "/" to ("text/html; charset=utf-8" to page.toByteArray()),
                // The same page under another title: scenes 11 and 12 arm it after scene 10 left for it.
                "/second.html" to ("text/html; charset=utf-8" to page.replace("Page dialogs", "Second page").toByteArray()),
                "/other.html" to DemoServer.page("Another tab", "<p>No dialogs here.</p>")
            )
        ).also { it.start() }
        // The frame's origin: the same host one port up (a different port is a different origin).
        frameServer = DemoServer(
            FRAME_PORT,
            mapOf(
                "/frame.html" to ("text/html; charset=utf-8" to (
                    "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\">" +
                        "<style>html,body{margin:0;height:100%}button{width:100%;height:100%;border:0;background:#b56576;color:#fff;font:20px sans-serif}</style></head>" +
                        "<body><button id=\"go\" onclick=\"alert('Hello from the frame.')\">alert() from an embedded frame</button></body></html>"
                    ).toByteArray())
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            frameServer.close()
        }
        if (failures > 0) error("$failures check(s) failed; see page-dialogs-findings.txt")
    }

    override fun warmUp() {
        findings = File(out, "page-dialogs-findings.txt")
        findings.writeText(
            "Zenium Android page dialogs checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, $THEME)\n\n"
        )
        finding("demo server: ${server.selfCheck()}; frame server: ${frameServer.selfCheck()}")
        awaitLoaded(DEMO, "$ORIGIN/")
        SystemClock.sleep(2_000)
        calibrate()
        finding("start: ${describeActive()}")
    }

    override fun demo() {
        still("start")
        alertScene()
        checkboxScene()
        cancelScenes()
        promptScene()
        longScene()
        embeddedScene()
        suppressionScene()
        backgroundTabScene()
        modalScene()
        leaveOnNavigation()
        reloadSite()
        leaveOnCardClose()
        still("end")
        finding("\nend: ${describeActive()}")
        finding(if (failures == 0) "ALL CHECKS PASSED" else "$failures CHECK(S) FAILED")
    }

    // --- the scenes ------------------------------------------------------------------------------

    /** 1. alert(): the sheet titled after the site, the message as body copy, OK alone; OK returns the call. */
    private fun alertScene() {
        finding("\n1. alert(): the page's dialog as Zenium's sheet; OK dismisses it")
        val before = pageLog()
        val sheet = raise("#alert", SAYS)
        expect("the sheet rises for the alert, its window titled '$SAYS'", sheet != null)
        if (sheet == null) return
        expect("the title reads the site: '${sheet.title()}'", sheet.title() == SAYS)
        expect("the page's message stands as body copy: '${sheet.text("Hello from the page.")?.text}'", sheet.text("Hello from the page.") != null)
        expect("no check row on the page's first dialog", sheet.check() == null)
        expect("no Cancel for an alert, OK alone", sheet.peer(CANCEL) == null && sheet.peer("OK") != null)
        expect("the grip reads 'Dismiss' as a button", sheet.grip()?.className == BUTTON)
        expect("the focus opened on the sheet's container (§9.22): ${sheet.focusIn()}", sheet.focusIn() == "sheet")
        still("alert")
        answer(sheet, "OK")
        expect("alert() returned to the page", awaitLog { it.getInt("alerts") == before.getInt("alerts") + 1 })
    }

    /** 2. confirm(), the visit's second dialog: Chrome's check row unticked; Cancel | OK; OK returns true. */
    private fun checkboxScene() {
        finding("\n2. confirm(): the visit's second dialog carries the check row; OK returns true")
        val sheet = raise("#confirm", SAYS)
        expect("the sheet rises for the confirm", sheet != null)
        if (sheet == null) return
        expect("the message as body copy: 'Delete the draft?'", sheet.text("Delete the draft?") != null)
        val check = sheet.check()
        expect("the check row '$SUPPRESS_LABEL' is offered, unticked", check != null && !check.isChecked && check.text?.toString() == SUPPRESS_LABEL)
        expect("Cancel | OK as the footer's peers", sheet.peer(CANCEL) != null && sheet.peer("OK") != null)
        still("checkbox")
        answer(sheet, "OK")
        expect("confirm() returned true", awaitLog { it.getInt("confirms") == 1 && it.optBoolean("confirm", false) })
    }

    /** 3. confirm() on a new visit: Cancel returns false; the system back and the scrim cancel too. */
    private fun cancelScenes() {
        finding("\n3. confirm(): Cancel returns false; the system back and the scrim cancel too")
        newVisit()
        var sheet = raise("#confirm", SAYS)
        expect("the sheet rises, no check row on a new visit's first dialog", sheet != null && sheet.check() == null)
        if (sheet == null) return
        still("confirm")
        answer(sheet, CANCEL)
        expect("confirm() returned false", awaitLog { it.getInt("confirms") == 1 && !it.optBoolean("confirm", true) })

        sheet = raise("#confirm", SAYS)
        expect("the sheet rises again", sheet != null)
        back()
        expect("the system back sends the sheet away", awaitUntil(LOOKUP_WAIT) { sheetRoot(SAYS) == null })
        expect("and the page hears false", awaitLog { it.getInt("confirms") == 2 && !it.optBoolean("confirm", true) })

        sheet = raise("#confirm", SAYS)
        expect("the sheet rises once more", sheet != null)
        touchScrim("the scrim over the page")
        expect("a touch on the scrim sends the sheet away", awaitUntil(LOOKUP_WAIT) { sheetRoot(SAYS) == null })
        expect("and the page hears false", awaitLog { it.getInt("confirms") == 3 && !it.optBoolean("confirm", true) })
    }

    /** 4. prompt(): the message labels the field, the value selected; a tap focuses it with the keyboard; the typed name returns. */
    private fun promptScene() {
        finding("\n4. prompt(): the message as the field's label, the default selected; a tap brings the keyboard; the typed name returns")
        newVisit()
        val sheet = raise("#prompt", SAYS)
        expect("the sheet rises for the prompt", sheet != null)
        if (sheet == null) return
        val field = sheet.field()
        expect("the message labels the field: 'What is your name?'", sheet.text("What is your name?") != null && field != null)
        expect("the field holds the default 'Ada': '${field?.text}'", field?.text?.toString() == "Ada")
        expect("the focus opened on the sheet, not in the field (§9.22): ${sheet.focusIn()}", awaitUntil(3_000) { sheet.focusIn() == "sheet" })
        expect("the keyboard is down", !keyboardUp())
        still("prompt")
        val tapped = field != null && touchUntil("the prompt's field", { steadyBounds(field) }, { sheet.focusIn() == "field" })
        expect("a tap moves the focus into the field", tapped)
        expect("and the keyboard comes up", awaitUntil(8_000) { keyboardUp() })
        SystemClock.sleep(1_500)
        val ok = sheet.peer("OK")?.let { steadyBounds(it) }
        val keyboardTop = keyboardTop()
        expect("the sheet stands on the keyboard: OK's bottom ${ok?.bottom} above the keyboard's top $keyboardTop", ok != null && keyboardTop != null && ok.bottom <= keyboardTop)
        val selection = field?.let { it.refresh(); it.textSelectionStart to it.textSelectionEnd }
        expect("the default is selected, so the first keystroke replaces it: selection $selection", selection == (0 to 3))
        still("prompt-keyboard")
        keys("Grace")
        expect("the field reads the typed 'Grace': '${sheet.field()?.text}'", awaitUntil(5_000) { sheet.field()?.text?.toString() == "Grace" })
        still("prompt-typed")
        answer(sheet, "OK")
        expect("prompt() returned 'Grace'", awaitLog { it.getInt("prompts") == 1 && it.optString("prompt") == "Grace" })
        if (!awaitUntil(3_000) { !keyboardUp() }) {
            finding("  (the keyboard stayed up after the sheet: a back for it)")
            back()
            awaitUntil(4_000) { !keyboardUp() }
        }
        SystemClock.sleep(1_000)
    }

    /** 5. A long alert: the title block and the footer pinned, the message scrolling between them under the hairline. */
    private fun longScene() {
        finding("\n5. A long alert(): the message scrolls under the pinned title block and above the pinned footer")
        newVisit()
        val before = pageLog()
        val sheet = raise("#long", SAYS)
        expect("the sheet rises for the long alert", sheet != null)
        if (sheet == null) return
        val scroller = sheet.scroller()
        val title = sheet.text(SAYS)?.let { steadyBounds(it) }
        val ok = sheet.peer("OK")?.let { steadyBounds(it) }
        val cap = touchable.top + 40 * density
        expect("the body scrolls (the scroller reports a forward scroll)", scroller != null && scroller.isScrollable && scroller.actionList.any { it.id == AccessibilityNodeInfo.ACTION_SCROLL_FORWARD })
        expect("the sheet stands at most 40 dp under the status bar: title top ${title?.top} at or below ${cap.roundToInt()}", title != null && title.top >= cap - 2)
        still("long")
        val box = scroller?.let { steadyBounds(it) }
        if (box != null) {
            val f = Finger()
            f.down(box.exactCenterX(), box.bottom - 24 * density)
            f.settleIn(0f, -NUDGE)
            f.moveBy(0f, -(box.height() * 0.6f), 400)
            f.hold(120)
            f.up()
        }
        SystemClock.sleep(600)
        val scrolled = scroller != null && scroller.refresh() && scroller.actionList.any { it.id == AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD }
        expect("a drag scrolls the message (the scroller now offers a scroll back)", scrolled)
        val titleAfter = sheet.text(SAYS)?.let { steadyBounds(it) }
        val okAfter = sheet.peer("OK")?.let { steadyBounds(it) }
        expect("the title block stands pinned: $title before, $titleAfter after", title != null && title == titleAfter)
        expect("the footer stands pinned: $ok before, $okAfter after", ok != null && ok == okAfter)
        still("long-scrolled")
        answer(sheet, "OK")
        expect("alert() returned", awaitLog { it.getInt("alerts") == before.getInt("alerts") + 1 })
    }

    /** 6. An alert from a frame of another origin is titled "An embedded page at … says". */
    private fun embeddedScene() {
        finding("\n6. alert() from a frame of another origin: 'An embedded page at $FRAME_SITE says'")
        newVisit()
        val sheet = raise("#frame", EMBEDDED_SAYS)
        expect("the sheet rises titled '$EMBEDDED_SAYS'", sheet != null)
        if (sheet == null) return
        expect("the frame's message as body copy", sheet.text("Hello from the frame.") != null)
        still("embedded")
        answer(sheet, "OK")
        expect("the frame's alert() returned (the sheet gone)", awaitUntil(LOOKUP_WAIT) { sheetRoot(EMBEDDED_SAYS) == null })
    }

    /** 7. The check row ticked: the page's next dialogs are answered at once, until the next navigation. */
    private fun suppressionScene() {
        finding("\n7. '$SUPPRESS_LABEL': the page's next dialogs answered at once, until the next navigation")
        val before = pageLog()
        val sheet = raise("#alert", SAYS)
        expect("the sheet rises with the check row (the frame's dialog was the visit's first)", sheet != null && sheet.check() != null)
        if (sheet == null) return
        val check = sheet.check()
        val ticked = check != null && touchUntil("the check row", { steadyBounds(check) }, { check.refresh() && check.isChecked })
        expect("a touch on the row ticks it", ticked)
        still("suppress-ticked")
        answer(sheet, "OK")
        expect("alert() returned", awaitLog { it.getInt("alerts") == before.getInt("alerts") + 1 })
        tapPage("#confirm")
        expect(
            "the page's next confirm() is answered false at once",
            awaitLog(6_000) { it.getInt("confirms") == before.getInt("confirms") + 1 && !it.optBoolean("confirm", true) }
        )
        tapPage("#alert")
        expect("and its next alert() returns at once", awaitLog(6_000) { it.getInt("alerts") == before.getInt("alerts") + 2 })
        val seen = sheetsSeenFor(1_500)
        expect("with no sheet on the way ($seen seen)", seen == 0 && sheetRoot(SAYS) == null)
        still("suppressed-no-sheet")
        // A new visit: the reload commits another document, and the page starts over.
        newVisit()
        expect("the reload started the page over", awaitLog { it.getInt("alerts") == 0 })
        val again = raise("#alert", SAYS)
        expect("after the navigation the page's alert shows again", again != null)
        expect("as the first of a new visit: no check row", again != null && again.check() == null)
        still("after-reload")
        if (again != null) answer(again, "OK")
        expect("alert() returned", awaitLog { it.getInt("alerts") == 1 })
    }

    /**
     * 8. A background tab's alert is answered as a dismissal at once: nothing shows on the other
     * tab, the call returns. The page arms a [LATER_MS] timer on a touch; the swipe to the other
     * tab comes first, and the scene reads nothing off the chrome while a sheet could be up (a
     * sheet the demo tab raised while still on screen would hold the chrome's word).
     */
    private fun backgroundTabScene() {
        finding("\n8. A dialog from a background tab is answered at once, unseen: the one renderer waits in the call for every page")
        // The chrome has just taken a sheet down and re-laid the bar: a quiet moment before the pill is touched.
        SystemClock.sleep(2_500)
        val before = pageLog()
        val armed = SystemClock.uptimeMillis()
        tapPage("#later")
        val switched = switchTo(OTHER, +1, "the pill swipe to the next tab")
        if (sheetRoot(SAYS) != null) {
            expect("the demo tab was still on screen when its alert fired, ${SystemClock.uptimeMillis() - armed} ms after the touch: nothing of the scene can be read", false)
            sheet(SAYS)?.let { answer(it, "OK") }
            return
        }
        expect("the other tab is active ${SystemClock.uptimeMillis() - armed} ms after the touch, well inside the page's ${LATER_MS / 1000} s timer", switched)
        still("background-other-tab")
        // The timer runs out; the call must return with no sheet on the way.
        val deadline = armed + LATER_MS + LOOKUP_WAIT
        var returned = false
        var shown = false
        var seen = 0
        var up = appWindows() > 1
        while (SystemClock.uptimeMillis() < deadline) {
            val now = appWindows() > 1
            if (now && !up) seen++
            up = now
            if (now && sheetRoot(SAYS) != null) {
                shown = true
                break
            }
            if (!now && pageLog().getInt("alerts") == before.getInt("alerts") + 1) {
                returned = true
                break
            }
            SystemClock.sleep(POLL_MS)
        }
        if (shown) {
            expect("the background page's alert() raised a sheet over the other tab", false)
            sheet(SAYS)?.let { answer(it, "OK") }
        } else {
            expect("the background page's alert() returned, ${SystemClock.uptimeMillis() - armed} ms after the touch, with nobody to answer it", returned)
            expect("nothing showed for it on the other tab ($seen sheets seen), which stays active", seen == 0 && activeTabId() == OTHER)
        }
        still("background-dismissed")
        expect("the swipe back makes the demo tab active", switchTo(DEMO, -1, "the pill swipe back to the demo tab"))
        SystemClock.sleep(1_500)
        expect("nothing is pending for it: no sheet on the return", sheetRoot(SAYS) == null)
        still("background-returned")
    }

    /** 9. The sheet is modal, and the chrome waits with the page while it is up (the §9.23 proof). */
    private fun modalScene() {
        finding("\n9. The sheet is modal, and the chrome's JavaScript waits with the page while it is up")
        val before = pageLog()
        val button = pagePoint("#alert")
        val sheet = raise("#alert", SAYS)
        expect("the sheet is up", sheet != null)
        if (sheet == null) return
        val silent = !chromeAnswersWithin(3_000)
        expect("the chrome's JavaScript does not answer while the page waits in alert() (3 s asked)", silent)
        still("modal")
        if (button != null) {
            finding("  touch at ${button.x.roundToInt()},${button.y.roundToInt()} on the page's alert() button, under the scrim")
            Finger().tap(button.x, button.y)
        }
        expect("the touch is the scrim's: the sheet goes", awaitUntil(LOOKUP_WAIT) { sheetRoot(SAYS) == null })
        expect("the chrome's JavaScript answers again", chromeAnswersWithin(10_000))
        expect("alert() returned once", awaitLog { it.getInt("alerts") == before.getInt("alerts") + 1 })
        val seen = sheetsSeenFor(2_500)
        expect("and the page's button under the scrim was not pressed: no second sheet ($seen seen), one alert on record", seen == 0 && pageLog().getInt("alerts") == before.getInt("alerts") + 1)
        expect("the bar took nothing of it: the URL field is closed", !urlbarOpen())
    }

    /** 10. beforeunload on a link: "Leave site?", Cancel stays, Leave goes. */
    private fun leaveOnNavigation() {
        finding("\n10. beforeunload on a navigation: 'Leave site?'; Cancel stays on the page, Leave goes")
        tapPage("#arm")
        expect("the page armed its beforeunload handler", awaitLog { it.optBoolean("armed") })
        var sheet = raise("#link", LEAVE)
        expect("'Leave site?' rises", sheet != null)
        if (sheet == null) return
        expect("with Chrome's line as the description: '$LEAVE_LINE'", sheet.text(LEAVE_LINE) != null)
        expect("Cancel | Leave as the footer's peers", sheet.peer(CANCEL) != null && sheet.peer("Leave") != null)
        still("leave-site")
        answer(sheet, CANCEL)
        SystemClock.sleep(2_000)
        expect("the page stayed: ${activeUrl()}, its script state intact", activeUrl() == "$ORIGIN/" && pageLog().optBoolean("armed"))
        still("leave-cancelled")
        sheet = raise("#link", LEAVE)
        expect("'Leave site?' rises again", sheet != null)
        if (sheet != null) answer(sheet, "Leave")
        expect("the navigation goes on to the second page", awaitUntil(15_000) { activeUrl() == "$ORIGIN/second.html" })
        awaitLoaded(DEMO, "$ORIGIN/second.html")
        SystemClock.sleep(1_500)
        still("left")
    }

    /** 11. beforeunload on a reload the core asked for: "Reload site?"; Cancel keeps the page. */
    private fun reloadSite() {
        finding("\n11. beforeunload on a reload: 'Reload site?'; Cancel keeps the page")
        tapPage("#arm")
        expect("the second page armed its handler", awaitLog { it.optBoolean("armed") })
        fireCore("tab.reload", JSONObject().put("tabId", DEMO).toString())
        val sheet = awaitSheet(RELOAD)
        expect("'Reload site?' rises", sheet != null)
        if (sheet == null) return
        expect("with Chrome's line and Cancel | Reload", sheet.text(LEAVE_LINE) != null && sheet.peer(CANCEL) != null && sheet.peer("Reload") != null)
        still("reload-site")
        answer(sheet, CANCEL)
        SystemClock.sleep(2_000)
        expect("the page stayed as it was: ${activeUrl()}, its handler still armed", activeUrl() == "$ORIGIN/second.html" && pageLog().optBoolean("armed"))
    }

    /** 12. beforeunload on the overview card's X: Cancel keeps the card standing, Leave closes the tab. */
    private fun leaveOnCardClose() {
        finding("\n12. beforeunload on the card's close: Cancel keeps the tab and its card, Leave closes it")
        expect("the second page's handler is armed", pageLog().optBoolean("armed"))
        openOverview()
        expect("the overview shows the demo card", awaitDom("!!document.querySelector(${JSONObject.quote(CARD)})"))
        still("overview")
        val asked = touchUntil("the card's X", { steadyRect { domRect(CARD_CLOSE) } }, { sheetRoot(LEAVE) != null }, waitMs = SHEET_WAIT)
        expect("a touch on the X asks 'Leave site?' over the overview", asked)
        var sheet = sheet(LEAVE)
        if (sheet == null) return
        still("close-leave-site")
        answer(sheet, CANCEL)
        // The card's exit would have run 900 ms after a close the browser never showed: well past it.
        SystemClock.sleep(3_000)
        expect("the tab stays", tabExists(DEMO))
        expect("its card stands in the grid", inDom(CARD))
        expect("the page is intact: ${activeUrl()}, its handler still armed", activeUrl() == "$ORIGIN/second.html" && pageLog().optBoolean("armed"))
        still("close-cancelled")
        val again = touchUntil("the card's X", { steadyRect { domRect(CARD_CLOSE) } }, { sheetRoot(LEAVE) != null }, waitMs = SHEET_WAIT)
        expect("the X asks again", again)
        sheet = sheet(LEAVE)
        if (sheet != null) answer(sheet, "Leave")
        expect("the tab closes", awaitUntil(10_000) { !tabExists(DEMO) })
        expect("its card has left the grid", awaitDom("!document.querySelector(${JSONObject.quote(CARD)})", 10_000))
        expect("the other tab is what is left", coreState().getJSONObject("tabs").let { it.length() == 1 && it.has(OTHER) })
        SystemClock.sleep(1_500)
        still("close-left")
    }

    // --- the sheet: the dialog's own window in the accessibility tree ------------------------------

    /** A sheet up: the root of its window and its title. */
    private inner class Sheet(val root: AccessibilityNodeInfo, val name: String) {
        /** The first node under the root that `accept`s. */
        fun node(accept: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? = walk(root, SHEET_NODES, accept)
        fun text(text: String): AccessibilityNodeInfo? = node { it.text?.toString() == text }
        /** The heading's text (the title block's first line). */
        fun title(): String = node { it.text?.toString() == name }?.text?.toString().orEmpty()
        /** A footer peer by its label: a `TextView` read as a button. */
        fun peer(label: String): AccessibilityNodeInfo? = node { it.className == BUTTON && it.text?.toString() == label }
        fun field(): AccessibilityNodeInfo? = node { it.className == "android.widget.EditText" }
        fun check(): AccessibilityNodeInfo? = node { it.isCheckable }
        fun scroller(): AccessibilityNodeInfo? = node { it.className == "android.widget.ScrollView" }
        fun grip(): AccessibilityNodeInfo? = node { it.contentDescription?.toString() == GRIP_LABEL }
        /** Where the focus is: the field, the sheet (its container or a control), or nowhere. */
        fun focusIn(): String {
            val focused = node { it.isFocused } ?: return "none"
            return if (focused.className == "android.widget.EditText") "field" else "sheet"
        }
    }

    /**
     * The root of the sheet's window: the app's window whose title is `title` – a `Dialog`'s
     * `setTitle` names its window for the accessibility tree – or, failing a title, one whose
     * first nodes carry the title as a text; null when no such sheet is up.
     */
    private fun sheetRoot(title: String): AccessibilityNodeInfo? {
        for (window in ui.windows) {
            if (window.type != AccessibilityWindowInfo.TYPE_APPLICATION) continue
            val root = window.root ?: continue
            if (root.packageName?.toString() != app.packageName) continue
            if (window.title?.toString() == title) return root
            if (walk(root, SHALLOW_NODES) { it.text?.toString() == title } != null) return root
        }
        return null
    }

    private fun sheet(title: String): Sheet? = sheetRoot(title)?.let { Sheet(it, title) }

    private fun awaitSheet(title: String, timeoutMs: Long = LOOKUP_WAIT): Sheet? {
        awaitUntil(timeoutMs) { sheetRoot(title) != null }
        return sheet(title)
    }

    /** How many of the app's windows are up: one for the activity, one more for a sheet. */
    private fun appWindows(): Int = ui.windows.count { it.type == AccessibilityWindowInfo.TYPE_APPLICATION && it.root?.packageName?.toString() == app.packageName }

    /** Watch for `durationMs`: how many times a sheet (a second window of the app's) was seen coming up. */
    private fun sheetsSeenFor(durationMs: Long): Int {
        val deadline = SystemClock.uptimeMillis() + durationMs
        var seen = 0
        var up = appWindows() > 1
        if (up) seen++
        while (SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(150)
            val now = appWindows() > 1
            if (now && !up) seen++
            up = now
        }
        return seen
    }

    /** Breadth first under `root`, at most `limit` nodes: the first that `accept`s. */
    private fun walk(root: AccessibilityNodeInfo, limit: Int, accept: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.add(root)
        var visited = 0
        while (queue.isNotEmpty() && visited < limit) {
            val node = queue.removeFirst()
            visited++
            if (accept(node)) return node
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return null
    }

    /**
     * A real touch on the page's `selector` until the sheet titled `title` is up (the emulator's
     * WebView reads a tap as a hold now and then, and a hold opens nothing); the sheet, or null.
     */
    private fun raise(selector: String, title: String): Sheet? {
        for (attempt in 1..TOUCH_ATTEMPTS) {
            if (!tapPage(selector)) return sheet(title)
            if (awaitUntil(TOUCH_TOOK_WAIT) { sheetRoot(title) != null }) return sheet(title)
            if (attempt < TOUCH_ATTEMPTS) finding("  (the touch on $selector did not take, attempt $attempt: touching again)")
        }
        return sheet(title)
    }

    /**
     * A touch on the sheet's `label` peer, made again when the sheet still stands: the claim of
     * the step – what the answer did to the page and the core – is read by the caller.
     */
    private fun answer(sheet: Sheet, label: String): Boolean {
        for (attempt in 1..TOUCH_ATTEMPTS) {
            val peer = sheet.peer(label) ?: run {
                finding("  (no $label on the sheet)")
                return sheetRoot(sheet.name) == null
            }
            if (!touchNode(peer, "the sheet's $label")) return false
            if (awaitUntil(TOUCH_TOOK_WAIT) { sheetRoot(sheet.name) == null }) return true
            if (attempt < TOUCH_ATTEMPTS) finding("  (the touch on $label did not take, attempt $attempt: touching again)")
        }
        touchFault("the touch on the sheet's $label did not send the sheet away")
        return false
    }

    /** A real touch on the middle of `node`'s part inside the touchable band, logged. */
    private fun touchNode(node: AccessibilityNodeInfo, what: String): Boolean {
        val bounds = steadyBounds(node) ?: run {
            finding("  ($what has gone from the tree)")
            return false
        }
        touch(bounds, what)
        return true
    }

    /** A touch on the page area above the sheet: the scrim's, which answers as Cancel. */
    private fun touchScrim(what: String) {
        val point = PointF(width / 2f, touchable.top + 48 * density)
        finding("  touch at ${point.x.roundToInt()},${point.y.roundToInt()} on $what")
        Finger().tap(point.x, point.y)
    }

    /** The keyboard is up: the IME has a window on screen, or the activity reports its inset. */
    private fun keyboardUp(): Boolean = keyboard() != null || imeShown()

    /** The keyboard's window on screen (UiAutomation lists the IME as a window of its own), null while it is down. */
    private fun keyboard(): Rect? =
        ui.windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD }?.let { Rect().also(it::getBoundsInScreen) }?.takeIf { !it.isEmpty }

    /** Where the keyboard's top edge is (screen px), null while it is down. */
    private fun keyboardTop(): Int? = keyboard()?.top ?: imeInset().takeIf { it > 0 }?.let { height - it }

    /**
     * Whether the chrome's JavaScript answers an evaluation within `timeoutMs`: it does not while
     * a page waits in `alert()` (the one renderer), and does again once the sheet has gone.
     */
    private fun chromeAnswersWithin(timeoutMs: Long): Boolean {
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync { host.chrome.evaluateJavascript("'x'") { latch.countDown() } }
        return latch.await(timeoutMs, TimeUnit.MILLISECONDS)
    }

    // --- the page --------------------------------------------------------------------------------

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    /** Evaluate in the demo tab's page (shown or not); the JSON text of the value ("" when nothing answered). */
    private fun pageJs(code: String, tabId: String = DEMO): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val tab = host.tabs.get(tabId)
            if (tab == null) {
                latch.countDown()
            } else {
                tab.evaluate(code) { value ->
                    result = value ?: ""
                    latch.countDown()
                }
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    /** The page's record of its calls (`window.__log`); empty when the page did not answer. */
    private fun pageLog(): JSONObject =
        runCatching { JSONObject(pageJs("JSON.stringify(window.__log||{})").let { JSONTokener(it).nextValue() as String }) }
            .getOrDefault(JSONObject())

    /** Whether the page's record comes to satisfy `test` within `timeoutMs`. */
    private fun awaitLog(timeoutMs: Long = LOOKUP_WAIT, test: (JSONObject) -> Boolean): Boolean =
        awaitUntil(timeoutMs) { runCatching { test(pageLog()) }.getOrDefault(false) }

    /** Where the middle of the first element matching `selector` is on screen, or null. */
    private fun pagePoint(selector: String): PointF? {
        val raw = pageJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        val origin = onMain { host.tabs.get(DEMO)?.let { v -> IntArray(2).also(v::getLocationOnScreen) } } ?: return null
        return PointF(
            origin[0] + point.getDouble(0).toFloat() * density,
            origin[1] + point.getDouble(1).toFloat() * density
        )
    }

    /** A real touch on the page element matching `selector`; false, and a note, when the page has none. */
    private fun tapPage(selector: String): Boolean {
        val p = pagePoint(selector) ?: run {
            finding("  (nothing matches $selector on the page)")
            return false
        }
        finding("  touch at ${p.x.roundToInt()},${p.y.roundToInt()} on the page's $selector")
        Finger().tap(p.x, p.y)
        return true
    }

    /** A new visit of the demo page: a reload commits another document, and the page's dialog count starts over. */
    private fun newVisit() {
        fireCore("tab.reload", JSONObject().put("tabId", DEMO).toString())
        SystemClock.sleep(500)
        awaitLoaded(DEMO, "$ORIGIN/")
        awaitLog { it.getInt("alerts") == 0 && it.getInt("confirms") == 0 && it.getInt("prompts") == 0 }
        SystemClock.sleep(1_000)
    }

    private fun awaitLoaded(tabId: String, url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { host.tabs.get(tabId).let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (current == url && progress == 100) return
            SystemClock.sleep(250)
        }
        finding("  (gave up waiting for $url in $tabId)")
    }

    // --- moves -----------------------------------------------------------------------------------

    /**
     * A real touch on the middle of `box` (screen px), logged: the finger's down and up
     * [TAP_HOLD_MS] apart, a frame, so the two queue together on the emulator's held main
     * thread and no long press can fall between them.
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
     * and when nothing came of it read the box again and touch again, up to `attempts` times.
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

    /**
     * A real pill swipe to the next (`direction` +1) or the previous (-1) tab, and true once the
     * core names `tabId` active. The swipe is settled the way the emulator needs ([settleIn]: the
     * slop crossed along the track, then the finger still while the chrome takes the page's
     * snapshot on the software GPU, then the swipe): a quick fling right after a sheet has gone
     * down reaches the chrome as one batched move at the app's 3–5 frames a second and moves the
     * track not at all. A swipe the emulator dropped all the same is noted, and the core's own
     * `tab.activate` – what the swipe ends in – switches instead, so the scene can still be read.
     */
    private fun switchTo(tabId: String, direction: Int, what: String): Boolean {
        finding("  $what")
        swipeTabs(direction)
        if (awaitSwitch(tabId)) return true
        if (appWindows() > 1) return false
        finding("  (the swipe did not take on the emulator: the core's tab.activate switches instead)")
        fireCore("tab.activate", JSONObject().put("tabId", tabId).toString())
        return awaitSwitch(tabId)
    }

    /** The swipe of [switchTo], from the pill's end the finger sets out from. */
    private fun swipeTabs(direction: Int) {
        val f = Finger()
        f.down(if (direction > 0) pill.right - 10f else pill.left + 10f, pillY)
        f.settleIn(-direction * NUDGE, 0f)
        f.moveBy(-direction * (SWIPE_FRACTION * width - NUDGE), 0f, 300)
        f.up()
    }

    /**
     * Whether the core comes to name `tabId` active within [SWITCH_WAIT]. The chrome is asked
     * only while no sheet is up: a page's dialog holds the renderer, and the chrome's word with it.
     */
    private fun awaitSwitch(tabId: String): Boolean {
        val deadline = SystemClock.uptimeMillis() + SWITCH_WAIT
        while (true) {
            if (appWindows() > 1) return false
            if (runCatching { activeTabId() }.getOrDefault("") == tabId) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(POLL_MS)
        }
    }

    /**
     * Open the overview with a touch on the bar's Tabs button (the count trails its label); a
     * touch the emulator's lag turns into a hold is dismissed and tried again.
     */
    private fun openOverview() {
        for (attempt in 0 until OPEN_ATTEMPTS) {
            val tabs = findNode { it.startsWith("Tabs (") }?.let { node -> Rect().also { node.getBoundsInScreen(it) } }
                ?: domRect("[aria-label^=\"Tabs (\"]")
            if (tabs != null) {
                finding("  touch at ${tabs.centerX()},${tabs.centerY()} on the bar's Tabs button")
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

    /** A JS expression's string result in the chrome ("" when it never answered or returned nothing). */
    private fun jsString(code: String): String = (JSONTokener(chromeJs(code)).nextValue() as? String).orEmpty()

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

    /** The on-screen box of the first element `selector` matches, null when nothing does. */
    private fun domRect(selector: String): Rect? =
        rectFrom(jsString("(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';$RECT_JS})()"))

    private fun inDom(selector: String): Boolean =
        jsString("(function(){return document.querySelector(${JSONObject.quote(selector)})?'yes':''})()") == "yes"

    /**
     * A box read from the DOM once two reads [STEADY_MS] apart agree (the overview's cards while
     * it grows in report where they are on each frame); the last read when they never do within
     * [LOOKUP_WAIT], null when the element never shows.
     */
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

    private fun awaitRect(read: () -> Rect?, timeoutMs: Long): Rect? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            read()?.let { return it }
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(POLL_MS)
        }
    }

    /** Whether `test` comes to hold within `timeoutMs`, asked every [POLL_MS]. */
    private fun awaitUntil(timeoutMs: Long, test: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (test()) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(POLL_MS)
        }
    }

    /** Poll a JS boolean expression against the chrome's document. */
    private fun awaitDom(expression: String, timeoutMs: Long = LOOKUP_WAIT): Boolean =
        awaitUntil(timeoutMs) { jsString("(function(){return ($expression)?'yes':''})()") == "yes" }

    /**
     * Check the DOM's coordinates against the accessibility tree once: the bar's Menu button
     * never moves, so its accessibility bounds are current. Any offset (a chrome not at the
     * window's origin) is applied to every box from then on.
     */
    private fun calibrate() {
        val fromDom = domRect("[aria-label=\"$MENU_LABEL\"]") ?: return
        val fromTree = waitFor(MENU_LABEL, 4_000) ?: return
        val dx = fromTree.exactCenterX() - fromDom.exactCenterX()
        val dy = fromTree.exactCenterY() - fromDom.exactCenterY()
        finding("coordinates: Menu button at $fromDom from the DOM, $fromTree from the accessibility tree (offset ${dx.roundToInt()}, ${dy.roundToInt()})")
        if (abs(dx) <= MAX_OFFSET && abs(dy) <= MAX_OFFSET) {
            originX = dx
            originY = dy
        }
    }

    // --- keys ------------------------------------------------------------------------------------

    /** One character's events at a time, so each carries the time it is injected. */
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

    // --- the core's state ------------------------------------------------------------------------

    /**
     * Run a core command without waiting on its promise: a `tab.reload` whose page objects has
     * the renderer – and the chrome's word with it – waiting in the question the moment after.
     */
    private fun fireCore(name: String, args: String) {
        chromeJs("window.zen.invoke(${JSONObject.quote(name)},$args);''")
    }

    private fun activeTabId(): String = activeCoreTab()?.optString("id").orEmpty()

    private fun activeUrl(): String = activeCoreTab()?.optString("url").orEmpty()

    private fun tabExists(tabId: String): Boolean = coreState().getJSONObject("tabs").has(tabId)

    private fun describeActive(): String {
        val state = coreState()
        val tab = activeCoreTab(state)
        return "active ${tab?.optString("id")} ${tab?.optString("url")}, ${state.getJSONObject("tabs").length()} tabs"
    }

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

    /** Numbered stills: `page-dialogs-NN-<state>.png`. */
    private fun still(state: String) {
        shots++
        shot("%02d-%s".format(shots, state))
    }

    private companion object {
        private const val PORT = 18138
        private const val FRAME_PORT = PORT + 1
        private const val SITE = "127.0.0.1:$PORT"
        private const val FRAME_SITE = "127.0.0.1:$FRAME_PORT"
        private const val ORIGIN = "http://$SITE"
        private const val DEMO = "tab_demo"
        private const val OTHER = "tab_other"
        /** Chrome's words, as PageDialogSpec has them: the titles and the lines the sheet is read by. */
        private const val SAYS = "$SITE says"
        private const val EMBEDDED_SAYS = "An embedded page at $FRAME_SITE says"
        private const val LEAVE = "Leave site?"
        private const val RELOAD = "Reload site?"
        private const val LEAVE_LINE = "Changes you made may not be saved."
        private const val SUPPRESS_LABEL = "Don't let this page create more dialogs"
        private const val CANCEL = "Cancel"
        /** The chassis's grip (`prompt_sheet_dismiss`). */
        private const val GRIP_LABEL = "Dismiss"
        private const val BUTTON = "android.widget.Button"
        private const val CARD = ".zen-overview-grid [data-tab-id=\"tab_demo\"]"
        private const val CARD_CLOSE = ".zen-overview-grid [data-tab-id=\"tab_demo\"] [aria-label^=\"Close \"]"
        private const val RECT_JS = "var r=e.getBoundingClientRect();" +
            "return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom,d:window.devicePixelRatio})"
        /** The `theme` argument: `dark`, else light (the shared script's `DEMO_THEME`). */
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
        /** How long a sheet may take to come up after a touch, or an element to appear in the DOM after a change. */
        private const val LOOKUP_WAIT = 8_000L
        private const val POLL_MS = 200L
        /** Two reads of a box this far apart agreeing count as at rest ([steadyRect]). */
        private const val STEADY_MS = 350L
        /** Largest DOM-to-screen offset (px) [calibrate] takes for real rather than for a stale tree. */
        private const val MAX_OFFSET = 200f
        private const val OPEN_ATTEMPTS = 4
        private const val TOUCH_ATTEMPTS = 3
        /** The finger's down and up this far apart ([touch]): a frame, so the two queue together under load. */
        private const val TAP_HOLD_MS = 16L
        /** How long a touch has to show it took before it is made again. */
        private const val TOUCH_TOOK_WAIT = 2_500L
        /** And for a touch whose outcome is a sheet rising over a page going away: longer. */
        private const val SHEET_WAIT = 6_000L
        /** The page's `#later` timer (its script): the room a settled swipe and its check have before the alert. */
        private const val LATER_MS = 12_000L
        /** How long a pill swipe has to end in the core naming the other tab active ([awaitSwitch]). */
        private const val SWITCH_WAIT = 3_000L
        /** The swipe's travel as a share of the screen's width: well past the track's commit distance (90 CSS px). */
        private const val SWIPE_FRACTION = 0.40f
        /** The sheet's own tree is a few dozen nodes; the activity's is thousands (the WebViews): how far a walk goes. */
        private const val SHEET_NODES = 200
        private const val SHALLOW_NODES = 60
    }
}
