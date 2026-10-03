package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.SystemClock
import android.util.Log
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
import kotlin.math.roundToInt

/**
 * Records an AI agent's dialog policy on the phone (`browser_dialog_policy`, the Android half:
 * [DialogPolicyAnswer], `TabWebView.dialogPolicy`): a page an agent drives while the user is
 * not looking at it has its `alert` / `confirm` / `prompt` and its "Leave site?" answered from
 * the policy at once, nothing drawn, and every answer reported to the core; the tab in front of
 * the user keeps its sheet, policy or not. The agent's two words to the view go the way the core
 * sends them – the bridge's `view.setAgentDriven` and `view.setDialogPolicy`, posted from the
 * chrome ([bridgePost]) – and the reports are read where the core receives them: the chrome's
 * `__zenHost.viewEvent` is wrapped once ([tapReports]) to keep a copy of each
 * `pageDialogAnswered` payload on its way in. Every outcome is read off the page's own record
 * of what its calls returned (`window.__log`), off the app's windows in the accessibility tree
 * (a sheet is a second window) and off that copy, never off the chrome's word alone:
 *
 *  1. the tab in front, a policy standing and even the agent's word on driving it: a touch on
 *     `confirm()` raises the sheet as it always has, Cancel returns false to the page, and no
 *     report is made – the policy governs hidden tabs only;
 *  2. the same tab, the core's word for a tab in front (not driven) and the policy still
 *     standing, armed with a `beforeunload` handler by a real touch (the activation the WebView
 *     asks before it raises the question): a reload the core asks meets "Reload site?", Cancel
 *     keeps the page, and still no report;
 *  3. the tab hidden behind the other (a pill swipe), the agent driving it, a policy of
 *     confirm accept (the tab's rule), prompt "Zenium" (the session's) and beforeunload stay
 *     (the tab's): the page's `confirm()` returns true, its `prompt()` returns "Zenium", its
 *     `alert()` returns, nothing shows over the other tab, and three reports name the kind, the
 *     document, the message, the answer and the rule – the alert's under `tab`, the rules that
 *     stand;
 *  4. a reload the core asks of the hidden armed page: the policy's stay – the page stays, its
 *     handler still armed, no sheet over the other tab – reported as `stay` under `tab`;
 *  5. the policy cleared (`null`, as the core sends when no rule covers the tab any more), the
 *     agent still driving: the defaults – `confirm()` false, `prompt()` null, `alert()` OK –
 *     each reported under `default`, and the reload now leaves (the default), reported as
 *     `leave` under `default`, the page a fresh document;
 *  6. the swipe back: the show ends the agent's word on the tab, and a touch on `confirm()`
 *     raises the sheet again; no report joins the eight.
 *
 * Findings go to `dialog-policy-findings.txt` next to the stills (one PASS or FAIL per claim,
 * ALL CHECKS PASSED at the end); the run fails on any FAIL. The page and the profile are
 * [PageDialogsDemo]'s (`page-dialogs-demo-page.html`, `page-dialogs-demo-state.json`): the
 * same two loopback servers, the demo page active and one other tab, in the colour scheme the
 * `theme` argument names. Driven by `android-dialog-policy-demo.yml`. See [DemoHarness].
 */
