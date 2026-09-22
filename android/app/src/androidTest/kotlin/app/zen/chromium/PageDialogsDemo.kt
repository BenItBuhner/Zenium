package app.zen.chromium

import android.graphics.PointF
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
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Records a page's dialogs on the phone (matrix PUI-27, PUI-28; v2 draft §9.11, §9.12, §9.14,
 * §9.22, §9.23): `alert` / `confirm` / `prompt` as the core's tab-modal `PageDialog`, a §9.23
 * prompt sheet titled after the site, and a `beforeunload` objection as the core's "Leave
 * site?". Every press is a real touch and every outcome is read off the core's state and off
 * what the page's call returned (`window.__log` in the page, read once its dialog has gone: the
 * page is blocked inside the call while the dialog is up), never off the chrome's word alone:
 *
 *  1. `alert`: the sheet with "127.0.0.1:18138 says" as its title block and the message as the
 *     description, OK alone in the footer; a touch on OK returns the call to the page;
 *  2. `confirm`, the page's second dialog of the visit: Chrome's "Don't let this page create
 *     more dialogs" checkbox, unticked; Cancel | OK as peers; OK returns true;
 *  3. `confirm` again: Cancel returns false; the system back cancels the next one too;
 *  4. `prompt`: the §9.12 field prefilled with the default, the focus on the sheet until a tap
 *     moves it into the field with the keyboard (§9.22), the sheet standing on the keyboard, the
 *     typed name returned to the page;
 *  5. the checkbox ticked with an `alert`: the page's next `confirm` and `alert` are answered at
 *     once with no sheet, until a reload starts a new visit, whose first dialog shows again
 *     without the checkbox;
 *  6. an `alert` a background tab raises (a timer after a pill fling to the other tab) waits in
 *     the core, nothing shown on the other tab; the fling back shows it;
 *  7. a tab switch with the sheet up hides it, the dialog still pending; the return shows it
 *     again. The bar is inert under a sheet (§9.5), so the switch is the core's here, as another
 *     app's link or a notification would make it – the model is the desktop's: hide and show,
 *     never a cancel;
 *  8. `beforeunload` on a link: "Leave site?" with Chrome's line and Cancel | Leave; Cancel
 *     keeps the page (its URL and its script state), Leave lets the navigation go;
 *  9. `beforeunload` on the overview card's X: the same question over the overview; Cancel
 *     keeps the tab, its card standing where it was; Leave closes the tab, the card with it.
 *
 * Positions come from the chrome's DOM (`getBoundingClientRect`, checked once against the
 * accessibility bounds of the bar's Menu button), because the WebView's accessibility tree
 * trails the software-rendered emulator by seconds; page positions from the page's own DOM and
 * its view's place on screen. Findings go to `page-dialogs-findings.txt` next to the stills
 * (one PASS or FAIL per claim, ALL CHECKS PASSED at the end); the run fails on any FAIL. The
 * pages come from a loopback server in this process ([DemoServer]); the profile
 * (`page-dialogs-demo-state.json`) holds the demo page (active) and one other tab. Driven by
 * `android-page-dialogs-demo.yml`. See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class PageDialogsDemo : DemoHarness("page-dialogs-demo-state.json", "page-dialogs", "page-dialogs-demo") {
    override val tag = "PageDialogsDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private var shots = 0
    private val host get() = (activity as MainActivity).host

    @Test
    fun record() {
        val page = readAsset("page-dialogs-demo-page.html")
        server = DemoServer(
            PORT,
            mapOf(
                "/" to ("text/html; charset=utf-8" to page.toByteArray()),
                // The same page under another title: scene 9 arms it after scene 8 left for it.
                "/second.html" to ("text/html; charset=utf-8" to page.replace("Page dialogs", "Second page").toByteArray()),
                "/other.html" to DemoServer.page("Another tab", "<p>No dialogs here.</p>")
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        if (failures > 0) error("$failures check(s) failed; see page-dialogs-findings.txt")
    }

    override fun warmUp() {
        findings = File(out, "page-dialogs-findings.txt")
        findings.writeText(
            "Zenium Android page dialogs checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded(DEMO, "$ORIGIN/")
        SystemClock.sleep(2_000)
        calibrate()
        finding("start: ${describeActive()}")
    }

    override fun demo() {
        still("start")
        alertScene()
        confirmScenes()
        promptScene()
        suppressionScene()
        backgroundTabScene()
        switchAwayScene()
        leaveOnNavigation()
        leaveOnCardClose()
        still("end")
        finding("\nend: ${describeActive()}")
        finding(if (failures == 0) "ALL CHECKS PASSED" else "$failures CHECK(S) FAILED")
    }

    // --- the scenes ------------------------------------------------------------------------------

    /** 1. alert(): the sheet titled after the site, OK alone; OK returns the call. */
    private fun alertScene() {
        finding("\n1. alert(): the page's dialog as the phone's sheet; OK dismisses it")
        val before = pageLog()
        tapPageUntil("#alert") { sheetUp("alert") }
        expect("the sheet rises for the alert", awaitSheet("alert"))
        expect("the title block names the site: '${sheetTitle()}'", sheetTitle() == "$SITE says")
        expect("the message is its description: '${sheetDescription()}'", sheetDescription() == "Hello from the page.")
        expect("no checkbox on the page's first dialog", !inDom(CHECKBOX))
        expect("no Cancel for an alert, OK alone", footerButton("Cancel") == null && footerButton("OK") != null)
        expect("the core lists one dialog, the demo tab's", pendingDialogs().let { it.length() == 1 && it.getJSONObject(0).getString("tabId") == DEMO })
        still("alert")
        answer("OK")
        expect("the sheet has gone and the core lists no dialog", awaitUntil(LOOKUP_WAIT) { sheetGone() && pendingDialogs().length() == 0 })
        expect("alert() returned to the page", awaitLog { it.getInt("alerts") == before.getInt("alerts") + 1 })
    }

    /** 2 and 3. confirm(): the checkbox from the second dialog on; OK true, Cancel false, back false. */
    private fun confirmScenes() {
        finding("\n2. confirm(): the visit's second dialog carries the checkbox; OK returns true")
        tapPageUntil("#confirm") { sheetUp("confirm") }
        expect("the sheet rises for the confirm", awaitSheet("confirm"))
        expect("the message: '${sheetDescription()}'", sheetDescription() == "Delete the draft?")
        expect(
            "the checkbox '$SUPPRESS_LABEL' is offered, unticked",
            inDom(CHECKBOX) && !isChecked() && hasText(SHEET, SUPPRESS_LABEL)
        )
        expect("Cancel | OK as the footer's peers", footerButton("Cancel") != null && footerButton("OK") != null)
        still("confirm")
        answer("OK")
        expect("confirm() returned true", awaitLog { it.getInt("confirms") == 1 && it.optBoolean("confirm", false) })

        finding("\n3. confirm(): Cancel returns false; the system back cancels too")
        tapPageUntil("#confirm") { sheetUp("confirm") }
        expect("the sheet rises", awaitSheet("confirm"))
        still("confirm-again")
        answer("Cancel")
        expect("confirm() returned false", awaitLog { it.getInt("confirms") == 2 && !it.optBoolean("confirm", true) })
        tapPageUntil("#confirm") { sheetUp("confirm") }
        expect("the sheet rises once more", awaitSheet("confirm"))
        back()
        expect("the system back sends the sheet away", awaitUntil(LOOKUP_WAIT) { sheetGone() })
        expect("and the page hears false", awaitLog { it.getInt("confirms") == 3 && !it.optBoolean("confirm", true) })
    }

    /** 4. prompt(): the field prefilled, focused on the tap with the keyboard, the typed value returned. */
    private fun promptScene() {
        finding("\n4. prompt(): the field prefilled; a tap focuses it with the keyboard; the typed name returns")
        tapPageUntil("#prompt") { sheetUp("prompt") }
        expect("the sheet rises for the prompt", awaitSheet("prompt"))
        expect("the message: '${sheetDescription()}'", sheetDescription() == "What is your name?")
        expect("the field holds the default 'Ada': '${fieldValue()}'", fieldValue() == "Ada")
        expect("focus opened on the sheet, not in the field (§9.22): ${focusIn()}", awaitUntil(3_000) { focusIn() == "sheet" })
        expect("the keyboard is down", !imeShown())
        still("prompt")
        val tapped = touchUntil("the prompt's field", { steadyRect { domRect(FIELD) } }, { focusIn() == "field" })
        expect("a tap moves the focus into the field", tapped)
        val keyboard = awaitIme(shown = true, timeoutMs = 8_000)
        expect("and the keyboard comes up", keyboard)
        SystemClock.sleep(1_500)
        val footer = domRect("$SHEET .zen-sheet-footer")
        val imeTop = height - imeInset()
        expect(
            "the sheet stands on the keyboard: footer bottom ${footer?.bottom} above the keyboard's top $imeTop",
            footer != null && footer.bottom <= imeTop
        )
        still("prompt-keyboard")
        // The default text is selected from the field itself, and the name typed over it.
        jsString("(function(){var e=document.querySelector(${JSONObject.quote(FIELD)});if(e){e.focus();e.select()}return ''})()")
        SystemClock.sleep(300)
        keys("Grace")
        expect("the field reads the typed 'Grace': '${fieldValue()}'", awaitUntil(5_000) { fieldValue() == "Grace" })
        still("prompt-typed")
        val ok = footerButton("OK")
        if (ok != null && touchPoint(ok) != null && ok.bottom <= height - imeInset()) {
            answer("OK")
        } else {
            finding("  (OK at $ok is under the keyboard: Enter in the field submits instead)")
            pressKey(KeyEvent.KEYCODE_ENTER)
        }
        expect("the sheet has gone", awaitUntil(LOOKUP_WAIT) { sheetGone() })
        expect("prompt() returned 'Grace'", awaitLog { it.getInt("prompts") == 1 && it.optString("prompt") == "Grace" })
        if (!awaitIme(shown = false, timeoutMs = 3_000)) {
            finding("  (the keyboard stayed up after the sheet: a back for it)")
            back()
            awaitIme(shown = false, timeoutMs = 4_000)
        }
        SystemClock.sleep(1_000)
    }

    /** 5. The checkbox ticked: the page's next dialogs are answered at once, until the next navigation. */
    private fun suppressionScene() {
        finding("\n5. '$SUPPRESS_LABEL': the page's next dialogs answered at once, until the next navigation")
        val before = pageLog()
        tapPageUntil("#alert") { sheetUp("alert") }
        expect("the sheet rises with the checkbox", awaitSheet("alert") && inDom(CHECKBOX))
        val ticked = touchUntil("the checkbox row", { steadyRect { domRect(CHECKBOX_ROW) } }, { isChecked() })
        expect("a touch on the row ticks it", ticked)
        still("suppress-ticked")
        answer("OK")
        expect("alert() returned", awaitLog { it.getInt("alerts") == before.getInt("alerts") + 1 })
        watchSheets()
        tapPage("#confirm")
        expect(
            "the page's next confirm() is answered false at once",
            awaitLog(6_000) { it.getInt("confirms") == before.getInt("confirms") + 1 && !it.optBoolean("confirm", true) }
        )
        tapPage("#alert")
        expect("and its next alert() returns at once", awaitLog(6_000) { it.getInt("alerts") == before.getInt("alerts") + 2 })
        SystemClock.sleep(1_000)
        expect("with no sheet on the way (${sheetsSeen()} seen) and nothing pending", sheetsSeen() == 0 && sheetGone() && pendingDialogs().length() == 0)
        still("suppressed-no-sheet")
        // A new visit: the reload commits another document, and the page starts over.
        coreInvoke("tab.reload", JSONObject().put("tabId", DEMO).toString())
        awaitLoaded(DEMO, "$ORIGIN/")
        expect("the reload started the page over", awaitLog { it.getInt("alerts") == 0 })
        SystemClock.sleep(1_000)
        tapPageUntil("#alert") { sheetUp("alert") }
        expect("after the navigation the page's alert shows again", awaitSheet("alert"))
        expect("as the first of a new visit: no checkbox", !inDom(CHECKBOX))
        still("after-reload")
        answer("OK")
        expect("alert() returned", awaitLog { it.getInt("alerts") == 1 })
    }

    /** 6. A background tab's alert waits in the core, unseen, until its tab is on screen again. */
    private fun backgroundTabScene() {
        finding("\n6. A dialog from a background tab waits unseen until its tab is on screen again")
        val before = pageLog()
        watchSheets()
        tapPage("#later")
        flingLeft()
        expect("the pill fling made the other tab active", awaitUntil(6_000) { activeTabId() == OTHER })
        expect("the background page's alert is queued in the core", awaitUntil(10_000) { pendingDialogs().length() == 1 })
        SystemClock.sleep(2_500)
        expect("nothing shows for it on the other tab (${sheetsSeen()} sheets seen)", sheetsSeen() == 0 && sheetGone() && activeTabId() == OTHER)
        still("background-pending")
        flingRight()
        expect("the fling back made the demo tab active", awaitUntil(6_000) { activeTabId() == DEMO })
        expect("its sheet rises on the return", awaitSheet("alert"))
        expect("with the background page's message: '${sheetDescription()}'", sheetDescription() == "Hello from a background tab.")
        still("background-returned")
        answer("OK")
        expect("the page's alert() returned", awaitLog { it.getInt("alerts") == before.getInt("alerts") + 1 })
        SystemClock.sleep(1_000)
    }

    /** 7. A tab switch with the sheet up hides it, the dialog pending; the return shows it again. */
    private fun switchAwayScene() {
        finding("\n7. A tab switch with the dialog up hides it; the return shows it again, still pending")
        val before = pageLog()
        tapPageUntil("#alert") { sheetUp("alert") }
        expect("the sheet is up", awaitSheet("alert"))
        finding("  (the bar is inert under a sheet, §9.5: the switch is the core's, as another app's link would make it)")
        coreInvoke("tab.activate", JSONObject().put("tabId", OTHER).toString())
        expect("the sheet leaves with its tab", awaitUntil(LOOKUP_WAIT) { sheetGone() && activeTabId() == OTHER })
        expect("the dialog is still pending in the core", pendingDialogs().length() == 1)
        still("switched-away")
        SystemClock.sleep(1_000)
        coreInvoke("tab.activate", JSONObject().put("tabId", DEMO).toString())
        expect("the sheet is back on the return", awaitSheet("alert"))
        still("switched-back")
        answer("OK")
        expect("the page's alert() returned", awaitLog { it.getInt("alerts") == before.getInt("alerts") + 1 })
    }

    /** 8. beforeunload on a link: "Leave site?", Cancel stays, Leave goes. */
    private fun leaveOnNavigation() {
        finding("\n8. beforeunload on a navigation: 'Leave site?'; Cancel stays on the page, Leave goes")
        tapPage("#arm")
        expect("the page armed its beforeunload handler", awaitLog { it.optBoolean("armed") })
        tapPageUntil("#link") { sheetUp("beforeunload") }
        expect("'Leave site?' rises", awaitSheet("beforeunload"))
        expect("titled 'Leave site?': '${sheetTitle()}'", sheetTitle() == "Leave site?")
        expect("with Chrome's line: '${sheetDescription()}'", sheetDescription() == "Changes you made may not be saved.")
        expect("Cancel | Leave as the footer's peers", footerButton("Cancel") != null && footerButton("Leave") != null)
        still("leave-site")
        answer("Cancel")
        expect("the sheet has gone", awaitUntil(LOOKUP_WAIT) { sheetGone() })
        SystemClock.sleep(2_000)
        expect("the page stayed: ${activeUrl()}, its script state intact", activeUrl() == "$ORIGIN/" && pageLog().optBoolean("armed"))
        still("leave-cancelled")
        tapPageUntil("#link") { sheetUp("beforeunload") }
        expect("'Leave site?' rises again", awaitSheet("beforeunload"))
        answer("Leave")
        expect("the navigation goes on to the second page", awaitUntil(15_000) { activeUrl() == "$ORIGIN/second.html" })
        awaitLoaded(DEMO, "$ORIGIN/second.html")
        SystemClock.sleep(1_500)
        still("left")
    }

    /** 9. beforeunload on the overview card's X: Cancel keeps the card standing, Leave closes the tab. */
    private fun leaveOnCardClose() {
        finding("\n9. beforeunload on the card's close: Cancel keeps the tab and its card, Leave closes it")
        tapPage("#arm")
        expect("the second page armed its handler", awaitLog { it.optBoolean("armed") })
        openOverview()
        expect("the overview shows the demo card", awaitDom("!!document.querySelector(${JSONObject.quote(CARD)})"))
        still("overview")
        val asked = touchUntil("the card's X", { steadyRect { domRect(CARD_CLOSE) } }, { sheetUp("beforeunload") }, waitMs = SHEET_WAIT)
        expect("a touch on the X asks 'Leave site?' over the overview", asked)
        expect("titled 'Leave site?': '${sheetTitle()}'", sheetTitle() == "Leave site?")
        still("close-leave-site")
        answer("Cancel")
        expect("the sheet has gone", awaitUntil(LOOKUP_WAIT) { sheetGone() })
        // The card's exit would have run 900 ms after a close the browser never showed: well past it.
        SystemClock.sleep(3_000)
        expect("the tab stays", tabExists(DEMO))
        expect("its card stands in the grid", inDom(CARD))
        expect("the page is intact: ${activeUrl()}, its handler still armed", activeUrl() == "$ORIGIN/second.html" && pageLog().optBoolean("armed"))
        still("close-cancelled")
        val again = touchUntil("the card's X", { steadyRect { domRect(CARD_CLOSE) } }, { sheetUp("beforeunload") }, waitMs = SHEET_WAIT)
        expect("the X asks again", again)
        answer("Leave")
        expect("the tab closes", awaitUntil(10_000) { !tabExists(DEMO) })
        expect("its card has left the grid", awaitDom("!document.querySelector(${JSONObject.quote(CARD)})", 10_000))
        expect("the other tab is what is left", coreState().getJSONObject("tabs").let { it.length() == 1 && it.has(OTHER) })
        SystemClock.sleep(1_500)
        still("close-left")
    }

    // --- the sheet -------------------------------------------------------------------------------

    /** The page dialog sheet of `kind` is up and at rest: not leaving, not inert, drawn. */
    private fun sheetUp(kind: String): Boolean =
        jsString(
            "(function(){var s=document.querySelector('[data-sheet-layer]:not([data-leaving]) $SHEET:not([inert])');" +
                "if(!s||!s.querySelector('[data-page-dialog=\"$kind\"]'))return '';" +
                "return getComputedStyle(s).opacity==='0'?'':'up'})()"
        ) == "up"

    /** No page dialog sheet in the DOM at all (its leave has landed). */
    private fun sheetGone(): Boolean = !inDom(SHEET)

    /** The sheet is on its way down (a picked answer sends it off at once) or gone. */
    private fun sheetLeavingOrGone(): Boolean =
        jsString(
            "(function(){var s=document.querySelector('$SHEET');if(!s)return 'yes';" +
                "var l=s.closest('[data-sheet-layer]');return (l&&l.hasAttribute('data-leaving'))||s.hasAttribute('inert')?'yes':''})()"
        ) == "yes"

    private fun awaitSheet(kind: String, timeoutMs: Long = LOOKUP_WAIT): Boolean = awaitUntil(timeoutMs) { sheetUp(kind) }

    private fun sheetTitle(): String = textOf("$SHEET .zen-sheet-title-block h2")

    private fun sheetDescription(): String = textOf("$SHEET .zen-sheet-title-block p")

    /** A footer button of the sheet by its label, once the sheet has come to rest. */
    private fun footerButton(label: String): Rect? = steadyRect { textRect("$SHEET .zen-sheet-footer button", label) }

    /**
     * A touch on the sheet's `label` button, made again when the sheet still stands: the claim
     * of the step – what the answer did to the page and the core – is read by the caller.
     */
    private fun answer(label: String): Boolean {
        val took = touchUntil("the sheet's $label", { footerButton(label) }, { sheetLeavingOrGone() })
        if (!took) touchFault("the touch on the sheet's $label did not send the sheet away")
        return took
    }

    private fun fieldValue(): String =
        jsString("(function(){var e=document.querySelector(${JSONObject.quote(FIELD)});return e?e.value:''})()")

    /** Where the chrome's focus is: the prompt's field, elsewhere in the sheet, or the element's tag. */
    private fun focusIn(): String =
        jsString(
            "(function(){var a=document.activeElement;if(!a||a===document.body)return 'body';" +
                "if(a.matches(${JSONObject.quote(FIELD)}))return 'field';" +
                "if(a.closest('$SHEET'))return 'sheet';return a.tagName})()"
        )

    private fun isChecked(): Boolean =
        jsString("(function(){var e=document.querySelector('$CHECKBOX');return e&&e.checked?'yes':''})()") == "yes"

    /**
     * Put page dialog sheets on record: a MutationObserver counts every appearance of one, so a
     * sheet that came and went between two polls is not missed. Each call clears the record.
     */
    private fun watchSheets() {
        jsString(
            "(function(){window.__demoSheets=0;var seen=false;var note=function(){var up=!!document.querySelector('$SHEET');" +
                "if(up&&!seen)window.__demoSheets++;seen=up};" +
                "if(window.__demoSheetWatch)window.__demoSheetWatch.disconnect();" +
                "window.__demoSheetWatch=new MutationObserver(note);" +
                "window.__demoSheetWatch.observe(document.body,{childList:true,subtree:true});note();return ''})()"
        )
    }

    private fun sheetsSeen(): Int = jsString("(function(){return String(window.__demoSheets||0)})()").toIntOrNull() ?: -1

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

    /**
     * [tapPage] until `took` holds (the dialog it opens is up), up to [TOUCH_ATTEMPTS] times:
     * the emulator's WebView reads a tap as a hold now and then, and a hold opens nothing.
     */
    private fun tapPageUntil(selector: String, took: () -> Boolean): Boolean {
        for (attempt in 1..TOUCH_ATTEMPTS) {
            if (!tapPage(selector)) return took()
            if (awaitUntil(TOUCH_TOOK_WAIT) { took() }) return true
            if (attempt < TOUCH_ATTEMPTS) finding("  (the touch on $selector did not take, attempt $attempt: touching again)")
        }
        return took()
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
        jsString("(function(){return document.querySelector('.zen-quick-menu, .zen-sheet:not($SHEET)') ? 'held' : ''})()") == "held"

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

    /** The box of the first element matching `selector` whose text starts with `prefix`. */
    private fun textRect(selector: String, prefix: String): Rect? =
        rectFrom(
            jsString(
                "(function(){var p=${JSONObject.quote(prefix)};var e=Array.prototype.find.call(document.querySelectorAll(${JSONObject.quote(selector)})," +
                    "function(n){return n.textContent.trim().indexOf(p)===0});if(!e)return '';$RECT_JS})()"
            )
        )

    private fun textOf(selector: String): String =
        jsString("(function(){var e=document.querySelector(${JSONObject.quote(selector)});return e?e.textContent.trim():''})()")

    private fun inDom(selector: String): Boolean =
        jsString("(function(){return document.querySelector(${JSONObject.quote(selector)})?'yes':''})()") == "yes"

    private fun hasText(selector: String, text: String): Boolean =
        jsString(
            "(function(){return Array.prototype.some.call(document.querySelectorAll(${JSONObject.quote(selector)})," +
                "function(n){return n.textContent.indexOf(${JSONObject.quote(text)})>=0})?'yes':''})()"
        ) == "yes"

    /**
     * A box read from the DOM once two reads [STEADY_MS] apart agree (a sheet's rows while it
     * rises report where they are on each frame); the last read when they never do within
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

    private fun pressKey(keyCode: Int) {
        val now = SystemClock.uptimeMillis()
        for (action in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            val event = KeyEvent(
                now, SystemClock.uptimeMillis(), action, keyCode, 0, 0,
                KeyCharacterMap.VIRTUAL_KEYBOARD, 0, 0, InputDevice.SOURCE_KEYBOARD
            )
            ui.injectInputEvent(event, true)
            SystemClock.sleep(30)
        }
        SystemClock.sleep(300)
    }

    // --- the core's state ------------------------------------------------------------------------

    private fun pendingDialogs(): JSONArray = coreState().optJSONArray("pageDialogs") ?: JSONArray()

    private fun activeTabId(): String = activeCoreTab()?.optString("id").orEmpty()

    private fun activeUrl(): String = activeCoreTab()?.optString("url").orEmpty()

    private fun tabExists(tabId: String): Boolean = coreState().getJSONObject("tabs").has(tabId)

    private fun describeActive(): String {
        val state = coreState()
        val tab = activeCoreTab(state)
        return "active ${tab?.optString("id")} ${tab?.optString("url")}, ${state.getJSONObject("tabs").length()} tabs, " +
            "${state.optJSONArray("pageDialogs")?.length() ?: 0} dialogs pending"
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
        private const val SITE = "127.0.0.1:$PORT"
        private const val ORIGIN = "http://$SITE"
        private const val DEMO = "tab_demo"
        private const val OTHER = "tab_other"
        private const val SUPPRESS_LABEL = "Don't let this page create more dialogs"
        /** The page dialog's sheet (`PhoneSheet` with `className="zen-page-dialog-sheet"`). */
        private const val SHEET = ".zen-page-dialog-sheet"
        private const val FIELD = ".zen-page-dialog-sheet input.zen-v2-field"
        private const val CHECKBOX = ".zen-page-dialog-sheet input.zen-v2-checkbox"
        private const val CHECKBOX_ROW = ".zen-page-dialog-sheet label.zen-v2-check-row"
        private const val CARD = ".zen-overview-grid [data-tab-id=\"tab_demo\"]"
        private const val CARD_CLOSE = ".zen-overview-grid [data-tab-id=\"tab_demo\"] [aria-label^=\"Close \"]"
        private const val RECT_JS = "var r=e.getBoundingClientRect();" +
            "return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom,d:window.devicePixelRatio})"
        /** How long an element may take to appear in the DOM after a change. */
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
    }
}
