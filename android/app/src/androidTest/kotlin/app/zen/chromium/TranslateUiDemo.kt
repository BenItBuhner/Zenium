package app.zen.chromium

import android.graphics.PointF
import android.graphics.Rect
import android.os.SystemClock
import android.util.Log
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The `android-translate-demo` workflow's `ui` sequence: the translation bar in the phone chrome,
 * driven with real touches on the Spanish fixture page. The page is offered on load (the host
 * raises `domReady`; `esOnLoad` records what the tab reached), the bar is asked for from the app
 * menu all the same, put away and raised again from the translate row of the site-information
 * sheet (the pill carries no translate chip on the phone, v2 §9.29: the sheet's row offers), the
 * page is translated from the bar (model download, translating, translated), the original is
 * shown again, the bar's options sheet is opened and its Translate To list aimed at Basque, and
 * Settings > Languages is visited: the Settings tab's `languages` category (#134) with its rows
 * and the picker sheets its action rows open, Basque added to the languages read and the
 * Afrikaans to English model set downloading. What the state machine reported along the way goes
 * to `translate-results.json` next to the screenshots.
 *
 * Every control pressed inside a sheet takes a real finger whose result is asserted (the rule in
 * DemoHarness, the audit after #194): the app menu's rows (the tab's offer becomes the user's; the
 * Settings tab comes up), the options sheet's Translate To (its language list comes in) and Basque
 * (the tab's offer is aimed at Basque, read from the core), the language picker's Basque (the
 * core's preferences list it, then the page's row) and the model picker's Afrikaans to English
 * (the core's downloading list has the pair, then the page's row). A touch that went in and did
 * not do that faults the run; the tree's click stands in only where no touch could go in (a row
 * that never showed bounds on screen), and says so in the log.
 */
@RunWith(AndroidJUnit4::class)
class TranslateUiDemo : TranslateDemoBase("services-translate-android-ui") {
    override val tag = "TranslateUiDemo"

    @Test
    fun record() = runDemo()

    override fun warmUp() {
        awaitCore()
        awaitLoaded(ES_TAB, "es.html")
        // What the page reaches on its own (the host's domReady, CT-08). The menu's row is pressed
        // only once detection has had its say, so that what the row does is its own doing.
        val onLoad = awaitStatus(ES_TAB, 30_000) { it != "detecting" && it != "idle" }
        results.put("esOnLoad", onLoad?.optString("status") ?: "none")
        results.put("esOnLoadAuto", onLoad?.optBoolean("auto") ?: false)
        SystemClock.sleep(1_500)
    }

    override fun demo() {
        val f = Finger()
        val sequenceStart = SystemClock.uptimeMillis()
        shot("01-es-page")

        // --- the bar from the app menu: Menu > Translate Page… ---------------------------------
        // The offer on screen is the auto-offer's (`auto` true). The menu's row asks for it by
        // hand: the finger's result is the tab's offer marked as the user's own – offered, `auto`
        // false, not dismissed – read from the core, never the menu having closed.
        results.put(
            "menuRow",
            pickMenuRow("Translate Page…", "the tab's offer is the user's own (offered, auto false, not dismissed)") {
                tabState(ES_TAB)?.let { s ->
                    s.optString("status") == "offered" && !s.optBoolean("auto") && !s.optBoolean("dismissed")
                } == true
            }
        )
        val offered = awaitStatus(ES_TAB, 60_000) { it == "offered" }
        results.put("offerFromMenu", offered?.optString("status") ?: "none")
        results.put("source", offered?.opt("source") ?: JSONObject.NULL)
        results.put("target", offered?.opt("target") ?: JSONObject.NULL)
        Log.i(tag, "offer from the menu: $offered")
        beat()
        shot("02-es-offer")

        // --- the translate row of the site-information sheet puts the bar away and raises it again
        // (v2 §9.29: the offer is the sheet's row, not a pill chip; the pill's address stop speaks
        // it – "Address, <host>, Translation offered" – and the row keeps the pair on offer) ----
        results.put("addressSpoken", addressSpoken() ?: JSONObject.NULL)
        val hidden = tapTranslateRow(f, "Hide the translation bar")
        val dismissed = awaitTab(ES_TAB, 5_000) { it.optBoolean("dismissed") }
        SystemClock.sleep(1_200)
        results.put("sheetRowHide", hidden != null && dismissed?.optBoolean("dismissed") == true && barUp() == false)
        shot("03-es-bar-hidden")
        val raised = tapTranslateRow(f, "Translate this page")
        val back = awaitTab(ES_TAB, 5_000) { it.optString("status") == "offered" && !it.optBoolean("dismissed") }
        SystemClock.sleep(1_200)
        results.put("sheetRowRaise", raised != null && back?.optBoolean("dismissed") == false && barUp() == true)
        results.put("sheetRow", raised ?: hidden ?: JSONObject.NULL)
        Log.i(tag, "translate row: hid=$hidden (${results.opt("sheetRowHide")}) raised=$raised (${results.opt("sheetRowRaise")})")
        shot("04-es-bar-from-sheet")

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
        // The sheet's fingers: Translate To must bring its list of languages in (Afrikaans leads
        // it; the top level has no language row), and Basque in that list must leave the tab's
        // offer aimed at Basque – the core's word, with the bar's caption then reading the pair.
        tapLabel(f, "Translation options")
        val options = waitFor("Translate To", 8_000) != null
        SystemClock.sleep(1_200)
        shot("08-es-options")
        val listIn = { findByLabel("Afrikaans") != null }
        val translateTo = touchTapLabelExpecting(
            "Translate To",
            "the list of languages to translate into is in (Afrikaans leads it)",
            timeoutMs = 8_000,
            took = listIn
        )
        if (!translateTo && !listIn()) standIn("Translate To") { clickByLabel("Translate To") && waitFor("Afrikaans", 5_000) != null }
        SystemClock.sleep(1_200)
        shot("09-es-translate-to")
        val aimedAtBasque = { tabState(ES_TAB)?.optString("target") == "eu" }
        val basqueTarget = touchTapLabelExpecting(
            "Basque",
            "the tab's offer is aimed at Basque (target eu, the core's word)",
            timeoutMs = 8_000,
            took = aimedAtBasque
        )
        if (!basqueTarget && !aimedAtBasque()) standIn("Basque") { clickByLabel("Basque") && awaitTook(aimedAtBasque, 5_000) }
        waitForGone("Afrikaans", 5_000)
        val caption = waitFor("Spanish to Basque", 5_000) != null
        SystemClock.sleep(800)
        results.put(
            "optionsSheet",
            JSONObject()
                .put("sheet", options)
                .put("translateToList", translateTo)
                .put("basqueTarget", basqueTarget)
                .put("target", tabState(ES_TAB)?.opt("target") ?: JSONObject.NULL)
                .put("caption", caption)
        )
        Log.i(tag, "options sheet: ${results.getJSONObject("optionsSheet")}")
        shot("10-es-target-basque")

        // --- Settings > Languages: the Settings tab's `languages` category (#134, §10.2) ----------
        // The menu's Settings row under a finger: the Settings tab's landing is what it brings up,
        // proven by the chrome document's `data-section` (the tree's Languages row second: on the
        // emulator's software GPU the WebView's tree lists a Settings page seconds after it is on
        // screen, and the nightly's run had every Settings touch "not taking" by the tree alone).
        results.put(
            "settingsRow",
            pickMenuRow("Settings", "the Settings tab is up on its landing") { settingsSectionIs(SETTINGS_LANDING, treeSign = "Languages") }
        )
        SystemClock.sleep(2_500)
        // The landing's Languages category under a finger where the document has it, the section
        // proven by its `data-section` (its Preferred languages heading the tree's word for it:
        // the section leads with that group as CT-41 lays it out, `settings/languages.tsx`, and
        // translate's languages-you-read is derived from it since #328); the tree's click
        // standing in when no finger could go in.
        val section = { settingsSectionIs(LANGUAGES_SECTION, treeSign = "Preferred languages") }
        val opened = touchSettingsRowExpecting("Languages", "the Languages section is up (its Preferred languages heading)", timeoutMs = 8_000, took = section) ||
            section() ||
            standIn("Languages") { clickSettingsRow("Languages") && awaitTook(section, 8_000) }
        results.put("settingsLanguages", JSONObject().put("opened", opened).put("section", section()))
        Log.i(tag, "settings > languages: ${results.getJSONObject("settingsLanguages")}")
        SystemClock.sleep(1_200)
        shot("11-settings-languages")
        val models = revealSettingsRow("Translation models")
        results.put("settingsModels", models != null)
        SystemClock.sleep(1_200)
        shot("12-settings-models")

        // --- the picker sheets the action rows open (§9.13): a language to add, a model to get ---
        // The action rows are Settings-page rows (a finger where the document has them; the
        // tree's click when they never show bounds). The sheets they open take the rule's
        // fingers: Basque in the language list must join the languages read – the core's
        // preferences, then the page's row – and Afrikaans to English in the model list must set
        // its download going – the core's downloading list, then the page's row saying so. A
        // sheet is up by the document (`[data-sheet-layer] [role=dialog]` named by its title,
        // [sheetPresented]), the tree's node second.
        // Preferred languages' Add language row opens the §9.13 picker sheet with its filter field
        // ("Find a language") pinned over the list – the field is what tells the sheet is up. Its
        // rows read the language's name and, under it, the native name (`Basque` / `euskara`):
        // the document finds the row by its label, the tree by the prefix.
        val addSheet = { sheetPresented("Add language", prefix = true) || findByLabel("Find a language") != null }
        val addOpened = touchSettingsRowExpecting("Add language", "the Add language picker sheet is up (its Find a language field)", timeoutMs = 8_000, took = addSheet) ||
            addSheet() ||
            standIn("Add language") { clickSettingsRow("Add language") && awaitTook(addSheet, 8_000) }
        SystemClock.sleep(1_200)
        shot("13-settings-add-language")
        val readsBasque = { "eu" in preferred() }
        revealPrefix("Basque")
        val basqueRead = touchSettingsRowExpecting(
            "Basque",
            "Basque is among the languages read (the core's preferences, derived from the preferred languages)",
            timeoutMs = 8_000,
            took = readsBasque
        )
        if (!basqueRead && !readsBasque()) standIn("Basque") { (clickSettingsRow("Basque") || clickByLabel("Basque")) && awaitTook(readsBasque, 5_000) }
        val addClosed = awaitSheetGone("Add language", 5_000, prefix = true) && waitForGone("Find a language", 3_000)
        val basqueRow = awaitSettingsRow("Basque", 8_000) || waitFor("Basque", 3_000) != null
        results.put(
            "addLanguageSheet",
            JSONObject()
                .put("opened", addOpened)
                .put("sheet", addSheet() || addClosed)
                .put("basqueRead", basqueRead)
                .put("preferred", JSONArray(preferred()))
                .put("row", basqueRow)
        )
        Log.i(tag, "add a language: ${results.getJSONObject("addLanguageSheet")}")
        SystemClock.sleep(1_000)
        shot("14-settings-language-added")

        // The Download a model row (its label and description run together in the tree: matched
        // by the label's prefix there); its sheet lists the registry's pairs as rows, Afrikaans
        // to English leading.
        val modelSheet = { sheetPresented("Download a model") || settingsRowListed("Afrikaans to English") || findNode { it.startsWith("Afrikaans to English") } != null }
        val downloadOpened = touchSettingsRowExpecting(
            "Download a model",
            "the Download a model sheet is up (Afrikaans to English leads it)",
            timeoutMs = 8_000,
            took = modelSheet
        ) || modelSheet() || standIn("Download a model") { (clickSettingsRow("Download a model") || clickByPrefix("Download a model")) && awaitTook(modelSheet, 10_000) }
        SystemClock.sleep(1_200)
        shot("15-settings-download-model")
        val afEnListed = { modelListed("af", "en") }
        val downloadStarted = touchSettingsRowExpecting(
            "Afrikaans to English",
            "the Afrikaans to English model is on its way (the core's downloading list)",
            timeoutMs = 8_000,
            took = afEnListed
        )
        if (!downloadStarted && !afEnListed()) standIn("Afrikaans to English") { (clickSettingsRow("Afrikaans to English") || clickByPrefix("Afrikaans to English")) && awaitTook(afEnListed, 5_000) }
        val downloadClosed = awaitSheetGone("Download a model", 5_000)
        val arrivingRow = awaitSettingsRow("Afrikaans to English", 8_000) || waitForPrefix("Afrikaans to English", 3_000)
        results.put(
            "downloadModelSheet",
            JSONObject()
                .put("opened", downloadOpened)
                .put("sheet", downloadClosed)
                .put("afrikaansToEnglish", downloadStarted)
                .put("row", arrivingRow)
        )
        Log.i(tag, "download a model: ${results.getJSONObject("downloadModelSheet")}")
        SystemClock.sleep(1_000)
        shot("16-settings-model-arriving")

        val state = translateState()
        results.put("installed", state?.optJSONArray("installed"))
        results.put("downloading", state?.optJSONArray("downloading"))
        results.put("sequenceMs", SystemClock.uptimeMillis() - sequenceStart)
        File(out, "translate-results.json").writeText(results.toString(2))
        Log.i(tag, "results: $results")
    }

    // --- the sheets' controls under a finger -----------------------------------------------------

    /**
     * The app menu's row `label` under a finger (the rule in DemoHarness, the menu flow's
     * injected touch): the menu is opened, pulled to its full height and the row scrolled into
     * view and touched once its bounds hold still ([openMenuItem]); then `took` – what the row
     * does, named by `effect` – must hold within `timeoutMs`, else the run has a touch fault. The
     * tree's click stands in only when no finger could go in (the row never showed bounds on
     * screen), and the log says so. True when `took` holds at the end.
     */
    private fun pickMenuRow(label: String, effect: String, timeoutMs: Long = 10_000, took: () -> Boolean): Boolean {
        val touched = openMenuItem(label)
        if (!touched) {
            Log.w(tag, "no finger went in on the menu's '$label'; the tree's click stands in")
            if (!clickByLabel(label)) {
                Log.w(tag, "the menu has no '$label'")
                back()
                return false
            }
        }
        if (awaitTook(took, timeoutMs)) {
            Log.i(tag, "the ${if (touched) "touch" else "click"} on the menu's '$label' took: $effect")
            return true
        }
        if (touched) touchFault("a touch on the menu's '$label' did not take: not $effect within $timeoutMs ms")
        else Log.w(tag, "the click on the menu's '$label' did not take: not $effect within $timeoutMs ms")
        return false
    }

    /**
     * The accessibility tree's click in place of a finger that could not go in on `label`, so the
     * recording goes on; a touch that went in and did not take has faulted the run already
     * ([touchTapLabelExpecting]), whatever `standIn` does after it.
     */
    private fun standIn(label: String, click: () -> Boolean): Boolean {
        Log.w(tag, "the tree's click stands in for '$label'")
        val done = click()
        if (!done) Log.w(tag, "the tree's click on '$label' did not carry the step either")
        return done
    }

    /** Poll `took` for up to `timeoutMs`. */
    private fun awaitTook(took: () -> Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (took()) return true
            SystemClock.sleep(200)
        }
        return took()
    }

    /**
     * Scroll the first node whose text starts with `prefix` into view (a Settings row with a
     * description reads label and description as one text), like [reveal] does for a label.
     */
    private fun revealPrefix(prefix: String) {
        val node = findNode { it.startsWith(prefix) } ?: run {
            Log.w(tag, "nothing reads '$prefix…'")
            return
        }
        node.performAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SHOW_ON_SCREEN.id)
        SystemClock.sleep(1_500)
    }

    /**
     * Click the nearest clickable ancestor of the first node whose text starts with `prefix` (the
     * tree's stand-in for a row a finger could not reach, see [standIn]).
     */
    private fun clickByPrefix(prefix: String): Boolean {
        revealPrefix(prefix)
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

    // --- the core's word ---------------------------------------------------------------------------

    /** The core's translate slice of the UI state (preferences, installed and downloading models). */
    private fun translateState(): JSONObject? =
        await("window.zen.invoke('app.getState').then(function(s){return s.translate})", 15_000)

    /** The languages read, as the core's preferences have them. */
    private fun preferred(): List<String> {
        val codes = translateState()?.optJSONObject("preferences")?.optJSONArray("preferred") ?: return emptyList()
        return (0 until codes.length()).map { codes.optString(it) }
    }

    /** Whether the core lists the `from` → `to` model as downloading or installed. */
    private fun modelListed(from: String, to: String): Boolean {
        val state = translateState() ?: return false
        return listOf("downloading", "installed").any { key ->
            val list = state.optJSONArray(key) ?: return@any false
            (0 until list.length()).any { i ->
                list.optJSONObject(i)?.let { it.optString("from") == from && it.optString("to") == to } == true
            }
        }
    }

    /**
     * A real touch on the translate row of the site-information sheet, once it reads `label` (the
     * label tells whether the touch raises the bar or puts it away). The pill carries no translate
     * chip on the phone (v2 §9.29, OMN-02): the offer is a row at the top of the sheet the pill's
     * site icon opens, named by its label and the pair on offer ("Translate this page, Spanish to
     * English"; `pillChipRows` in components/phone/pillChips.tsx), and the sheet leaves for the
     * bar. The row is found through the tree as every sheet row is, with the sheet's own DOM
     * rectangle as the fallback when the tree has not caught up; the row's full name, or null when
     * nothing to touch was found (the sheet is closed again then).
     */
    private fun tapTranslateRow(f: Finger, label: String): String? {
        openSiteInfo(f)
        val deadline = SystemClock.uptimeMillis() + 8_000
        var node: AccessibilityNodeInfo? = null
        var dom: Pair<PointF, String>? = null
        while (node == null && dom == null && SystemClock.uptimeMillis() < deadline) {
            node = findNode { it.startsWith(label) }
            if (node == null) dom = sheetRow(label)
            if (node == null && dom == null) SystemClock.sleep(200)
        }
        val name = node?.let { (it.contentDescription ?: it.text)?.toString() } ?: dom?.second
        val at = when {
            node != null -> touchPoint(steadyBounds(node) ?: Rect().also { node.getBoundsInScreen(it) })
            dom != null -> dom.first
            else -> null
        }
        if (name == null || at == null) {
            Log.w(tag, "no translate row reading '$label' in the site-information sheet (tree: ${node != null}, DOM: ${dom != null})")
            back()
            SystemClock.sleep(1_000)
            return null
        }
        Log.i(tag, "translate row '$name' at $at (${if (node != null) "in the tree" else "DOM only"})")
        f.tap(at.x, at.y)
        return name
    }

    /** The pill's site icon opens the site-information sheet; the rows settle before a touch. */
    private fun openSiteInfo(f: Finger) {
        val icon = findByLabel(SITE_ICON_LABEL)?.takeIf { it.top > height * 0.6 }
        if (icon != null) f.tap(icon.exactCenterX(), icon.exactCenterY())
        else {
            Log.w(tag, "site icon not in the accessibility tree; tapping the start of the pill")
            f.tap(pill.left + 22 * density, pill.exactCenterY())
        }
        SystemClock.sleep(2_500)
    }

    /** The pill's address stop as TalkBack reads it ("Address, <host>, Translation offered"). */
    private fun addressSpoken(): String? =
        findNode { it.startsWith("Address,") }?.let { (it.contentDescription ?: it.text)?.toString() }

    /** The sheet's row reading `label` as the chrome's DOM has it: its centre on screen and its name. */
    private fun sheetRow(label: String): Pair<PointF, String>? {
        val raw = chrome(
            "(function(){var rows=document.querySelectorAll('[data-testid=\"siteinfo-pill-chips\"] button');" +
                "for(var i=0;i<rows.length;i++){var b=rows[i];var l=b.getAttribute('aria-label')||'';if(l.indexOf(${JSONObject.quote(label)})!==0)continue;" +
                "var r=b.getBoundingClientRect();if(!r.width||!r.height)return null;" +
                "return {x:r.left+r.width/2,y:r.top+r.height/2,dpr:window.devicePixelRatio,label:l}}return null})()"
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

    private companion object {
        /** The pill's site icon: the button that opens the site-information sheet. */
        private const val SITE_ICON_LABEL = "Site information"
    }
}
