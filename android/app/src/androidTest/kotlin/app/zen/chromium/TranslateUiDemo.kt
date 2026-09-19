package app.zen.chromium

import android.graphics.PointF
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The `android-translate-demo` workflow's `ui` sequence: the translation bar in the phone chrome,
 * driven with real touches on the Spanish fixture page. The page is offered on load (the host
 * raises `domReady`; `esOnLoad` records what the tab reached), the bar is asked for from the app
 * menu all the same, put away and raised again from the glyph at the end of the URL pill, the
 * page is translated from the bar (model download, translating, translated), the original is
 * shown again, the bar's options sheet is opened, and Settings > Languages is visited: the
 * Settings tab's `languages` category (#134) with its rows and the picker sheets its action rows
 * open (a language to add, a model to download). What the state machine reported along the way
 * goes to `translate-results.json` next to the screenshots.
 */
@RunWith(AndroidJUnit4::class)
class TranslateUiDemo : TranslateDemoBase("services-translate-android-ui") {
    override val tag = "TranslateUiDemo"

    @Test
    fun record() = runDemo()

    override fun warmUp() {
        awaitCore()
        awaitLoaded(ES_TAB, "es.html")
        results.put("esOnLoad", tabState(ES_TAB)?.optString("status") ?: "none")
        SystemClock.sleep(1_500)
    }

