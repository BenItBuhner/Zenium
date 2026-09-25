package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.speech.tts.TextToSpeech
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records read aloud FROM THE SELECTION on the phone (EDGE-12: "Read aloud from the selection
 * toolbar starts playback at the selected text") and writes `read-aloud-selection-findings.txt`
 * next to the stills (one `PASS` or `FAIL` per check; the test fails at the end when any did, or
 * when a touch did not take). A page of three short paragraphs comes from a loopback server in
 * this process ([DemoServer]); the word the finger lands on is in the second.
 *
 *  A. THE WORD (light): a long press on the word in the second paragraph raises the system's
 *     floating toolbar with Zenium's "Listen" (behind the overflow on a phone: `Menus.
 *     selectionActions`, the id `readAloud`); a real touch on it starts a session with
 *     `source: selection` (`readAloud.start { from: 'selection-on' }`); the engine is handed
 *     the selected word ITSELF first (the host's `ZenReadAloud` log, one line per utterance),
 *     the text is the 5 sentences from the word on (the heading and the first paragraph – 3 of
 *     the page's 8 – are NOT in it), the highlight painted into the page sits in the second or
 *     third paragraph and never in the first, and the reading goes on past the word (`playing`
 *     past sentence 0, or ended without an error). The mode's finish collapsed the page's
 *     selection before the core's extraction reached the document and the page script stood the
 *     cleared one in (`selectionMemory.ts`), so the document is left collapsed.
 *  B. THE SENTENCE (light): the long press again, then – the mode still up – the selection
 *     extended by script to the paragraph's second sentence; the touch on Listen hands the
 *     engine that sentence first and the text is the 3 sentences from it on. (A handle drag is
 *     the user's way; the script's extension keeps the driver off the emulator's handle
 *     geometry. Should the mode not survive the extension, that is said and the act is
 *     recorded as not run, not as a failure of the product.)
 *  C. THE WORD (dark): act A again under the dark scheme, for the design record.
 *
 * Without a speech engine (a build's image without one) the host's availability is overridden
 * so the toolbar's item still shows, and the speech checks give way to the player's error state
 * (as `ReadAloudDemo` does). The model behind the player is services' (`ReadAloudService`, the
 * page script's `selectionBlocks`, the sentence walk, the highlight); this driver records the
 * phone's entry and where the reading starts. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class ReadAloudSelectionDemo : DemoHarness("read-aloud-selection-demo-state.json", "read-aloud-selection", "read-aloud-selection-demo") {
    override val tag = "ReadAloudSelectionDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private val host get() = (activity as MainActivity).host
    /** The device has no speech engine: the host's availability is overridden and the speech checks are skipped. */
    private var engineless = false
    private var engineReport = ""

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf("/" to ("text/html; charset=utf-8" to readAsset("read-aloud-selection-demo-page.html").toByteArray()))
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
            ReadAloud.availabilityOverride = null
        }
        if (failures > 0) throw AssertionError("$failures read-aloud-selection check(s) failed; see read-aloud-selection-findings.txt")
    }

    override fun beforeLaunch() {
        engineReport = probeEngine()
        // The capability is read at boot: without an engine the toolbar's item never shows and
        // the entry could not be recorded. The override makes the host say yes; every speak then
        // fails with `error` and the checks expect that state.
        if (engineless) ReadAloud.availabilityOverride = true
    }

    /** The device's engine: a `TextToSpeech` of this process's own, bound and shut down again before the app's binds. */
    private fun probeEngine(): String {
        var tts: TextToSpeech? = null
        var status = TextToSpeech.ERROR
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            tts = TextToSpeech(app) { s ->
                status = s
                latch.countDown()
            }
        }
        val engine = tts ?: return "TextToSpeech could not be constructed"
        val engines = runCatching { engine.engines.map { "${it.name} (${it.label})" } }.getOrDefault(emptyList())
        val bound = latch.await(25, TimeUnit.SECONDS)
        val report = if (!bound || status != TextToSpeech.SUCCESS) {
            engineless = true
            "engines: ${engines.joinToString(", ").ifEmpty { "NONE" }}; bind: ${if (!bound) "no onInit within 25 s" else "onInit status $status"}"
        } else {
            val default = runCatching { engine.defaultEngine }.getOrNull()
            val voice = runCatching { engine.defaultVoice }.getOrNull()
            "engines: ${engines.joinToString(", ")}; bound: default engine $default; default voice ${voice?.name} (${voice?.locale?.toLanguageTag()})"
        }
        instrumentation.runOnMainSync { runCatching { engine.shutdown() } }
        return report
    }

    override fun warmUp() {
        findings = File(out, "read-aloud-selection-findings.txt")
        findings.writeText("Zenium Android read aloud from the selection (EDGE-12) checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        finding("demo server: ${server.selfCheck()}")
        finding("speech engine (before the app booted): $engineReport")
        finding("host: available=${host.readAloud.available}${if (engineless) " (OVERRIDDEN: no engine on this image)" else ""}")
        val caps = coreState().getJSONObject("capabilities")
        finding("capabilities: readAloud=${caps.optBoolean("readAloud")} selectionToolbar=${caps.optBoolean("selectionToolbar")}")
        check("capabilities.readAloud and capabilities.selectionToolbar are on", caps.optBoolean("readAloud") && caps.optBoolean("selectionToolbar"))
        awaitLoaded("$ORIGIN/")
        val sentences = jsonString(pageJs("String(document.querySelectorAll('h1, p').length)"))
        finding("page: ${describeTab()}; blocks on the page: $sentences (the heading and three paragraphs)")
        SystemClock.sleep(1_500)
    }

    override fun demo() {
        shot("00-page")
        beat()
        fromWord("A", "light")
        fromSentence()
        dark()
        fromWord("C", "dark")
        finding("\nend: session=${readAloud()}${if (failures == 0) "" else "; $failures FAIL"}")
    }

    // --- A / C: the word -------------------------------------------------------------------------------

    /**
     * A long press on the word in the second paragraph, the toolbar's Listen under a finger, the
     * reading starting at the word: what EDGE-12 claims. [act] names the act in the findings and
     * the stills; [scheme] the colour scheme the stills are taken under.
     */
    private fun fromWord(act: String, scheme: String) {
        finding("\n$act. EDGE-12 $TOOLBAR_ITEM from the selected WORD ($scheme): the reading starts at the selection")
        frontApp()
        stopReading()
        val items = longPress("#word") { list -> list.any { it.label == TOOLBAR_ITEM || it.label == "More options" } }
        val selected = jsonString(pageJs("String(getSelection())"))
        finding("  long press on the word: selection '$selected'; toolbar: ${items?.joinToString(" | ") { it.label } ?: "MISSING"}")
        check("$act: the long press selects the word 'finger' and the selection toolbar comes up", items != null && selected.trim() == WORD)
        if (items == null) return
        startFromToolbar(act, items, selected.trim(), expectedFirst = WORD, expectedSentences = SENTENCES_FROM_WORD, still = "$act-playing-from-word-$scheme")
    }

    // --- B: the sentence -----------------------------------------------------------------------------

    /**
     * The long press, then the live selection extended by script to the paragraph's second
     * sentence with the mode up (the WebView keeps one mode across selection changes and
     * re-lists the items: `TabWebView.SelectionActionMode`); the touch on Listen hands the engine
     * that sentence first.
     */
    private fun fromSentence() {
        finding("\nB. EDGE-12 $TOOLBAR_ITEM from a selected SENTENCE (the selection extended under the live mode)")
        frontApp()
        stopReading()
        val before = longPress("#word") { list -> list.any { it.label == TOOLBAR_ITEM || it.label == "More options" } }
        if (before == null) {
            check("B: the selection toolbar comes up for the sentence act", false)
            return
        }
        // "Its tail follows the selection." – the paragraph's second sentence, whole.
        val extended = jsonString(
            pageJs(
                "(function(){var t=document.getElementById('two');var n=t.lastChild;var s=n.data.indexOf(${JSONObject.quote(SENTENCE)});" +
                    "if(s<0)return 'no sentence';getSelection().setBaseAndExtent(n,s,n,s+${SENTENCE.length});return String(getSelection())})()"
            )
        )
        SystemClock.sleep(1_500)
        val items = toolbarItems()
        finding("  extended by script: selection '$extended'; toolbar after: ${items?.joinToString(" | ") { it.label } ?: "GONE"}")
        check("B: the script's extension selects the sentence", extended.trim() == SENTENCE)
        if (items == null || items.none { it.label == TOOLBAR_ITEM || it.label == "More options" }) {
            // The mode did not survive the change: the act cannot be run this way on this image.
            // Said as a finding; the product's claim is act A's.
            finding("  the selection mode did not survive the script's extension (toolbar ${if (items == null) "gone" else "without our items"}): act B NOT RUN")
            clearSelection()
            return
        }
        startFromToolbar("B", items, extended.trim(), expectedFirst = SENTENCE, expectedSentences = SENTENCES_FROM_SENTENCE, still = "B-playing-from-sentence-light")
    }

    // --- the start, read three ways ----------------------------------------------------------------

    /**
     * A real touch on the toolbar's Listen (behind the overflow when the bar has no room; the
     * overflow's list is the still `*-selection-item-*`), then what the session reads first:
     * the host's log (the utterance the engine was handed), the model's sentence count (only
     * what follows the selection), the highlight's place in the page, the session's source, and
     * the document left collapsed.
     */
    private fun startFromToolbar(act: String, items: List<ToolbarItem>, selected: String, expectedFirst: String, expectedSentences: Int, still: String) {
        val inBar = items.find { it.label == TOOLBAR_ITEM }
        val logBefore = hostLog().size
        val scheme = still.substringAfterLast('-')
        val point: PointF? = if (inBar != null) {
            shot("$act-selection-item-$scheme")
            touchTapPoint(inBar.node)
        } else {
            val more = items.find { it.label == "More options" }
            val node = if (more != null && touchTapPoint(more.node) != null) awaitInWindows(TOOLBAR_ITEM, 5_000) else null
            if (node != null) {
                SystemClock.sleep(600)
                shot("$act-selection-item-$scheme")
                touchTapPoint(node)
            } else {
                finding("  '$TOOLBAR_ITEM' is not behind the overflow either")
                findInWindows { it == "Close overflow" }?.let { touchTapPoint(it) }
                null
            }
        }
        finding("  real touch on $TOOLBAR_ITEM ${point?.let { "at ${it.x.toInt()},${it.y.toInt()}${if (inBar == null) " (behind the overflow)" else ""}" } ?: "NOT POSSIBLE (item missing)"}")
        val first = if (point == null) null else awaitSample(10_000) { it.optString("source") == "selection" }
        if (point != null && first == null) touchFault("a touch on the toolbar's $TOOLBAR_ITEM started no session from the selection ($act)")
        check("$act: $TOOLBAR_ITEM is on the toolbar and a touch on it starts a session from the selection", first != null)
        if (first == null) {
            clearSelection()
            return
        }
        val up = poll(8_000) { panelUp() }
        // The word is spoken in well under a second and the walk goes on: the session reads
        // `playing` past it, or `ended` without an error when the engine raced the poll.
        val spoke = engineless || first.optString("status") == "playing" ||
            awaitSample(20_000) { it.optString("status") == "playing" || it.optString("status") == "ended" } != null
        val session = readAloud() ?: first
        val error = session.optString("error")
        val handed = hostLog().drop(logBefore).filter { ": FLUSH at " in it || ": ADD at " in it }
            .map { it.substringAfter(" \"").substringBeforeLast('"').trim() }
        val count = session.optInt("sentenceCount")
        val place = highlightPlace()
        val status = session.optString("status")
        finding("  player up=$up; status $status; sentences $count (the page has $SENTENCES_ON_PAGE); sentence ${session.optInt("sentenceIndex")}; error '$error'; source ${session.optString("source")}")
        finding("  the engine was handed: ${handed.joinToString(" | ") { "\"$it\"" }}")
        finding("  the highlight: $place")
        check("$act: the engine is handed the selection itself first ('$expectedFirst')", engineless || handed.firstOrNull() == expectedFirst)
        check("$act: the text is the $expectedSentences sentences from the selection on, not the page's $SENTENCES_ON_PAGE (the heading and the first paragraph are not in it)", count == expectedSentences)
        check("$act: the reading goes on past the selection (playing, or ended without an error)", engineless || (spoke && error.isEmpty()))
        check("$act: the session's source is the selection", session.optString("source") == "selection")
        // The highlight is cleared with the walk's end: a short text the engine raced through
        // before the poll has none to read, and the count above says where it began.
        if (!engineless && status != "ended") {
            check("$act: the sentence highlight is painted in the second or third paragraph, never the first", place.optBoolean("painted") && place.optString("in").let { it == "two" || it == "three" })
        }
        check("$act: the player is up under the page", up)
        SystemClock.sleep(600)
        shot(still)
        val collapsed = poll(3_000) { jsonString(pageJs("String(getSelection().isCollapsed)")) == "true" }
        val selectedNow = jsonString(pageJs("String(getSelection())"))
        finding("  the document's selection after the touch: collapsed=$collapsed, text '$selectedNow'")
        check("$act: the document's selection is left collapsed (no handles stay up)", collapsed && selectedNow.isEmpty())
        beat()
        stopReading()
        clearSelection()
    }

    // --- the scheme --------------------------------------------------------------------------------------

    private fun dark() {
        finding("\ndark scheme for the design record")
        frontApp()
        shell("cmd uimode night yes")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(4_000)
        ensureForeground()
        awaitLoaded("$ORIGIN/")
        shot("C-page-dark")
    }

    // --- the session ---------------------------------------------------------------------------------

    private fun readAloud(): JSONObject? = coreState().optJSONObject("readAloud")

    private fun awaitSample(timeoutMs: Long, condition: (JSONObject) -> Boolean): JSONObject? {
        var hit: JSONObject? = null
        poll(timeoutMs) {
            hit = readAloud()?.takeIf(condition)
            hit != null
        }
        return hit
    }

    private fun stopReading() {
        if (readAloud() == null) return
        coreInvoke("readAloud.stop")
        poll(5_000) { readAloud() == null }
    }

    /** The host's log (`ReadAloud.kt`): one `speak` line per utterance the engine is handed, the text clipped at 40. */
    private fun hostLog(): List<String> = shell("logcat -d -s $HOST_TAG:*").lines().filter { "speak " in it }

    private fun panelUp(): Boolean = findNode { it == PANEL_LABEL } != null || findNode { it == "Previous sentence" } != null

    /**
     * Where the sentence highlight the page script painted sits: the id of the paragraph holding
     * the highlight's first range (`one` / `two` / `three`, `h1` for the heading), its text, and
     * whether anything is painted. `{}` when the page never answered.
     */
    private fun highlightPlace(): JSONObject {
        val raw = pageJs(
            "(function(){var h=window.CSS&&CSS.highlights&&CSS.highlights.get('zenium-read-sentence');" +
                "if(!h)return JSON.stringify({painted:false,api:!!(window.CSS&&CSS.highlights)});" +
                "var r=null;h.forEach(function(x){if(!r)r=x});if(!r)return JSON.stringify({painted:false,empty:true});" +
                "var n=r.startContainer;while(n&&n.nodeType!==1)n=n.parentNode;var p=n&&n.closest?n.closest('h1,p'):null;" +
                "return JSON.stringify({painted:true,in:p?(p.id||p.tagName.toLowerCase()):'?',text:String(r).slice(0,60)})})()"
        )
        return runCatching { JSONObject(jsonString(raw)) }.getOrDefault(JSONObject())
    }

    // --- the selection toolbar (ReadAloudDemo's shapes) ---------------------------------------------

    private class ToolbarItem(val label: String, val bounds: Rect, val node: AccessibilityNodeInfo)

    /** The floating toolbar's buttons, left to right, in the window that holds the system's Copy; null while none is up. */
    private fun toolbarItems(): List<ToolbarItem>? {
        for (window in ui.windows) {
            val root = window.root ?: continue
            val items = ArrayList<ToolbarItem>()
            val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
            var visited = 0
            while (queue.isNotEmpty() && visited < 3_000) {
                val node = queue.removeFirst()
                visited++
                val label = node.contentDescription?.toString()?.trim().orEmpty()
                if (label.isNotEmpty() && node.isClickable && node.isVisibleToUser) {
                    items += ToolbarItem(label, Rect().also { node.getBoundsInScreen(it) }, node)
                }
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
            if (items.any { it.label == "Copy" }) return items.sortedBy { it.bounds.left }
        }
        return null
    }

    /**
     * A real long press on the element `selector` names, up to [gestureTries] times when the
     * software renderer swallows the finger, until the toolbar answers [ready]; the last toolbar
     * seen, or null.
     */
    private fun longPress(selector: String, ready: (List<ToolbarItem>) -> Boolean): List<ToolbarItem>? {
        val tries = gestureTries()
        var last: List<ToolbarItem>? = null
        for (attempt in 1..tries) {
            val p = pagePoint(selector) ?: run {
                check("$selector is on the page for the long press (${describeTab()})", false)
                return null
            }
            Finger().apply {
                down(p.x, p.y)
                hold(1_200)
                up()
            }
            val deadline = SystemClock.uptimeMillis() + 12_000
            while (SystemClock.uptimeMillis() < deadline) {
                toolbarItems()?.let { items ->
                    last = items
                    if (ready(items)) return items
                }
                SystemClock.sleep(250)
            }
            if (attempt < tries) noteLine("  no selection toolbar for the long press on $selector; pressing again (${attempt + 1}/$tries)")
        }
        return last
    }

    /** How many injected fingers one gesture gets before it is a fault: one on a GPU, more on the emulator's software GL. */
    private fun gestureTries(): Int = if (renderer.hardware) 1 else GESTURE_TRIES_SOFTWARE

    private fun awaitInWindows(label: String, timeoutMs: Long): AccessibilityNodeInfo? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            findInWindows { it == label }?.let { return it }
            SystemClock.sleep(200)
        }
        return null
    }

    private fun clearSelection() {
        pagePoint("#tail")?.let { Finger().tap(it.x, it.y) }
        SystemClock.sleep(1_000)
    }

    // --- the page -----------------------------------------------------------------------------------

    /** Evaluate in the demo tab's page; the raw JSON-encoded result ("" when it never answered). */
    private fun pageJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB)
            if (view == null) latch.countDown()
            else view.evaluateJavascript(code) { value ->
                result = value ?: ""
                latch.countDown()
            }
        }
        latch.await(10, TimeUnit.SECONDS)
        return result
    }

    private fun jsonString(raw: String): String = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw

    /** Where the middle of the first element matching `selector` is on screen (device px); null when there is no such element or page. */
    private fun pagePoint(selector: String): PointF? {
        val raw = pageJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "e.scrollIntoView({block:'center'});var r=e.getBoundingClientRect();return JSON.stringify([r.left+r.width/2,r.top+r.height/2])})()"
        )
        val json = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull()
            ?.let { runCatching { JSONArray(it) }.getOrNull() } ?: return null
        var origin: IntArray? = null
        var scale = 0f
        instrumentation.runOnMainSync {
            val view = host.tabs.get(TAB) ?: return@runOnMainSync
            origin = IntArray(2).also { view.getLocationOnScreen(it) }
            @Suppress("DEPRECATION")
            scale = view.scale
        }
        val at = origin ?: return null
        if (scale <= 0f) scale = density
        return PointF((at[0] + json.getDouble(0) * scale).toFloat(), (at[1] + json.getDouble(1) * scale).toFloat())
    }

    private fun tab(): JSONObject? = coreState().getJSONObject("tabs").optJSONObject(TAB)

    private fun describeTab(): String {
        val tab = tab() ?: return "tab $TAB gone"
        return "url=${tab.optString("url")} title=\"${tab.optString("title").take(50)}\" readerable=${tab.optBoolean("readerable")}"
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = tab()
            if (tab != null && tab.optString("url") == url && !tab.optBoolean("loading")) {
                SystemClock.sleep(800)
                return
            }
            SystemClock.sleep(400)
        }
        finding("  the page never finished loading: ${describeTab()}")
    }

    // --- the system ---------------------------------------------------------------------------------

    /** `adb shell` from inside the instrumentation (UiAutomation's shell): the command's output. */
    private fun shell(command: String): String = runCatching {
        val fd = ui.executeShellCommand(command)
        ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().toString(Charsets.UTF_8) }
    }.getOrElse { "shell failed: $it" }

    /** The app in front before a step touches its chrome, whatever the last step left on the screen. */
    private fun frontApp() {
        if (ui.rootInActiveWindow?.packageName?.toString() == app.packageName) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
        SystemClock.sleep(800)
        if (ui.rootInActiveWindow?.packageName?.toString() == app.packageName) return
        shell("am start -W -a android.intent.action.MAIN -f 0x20000000 -n ${app.packageName}/${MainActivity::class.java.name}")
        val front = poll(8_000) { ui.rootInActiveWindow?.packageName?.toString() == app.packageName }
        finding("  the app brought to the front for the step: $front")
        SystemClock.sleep(1_000)
    }

    // --- findings -------------------------------------------------------------------------------------

    private fun poll(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return true
            SystemClock.sleep(200)
        }
        return condition()
    }

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        finding("  ${if (ok) "PASS" else "FAIL"}: $what")
    }

    private fun finding(line: String) {
        Log.i(tag, line)
        findings.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18149
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val TAB = "tab_demo"
        /** Our selection-toolbar item (`Menus.selectionActions`, the id `readAloud`): the menu's verb, beside Google's own "Read aloud". */
        private const val TOOLBAR_ITEM = "Listen"
        /** The player's `role=region` label (`ReadAloudPanel`). */
        private const val PANEL_LABEL = "Read aloud"
        /** The host's log tag (`ReadAloud.kt`): one line per utterance the engine is handed. */
        private const val HOST_TAG = "ZenReadAloud"
        /** The word under the finger (`#word` in the page's second paragraph). */
        private const val WORD = "finger"
        /** The second paragraph's second sentence, the selection act B extends to. */
        private const val SENTENCE = "Its tail follows the selection."
        /** The page's sentences: the heading, three, three, one (`read-aloud-selection-demo-page.html`). */
        private const val SENTENCES_ON_PAGE = 8
        /** From the word: "finger" | "lands." | the two sentences after | the third paragraph. */
        private const val SENTENCES_FROM_WORD = 5
        /** From the sentence: it | the one after | the third paragraph. */
        private const val SENTENCES_FROM_SENTENCE = 3
        /** Injected fingers per gesture on a software renderer before the step is a fault (`ReadAloudDemo`'s rule). */
        private const val GESTURE_TRIES_SOFTWARE = 4
    }
}
