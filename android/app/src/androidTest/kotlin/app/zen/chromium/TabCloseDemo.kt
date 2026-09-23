package app.zen.chromium

import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
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
 * Records closing tabs from the phone's tab overview and taking it back (matrix TAB-05, TAB-06,
 * TAB-07, TAB-22, TAB-23, GN-16, BH-26; v2 draft 9.23, 9.33, 11.4), with every press a real
 * touch and the outcome of each read off the core's state, never off the chrome's word:
 *
 *  1. a card closed with its X: the toast `Closed <title>` with Undo; Undo puts the tab back
 *     at its index;
 *  2. a card of the Research group swiped off the grid: the same toast; Undo puts it back into
 *     the group at its index;
 *  3. the header menu's Close All Tabs: the `Close 7 tabs?` prompt; a touch on Close all closes
 *     every unpinned tab of the space (Essentials stay), one `7 tabs closed` toast; Undo brings
 *     the seven back in their order, group included;
 *  4. the prompt's Don't ask again: touched, then Close all; `settings.confirmCloseAll` is off
 *     in the core; Undo; the next Close all closes without a prompt; Undo;
 *  5. Recently Closed: a card closed with its X, the menu's row opens the sheet, a touch on the
 *     entry restores the tab and the overview leaves on it.
 *
 * Positions come from the chrome's DOM (`getBoundingClientRect`, checked once against the
 * accessibility bounds of the overview's Spaces button), because the WebView's accessibility
 * tree trails the software-rendered emulator by seconds. Every touch is a down and an up a
 * frame apart ([touch]), and every touch on a control is checked for having taken
 * ([touchUntil]): while the emulator's main thread is held (seven pages going away at once),
 * the WebView's gesture detector turns a tap into a long press when a long task falls between
 * its down and its up, and a long press is nothing to a button, so such a touch is made again
 * while the control is still there. The bulk close races the toast's five-second clock through
 * [closeAllThenUndo]: one read per poll, the Undo touched at the first sighting of the toast,
 * the still and the slow checks after it; a scenario whose Undo failed puts the tabs back
 * through the core so the next one still runs. Findings go to `tab-close-findings.txt`
 * next to the stills (one PASS or FAIL per claim, ALL CHECKS PASSED at the end); the run fails
 * on any FAIL. Profile `overview-demo-state.json`: the Work space with the group Research
 * [World Wide Web, Damping] and the loose tabs example.com (active), Hacker News, RFC 2324, Tea,
 * Coffee, plus three Essentials. Driven by `android-tab-close-demo.yml`. See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class TabCloseDemo : DemoHarness("overview-demo-state.json", "tab-close", "tabclose-demo") {
    override val tag = "TabCloseDemo"
    private lateinit var findings: File
    private var failures = 0
    private var shots = 0

    @Test
    fun record() {
        runDemo()
        if (failures > 0) error("$failures check(s) failed; see tab-close-findings.txt")
    }

    /** Visit the next tab and come back so the two front cards have thumbnails. */
    override fun warmUp() {
        findings = File(out, "tab-close-findings.txt")
        findings.writeText(
            "Zenium Android tab closing checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        flingLeft(); settle()
        touchWithoutGesture(); settle()
        flingRight(); settle()
        touchWithoutGesture(); settle()
        finding("start: ${describeSpace()}")
    }

    override fun demo() {
        openOverview()
        still("grid")
        val start = trackOrder()

        closeByX(start)
        swipeOff(start)
        closeAllWithPrompt(start)
        dontAskAgain(start)
        recentlyClosed()

        still("end")
        finding("\nend: ${describeSpace()}")
        finding(if (failures == 0) "ALL CHECKS PASSED" else "$failures CHECK(S) FAILED")
    }

    // --- the scenarios ---------------------------------------------------------------------------

    /** 1. Tea closed with its X, then Undo on the toast. */
    private fun closeByX(start: List<Pair<String, String?>>) {
        finding("\n1. Tea closed with its X, Undo on the toast")
        closeWithX(TEA, "Tea")
        val gone = awaitTab(TEA, exists = false)
        expect("the tab is closed at once", gone)
        val toast = awaitToast("Closed ")
        expect("a toast reads 'Closed <title>' with Undo: '${toast.orEmpty()}'", toast != null && undoRect() != null)
        expect("the card has left the grid", awaitDom("!document.querySelector('${card(TEA)}')"))
        still("closed-x-toast")
        undo("Undo") { tabExists(TEA) }
        expect("Undo brings Tea back", awaitTab(TEA, exists = true))
        SystemClock.sleep(SETTLE)
        expect("Tea is back at its index, loose", trackOrder() == start)
        still("undo-x")
        awaitToastGone()
    }

    /**
     * A touch on a card's X that has to take: the card leaves the DOM as the tab goes. The card
     * is shown (scrolled into the grid) once, first, and has to be there; the touches read the X
     * where it is and read nothing once the card has left – a touch that took later than
     * [TOUCH_TOOK_WAIT] (the repairs' third proof run, Hacker News: the WebView's main thread
     * was skipping frames of 700 ms around the touch, the card left just after the wait, and
     * the touch again waited [LOOKUP_WAIT] for an X that was never coming back and threw).
     */
    private fun closeWithX(tabId: String, name: String) {
        val x = closeButtonOf(card(tabId))
        show(x)
        touchUntil("the X of $name", { domRect(x) }, { !inDom(card(tabId)) })
    }

    /** 2. Damping, in the Research group, swiped off the grid, then Undo. */
    private fun swipeOff(start: List<Pair<String, String?>>) {
        finding("\n2. Damping (group Research) swiped off the grid, Undo on the toast")
        val damping = show(card(DAMPING))
        val f = Finger()
        f.down(damping.exactCenterX(), damping.exactCenterY())
        f.moveBy(1.1f * damping.width(), 0f, 220)
        f.up()
        finding("  swipe from ${damping.exactCenterX().roundToInt()},${damping.exactCenterY().roundToInt()} by ${(1.1f * damping.width()).roundToInt()} px")
        expect("the tab is closed once the card has flown off", awaitTab(DAMPING, exists = false, timeoutMs = 10_000))
        val toast = awaitToast("Closed ")
        expect("the toast reads 'Closed <title>': '${toast.orEmpty()}'", toast != null)
        still("closed-swipe-toast")
        undo("Undo") { tabExists(DAMPING) }
        expect("Undo brings Damping back", awaitTab(DAMPING, exists = true))
        SystemClock.sleep(SETTLE)
        expect("Damping is back in Research at its index", trackOrder() == start && folderOf(DAMPING) == RESEARCH)
        still("undo-swipe")
        awaitToastGone()
    }

    /** 3. Close all tabs from the header menu, the prompt, Close all touched, one toast, Undo. */
    private fun closeAllWithPrompt(start: List<Pair<String, String?>>) {
        finding("\n3. Close all tabs: the prompt, Close all, one toast, Undo restores the seven")
        openMenuRow("Close All Tabs") { promptUp() }
        expect("the prompt asks 'Close 7 tabs?'", awaitText(".zen-frame-dialogs", PROMPT))
        expect("the prompt carries Don't ask again, unticked", awaitDom("$CHECKBOX_IN_DOM && !$CHECKBOX_CHECKED"))
        still("closeall-prompt")
        val bulk = closeAllThenUndo("Close all on the prompt", { footerButton("Close all") }, "closeall-toast")
        expect("one toast reads '7 tabs closed': '${bulk.toast}'", bulk.toast.startsWith(BULK_TOAST))
        expectClosedAtToast(bulk)
        expect("Undo brings the seven back", awaitUnpinned(7, RESTORE_ALL_WAIT))
        SystemClock.sleep(SETTLE)
        expect("they are back in their order, Research whole", trackOrder() == start)
        expect("the Essentials were never touched", coreState().getJSONObject("tabs").let { it.has(MAIL) && it.has(CAL) && it.has(GH) })
        still("undo-all")
        restoreForNextScenario(start)
        awaitToastGone()
    }

    /** A footer button of the prompt sheet by its label, once the sheet has come to rest. */
    private fun footerButton(label: String): Rect? =
        steadyRect({ textRect(".zen-frame-dialogs .zen-sheet-footer button", label) })

    private fun promptUp(): Boolean = hasText(".zen-frame-dialogs", PROMPT)

    /** 4. Don't ask again touched: the setting turns off with the close; the next Close all has no prompt. */
    private fun dontAskAgain(start: List<Pair<String, String?>>) {
        finding("\n4. Don't ask again, then Close all twice: the second time without the prompt")
        openMenuRow("Close All Tabs") { promptUp() }
        expect("the prompt is up", awaitText(".zen-frame-dialogs", PROMPT))
        val ticked = touchUntil("the Don't ask again checkbox", { steadyRect({ domRect(CHECKBOX) }) }, { isChecked() })
        expect("the checkbox is ticked by the touch", ticked)
        still("dont-ask-checked")
        val first = closeAllThenUndo("Close all on the prompt", { footerButton("Close all") }, null)
        expect("the tabs close, one toast '${first.toast}'", first.toast.startsWith(BULK_TOAST))
        expectClosedAtToast(first)
        expect("Undo brings the seven back", awaitUnpinned(7, RESTORE_ALL_WAIT))
        expect("settings.confirmCloseAll is off in the core", awaitSetting("confirmCloseAll", false))
        SystemClock.sleep(SETTLE)
        restoreForNextScenario(start)
        awaitToastGone()

        // The prompt is watched for from the touch on the row to the toast: it must never show.
        openMenu()
        val second = closeAllThenUndo("'Close All Tabs' in the menu", { steadyRect { menuRow("Close All Tabs") } }, "closeall-noprompt-toast")
        expect("the toast reads '7 tabs closed': '${second.toast}'", second.toast.startsWith(BULK_TOAST))
        expect("with no prompt on the way", !second.promptSeen)
        expectClosedAtToast(second)
        expect("Undo brings the seven back", awaitUnpinned(7, RESTORE_ALL_WAIT))
        SystemClock.sleep(SETTLE)
        expect("in their order", trackOrder() == start)
        still("closeall-noprompt-undone")
        restoreForNextScenario(start)
        awaitToastGone()
    }

    /** What [closeAllThenUndo] saw: the toast's text, whether the prompt showed on the way, the state at the toast. */
    private class BulkClose(
        val toast: String,
        val promptSeen: Boolean,
        /** Regular tabs left in the active space per the core when the toast stood; null when that read never came. */
        val unpinnedAtToast: Int?,
        /** Cards left in the overview grid at the same moment. */
        val cardsAtToast: Int
    )

    /**
     * The bulk close and its Undo, against the toast's five-second clock. Once the seven pages
     * go, the emulator's main thread is held for seconds (their WebViews going away, the
     * Essential that takes over loading): every read of the chrome, and every touch, waits a
     * second or two in its queue, while the toast's clock and its entry run in the chrome's
     * renderer, which does not wait. So: `trigger` (the prompt's Close all, or the menu row when
     * there is no prompt) is touched, and touched again when the sheet still stands after
     * [SHEET_WAIT] with no toast up; the toast is watched for with ONE read per poll, which also
     * has the core snapshot its state the first time the toast is seen; and the Undo is touched
     * at the first sighting – where the read found it, or, when the card was still coming up,
     * where it comes to rest, [ENTRY_WAIT] later – before the still is captured and before
     * anything else is read. When the next read finds the toast still standing (a touch read as
     * a hold; see [touch]), the Undo is touched again, up to [TOUCH_ATTEMPTS] times: a finger on
     * the card holds its clock and lets it go with a second on it at least. The checks that take
     * their time come after.
     */
    private fun closeAllThenUndo(what: String, trigger: () -> Rect?, stillName: String?): BulkClose {
        jsString("(function(){window.__demoSnap=undefined;return ''})()")
        val box = trigger() ?: run {
            finding("  ($what is not there to touch)")
            return BulkClose("", false, null, -1)
        }
        if (!touchOnScreen(box, what)) return BulkClose("", false, null, -1)
        var touchedAt = SystemClock.uptimeMillis()
        val deadline = touchedAt + BULK_TOAST_WAIT
        var promptSeen = false
        var state = toastState()
        // The toast is sighted once its text is up and its Undo will be on the screen at rest.
        fun sighted(s: ToastState): Boolean =
            s.text.startsWith(BULK_TOAST) && s.undo != null && (s.undoAtRest ?: s.undo).let { touchPoint(it) != null }
        while (!sighted(state)) {
            promptSeen = promptSeen || state.prompt
            if (SystemClock.uptimeMillis() >= deadline) {
                finding("  (no '$BULK_TOAST' toast within ${BULK_TOAST_WAIT / 1000} s: '${state.text}')")
                return BulkClose(state.text, promptSeen, state.unpinned, state.cards)
            }
            // The sheet still standing this long after the touch, and no toast: it did not take.
            if (state.text.isEmpty() && (state.prompt || state.menu) && SystemClock.uptimeMillis() - touchedAt > SHEET_WAIT) {
                trigger()?.let {
                    finding("  (the touch on $what did not take: touching again)")
                    touchOnScreen(it, what)
                    touchedAt = SystemClock.uptimeMillis()
                }
            }
            SystemClock.sleep(150)
            state = toastState()
        }
        promptSeen = promptSeen || state.prompt
        if (state.moving) {
            // Still coming up: the card rests within ENTRY_WAIT (SPRING_GENTLE from the edge).
            finding("  (the toast is still entering: touching where its Undo comes to rest)")
            SystemClock.sleep(ENTRY_WAIT)
        }
        touch(state.undoAtRest ?: state.undo!!, "the toast's Undo")
        // Captured after the touch, which is still in its queue while the main thread is held:
        // the screen shows the toast standing, and the touch lost nothing to the capture.
        if (stillName != null) still(stillName)
        // The snapshot the first sighting started comes with the next read at the latest; it
        // was taken before that touch's click could run, so it is the state at the toast.
        var unpinned = state.unpinned
        for (attempt in 1..TOUCH_ATTEMPTS) {
            SystemClock.sleep(BULK_UNDO_READ_WAIT)
            val after = toastState()
            if (unpinned == null) unpinned = after.unpinned
            if (after.text.isEmpty() || after.moving) break
            val undo = after.undo?.takeIf { touchPoint(it) != null } ?: break
            if (attempt < TOUCH_ATTEMPTS) {
                finding("  (the touch on the toast's Undo did not take, attempt $attempt: touching again)")
                touch(undo, "the toast's Undo")
            }
        }
        // The snapshot's answer can trail the toast's exit when the core is busy putting the
        // seven back: it was asked for at the toast all the same, so it is waited for a little.
        val snapshotDeadline = SystemClock.uptimeMillis() + SNAPSHOT_WAIT
        while (unpinned == null && SystemClock.uptimeMillis() < snapshotDeadline) {
            SystemClock.sleep(300)
            unpinned = toastState().unpinned
        }
        return BulkClose(state.text, promptSeen, unpinned, state.cards)
    }

    private fun expectClosedAtToast(bulk: BulkClose) {
        expect(
            "every unpinned tab of the space was closed when the toast stood (${bulk.unpinnedAtToast ?: "state not read"} left in the core, ${bulk.cardsAtToast} cards in the grid)",
            bulk.unpinnedAtToast == 0
        )
    }

    /** One read of the chrome for [closeAllThenUndo]: the toast, the sheets, the grid, and the core's state at the toast. */
    private class ToastState(
        val text: String,
        val moving: Boolean,
        val undo: Rect?,
        /** Where the Undo is once the card rests: [undo] with the card's transform (its entry, still under way) taken out. */
        val undoAtRest: Rect?,
        val prompt: Boolean,
        val menu: Boolean,
        val cards: Int,
        /** Regular tabs left in the active space, from the snapshot the first sighting of the toast started; null until it has come. */
        val unpinned: Int?
    )

    /**
     * The toast (text, whether it is moving, where its button is, and where the button is once
     * the card rests: the card rides a `translate3d` while it enters, taken out of the box),
     * whether the prompt or the menu sheet is up, how many cards the grid holds, in one
     * evaluation. The first time it finds a toast up it also has the core snapshot its state
     * (`app.getState`, in-process on Android, settled in the microtask after this script and so
     * before any touch's click); the snapshot comes back with the next read.
     */
    private fun toastState(): ToastState {
        val raw = jsString(
            "(function(){var t=document.querySelector('.zen-message-toast');" +
                "var x=t?(t.querySelector('.zen-message-text')||{textContent:''}).textContent:'';" +
                "var b=t?t.querySelector('.zen-message-button'):null;var r=b?b.getBoundingClientRect():null;" +
                "var tr=t?getComputedStyle(t).transform:'none';var mx=(tr&&tr!=='none')?new DOMMatrix(tr):null;" +
                "var dx=mx?mx.m41:0,dy=mx?mx.m42:0;var d=window.devicePixelRatio;" +
                "if(t&&window.__demoSnap===undefined){window.__demoSnap='pending';" +
                "window.zen.invoke('app.getState',null).then(function(s){window.__demoSnap=JSON.stringify(s)},function(){window.__demoSnap='ERR'})}" +
                "var snap=(window.__demoSnap&&window.__demoSnap!=='pending')?window.__demoSnap:null;" +
                "return JSON.stringify({x:x,m:!!(t&&t.hasAttribute('data-moving')),u:r?{l:r.left,t:r.top,r:r.right,b:r.bottom,d:d}:null," +
                "ur:r?{l:r.left-dx,t:r.top-dy,r:r.right-dx,b:r.bottom-dy,d:d}:null," +
                "p:Array.prototype.some.call(document.querySelectorAll('.zen-frame-dialogs'),function(n){return n.textContent.indexOf(${JSONObject.quote(PROMPT)})>=0})," +
                "menu:!!document.querySelector('.zen-sheet-item'),c:document.querySelectorAll('.zen-overview-grid [data-tab-id]').length,snap:snap})})()"
        )
        if (raw.isEmpty()) return ToastState("", false, null, null, false, false, -1, null)
        val o = JSONObject(raw)
        val snap = o.optString("snap", "")
        val unpinned = if (snap.isEmpty() || snap == "ERR" || o.isNull("snap")) null else trackOrder(JSONObject(snap)).size
        return ToastState(
            o.optString("x"),
            o.optBoolean("m"),
            if (o.isNull("u")) null else rectFrom(o.getJSONObject("u").toString()),
            if (o.isNull("ur")) null else rectFrom(o.getJSONObject("ur").toString()),
            o.optBoolean("p"),
            o.optBoolean("menu"),
            o.optInt("c", -1),
            unpinned
        )
    }

    /**
     * When a scenario's Undo did not bring the seven back, put them back through the core
     * (`session.restoreClosed`, newest first, as the chrome's Undo does: a bulk close takes the
     * tabs in track order, so each entry holds index 0 and only the newest-first restore rebuilds
     * the order) so the scenarios after it still have their tabs: one failure, one FAIL, not a
     * cascade. Says so in the findings.
     */
    private fun restoreForNextScenario(start: List<Pair<String, String?>>) {
        if (trackOrder() == start) return
        // The list is newest first and holds only this demo's closes (the profile seeds none).
        val closed = JSONArray(coreInvoke("session.recentlyClosed"))
        val ids = (0 until closed.length()).map { closed.getJSONObject(it) }
            .filter { it.optString("kind") == "tab" }
            .map { it.getString("id") }
        finding("  (the tabs did not come back: ${ids.size} put back through the core for the next scenario)")
        for (id in ids) coreInvoke("session.restoreClosed", JSONObject().put("id", id).toString())
        awaitUnpinned(start.size, RESTORE_ALL_WAIT)
        SystemClock.sleep(SETTLE)
    }

    /** 5. Hacker News closed with its X; Recently closed lists it; a touch on the row restores it. */
    private fun recentlyClosed() {
        finding("\n5. Recently closed: Hacker News closed, listed, restored from the sheet")
        closeWithX(HN, "Hacker News")
        expect("the tab is closed", awaitTab(HN, exists = false))
        awaitToastGone()
        openMenuRow("Recently Closed") { inDom(ROW) }
        expect("the sheet lists the entry", awaitText(ROW, "Hacker News", timeoutMs = 8_000) ||
            awaitText(ROW, "news.ycombinator.com", timeoutMs = 1_000))
        still("recent-list")
        // The row's touch sends the sheet off first, then restores: either is the touch taking.
        touchUntil("the first Recently closed row", { steadyRect({ textRect("$ROW .zen-list-main", "") }) }, { !inDom(ROW) || !inDom(".zen-overview") }, waitMs = SHEET_WAIT)
        expect("the tab is restored", awaitTab(HN, exists = true))
        expect("the overview leaves on it", awaitDom("!document.querySelector('.zen-overview')", 10_000))
        SystemClock.sleep(SETTLE)
        expect("Hacker News is the active tab", activeSpace(coreState()).optString("activeTabId") == HN)
        still("recent-restored")
    }

    // --- moves -----------------------------------------------------------------------------------

    /**
     * A real touch on the middle of `box` (screen px), logged: the finger's down and up
     * [TAP_HOLD_MS] apart. The WebView's gesture detector reads a tap as a long press when a
     * long task on the main thread (a page's WebView going away) falls between its handling of
     * the down and the arrival of the up; a down and an up already queued together are handled
     * back to back, with no room for one. So the two are injected as close together as a
     * frame, not the harness's 60 ms.
     */
    private fun touch(box: Rect, what: String) {
        val point = touchPoint(box) ?: error("$what at $box is out of the touchable window $touchable")
        finding("  touch at ${point.x.roundToInt()},${point.y.roundToInt()} on $what")
        val f = Finger()
        f.down(point.x, point.y)
        f.hold(TAP_HOLD_MS)
        f.up()
    }

    /** [touch] when `box` is inside the touchable window; false, and a note, when it is not (a sheet on its way out). */
    private fun touchOnScreen(box: Rect, what: String): Boolean {
        if (touchPoint(box) == null) {
            finding("  ($what is off the screen at $box)")
            return false
        }
        touch(box, what)
        return true
    }

    /**
     * A touch that has to take. The emulator's WebView reads a short tap as a hold now and then –
     * with its main thread held (pages going away, a grid reflowing) the long-press clock runs
     * out before the up is seen – and a hold is nothing to a button. So: touch `what` where
     * `read` finds it, watch `took` for `waitMs`, and when nothing came of it read the box again
     * (it may have moved) and touch again, up to `attempts` times. Whether it took in the end.
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
                // Off the screen: a sheet on its way out still in the DOM, or one not yet risen.
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
     * A touch on the toast's `label` button (Undo) that has to take: `took` is the scenario's
     * own consequence in the core (the closed tab back), touched again while the toast stands
     * when it has not come. The toast's motion (`data-moving`) was the proof before: a card
     * whose entry spring has not reported its rest carries the attribute standing still, so a
     * touch the WebView had read as a hold (the repairs' second proof run, the Damping swipe's
     * Undo: the toast stood two seconds more and left on its clock, the tab never came back and
     * the Close all after it asked about six tabs) passed as taken and was never retried.
     */
    private fun undo(label: String, took: () -> Boolean = { toastLeavingOrGone() }): Boolean {
        if (awaitRect({ undoRect() }, 6_000) == null) {
            record("  the toast's $label button never showed", false)
            return false
        }
        awaitDom("(function(){var e=document.querySelector('.zen-message-toast');return !!e&&!e.hasAttribute('data-moving')})()", 1_500)
        val ok = touchUntil("the toast's $label", { undoRect() }, took, waitMs = UNDO_TOOK_WAIT)
        if (!ok) record("  the touch on the toast's $label never took", false)
        return ok
    }

    /**
     * Open the overview header's menu with a touch on More, then touch the row whose label
     * starts with `row` (`Close All Tabs (7)`, `Recently Closed (1)`, the menu's Title Case, v2 §9.1)
     * once the sheet has risen;
     * `took` says what the row's touch brings about (the prompt, the list).
     */
    private fun openMenuRow(row: String, took: () -> Boolean) {
        openMenu()
        touchUntil("'$row' in the menu", { steadyRect { menuRow(row) } }, took, waitMs = SHEET_WAIT)
    }

    /** A row of the header menu by the start of its label, wherever the sheet is at the moment. */
    private fun menuRow(row: String): Rect? = textRect(".zen-sheet-item", row)

    /** Touch More in the overview header until the menu sheet's rows are there. */
    private fun openMenu() {
        // A menu still up from an earlier step (a row that had nothing to do) is sent away first:
        // a touch on More would land on its scrim and only send it away.
        if (menuRow("") != null) {
            back()
            awaitUntil(SHEET_WAIT) { menuRow("") == null }
            SystemClock.sleep(500)
        }
        // The menu reads the recently closed list before it comes up: a second touch too soon
        // would land on its scrim and send it away again.
        val opened = touchUntil("More in the overview header", { domRect("[aria-label=\"More\"]") }, { menuRow("") != null }, waitMs = SHEET_WAIT)
        if (!opened) error("the overview's menu never opened")
    }

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

    /**
     * Open the overview with a touch on the bar's Tabs button (the count trails its label);
     * a touch the emulator's lag turns into a hold is dismissed and tried again.
     */
    private fun openOverview() {
        for (attempt in 0 until OPEN_ATTEMPTS) {
            // The Tabs button is on the bar, under the URL field when that is up: the shared close
            // (by the chrome's state), with a page it moved named in the record.
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

    /**
     * The on-screen box of the first element `selector` matches, null when nothing does. With
     * `scrollIntoView`, the overview grid is scrolled the least it has to for the element to be
     * fully in its viewport first.
     */
    private fun domRect(selector: String, scrollIntoView: Boolean = false): Rect? {
        val scroll = if (!scrollIntoView) "" else
            "var g=document.querySelector('.zen-overview-grid');" +
                "if(g){var gr=g.getBoundingClientRect(),er=e.getBoundingClientRect();" +
                "if(er.top<gr.top||er.bottom>gr.bottom)e.scrollIntoView({block:'nearest'});}"
        return rectFrom(jsString("(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return '';$scroll$RECT_JS})()"))
    }

    /** The box of the first element matching `selector` whose text starts with `prefix` (any, when `prefix` is empty). */
    private fun textRect(selector: String, prefix: String): Rect? =
        rectFrom(
            jsString(
                "(function(){var p=${JSONObject.quote(prefix)};var e=Array.prototype.find.call(document.querySelectorAll(${JSONObject.quote(selector)})," +
                    "function(n){return n.textContent.trim().indexOf(p)===0});if(!e)return '';$RECT_JS})()"
            )
        )

    /** The toast's action button (`Undo`), when a toast is up. */
    private fun undoRect(): Rect? = domRect(".zen-message-toast .zen-message-button")

    /** Whether the toast has been sent off (a picked action does that at once) or is gone. */
    private fun toastLeavingOrGone(): Boolean =
        jsString("(function(){var e=document.querySelector('.zen-message-toast');return !e||e.hasAttribute('data-moving')?'yes':''})()") == "yes"

    /** Whether anything matches `selector` right now. */
    private fun inDom(selector: String): Boolean =
        jsString("(function(){return document.querySelector(${JSONObject.quote(selector)})?'yes':''})()") == "yes"

    /** Whether an element matching `selector` whose text contains `text` is there right now. */
    private fun hasText(selector: String, text: String): Boolean =
        jsString(
            "(function(){return Array.prototype.some.call(document.querySelectorAll(${JSONObject.quote(selector)})," +
                "function(n){return n.textContent.indexOf(${JSONObject.quote(text)})>=0})?'yes':''})()"
        ) == "yes"

    private fun isChecked(): Boolean = jsString("(function(){return ($CHECKBOX_CHECKED)?'yes':''})()") == "yes"

    /** The box of `selector`, waiting for it to be in the DOM; the demo cannot go on without it. */
    private fun box(selector: String): Rect =
        awaitRect({ domRect(selector) }, LOOKUP_WAIT) ?: error("nothing matches $selector")

    /** Like [box], after scrolling the element fully into the grid's viewport when it is not. */
    private fun show(selector: String): Rect {
        val before = box(selector)
        val after = domRect(selector, scrollIntoView = true) ?: before
        if (after != before) SystemClock.sleep(1_200)
        return domRect(selector) ?: after
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
    private fun awaitDom(expression: String, timeoutMs: Long = 8_000): Boolean =
        awaitUntil(timeoutMs) { jsString("(function(){return ($expression)?'yes':''})()") == "yes" }

    /** Whether an element matching `selector` whose text contains `text` shows up in time. */
    private fun awaitText(selector: String, text: String, timeoutMs: Long = 8_000): Boolean =
        awaitUntil(timeoutMs) { hasText(selector, text) }

    /** The toast's text once one starting with `prefix` is up; null when none comes in time. */
    private fun awaitToast(prefix: String, timeoutMs: Long = 8_000): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            val text = jsString("(function(){var e=document.querySelector('.zen-message-toast .zen-message-text');return e?e.textContent:''})()")
            if (text.startsWith(prefix)) return text
            if (SystemClock.uptimeMillis() >= deadline) return null
            SystemClock.sleep(150)
        }
    }

    /** Wait for the toast to leave (its clock, plus its exit), so the next step starts with none up. */
    private fun awaitToastGone() {
        if (!awaitDom("!document.querySelector('.zen-message-toast')", 9_000)) finding("  (a toast is still up)")
        SystemClock.sleep(500)
    }

    /**
     * Check the DOM's coordinates against the accessibility tree once: the Spaces button in the
     * overview's header never moves, so its accessibility bounds are current. Any offset (a
     * chrome not at the window's origin) is applied to every box from then on.
     */
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

    private fun awaitTab(tabId: String, exists: Boolean, timeoutMs: Long = 8_000): Boolean =
        awaitUntil(timeoutMs) { tabExists(tabId) == exists }

    /** Wait for the active space to hold `count` unpinned, non-Essential tabs. */
    private fun awaitUnpinned(count: Int, timeoutMs: Long): Boolean =
        awaitUntil(timeoutMs) { trackOrder().size == count }

    private fun awaitSetting(name: String, value: Boolean, timeoutMs: Long = 6_000): Boolean =
        awaitUntil(timeoutMs) {
            val settings = coreState().optJSONObject("settings")
            settings != null && settings.optBoolean(name, !value) == value
        }

    /** The folder a tab is in per the core, null when loose (or gone). */
    private fun folderOf(tabId: String, state: JSONObject = coreState()): String? {
        val tab = state.getJSONObject("tabs").optJSONObject(tabId) ?: return null
        return if (tab.isNull("folderId")) null else tab.optString("folderId").takeIf { it.isNotEmpty() }
    }

    private fun activeSpace(state: JSONObject): JSONObject {
        val spaces = state.getJSONArray("spaces")
        val activeId = state.optString("activeSpaceId")
        for (i in 0 until spaces.length()) {
            val space = spaces.getJSONObject(i)
            if (space.getString("id") == activeId) return space
        }
        return spaces.getJSONObject(0)
    }

    /** The active space's regular tabs in track order, as (id, folderId) pairs. */
    private fun trackOrder(state: JSONObject = coreState()): List<Pair<String, String?>> {
        val tabs = state.getJSONObject("tabs")
        val ids = activeSpace(state).getJSONArray("tabIds")
        val order = ArrayList<Pair<String, String?>>()
        for (i in 0 until ids.length()) {
            val id = ids.getString(i)
            val tab = tabs.optJSONObject(id) ?: continue
            if (tab.optBoolean("pinned") || tab.optBoolean("essential")) continue
            order += id to folderOf(id, state)
        }
        return order
    }

    private fun describeSpace(): String {
        val state = coreState()
        val tabs = state.getJSONObject("tabs")
        val folders = state.getJSONObject("folders")
        val title = { id: String -> tabs.optJSONObject(id)?.optString("title") ?: id }
        val order = trackOrder(state)
        val groups = order.mapNotNull { it.second }.distinct().joinToString("; ") { folderId ->
            val name = folders.optJSONObject(folderId)?.optString("name") ?: folderId
            "group $name [${order.filter { it.second == folderId }.joinToString(", ") { title(it.first) }}]"
        }
        val loose = order.filter { it.second == null }.joinToString(", ") { title(it.first) }
        return "${if (groups.isEmpty()) "no groups" else groups}; loose [$loose]; confirmCloseAll ${state.optJSONObject("settings")?.opt("confirmCloseAll")}"
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

    /** Numbered stills: `tab-close-NN-<state>.png`. */
    private fun still(state: String) {
        shots++
        shot("%02d-%s".format(shots, state))
    }

    private companion object {
        /** How long a release, a close or a restore has to finish its motion before the state is read. */
        private const val SETTLE = 2_500L
        /** How long an element may take to appear in the DOM after a change. */
        private const val LOOKUP_WAIT = 8_000L
        /** How often the DOM and the core are asked while waiting for something. */
        private const val POLL_MS = 200L
        /** Two reads of a box this far apart agreeing count as at rest ([steadyRect]). */
        private const val STEADY_MS = 350L
        /** Largest DOM-to-screen offset (px) [calibrate] takes for real rather than for a stale tree. */
        private const val MAX_OFFSET = 200f
        /** Taps on the Tabs button [openOverview] tries before giving up (each may be read as a hold). */
        private const val OPEN_ATTEMPTS = 4
        /** Touches on a control [touchUntil] makes before giving up (each may be read as a hold). */
        private const val TOUCH_ATTEMPTS = 4
        /** The finger's down and up this far apart ([touch]): a frame, so the two queue together under load. */
        private const val TAP_HOLD_MS = 16L
        /** How long a touch has to show it took before it is made again. */
        private const val TOUCH_TOOK_WAIT = 900L
        /**
         * The same for the toast's Undo, shorter: a touch read as a hold restarts the toast's
         * clock with a second at least, and the next touch has to come within it.
         */
        private const val UNDO_TOOK_WAIT = 650L
        /**
         * Between the touch on a bulk close's Undo and the read that says whether it took: the
         * read waits its turn behind the touch on the held main thread anyway, and every
         * millisecond before the next touch is one off the toast's clock.
         */
        private const val BULK_UNDO_READ_WAIT = 200L
        /** A toast sighted while entering rests within this (SPRING_GENTLE from the edge settles in ~400 ms). */
        private const val ENTRY_WAIT = 500L
        /**
         * And for a touch whose outcome is a sheet coming up or going (its rise or exit under
         * load, a callback that runs as it lands): longer, since a touch made again too soon
         * would land on the sheet's scrim.
         */
        private const val SHEET_WAIT = 5_000L
        /** Seven pages coming back one after the other on a software-rendered emulator. */
        private const val RESTORE_ALL_WAIT = 30_000L
        /** From the touch that closes the seven to their toast: the sheet's exit, the closes, the entries' attribution. */
        private const val BULK_TOAST_WAIT = 20_000L
        /** How long the core's snapshot asked for at the toast may trail the toast's exit. */
        private const val SNAPSHOT_WAIT = 8_000L
        private const val PROMPT = "Close 7 tabs?"
        private const val BULK_TOAST = "7 tabs closed"
        /** A row of the Recently closed sheet: the shared row primitive with the phone modifier (#201). */
        private const val ROW = ".zen-frame-dialogs .zen-v2-row.zen-phone-row"
        private const val CHECKBOX = ".zen-frame-dialogs input.zen-v2-checkbox"
        private const val CHECKBOX_IN_DOM = "!!document.querySelector('$CHECKBOX')"
        private const val CHECKBOX_CHECKED = "($CHECKBOX_IN_DOM && document.querySelector('$CHECKBOX').checked)"
        private const val RECT_JS = "var r=e.getBoundingClientRect();" +
            "return JSON.stringify({l:r.left,t:r.top,r:r.right,b:r.bottom,d:window.devicePixelRatio})"

        // The seeded profile's ids.
        private const val TEA = "tab_tea"
        private const val DAMPING = "tab_damping"
        private const val HN = "tab_hn"
        private const val MAIL = "tab_mail"
        private const val CAL = "tab_cal"
        private const val GH = "tab_gh"
        private const val RESEARCH = "folder_research"
    }
}
