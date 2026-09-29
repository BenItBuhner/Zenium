package app.zen.chromium

import android.content.ClipData
import android.content.ClipboardManager
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.PointF
import android.graphics.Rect
import android.os.Build
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Base64
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
 * Records text fragments on a phone (parity row PUI-40: a `#:~:text=` link scrolls to and
 * highlights the passage; the selection toolbar makes such a link) and writes what it measured
 * to `text-fragment-findings.txt` next to the screenshots (one `PASS` or `FAIL` per check; the
 * test fails at the end when any check did):
 *
 *  - the engine first: whether this WebView follows a text fragment itself (`document.fragmentDirective`),
 *    on a top-level load and on an in-page fragment change, and whether it has the Custom
 *    Highlight API the page script paints through – recorded, so the run's header tells what
 *    the page script had to do;
 *  - a top-level load of the article with `#:~:text=lantern` lands on the passage: the word is
 *    inside the viewport, the page has scrolled, and the passage is painted – read off the
 *    still's pixels under the word (the engine's `::target-text` wash, or the script's `Mark`
 *    colours where the engine leaves text fragments alone, against the article's grey-scale
 *    colours); the directive is out of the URL the page sees, and out of the tab's URL where the
 *    page script did the following (the engine's own keeps it in the address, as Chrome does);
 *  - an in-page fragment change to a text directive: recorded (the spec has it followed on a
 *    navigation alone; this WebView follows it in place too);
 *  - a REAL long press (injected touch) on the word selects it; `Copy link to highlight` is the
 *    last of Zenium's rows – in the bar when it has room, else at the head of the overflow a real
 *    touch on the toolbar's overflow button opens (a real drag reveals a row under the list's
 *    fold) – and a real touch on it puts the link on the clipboard: the article's URL with
 *    `#:~:text=lantern`; the toolbar goes; below Android 13 the chrome says `Link copied`
 *    (Android 13 shows its own chip);
 *  - opening the copied link as another app would (an ACTION_VIEW intent) opens it in a new tab
 *    that lands on the passage, highlighted;
 *  - a word the article uses twice (`harbour`, its second occurrence selected) gets a link with
 *    context (a prefix or a suffix, as Chrome adds one), and opening it lands on the second
 *    occurrence, not the first;
 *  - the followed link and the overflow in dark, for the design record.
 *
 * The pages come from a loopback server inside this process ([DemoServer]). See [DemoHarness]
 * for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class TextFragmentDemo : DemoHarness("text-fragment-demo-state.json", "text-fragment", "text-fragment-demo") {
    override val tag = "TextFragmentDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private var failures = 0
    private val host get() = (activity as MainActivity).host

    @Test
    fun record() {
        server = DemoServer(
            PORT,
            mapOf(
                "/start.html" to DemoServer.page("Text fragments", "<p>The article is a tap away; this page is where the demo starts from.</p>"),
                "/article.html" to ("text/html; charset=utf-8" to article().toByteArray())
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        if (failures > 0) throw AssertionError("$failures text fragment check(s) failed; see text-fragment-findings.txt")
    }

    override fun warmUp() {
        findings = File(out, "text-fragment-findings.txt")
        findings.writeText("Zenium Android text fragment checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        finding("demo server: ${server.selfCheck()}")
        awaitLoaded("$ORIGIN/start.html")
        SystemClock.sleep(1_500)
        engineFacts()
        // The first action mode pays for the floating toolbar's inflation: once, off camera.
        navigate(ARTICLE)
        scrollTo("#word")
        val warm = longPress("#word") { items -> items.any { it.label == "Copy" } }
        finding("warm-up toolbar: ${warm.describe()}")
        clearSelection()
        navigate(START)
    }

    override fun demo() {
        shot("00-start")
        followedLink()
        copyLinkFromToolbar()
        contextLink()
        dark()
        finding("\nend: ${describeActive()}${if (failures == 0) "" else "; $failures FAIL"}")
    }

    // --- the engine ------------------------------------------------------------------------------

    /** What this WebView brings of its own: recorded in the header, so the checks below read right. */
    private fun engineFacts() {
        val agent = jsonString(tabJs("navigator.userAgent"))
        val native = tabJs("'fragmentDirective' in document") == "true"
        val highlights = tabJs("!!(window.CSS&&CSS.highlights&&window.Highlight)") == "true"
        finding("engine: $agent")
        finding("engine: document.fragmentDirective ${if (native) "present – the engine follows text fragments itself" else "absent – the engine leaves text fragments alone; the page script follows them"}")
        finding("engine: CSS Custom Highlight API ${if (highlights) "present – the script paints through ::highlight()" else "absent – the script selects the passage instead"}")
    }

    // --- PUI-40: following a link ----------------------------------------------------------------

    /** A top-level load with `#:~:text=lantern`: the passage in view, painted, the directive out of the URLs. */
    private fun followedLink() {
        finding("\nPUI-40 a link with #:~:text= opened: the page lands on the passage")
        navigate("$ARTICLE#:~:text=lantern")
        awaitFollowed("#word")
        SystemClock.sleep(1_200)
        checkLanded("#word", "the word 'lantern'", still = "01-followed-light")
        val pageUrl = jsonString(tabJs("location.href"))
        val tabUrl = activeCoreTab()?.optString("url").orEmpty()
        val native = tabJs("'fragmentDirective' in document") == "true"
        finding("  the page's location.href: $pageUrl")
        finding("  the tab's URL (the pill): $tabUrl")
        check("the directive is out of the URL the page sees", pageUrl == ARTICLE)
        if (native) {
            // The engine's own following keeps the directive in the address, as Chrome's omnibox does: recorded, not judged.
            finding("  the tab's URL is the engine's own (the directive ${if (tabUrl.contains(":~:")) "kept" else "gone"})")
        } else {
            check("the directive is out of the tab's URL", tabUrl.isNotEmpty() && !tabUrl.contains(":~:"))
        }
        // An in-page fragment change is no navigation: nothing follows it (the spec; Chrome).
        val before = tabJs("window.scrollY").toDoubleOrNull() ?: 0.0
        tabJs("(function(){location.hash='#:~:text=Fog%20rolled';return true})()")
        SystemClock.sleep(1_200)
        val after = tabJs("window.scrollY").toDoubleOrNull() ?: 0.0
        val hash = jsonString(tabJs("location.hash"))
        finding("  in-page fragment change to a text directive: scrollY $before -> $after, location.hash '$hash' (${if (after == before) "not followed, as the spec has it" else "FOLLOWED by the engine"})")
        tabJs("(function(){history.replaceState(null,'',location.pathname);return true})()")
    }

    /**
     * The passage's element is inside the viewport, the page has scrolled, and the passage is
     * painted – judged on the pixels: the frame saved as the still `still` is sampled under the
     * passage's element, and the share of its pixels with a tint (colour channels more than 16 of
     * 255 apart) is the highlight's mark on screen. The engine's `::target-text` wash and the
     * script's `Mark` colours are tints; the article's own colours are 7 apart at most
     * (`#15141a` on `#fbfbfe`; dark, `#fbfbfe` on `#1c1b22`), and the glyphs' anti-aliasing is
     * grey. A fifth of the word tinted is the bar (the wash fills the box around the glyphs).
     */
    private fun checkLanded(selector: String, what: String, still: String) {
        val box = viewportBox(selector)
        val scrollY = tabJs("window.scrollY").toDoubleOrNull() ?: 0.0
        val innerHeight = tabJs("window.innerHeight").toDoubleOrNull() ?: 0.0
        val native = tabJs("'fragmentDirective' in document") == "true"
        val painted = tabJs("!!(window.CSS&&CSS.highlights&&CSS.highlights.has('zen-text-fragment'))") == "true"
        val selected = jsonString(tabJs("String(getSelection())"))
        val frame = screenshot()
        val tint = if (frame != null && box != null) tintShare(frame, box) else null
        if (frame != null) shot(still, frame) else shot(still)
        finding("  scrollY $scrollY, viewport height $innerHeight, $what at ${box?.let { "${it.getDouble(1).toInt()}..${it.getDouble(3).toInt()}" } ?: "UNKNOWN"} of the viewport")
        check("the page scrolled down to the passage", scrollY > 0)
        check("$what is inside the viewport", box != null && box.getDouble(1) >= 0 && box.getDouble(3) <= innerHeight)
        val how = when {
            painted -> "the script's highlight (::highlight(zen-text-fragment), the ::target-text colours)"
            native -> "the engine's own ::target-text"
            selected.isNotEmpty() -> "the passage selected ('$selected'; no Highlight API)"
            else -> "nothing the script knows of"
        }
        finding("  the pixels under $what: ${tint?.let { "%.2f tinted".format(it) } ?: "NOT MEASURED"} – $how")
        check("the passage is highlighted on screen (a fifth of $what's pixels tinted at least)", tint != null && tint >= 0.2)
    }

    /** A frame of the screen (three asks, as the harness's still takes it), or null. */
    private fun screenshot(): Bitmap? {
        repeat(3) { attempt ->
            ui.takeScreenshot()?.let { return it }
            Log.w(tag, "takeScreenshot returned null (attempt ${attempt + 1} of 3)")
            SystemClock.sleep(400)
        }
        return null
    }

    /**
     * The share of the pixels inside `box` (a viewport rectangle in CSS px, put on screen through
     * the shown view's origin and the density) whose colour channels are more than 16 of 255
     * apart – a tint against grey-scale text and background; null when the box is off the frame.
     */
    private fun tintShare(frame: Bitmap, box: JSONArray): Double? {
        val origin = onMain { shownTabView()?.let { v -> IntArray(2).also(v::getLocationOnScreen) } } ?: return null
        val left = (origin[0] + box.getDouble(0) * density).toInt().coerceIn(0, frame.width)
        val top = (origin[1] + box.getDouble(1) * density).toInt().coerceIn(0, frame.height)
        val right = (origin[0] + box.getDouble(2) * density).toInt().coerceIn(0, frame.width)
        val bottom = (origin[1] + box.getDouble(3) * density).toInt().coerceIn(0, frame.height)
        if (right <= left || bottom <= top) return null
        var tinted = 0
        for (y in top until bottom) for (x in left until right) {
            val c = frame.getPixel(x, y)
            val r = Color.red(c)
            val g = Color.green(c)
            val b = Color.blue(c)
            if (maxOf(r, g, b) - minOf(r, g, b) > 16) tinted++
        }
        return tinted.toDouble() / ((right - left) * (bottom - top))
    }

    /** The first element `selector` names, relative to the viewport: `[left, top, right, bottom]` in CSS px, or null. */
    private fun viewportBox(selector: String): JSONArray? {
        val raw = tabJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "var r=e.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom]})()"
        )
        return runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 4 }
    }

    /** Poll until the article is loaded and `selector` has come inside the viewport (the fallback's late look included), up to 12 s. */
    private fun awaitFollowed(selector: String) {
        awaitArticleLoaded()
        val deadline = SystemClock.uptimeMillis() + 12_000
        while (SystemClock.uptimeMillis() < deadline) {
            val box = viewportBox(selector)
            val innerHeight = tabJs("window.innerHeight").toDoubleOrNull() ?: 0.0
            if (box != null && box.getDouble(1) >= 0 && box.getDouble(3) <= innerHeight && innerHeight > 0) return
            SystemClock.sleep(300)
        }
        Log.w(tag, "the passage $selector did not come into view")
    }

    // --- PUI-40: making a link -------------------------------------------------------------------

    /** A real long press, the overflow, a real touch on Copy link to highlight: the link on the clipboard; opened, it lands. */
    private fun copyLinkFromToolbar() {
        finding("\nPUI-40 Copy link to highlight from the selection toolbar")
        navigate(START)
        navigate(ARTICLE)
        scrollTo("#word")
        clearClipboard()
        val items = longPress("#word") { list -> list.any { it.label == "Copy" } }
        val selected = jsonString(tabJs("String(getSelection())"))
        finding("  injected long press on 'lantern': selection '$selected' ${verdict(selected == "lantern")}")
        finding("  toolbar (content descriptions, left to right): ${items.describe()}")
        check("the system's Copy is there", items.orEmpty().any { it.label == "Copy" })
        val point = touchCopyLink(items.orEmpty(), scheme = "light")
        check("the toolbar is gone after the touch", point != null && awaitToolbarGone())
        val clip = awaitClipboard()
        finding("  clipboard: ${clip ?: "EMPTY"}")
        check("the clipboard holds the link to the highlight", clip == "$ARTICLE#:~:text=lantern")
        toastCheck()
        SystemClock.sleep(600)
        shot("03-copied-light")
        if (clip == null) {
            check("the copied link opens on the passage (nothing was copied)", false)
            clearSelection()
            return
        }
        // The link as another app hands it over: a new tab that lands on the passage.
        val known = tabIds()
        openLink(clip)
        val opened = awaitNewTab(known)
        finding("  opened the link: ${opened?.let { "tab ${it.optString("id")} '${it.optString("url")}'" } ?: "NO NEW TAB"}")
        check("the link opens in a new tab", opened != null)
        awaitFollowed("#word")
        SystemClock.sleep(1_200)
        checkLanded("#word", "the word 'lantern'", still = "04-opened-link-light")
        closeExtraTabs(known)
    }

    /**
     * A real touch on Copy link to highlight wherever the toolbar put it – in the bar, or behind
     * the overflow (a real touch on the overflow button; a real drag when the row is under the
     * list's fold) – with a still of the toolbar as it shows the row (`02-toolbar-<scheme>` or
     * `02-overflow-<scheme>`); where the finger landed, or null when the row was not to be found.
     */
    private fun touchCopyLink(items: List<ToolbarItem>, scheme: String?): PointF? {
        val inBar = items.find { it.label == TITLE }
        if (inBar != null) {
            finding("  $TITLE stands in the bar")
            if (scheme != null) shot("02-toolbar-$scheme")
            val point = touchTapPoint(inBar.node)
            finding("  real touch on $TITLE in the bar ${point?.let { "at ${it.x.toInt()},${it.y.toInt()}" } ?: "NOT POSSIBLE"}")
            return point
        }
        val listed = openOverflow(items, still = scheme?.let { "02-overflow-$it" })
        finding("  behind the overflow: ${listed?.joinToString(" | ") ?: "no list"}")
        check("$TITLE is listed behind the overflow", listed?.contains(TITLE) == true)
        val point = touchRowInOverflow(TITLE)
        finding("  real touch on $TITLE behind the overflow ${point?.let { "at ${it.x.toInt()},${it.y.toInt()}" } ?: "NOT POSSIBLE (row missing or under the fold)"}")
        if (point == null) findInWindows { it == "Close overflow" }?.let { touchTapPoint(it) }
        return point
    }

    /**
     * A real touch on the row `label` of the open overflow. When the row is not on screen, or the
     * harness refuses the touch because the row lies under the list's fold, a real finger drags
     * the list up from its lowest visible row to its highest and the touch is tried again (at
     * most three drags). Where the finger landed, or null.
     */
    private fun touchRowInOverflow(label: String): PointF? {
        repeat(4) { attempt ->
            findInWindows { it == label }?.let { node -> touchTapPoint(node)?.let { return it } }
            if (attempt == 3) return null
            val rows = overflowRowBounds() ?: return null
            val x = rows.first().exactCenterX()
            val from = rows.maxOf { it.bottom } - 8f
            val to = rows.minOf { it.top } + 8f
            if (from - to < 40f) return null
            Log.i(tag, "dragging the overflow list up at $x from $from to $to for '$label'")
            Finger().apply {
                down(x, from)
                moveBy(0f, to - from, 400)
                hold(150)
                up()
            }
            SystemClock.sleep(700)
        }
        return null
    }

    /** The bounds of the overflow's visible rows (the close arrow left out), or null when no list is open. */
    private fun overflowRowBounds(): List<Rect>? {
        for (window in ui.windows) {
            val root = window.root ?: continue
            val rows = ArrayList<Rect>()
            var close = false
            val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
            var visited = 0
            while (queue.isNotEmpty() && visited < 3_000) {
                val node = queue.removeFirst()
                visited++
                val label = node.contentDescription?.toString()?.trim().takeUnless { it.isNullOrEmpty() }
                    ?: node.text?.toString()?.trim().orEmpty()
                if (label == "Close overflow") close = true
                else if (label.isNotEmpty() && node.isVisibleToUser) rows += Rect().also { node.getBoundsInScreen(it) }
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
            if (close && rows.isNotEmpty()) return rows
        }
        return null
    }

    /**
     * A word the article uses twice, its second occurrence selected: the link carries context
     * (the generator adds a prefix or a suffix, a word at a time, while an earlier passage
     * matches), and opening it lands on the second occurrence.
     */
    private fun contextLink() {
        finding("\nPUI-40 a repeated word: the link carries context and lands on the right one")
        ensureActive("tab_demo")
        navigate(START)
        navigate(ARTICLE)
        scrollTo("#dup2")
        clearClipboard()
        val items = longPress("#dup2") { list -> list.any { it.label == "Copy" } }
        val selected = jsonString(tabJs("String(getSelection())"))
        finding("  injected long press on the second 'harbour': selection '$selected' ${verdict(selected == "harbour")}")
        val point = touchCopyLink(items.orEmpty(), scheme = null)
        check("the toolbar is gone after the touch", point != null && awaitToolbarGone())
        val clip = awaitClipboard()
        finding("  clipboard: ${clip ?: "EMPTY"}")
        val directive = clip?.substringAfter("#:~:", "").orEmpty()
        check("the link is to the article", clip?.startsWith("$ARTICLE#:~:text=") == true)
        check("the directive carries context (a prefix or a suffix)", directive.contains("-,") || directive.contains(",-"))
        if (clip == null) {
            check("the link with context opens on the second 'harbour' (nothing was copied)", false)
            clearSelection()
            return
        }
        val known = tabIds()
        openLink(clip)
        val opened = awaitNewTab(known)
        check("the link opens in a new tab", opened != null)
        awaitFollowed("#dup2")
        SystemClock.sleep(1_200)
        checkLanded("#dup2", "the second 'harbour'", still = "05-context-link-light")
        val first = viewportBox("#dup1")
        val innerHeight = tabJs("window.innerHeight").toDoubleOrNull() ?: 0.0
        check("the first 'harbour' is out of view", first != null && (first.getDouble(3) < 0 || first.getDouble(1) > innerHeight))
        closeExtraTabs(known)
    }

    /** Below Android 13 the chrome's toast says the link was copied; from 13 the system's own chip does. */
    private fun toastCheck() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            finding("  the copy's word: Android ${Build.VERSION.RELEASE} shows its own clipboard chip; the chrome's toast is not sent (${if (toastSeen("Link copied")) "yet seen" else "not seen"})")
        } else {
            check("the chrome's toast says Link copied", awaitToastSeen("Link copied"))
        }
    }

    // --- the design record -----------------------------------------------------------------------

    /** The followed link and the overflow with the system and the chrome in dark. */
    private fun dark() {
        finding("\ndesign record: dark")
        ensureActive("tab_demo")
        shell("cmd uimode night yes")
        coreInvoke("settings.update", "{\"colorScheme\":\"dark\"}")
        SystemClock.sleep(4_000)
        ensureForeground()
        navigate(START)
        navigate("$ARTICLE#:~:text=lantern")
        awaitFollowed("#word")
        SystemClock.sleep(1_200)
        checkLanded("#word", "the word 'lantern' (dark)", still = "01-followed-dark")
        val items = longPress("#word") { list -> list.any { it.label == "Copy" } }.orEmpty()
        if (items.any { it.label == TITLE }) {
            shot("02-toolbar-dark")
            finding("  dark: $TITLE stands in the bar")
        } else {
            val listed = openOverflow(items, still = "02-overflow-dark")
            check("dark: $TITLE is listed behind the overflow", listed?.contains(TITLE) == true)
            findInWindows { it == "Close overflow" }?.let { touchTapPoint(it) }
            SystemClock.sleep(500)
        }
        clearSelection()
        SystemClock.sleep(800)
        shell("cmd uimode night no")
        coreInvoke("settings.update", "{\"colorScheme\":\"light\"}")
        SystemClock.sleep(2_000)
    }

    // --- the clipboard ---------------------------------------------------------------------------

    /** The primary clip's text as the app sees it (the instrumentation shares the foreground app's process). */
    private fun clipboardText(): String? {
        var text: String? = null
        instrumentation.runOnMainSync {
            val manager = app.getSystemService(ClipboardManager::class.java)
            text = runCatching {
                manager?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(app)?.toString()
            }.getOrNull()
        }
        return text
    }

    /** Poll for a clip that is not the cleared one, up to 8 s; the text, or null. */
    private fun awaitClipboard(timeoutMs: Long = 8_000): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val text = clipboardText()
            if (!text.isNullOrEmpty() && text != CLEARED) return text
            SystemClock.sleep(200)
        }
        return clipboardText()?.takeIf { it != CLEARED }
    }

    /** A clip of the demo's own first, so a stale one cannot pass for the copy. */
    private fun clearClipboard() {
        instrumentation.runOnMainSync {
            app.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("demo", CLEARED))
        }
    }

    // --- the toolbar -----------------------------------------------------------------------------

    private class ToolbarItem(val label: String, val bounds: Rect, val node: AccessibilityNodeInfo)

    private fun List<ToolbarItem>?.describe(): String = this?.joinToString(" | ") { it.label } ?: "MISSING"

    /**
     * The floating toolbar's buttons, left to right: the clickable nodes with a content
     * description in the window that holds the system's Copy. Null while no toolbar is up.
     */
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

    private fun awaitToolbar(timeoutMs: Long = 12_000, ready: (List<ToolbarItem>) -> Boolean): List<ToolbarItem>? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last: List<ToolbarItem>? = null
        while (SystemClock.uptimeMillis() < deadline) {
            toolbarItems()?.let { items ->
                last = items
                if (ready(items)) return items
            }
            SystemClock.sleep(250)
        }
        return last
    }

    private fun awaitToolbarGone(timeoutMs: Long = 6_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (toolbarItems() == null) return true
            SystemClock.sleep(250)
        }
        return false
    }

    /**
     * A real touch on the toolbar's overflow button; the labels of the list behind it, top to
     * bottom (a still of it under `still`, when one is asked), or null when the list never
     * showed. The list is left open for the touch that follows.
     */
    private fun openOverflow(items: List<ToolbarItem>, still: String?): List<String>? {
        val more = items.find { it.label == "More options" } ?: run {
            finding("  the toolbar has no overflow button")
            return null
        }
        touchTapPoint(more.node) ?: return null
        val deadline = SystemClock.uptimeMillis() + 5_000
        var listed: List<String>? = null
        while (SystemClock.uptimeMillis() < deadline && listed.isNullOrEmpty()) {
            SystemClock.sleep(300)
            listed = overflowLabels()
        }
        SystemClock.sleep(700)
        listed = overflowLabels()?.takeIf { it.isNotEmpty() } ?: listed
        if (still != null) shot(still)
        return listed
    }

    /** The labels in the toolbar window while its overflow list is open (told by the close arrow), the arrow left out. */
    private fun overflowLabels(): List<String>? {
        for (window in ui.windows) {
            val root = window.root ?: continue
            val labels = ArrayList<Pair<String, Rect>>()
            val queue = ArrayDeque<AccessibilityNodeInfo>().apply { add(root) }
            var visited = 0
            while (queue.isNotEmpty() && visited < 3_000) {
                val node = queue.removeFirst()
                visited++
                val label = node.contentDescription?.toString()?.trim().takeUnless { it.isNullOrEmpty() }
                    ?: node.text?.toString()?.trim().orEmpty()
                if (label.isNotEmpty() && node.isVisibleToUser) labels += label to Rect().also { node.getBoundsInScreen(it) }
                for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
            }
            if (labels.any { it.first == "Close overflow" }) {
                return labels.filter { it.first != "Close overflow" }.sortedBy { it.second.top }.map { it.first }.distinct()
            }
        }
        return null
    }

    /** A REAL long press (injected touch) on the middle of the first element `selector` names: Blink selects the word, the toolbar comes. */
    private fun longPress(selector: String, ready: (List<ToolbarItem>) -> Boolean): List<ToolbarItem>? {
        val p = pagePoint(selector) ?: run {
            finding("  no $selector on the page")
            return null
        }
        Log.i(tag, "long press at ${p.x},${p.y} on $selector")
        Finger().apply {
            down(p.x, p.y)
            hold(1_200)
            up()
        }
        return awaitToolbar(ready = ready)
    }

    /**
     * A tap on the page's left margin clears the selection and finishes the mode (the tail of the
     * article is off screen wherever a passage is centred, so the tap goes to the paragraphs'
     * padding a fifth of the viewport down – on the page, off the text, and never on the chrome);
     * should the toolbar stay, the selection is dropped from the page instead.
     */
    private fun clearSelection() {
        marginPoint()?.let { Finger().tap(it.x, it.y) }
        if (!awaitToolbarGone(3_000)) {
            tabJs("(function(){getSelection().removeAllRanges();return true})()")
            awaitToolbarGone()
        }
        SystemClock.sleep(800)
    }

    /** A point on the paragraphs' left padding, a fifth of the viewport down from its top, on screen. */
    private fun marginPoint(): PointF? {
        val innerHeight = tabJs("window.innerHeight").toDoubleOrNull()?.takeIf { it > 0 } ?: return null
        val origin = onMain { shownTabView()?.let { v -> IntArray(2).also(v::getLocationOnScreen) } } ?: return null
        return PointF(origin[0] + 12f * density, origin[1] + (innerHeight * 0.2).toFloat() * density)
    }

    // --- the page --------------------------------------------------------------------------------

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun shownTabView(): TabWebView? = host.tabs.all().firstOrNull { it.isShown }

    /** Evaluate in the page on screen; the JSON text of the value ("" when nothing answered). */
    private fun tabJs(code: String): String {
        var result = ""
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            val tab = shownTabView()
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

    private fun jsonString(raw: String): String = runCatching { JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw

    /** Where the middle of the first element matching `selector` is on screen, or null. */
    private fun pagePoint(selector: String): PointF? {
        val raw = tabJs(
            "(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(!e)return null;" +
                "var r=e.getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()"
        )
        val point = runCatching { JSONArray(raw) }.getOrNull()?.takeIf { it.length() == 2 } ?: return null
        val origin = onMain { shownTabView()?.let { v -> IntArray(2).also(v::getLocationOnScreen) } } ?: return null
        return PointF(origin[0] + point.getDouble(0).toFloat() * density, origin[1] + point.getDouble(1).toFloat() * density)
    }

    /** Scroll the first element `selector` names to the middle of the viewport (the word must be on screen for the finger). */
    private fun scrollTo(selector: String) {
        tabJs("(function(){var e=document.querySelector(${JSONObject.quote(selector)});if(e)e.scrollIntoView({block:'center'});return true})()")
        SystemClock.sleep(900)
    }

    /** The active tab to `url` through the core, then loaded (a different document each time the demo asks: a full navigation). */
    private fun navigate(url: String) {
        coreInvoke("tab.navigate", """{"tabId":${JSONObject.quote(activeTabId())},"input":${JSONObject.quote(url)}}""")
        if (url.startsWith(ARTICLE)) awaitArticleLoaded() else awaitLoaded(url)
        SystemClock.sleep(600)
    }

    /** The article is on screen and loaded (its URL as the script leaves it: the directive gone), up to 20 s. */
    private fun awaitArticleLoaded(timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { shownTabView().let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (current.startsWith(ARTICLE) && progress == 100 && tabJs("document.readyState") == "\"complete\"") return
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for the article")
    }

    private fun awaitLoaded(url: String, timeoutMs: Long = 20_000) {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val (current, progress) = onMain { shownTabView().let { (it?.url ?: "") to (it?.progress ?: 0) } }
            if (current == url && progress == 100) return
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $url")
    }

    /**
     * The article: forty short paragraphs, a few screens tall, so a link to a passage near its end
     * has somewhere to scroll to. `lantern` occurs once (the plain link); `harbour` twice, in the
     * fifth and the thirty-fourth paragraph (the link with context); the tail is the tap that
     * clears a selection.
     */
    private fun article(): String {
        val paragraphs = StringBuilder()
        for (i in 1..40) {
            val text = when (i) {
                5 -> "Fog rolled over the <span id=\"dup1\">harbour</span> before dawn, and the bell buoy rang for no one."
                30 -> "Every evening the keeper climbed to the <span id=\"word\">lantern</span> and wound the clockwork by hand."
                34 -> "Boats came back to the <span id=\"dup2\">harbour</span> at dusk with the day's catch and the day's news."
                else -> "Paragraph $i. The keeper wrote the weather in the ledger and read it back at noon, as the rules asked."
            }
            paragraphs.append("<p id=\"p$i\">$text</p>")
        }
        return "<!doctype html><html><head><meta charset=utf-8>" +
            "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>The lighthouse keeper</title>" +
            "<style>body{margin:0;font-family:sans-serif;color:#15141a;background:#fbfbfe;line-height:1.5}" +
            "h1{font-size:28px;padding:40px 24px 12px}p{padding:10px 24px;font-size:20px;margin:0}" +
            "#tail{padding:40px 24px 120px;font-size:18px;color:#5b5b66}" +
            "@media (prefers-color-scheme: dark){body{color:#fbfbfe;background:#1c1b22}#tail{color:#b1b1b9}}</style></head>" +
            "<body><h1>The lighthouse keeper</h1>$paragraphs<p id=\"tail\">Nothing below this line.</p></body></html>"
    }

    // --- the core --------------------------------------------------------------------------------

    private fun activeTabId(): String = activeCoreTab()?.optString("id").orEmpty()

    private fun tabIds(): Set<String> = coreState().getJSONObject("tabs").keys().asSequence().toSet()

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} ${it?.optString("url")}, ${tabIds().size} tabs" }

    /**
     * Poll for a tab that was not among `known` (the link opening its tab), then for its view to be
     * the one on screen (the tab the link opened is the active one; the page checks that follow
     * read the shown view, so they wait for the switch to have happened); that tab, or null.
     */
    private fun awaitNewTab(known: Set<String>, timeoutMs: Long = 12_000): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var opened: JSONObject? = null
        while (opened == null && SystemClock.uptimeMillis() < deadline) {
            val tabs = coreState().getJSONObject("tabs")
            for (id in tabs.keys()) if (id !in known) opened = tabs.getJSONObject(id)
            if (opened == null) SystemClock.sleep(300)
        }
        val id = opened?.optString("id") ?: run {
            Log.w(tag, "no new tab appeared")
            return null
        }
        awaitShown(id)
        return opened
    }

    /** The view of tab `id` is the shown one and the tab the core's active, up to 6 s. */
    private fun awaitShown(id: String) {
        val deadline = SystemClock.uptimeMillis() + 6_000
        while (SystemClock.uptimeMillis() < deadline) {
            val shown = onMain { shownTabView()?.tabId }
            if (shown == id && activeTabId() == id) return
            SystemClock.sleep(250)
        }
        Log.w(tag, "tab $id did not come on screen (shown ${onMain { shownTabView()?.tabId }}, active ${activeTabId()})")
    }

    /** The tabs the link opened are closed again and the demo's own tab shown, so each scene starts alike. */
    private fun closeExtraTabs(known: Set<String>) {
        for (id in tabIds() - known) coreInvoke("tab.close", """{"tabId":${JSONObject.quote(id)},"force":true}""")
        ensureActive("tab_demo")
        SystemClock.sleep(1_000)
    }

    private fun ensureActive(tabId: String) {
        if (activeTabId() != tabId) coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(tabId)}}")
        awaitShown(tabId)
        SystemClock.sleep(500)
    }

    /** A shell command through UiAutomation, as adb would run it (base64 keeps its quoting intact). */
    private fun shell(script: String): String {
        val encoded = Base64.encodeToString(script.toByteArray(), Base64.NO_WRAP)
        val descriptor = ui.executeShellCommand("sh -c echo\${IFS}$encoded|base64\${IFS}-d|sh")
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.bufferedReader().readText() }
    }

    // --- findings --------------------------------------------------------------------------------

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        finding("  $what ${verdict(ok)}")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val PORT = 18154
        private const val ORIGIN = "http://127.0.0.1:$PORT"
        private const val START = "$ORIGIN/start.html"
        private const val ARTICLE = "$ORIGIN/article.html"
        private const val TITLE = TextFragmentLink.TITLE
        /** What the demo puts on the clipboard before a copy, so the copy is told from what was there. */
        private const val CLEARED = "zenium-text-fragment-demo-cleared"
    }
}