@RunWith(AndroidJUnit4::class)
class DialogPolicyDemo : DemoHarness("page-dialogs-demo-state.json", "dialog-policy", "policy") {
    override val tag = "DialogPolicyDemo"
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
                "/other.html" to DemoServer.page("Another tab", "<p>No dialogs here.</p>")
            )
        ).also { it.start() }
        // The page embeds a frame from the host one port up; a quiet one, so the still is clean.
        frameServer = DemoServer(
            FRAME_PORT,
            mapOf("/frame.html" to DemoServer.page("A frame", "<p>Nothing to say.</p>"))
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            frameServer.close()
        }
        if (failures > 0) error("$failures check(s) failed; see dialog-policy-findings.txt")
    }

    override fun warmUp() {
        findings = File(out, "dialog-policy-findings.txt")
        findings.writeText(
            "Zenium Android agent dialog policy checks (API ${Build.VERSION.SDK_INT}, " +
                "${width}x$height, density $density, $THEME)\n\n"
        )
        finding("demo server: ${server.selfCheck()}; frame server: ${frameServer.selfCheck()}")
        awaitLoaded(DEMO, "$ORIGIN/")
        SystemClock.sleep(2_000)
        finding("reports tapped at the chrome's __zenHost.viewEvent: ${tapReports()}")
        finding("start: ${describeActive()}")
    }

    override fun demo() {
        still("start")
        shownTabKeepsItsSheet()
        shownTabKeepsItsLeaveQuestion()
        hiddenTabAnsweredFromThePolicy()
        hiddenTabStaysOnThePolicysWord()
        hiddenTabTakesTheDefaults()
        shownAgainTheSheetIsBack()
        still("end")
        finding("\nend: ${describeActive()}; ${reports().length()} reports in all")
        finding(if (failures == 0) "ALL CHECKS PASSED" else "$failures CHECK(S) FAILED")
    }

    // --- the scenes ------------------------------------------------------------------------------

    /** 1. The tab in front keeps its sheet, the policy and even the agent's word standing. */
    private fun shownTabKeepsItsSheet() {
        finding("\n1. The tab in front: confirm() raises the sheet as always, policy or not")
        setAgentDriven(true)
        setPolicy(fullPolicy())
        expect(
            "the view holds the policy and the agent's word",
            viewPolicy() != null && viewDriven()
        )
        val before = reports().length()
        val sheet = raise("#confirm", SAYS)
        expect("the sheet rises for the shown tab's confirm(), titled '$SAYS'", sheet != null)
        if (sheet == null) return
        expect(
            "Cancel | OK as the footer's peers",
            sheet.peer(CANCEL) != null && sheet.peer("OK") != null
        )
        still("shown-sheet")
        answer(sheet, CANCEL)
        expect(
            "confirm() returned the user's false, not the policy's accept",
            awaitLog { it.getInt("confirms") == 1 && !it.optBoolean("confirm", true) }
        )
        expect(
            "no report was made for it (${reports().length()} on record)",
            reports().length() == before
        )
    }

    /** 2. The tab in front asks "Reload site?" as always; Cancel keeps the page; no report. */
    private fun shownTabKeepsItsLeaveQuestion() {
        finding("\n2. The tab in front, armed: a reload asks 'Reload site?' as always")
        // The core's word for a tab in front is that no agent drives it (a page an agent drives
        // leaves silently, UnloadObjection); the policy stands as it would, and governs nothing.
        setAgentDriven(false)
        expect(
            "the view holds the policy, the agent's word withdrawn",
            viewPolicy() != null && !viewDriven()
        )
        val before = reports().length()
        // A real touch: the WebView raises the question only for a document with an activation.
        tapPage("#arm")
        expect("the page's handler is armed", awaitLog { it.optBoolean("armed") })
        fireCore("tab.reload", JSONObject().put("tabId", DEMO).toString())
        val sheet = awaitSheet(RELOAD)
        expect(
            "the sheet rises: '$RELOAD' with Chrome's line",
            sheet != null && sheet.text(LEAVE_LINE) != null
        )
        if (sheet == null) return
        still("shown-reload-sheet")
        answer(sheet, CANCEL)
        SystemClock.sleep(1_500)
        expect(
            "the page stays, its handler armed: ${pageUrl()}",
            pageUrl() == "$ORIGIN/" && pageLog().optBoolean("armed")
        )
        expect(
            "no report was made for it (${reports().length()} on record)",
            reports().length() == before
        )
    }

    /** 3. Hidden and agent-driven: confirm, prompt and alert answered from the policy, reported. */
    private fun hiddenTabAnsweredFromThePolicy() {
        finding("\n3. The tab hidden behind the other, the agent driving it: the policy answers")
        SystemClock.sleep(1_500)
        val switched = switchTo(OTHER, +1, "the pill swipe to the other tab")
        expect("the other tab is active", switched)
        if (!switched) return
        // The agent's word comes after the hide, as the core's does at the agent's next action.
        SystemClock.sleep(1_500)
        setAgentDriven(true)
        setPolicy(fullPolicy())
        expect(
            "the hidden view holds the policy and the agent's word",
            viewPolicy() != null && viewDriven()
        )
        val before = reports().length()
        still("hidden-other-tab")

        val confirmed = clickAndWatch("#confirm")
        expect(
            "confirm() returned at once (${confirmed.took} ms), no sheet over the other tab",
            confirmed.returned && confirmed.sheets == 0
        )
        expect("and returned the policy's true", pageLog().optBoolean("confirm", false))
        val confirmReport = report(before)
        expect(
            "reported: $confirmReport",
            confirmReport.matches("confirm", "accept", "tab", "Delete the draft?")
        )

        val prompted = clickAndWatch("#prompt")
        expect(
            "prompt() returned at once (${prompted.took} ms), no sheet",
            prompted.returned && prompted.sheets == 0
        )
        expect(
            "and returned the policy's text 'Zenium': ${pageLog().opt("prompt")}",
            pageLog().optString("prompt") == "Zenium"
        )
        val promptReport = report(before + 1)
        expect(
            "reported with the policy's text, the field's default beside it: $promptReport",
            promptReport.matches("prompt", ZENIUM_TEXT, "session", "What is your name?") &&
                promptReport?.optString("defaultValue") == "Ada"
        )

        val alerted = clickAndWatch("#alert")
        expect(
            "alert() returned at once (${alerted.took} ms), no sheet",
            alerted.returned && alerted.sheets == 0
        )
        val alertReport = report(before + 2)
        expect(
            "reported under the tab's rules, the strictest standing: $alertReport",
            alertReport.matches("alert", "accept", "tab", "Hello from the page.")
        )
        expect(
            "three reports for three dialogs, all for the demo tab",
            reports().length() == before + 3 && reportsFor(DEMO) == reports().length()
        )
        expect(
            "the other tab stays active, nothing drawn over it",
            activeTabId() == OTHER && appWindows() == 1
        )
        still("hidden-answered")
    }

    /** 4. The hidden armed page objects to a reload: the policy's stay, reported. */
    private fun hiddenTabStaysOnThePolicysWord() {
        finding("\n4. A reload of the hidden armed page: the policy says stay; the page stays")
        expect("the page's handler is still armed", pageLog().optBoolean("armed"))
        val before = reports().length()
        fireCore("tab.reload", JSONObject().put("tabId", DEMO).toString())
        val seen = sheetsSeenFor(3_000)
        expect("no sheet comes over the other tab ($seen seen)", seen == 0)
        expect(
            "the page stays as it was: ${pageUrl()}, its handler armed",
            pageUrl() == "$ORIGIN/" && pageLog().optBoolean("armed")
        )
        val stayReport = report(before)
        expect(
            "reported with Chrome's line: $stayReport",
            stayReport.matches("beforeunload", "stay", "tab", LEAVE_LINE)
        )
        still("hidden-stayed")
    }

    /** 5. The policy cleared: the defaults answer and say so; the reload leaves. */
    private fun hiddenTabTakesTheDefaults() {
        finding("\n5. The policy cleared, the agent still driving: the defaults answer and say so")
        setPolicy(null)
        expect(
            "the view holds no policy, the agent's word still",
            viewPolicy() == null && viewDriven()
        )
        val before = reports().length()

        val confirmed = clickAndWatch("#confirm")
        expect("confirm() returned at once, no sheet", confirmed.returned && confirmed.sheets == 0)
        expect("and returned the default, false", !pageLog().optBoolean("confirm", true))
        val confirmReport = report(before)
        expect(
            "reported under default: $confirmReport",
            confirmReport.matches("confirm", "dismiss", "default", "Delete the draft?")
        )

        val prompted = clickAndWatch("#prompt")
        expect("prompt() returned at once, no sheet", prompted.returned && prompted.sheets == 0)
        expect(
            "and returned the default, null: ${pageLog().opt("prompt")}",
            pageLog().isNull("prompt")
        )
        val promptReport = report(before + 1)
        expect(
            "reported under default: $promptReport",
            promptReport.matches("prompt", "dismiss", "default", "What is your name?")
        )

        val alerted = clickAndWatch("#alert")
        expect("alert() returned at once, no sheet", alerted.returned && alerted.sheets == 0)
        val alertReport = report(before + 2)
        expect(
            "reported under default: $alertReport",
            alertReport.matches("alert", "accept", "default", "Hello from the page.")
        )

        fireCore("tab.reload", JSONObject().put("tabId", DEMO).toString())
        val seen = sheetsSeenFor(3_000)
        expect("the reload meets no sheet ($seen seen)", seen == 0)
        expect(
            "the page left, by default: a fresh document, nothing armed",
            awaitLog { !it.optBoolean("armed") && it.getInt("confirms") == 0 }
        )
        val leaveReport = report(before + 3)
        expect(
            "reported as leave under default: $leaveReport",
            leaveReport.matches("beforeunload", "leave", "default", LEAVE_LINE)
        )
        expect(
            "the other tab stays active, nothing drawn over it",
            activeTabId() == OTHER && appWindows() == 1
        )
        still("hidden-defaults")
    }

    /** 6. Shown again, the agent's word is over and the sheet is back. */
    private fun shownAgainTheSheetIsBack() {
        finding("\n6. The swipe back: the show ends the agent's word; the sheet is back")
        val before = reports().length()
        val switched = switchTo(DEMO, -1, "the pill swipe back to the demo tab")
        expect("the swipe back makes the demo tab active", switched)
        SystemClock.sleep(1_500)
        expect("the show cleared the agent's word on the tab", !viewDriven())
        val sheet = raise("#confirm", SAYS)
        expect("the sheet rises for confirm() again", sheet != null)
        if (sheet == null) return
        still("shown-again-sheet")
        answer(sheet, CANCEL)
        expect(
            "confirm() returned the user's false",
            awaitLog { it.getInt("confirms") == 1 && !it.optBoolean("confirm", true) }
        )
        expect("no report joined the $before", reports().length() == before)
    }

    // --- the agent's words to the view, as the core sends them -----------------------------------

    /** One `{ method, args }` to the host through the bridge's own `post`, as the core's goes. */
    private fun bridgePost(method: String, args: JSONObject) {
        val envelope = json("method" to method, "args" to args).toString()
        chromeJs("window.__zenNative.post(${JSONObject.quote(envelope)});''")
    }

    private fun setAgentDriven(driven: Boolean) {
        bridgePost("view.setAgentDriven", json("tabId" to DEMO, "driven" to driven))
        awaitUntil(LOOKUP_WAIT) { viewDriven() == driven }
    }

    /** `view.setDialogPolicy` with `policy`, or `null` for the core's "no rule covers the tab". */
    private fun setPolicy(policy: JSONObject?) {
        bridgePost("view.setDialogPolicy", json("tabId" to DEMO, "policy" to policy))
        awaitUntil(LOOKUP_WAIT) { (viewPolicy() != null) == (policy != null) }
    }

    private fun viewDriven(): Boolean = onMain { host.tabs.get(DEMO)?.agentDriven == true }

    private fun viewPolicy(): DialogPolicyAnswer.Policy? =
        onMain { host.tabs.get(DEMO)?.dialogPolicy }

    /**
     * The policy of scenes 1 to 4, as the core resolves one (`AgentDialogPolicy`): the tab's own
     * rule for confirm and beforeunload, the session's for prompt.
     */
    private fun fullPolicy(): JSONObject = json(
        "confirm" to json("answer" to "accept", "rule" to "tab"),
        "prompt" to json("answer" to json("text" to "Zenium"), "rule" to "session"),
        "beforeunload" to json("answer" to "stay", "rule" to "tab")
    )

    // --- the reports, where the core receives them -----------------------------------------------

    /**
     * Wrap the chrome's `__zenHost.viewEvent` once: a `pageDialogAnswered` payload is kept in
     * `window.__dialogReports` on its way to the core. The chrome's answer, for the findings.
     */
    private fun tapReports(): String = chromeJs(
        "(function(){var h=window.__zenHost;if(!h)return 'no __zenHost';" +
            "if(h.__dialogTap)return 'already';var orig=h.viewEvent;window.__dialogReports=[];" +
            "h.viewEvent=function(tabId,name,payload){if(name==='pageDialogAnswered'){" +
            "var entry={tabId:tabId};try{entry.report=JSON.parse(payload)}" +
            "catch(e){entry.bad=String(payload)}window.__dialogReports.push(entry)}" +
            "return orig.apply(h,arguments)};h.__dialogTap=true;return 'ok'})()"
    )

    /** Every report kept so far, in order. */
    private fun reports(): JSONArray =
        runCatching { JSONArray(jsString("JSON.stringify(window.__dialogReports||[])")) }
            .getOrDefault(JSONArray())

    private fun reportsFor(tabId: String): Int {
        val all = reports()
        return (0 until all.length()).count { all.getJSONObject(it).optString("tabId") == tabId }
    }

    /** The `index`th report's payload once it has arrived, or null. */
    private fun report(index: Int): JSONObject? {
        awaitUntil(LOOKUP_WAIT) { reports().length() > index }
        return reports().optJSONObject(index)?.optJSONObject("report")
    }

    /** Whether a report names `kind`, `answer` (its JSON text), `rule`, `message` and the page. */
    private fun JSONObject?.matches(
        kind: String,
        answer: String,
        rule: String,
        message: String
    ): Boolean {
        this ?: return false
        val said = opt("answer")
        val saidText = if (said is JSONObject) said.toString() else said?.toString()
        return optString("kind") == kind && saidText == answer && optString("rule") == rule &&
            optString("message") == message && optString("url") == "$ORIGIN/"
    }

    // --- the hidden page's calls -----------------------------------------------------------------

    private class PageCall(val returned: Boolean, val took: Long, val sheets: Int)

    /**
     * Press the hidden page's `selector` from its own script (`click()`: the handler's call
     * blocks the page until it is answered) and watch the app's windows while the call is out:
     * whether the call was made and returned within [LOOKUP_WAIT] (the page's own count of it
     * one up), how long it took, how many sheets came up. The view's `evaluate` takes one
     * expression, so the press is a function call; a script that failed is noted.
     */
    private fun clickAndWatch(selector: String): PageCall {
        val before = pageLog()
        val count = when (selector) {
            "#confirm" -> "confirms"
            "#prompt" -> "prompts"
            else -> "alerts"
        }
        val started = SystemClock.uptimeMillis()
        val latch = CountDownLatch(1)
        var value: String? = null
        val press = "(function(){document.querySelector(${JSONObject.quote(selector)}).click();" +
            "return ''})()"
        instrumentation.runOnMainSync {
            val tab = host.tabs.get(DEMO)
            if (tab == null) {
                latch.countDown()
            } else {
                tab.evaluate(press) {
                    value = it
                    latch.countDown()
                }
            }
        }
        var sheets = 0
        var up = appWindows() > 1
        val deadline = started + LOOKUP_WAIT
        var returned = false
        while (SystemClock.uptimeMillis() < deadline) {
            val now = appWindows() > 1
            if (now && !up) sheets++
            up = now
            if (latch.count == 0L) {
                returned = true
                break
            }
            SystemClock.sleep(POLL_MS)
        }
        val took = SystemClock.uptimeMillis() - started
        if (value?.contains("__zenError") == true) finding("  (the page's script failed: $value)")
        val counted = returned && awaitLog { it.getInt(count) == before.getInt(count) + 1 }
        return PageCall(counted, took, sheets)
    }

    // --- the sheet: the dialog's own window in the accessibility tree ----------------------------

    /** A sheet up: the root of its window and its title. */
    private inner class Sheet(val root: AccessibilityNodeInfo, val name: String) {
        fun node(accept: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? =
            walk(root, SHEET_NODES, accept)
        fun text(text: String): AccessibilityNodeInfo? = node { it.text?.toString() == text }
        /** A footer peer by its label: a `TextView` read as a button. */
        fun peer(label: String): AccessibilityNodeInfo? =
            node { it.className == BUTTON && it.text?.toString() == label }
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
    private fun appWindows(): Int = ui.windows.count {
        it.type == AccessibilityWindowInfo.TYPE_APPLICATION &&
            it.root?.packageName?.toString() == app.packageName
    }

    /** Watch for `durationMs`: how many times a sheet (a second window) was seen coming up. */
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
    private fun walk(
        root: AccessibilityNodeInfo,
        limit: Int,
        accept: (AccessibilityNodeInfo) -> Boolean
    ): AccessibilityNodeInfo? {
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
            if (attempt < TOUCH_ATTEMPTS) {
                finding("  (the touch on $selector did not take, attempt $attempt: touching again)")
            }
        }
        return sheet(title)
    }

    /** A touch on the sheet's `label` peer, made again when the sheet still stands. */
    private fun answer(sheet: Sheet, label: String): Boolean {
        for (attempt in 1..TOUCH_ATTEMPTS) {
            val peer = sheet.peer(label) ?: run {
                finding("  (no $label on the sheet)")
                return sheetRoot(sheet.name) == null
            }
            val bounds = steadyBounds(peer) ?: run {
                finding("  (the sheet's $label has gone from the tree)")
                return false
            }
            touch(bounds, "the sheet's $label")
            if (awaitUntil(TOUCH_TOOK_WAIT) { sheetRoot(sheet.name) == null }) return true
            if (attempt < TOUCH_ATTEMPTS) {
                finding("  (the touch on $label did not take, attempt $attempt: touching again)")
            }
        }
        touchFault("the touch on the sheet's $label did not send the sheet away")
        return false
    }

    // --- the page --------------------------------------------------------------------------------

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    /** Evaluate in the demo tab's page (shown or not); the JSON text of the value, or "". */
    private fun pageJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val tab = host.tabs.get(DEMO)
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

    /** The demo page's own address (`location.href`, shown or not); "" when it did not answer. */
    private fun pageUrl(): String =
        runCatching { JSONTokener(pageJs("location.href")).nextValue() as String }.getOrDefault("")

    /** The page's record of its calls (`window.__log`); empty when the page did not answer. */
    private fun pageLog(): JSONObject = runCatching {
        JSONObject(JSONTokener(pageJs("JSON.stringify(window.__log||{})")).nextValue() as String)
    }.getOrDefault(JSONObject())

    /** Whether the page's record comes to satisfy `test` within `timeoutMs`. */
    private fun awaitLog(timeoutMs: Long = LOOKUP_WAIT, test: (JSONObject) -> Boolean): Boolean =
        awaitUntil(timeoutMs) { runCatching { test(pageLog()) }.getOrDefault(false) }

    /** Where the middle of the first element matching `selector` is on screen, or null. */
    private fun pagePoint(selector: String): PointF? {
        val raw = pageJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});" +
                "if(!e)return null;var r=e.getBoundingClientRect();" +
                "return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 }
            ?: return null
        val origin = onMain {
            host.tabs.get(DEMO)?.let { v -> IntArray(2).also(v::getLocationOnScreen) }
        } ?: return null
        return PointF(
            origin[0] + point.getDouble(0).toFloat() * density,
            origin[1] + point.getDouble(1).toFloat() * density
        )
    }

    /** A real touch on the page element matching `selector`; false, and a note, when none. */
    private fun tapPage(selector: String): Boolean {
        val p = pagePoint(selector) ?: run {
            finding("  (nothing matches $selector on the page)")
            return false
        }
        finding("  touch at ${p.x.roundToInt()},${p.y.roundToInt()} on the page's $selector")
        Finger().tap(p.x, p.y)
        return true
    }

    private fun awaitLoaded(tabId: String, url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain {
                host.tabs.get(tabId).let { (it?.url ?: "") to (it?.progress ?: 0) }
            }
            if (current == url && progress == 100) return
            SystemClock.sleep(250)
        }
        finding("  (gave up waiting for $url in $tabId)")
    }

    // --- moves -----------------------------------------------------------------------------------

    /** A real touch on the middle of `box` (screen px), logged: down and up a frame apart. */
    private fun touch(box: Rect, what: String) {
        val point = touchPoint(box) ?: error("$what at $box is out of the touchable window")
        finding("  touch at ${point.x.roundToInt()},${point.y.roundToInt()} on $what")
        val f = Finger()
        f.down(point.x, point.y)
        f.hold(TAP_HOLD_MS)
        f.up()
    }

    /**
     * A real pill swipe to the next (`direction` +1) or the previous (-1) tab, and true once the
     * core names `tabId` active ([PageDialogsDemo]'s swipe: settled the way the emulator needs).
     * A swipe the emulator dropped is noted, and the core's own `tab.activate` switches instead,
     * so the scene can still be read.
     */
    private fun switchTo(tabId: String, direction: Int, what: String): Boolean {
        finding("  $what")
        val f = Finger()
        f.down(if (direction > 0) pill.right - 10f else pill.left + 10f, pillY)
        f.settleIn(-direction * NUDGE, 0f)
        f.moveBy(-direction * (SWIPE_FRACTION * width - NUDGE), 0f, 300)
        f.up()
        if (awaitSwitch(tabId)) return true
        if (appWindows() > 1) return false
        finding("  (the swipe did not take on the emulator: the core's tab.activate switches)")
        fireCore("tab.activate", JSONObject().put("tabId", tabId).toString())
        return awaitSwitch(tabId)
    }

    /** Whether the core names `tabId` active within [SWITCH_WAIT]; asked while no sheet is up. */
    private fun awaitSwitch(tabId: String): Boolean {
        val deadline = SystemClock.uptimeMillis() + SWITCH_WAIT
        while (true) {
            if (appWindows() > 1) return false
            if (runCatching { activeTabId() }.getOrDefault("") == tabId) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
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

    // --- the core's state ------------------------------------------------------------------------

    private fun jsString(code: String): String =
        (JSONTokener(chromeJs(code)).nextValue() as? String).orEmpty()

    /**
     * Run a core command without waiting on its promise: a `tab.reload` whose page objects has
     * the renderer – and the chrome's word with it – waiting in the question the moment after.
     */
    private fun fireCore(name: String, args: String) {
        chromeJs("window.zen.invoke(${JSONObject.quote(name)},$args);''")
    }

    private fun activeTabId(): String = activeCoreTab()?.optString("id").orEmpty()

    private fun describeActive(): String {
        val state = coreState()
        val tab = activeCoreTab(state)
        val tabs = state.getJSONObject("tabs").length()
        return "active ${tab?.optString("id")} ${tab?.optString("url")}, $tabs tabs"
    }

    // --- findings --------------------------------------------------------------------------------

    private fun expect(label: String, ok: Boolean) {
        if (!ok) failures++
        finding("  $label ${if (ok) "PASS" else "FAIL"}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    /** Numbered stills: `dialog-policy-NN-<state>.png`. */
    private fun still(state: String) {
        shots++
        shot("%02d-%s".format(shots, state))
    }

    private companion object {
        private const val PORT = 18138
        private const val FRAME_PORT = PORT + 1
        private const val SITE = "127.0.0.1:$PORT"
        private const val ORIGIN = "http://$SITE"
        private const val DEMO = "tab_demo"
        private const val OTHER = "tab_other"
        /** Chrome's words, as strings.xml's `page_dialog_*` has them: what the sheet is read by. */
        private const val SAYS = "$SITE says"
        private const val RELOAD = "Reload site?"
        private const val LEAVE_LINE = "Changes you made may not be saved."
        private const val CANCEL = "Cancel"
        private const val BUTTON = "android.widget.Button"
        /** A prompt's text answer as the report carries it (`{ text }`), as JSON text. */
        private const val ZENIUM_TEXT = "{\"text\":\"Zenium\"}"
        /** The `theme` argument: `dark`, else light (the shared script's `DEMO_THEME`). */
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
        private const val LOOKUP_WAIT = 8_000L
        private const val POLL_MS = 200L
        private const val TOUCH_ATTEMPTS = 3
        /** The finger's down and up this far apart ([touch]): a frame, so the two queue as one. */
        private const val TAP_HOLD_MS = 16L
        /** How long a touch has to show it took before it is made again. */
        private const val TOUCH_TOOK_WAIT = 2_500L
        /** How long a pill swipe has to end in the core naming the other tab active. */
        private const val SWITCH_WAIT = 3_000L
        /** The swipe's travel as a share of the screen's width: past the track's commit point. */
        private const val SWIPE_FRACTION = 0.40f
        /** The sheet's tree is a few dozen nodes; the activity's is thousands: a walk's reach. */
        private const val SHEET_NODES = 200
        private const val SHALLOW_NODES = 60
    }
}