    override fun demo() {
        val f = Finger()
        val sequenceStart = SystemClock.uptimeMillis()
        shot("01-es-page")

        // --- the bar from the app menu: Menu > Translate Page… ---------------------------------
        tapLabel(f, "Menu")
        results.put("menuRow", pickMenuRow("Translate Page…"))
        val offered = awaitStatus(ES_TAB, 60_000) { it == "offered" }
        results.put("offerFromMenu", offered?.optString("status") ?: "none")
        results.put("source", offered?.opt("source") ?: JSONObject.NULL)
        results.put("target", offered?.opt("target") ?: JSONObject.NULL)
        Log.i(tag, "offer from the menu: $offered")
        beat()
        shot("02-es-offer")

        // --- the glyph at the end of the pill puts the bar away and raises it again ------------
        val hidden = tapPillGlyph(f, "Hide the translation bar")
        val dismissed = awaitTab(ES_TAB, 5_000) { it.optBoolean("dismissed") }
        SystemClock.sleep(1_200)
        results.put("pillGlyphHide", hidden && dismissed?.optBoolean("dismissed") == true && barUp() == false)
        shot("03-es-bar-hidden")
        val raised = tapPillGlyph(f, "Translate this page")
        val back = awaitTab(ES_TAB, 5_000) { it.optString("status") == "offered" && !it.optBoolean("dismissed") }
        SystemClock.sleep(1_200)
        results.put("pillGlyphRaise", raised && back?.optBoolean("dismissed") == false && barUp() == true)
        Log.i(tag, "pill glyph: hid=$hidden (${results.opt("pillGlyphHide")}) raised=$raised (${results.opt("pillGlyphRaise")})")
        shot("04-es-bar-from-pill")

        // --- Translate: the model comes down, the page turns English ----------------------------
        val t0 = SystemClock.uptimeMillis()
        var downloadShot = false
        var firstTranslating = -1L
        tapLabel(f, "Translate")
        val end = awaitStatus(ES_TAB, 300_000) { status ->
            if (status == "downloading" && !downloadShot) {
                downloadShot = true
                SystemClock.sleep(700)
                shot("05-es-downloading")
            }
            if (status == "translating" && firstTranslating < 0) firstTranslating = SystemClock.uptimeMillis()
            status == "translated" || status == "error"
        }
        val doneAt = SystemClock.uptimeMillis()
        results.put(
            "translate",
            JSONObject()
                .put("status", end?.optString("status"))
                .put("error", end?.opt("error") ?: JSONObject.NULL)
                .put("units", end?.optJSONObject("progress"))
                .put("downloadShot", downloadShot)
                .put("totalMs", doneAt - t0)
                .put("translateMs", if (firstTranslating > 0) doneAt - firstTranslating else 0)
                .put("heading", pageString(ES_TAB, "document.querySelector('h1').textContent"))
        )
        Log.i(tag, "translated from the bar: ${results.getJSONObject("translate")}")
        page(ES_TAB, "window.scrollTo(0, 0)")
        beat()
        shot("06-es-translated")

        // --- Original: the page as it was, the offer back on the bar -----------------------------
        tapLabel(f, "Original")
        val reverted = awaitStatus(ES_TAB, 30_000) { it != "translated" && it != "translating" }
        SystemClock.sleep(800)
        results.put(
            "original",
            JSONObject()
                .put("status", reverted?.optString("status"))
                .put("heading", pageString(ES_TAB, "document.querySelector('h1').textContent"))
        )
        Log.i(tag, "original: ${results.getJSONObject("original")}")
        shot("07-es-original")

        // --- the bar's options: the languages and the always/never rules, as a sheet ------------
        tapLabel(f, "Translation options")
        val options = waitFor("Translate To", 8_000) != null
        results.put("optionsSheet", options)
        SystemClock.sleep(1_200)
        shot("08-es-options")
        back()
        SystemClock.sleep(1_500)

        // --- Settings > Languages: the Settings tab's `languages` category (#134, §10.2) ----------
        tapLabel(f, "Menu")
        results.put("settingsRow", pickMenuRow("Settings"))
        SystemClock.sleep(2_500)
        // The landing's category rows carry their label and nothing else.
        val chip = waitFor("Languages", 10_000)?.let { reveal("Languages") }
        val opened = if (chip != null) {
            f.tap(chip.exactCenterX(), chip.exactCenterY())
            true
        } else {
            clickByLabel("Languages")
        }
        val languages = waitFor("Languages you read", 8_000) != null
        results.put("settingsLanguages", JSONObject().put("opened", opened).put("section", languages))
        Log.i(tag, "settings > languages: opened=$opened section=$languages")
        SystemClock.sleep(1_200)
        shot("09-settings-languages")
        val models = reveal("Translation models")
        results.put("settingsModels", models != null)
        SystemClock.sleep(1_200)
        shot("10-settings-models")

        // --- the picker sheets the action rows open (§9.13): a language to add, a model to get ---
        // Rows are clicked through the tree (see pickMenuRow); the sheet is known by its title.
        val addOpened = reveal("Add a language") != null && clickByLabel("Add a language")
        val addSheet = waitFor("Add a language you read", 8_000) != null
        results.put("addLanguageSheet", JSONObject().put("opened", addOpened).put("sheet", addSheet))
        Log.i(tag, "add a language: opened=$addOpened sheet=$addSheet")
        SystemClock.sleep(1_200)
        shot("11-settings-add-language")
        back()
        awaitSurface(up = false, timeoutMs = 5_000)
        SystemClock.sleep(800)
        // The row reads its label and description as one text: matched by the label's prefix.
        val downloadOpened = clickByPrefix("Download a model")
        val downloadSheet = waitForPrefix("Afrikaans to English", 10_000)
        results.put("downloadModelSheet", JSONObject().put("opened", downloadOpened).put("sheet", downloadSheet))
        Log.i(tag, "download a model: opened=$downloadOpened sheet=$downloadSheet")
        SystemClock.sleep(1_200)
        shot("12-settings-download-model")
        back()
        awaitSurface(up = false, timeoutMs = 5_000)
        SystemClock.sleep(600)

        val state = invoke("app.getState")
        results.put("installed", state?.optJSONObject("translate")?.optJSONArray("installed"))
        results.put("sequenceMs", SystemClock.uptimeMillis() - sequenceStart)
        File(out, "translate-results.json").writeText(results.toString(2))
        Log.i(tag, "results: $results")
    }

    /**
     * Pick a row of the menu sheet through the accessibility tree once it is up. Rows are clicked,
     * not touched: the bounds the tree reports for content inside the sheet's scrolled list lag
     * behind on the emulator, and a touch at them would land on the scrim and put the sheet away.
     */
    private fun pickMenuRow(label: String): Boolean {
        if (waitFor(label, 8_000) == null) {
            Log.w(tag, "the menu never showed '$label'")
            return false
        }
        reveal(label)
        return clickByLabel(label)
    }

    /**
     * Click the nearest clickable ancestor of the first node whose text starts with `prefix`: a
     * Settings row with a description reads label and description as one text (the Settings tab
     * demo matches its rows the same way).
     */
    private fun clickByPrefix(prefix: String): Boolean {
        val match = findNode { it.startsWith(prefix) } ?: run {
            Log.w(tag, "nothing reads '$prefix…'")
            return false
        }
        match.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
        SystemClock.sleep(800)
        var node: AccessibilityNodeInfo? = findNode { it.startsWith(prefix) }
        while (node != null && !node.isClickable) node = node.parent
        return node?.performAction(AccessibilityNodeInfo.ACTION_CLICK) == true
    }

    /** Poll for a node whose text starts with `prefix`. */
    private fun waitForPrefix(prefix: String, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (findNode { it.startsWith(prefix) } != null) return true
            SystemClock.sleep(200)
        }
        return false
    }

    /**
     * A real touch on the translation glyph at the end of the URL pill, once it says `label` (the
     * label tells whether the tap raises the bar or puts it away). The glyph is located through the
     * chrome's DOM: the WebView's accessibility tree does not always carry the pill's inner buttons
     * (the other demos fall back to a position for the site icon for the same reason), so the tree
     * only stands in when the DOM has nothing to say.
     */
    private fun tapPillGlyph(f: Finger, label: String): Boolean {
        val deadline = SystemClock.uptimeMillis() + 5_000
        var glyph = pillGlyph()
        while ((glyph == null || glyph.second != label) && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(200)
            glyph = pillGlyph()
        }
        val tree = findByLabel(label)
        val at = when {
            glyph != null && glyph.second == label -> glyph.first
            tree != null -> PointF(tree.exactCenterX(), tree.exactCenterY())
            else -> {
                Log.w(tag, "no translation glyph labelled '$label' (the DOM says '${glyph?.second ?: "none"}', the tree nothing)")
                return false
            }
        }
        Log.i(tag, "pill glyph '$label' at $at (${if (tree != null) "in the tree too" else "DOM only"})")
        f.tap(at.x, at.y)
        return true
    }

    /** The pill's translation glyph as the chrome's DOM has it: its centre on screen and its label. */
    private fun pillGlyph(): Pair<PointF, String>? {
        val raw = chrome(
            "(function(){var b=document.querySelector('.zen-phone-bar [data-translate]');if(!b)return null;" +
                "var r=b.getBoundingClientRect();if(!r.width||!r.height)return null;" +
                "return {x:r.left+r.width/2,y:r.top+r.height/2,dpr:window.devicePixelRatio,label:b.getAttribute('aria-label')||''}})()"
        )
        if (raw == null || raw == "null") return null
        val json = runCatching { JSONObject(raw) }.getOrNull() ?: return null
        val origin = IntArray(2)
        instrumentation.runOnMainSync { (activity as MainActivity).host.chrome.getLocationOnScreen(origin) }
        val dpr = json.optDouble("dpr", density.toDouble())
        val at = PointF(
            origin[0] + (json.getDouble("x") * dpr).toFloat(),
            origin[1] + (json.getDouble("y") * dpr).toFloat()
        )
        return at to json.getString("label")
    }

    /** Whether the translate bar is in the chrome's DOM right now (null when the chrome did not answer). */
    private fun barUp(): Boolean? = when (chrome("!!document.querySelector('.zen-translate-bar')")) {
        "true" -> true
        "false" -> false
        else -> null
    }

    /** Poll a tab's whole translate state until `done(state)` holds; the last state when time runs out. */
    private fun awaitTab(tabId: String, timeoutMs: Long, done: (JSONObject) -> Boolean): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val state = tabState(tabId)
            if (state != null && done(state)) return state
            SystemClock.sleep(200)
        }
        return tabState(tabId)
    }
}
