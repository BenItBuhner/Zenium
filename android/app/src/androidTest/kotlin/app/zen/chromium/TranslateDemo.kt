package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Drives offline page translation for the `android-translate-demo` workflow. The engine PR has no
 * surface of its own yet, so the driver speaks to the core the way the translate bar will: through
 * `window.zen.invoke` in the chrome WebView. It seeds a profile with two fixture pages served from
 * the workflow runner (Spanish with a `lang` attribute, German without one), lets the auto-offer
 * detect each, translates them (models downloaded on first use, then read from `files/translate/`),
 * checks the page DOM, waits for late content to be translated, reverts, translates a selection,
 * and writes what it measured to `translate-results.json` next to the screenshots.
 */
@RunWith(AndroidJUnit4::class)
class TranslateDemo : DemoHarness("translate-demo-state.json", "services-translate-android", "translate-demo") {
    override val tag = "TranslateDemo"
    private val results = JSONObject()
    private val startedAt = SystemClock.uptimeMillis()
    private var nextId = 1

    @Test
    fun record() = runDemo()

    override fun warmUp() {
        awaitCore()
        awaitLoaded(ES_TAB, "es.html")
        val offered = awaitStatus(ES_TAB, 30_000) { it != "detecting" && it != "idle" }
        results.put("esOffer", offered)
        Log.i(tag, "es offer: $offered")
    }

    override fun demo() {
        // --- Spanish page: lang="es", auto-offer, translate (model download), live content, revert
        shot("01-es-original")
        val esChars = pageInt(ES_TAB, "document.body.innerText.replace(/\\s+/g, ' ').length")
        val es = translate(ES_TAB, esChars)
        results.put("es", es)
        results.put(
            "esChecks",
            JSONObject()
                .put("heading", pageString(ES_TAB, "document.querySelector('h1').textContent"))
                .put("brandKept", pageString(ES_TAB, "document.querySelector('.brand').textContent") == "Biblioteca Abierta")
                .put("linkText", pageString(ES_TAB, "(function(){var a=document.querySelector('a[href=\"#talleres\"]');return a?a.textContent:null})()"))
                .put("preKept", pageString(ES_TAB, "document.querySelector('pre').textContent.split('\\n')[0]")?.startsWith("Horario de verano") == true)
        )
        Log.i(tag, "es checks: ${results.getJSONObject("esChecks")}")
        page(ES_TAB, "window.scrollTo(0, 0)")
        beat()
        shot("02-es-translated")

        val aviso = awaitLateContent()
        results.put("esLateContent", aviso ?: JSONObject.NULL)
        Log.i(tag, "late content: $aviso")
        page(ES_TAB, "document.getElementById('aviso').scrollIntoView({block:'center'})")
        beat()
        shot("03-es-live-content")

        page(ES_TAB, "window.scrollTo(0, 0)")
        invoke("translate.revert", "{tabId:${JSONObject.quote(ES_TAB)}}")
        SystemClock.sleep(800)
        val reverted = pageString(ES_TAB, "document.querySelector('h1').textContent")
        results.put("esRevert", JSONObject().put("heading", reverted).put("status", tabState(ES_TAB)?.optString("status")))
        Log.i(tag, "reverted: $reverted")
        shot("04-es-reverted")

        // --- German page: no lang attribute, detected by fastText; selection first, then the page
        invoke("tab.activate", "{tabId:${JSONObject.quote(DE_TAB)}}")
        awaitLoaded(DE_TAB, "de.html")
        val deOffer = awaitStatus(DE_TAB, 30_000) { it != "detecting" && it != "idle" }
        results.put("deOffer", deOffer)
        Log.i(tag, "de offer (no lang attribute): $deOffer")
        settle()
        shot("05-de-original")

        page(DE_TAB, "(function(){var p=document.querySelectorAll('p')[1];var r=document.createRange();r.selectNodeContents(p);var s=getSelection();s.removeAllRanges();s.addRange(r)})()")
        SystemClock.sleep(400)
        val selectionStart = SystemClock.uptimeMillis()
        val selection = invoke("translate.selection", "{tabId:${JSONObject.quote(DE_TAB)}}", 180_000)
        results.put("pageSelection", JSONObject().put("result", selection).put("ms", SystemClock.uptimeMillis() - selectionStart))
        Log.i(tag, "selection: $selection")
        page(DE_TAB, "getSelection().removeAllRanges()")

        val deChars = pageInt(DE_TAB, "document.body.innerText.replace(/\\s+/g, ' ').length")
        val de = translate(DE_TAB, deChars)
        results.put("de", de)
        results.put("deTable", pageString(DE_TAB, "Array.prototype.map.call(document.querySelectorAll('td'),function(td){return td.textContent}).join(' | ')"))
        page(DE_TAB, "window.scrollTo(0, 0)")
        beat()
        shot("06-de-translated")
        page(DE_TAB, "document.querySelector('table').scrollIntoView({block:'center'})")
        beat()
        shot("07-de-translated-table")

        val given = invoke("translate.selection", "{tabId:${JSONObject.quote(DE_TAB)},text:${JSONObject.quote("Ein Platz, der hundert Jahre halten soll, braucht ein paar Monate mehr Sorgfalt.")}}")
        results.put("selection", given)
        Log.i(tag, "given selection: $given")

        // --- Preferences and installed models, then translate the German page again from disk
        val state = invoke("app.getState")
        results.put("installed", state?.optJSONObject("translate")?.optJSONArray("installed"))
        results.put("languages", state?.optJSONObject("translate")?.optJSONArray("languages")?.length() ?: 0)
        results.put("modelLicense", state?.optJSONObject("translate")?.optString("modelLicense"))
        invoke("tab.reload", "{tabId:${JSONObject.quote(DE_TAB)}}")
        SystemClock.sleep(2_500)
        awaitStatus(DE_TAB, 30_000) { it == "offered" }
        val cachedStart = SystemClock.uptimeMillis()
        invoke("translate.page", "{tabId:${JSONObject.quote(DE_TAB)}}", 180_000)
        val cached = awaitStatus(DE_TAB, 120_000) { it == "translated" || it == "error" }
        results.put("deCached", JSONObject().put("status", cached?.optString("status")).put("ms", SystemClock.uptimeMillis() - cachedStart))
        Log.i(tag, "de again from installed models: ${results.getJSONObject("deCached")}")
        beat()
        shot("08-de-translated-again")

        File(out, "translate-results.json").writeText(results.toString(2))
        Log.i(tag, "results: $results")
    }

    // --- translation with timing --------------------------------------------------------------

    /** `translate.page` on a tab, following the state until it settles; returns the measurements. */
    private fun translate(tabId: String, chars: Int): JSONObject {
        val t0 = SystemClock.uptimeMillis()
        var firstDownload = -1L
        var firstTranslating = -1L
        var lastDownload: JSONObject? = null
        startInvoke("translate.page", "{tabId:${JSONObject.quote(tabId)}}")
        val end = awaitStatus(tabId, 300_000) { status ->
            val now = SystemClock.uptimeMillis()
            if (status == "downloading" && firstDownload < 0) firstDownload = now
            if (status == "translating" && firstTranslating < 0) firstTranslating = now
            status == "translated" || status == "error"
        }.also { last -> lastDownload = last?.optJSONObject("download") }
        val doneAt = SystemClock.uptimeMillis()
        val translateMs = doneAt - (if (firstTranslating > 0) firstTranslating else t0)
        return JSONObject()
            .put("status", end?.optString("status"))
            .put("error", end?.opt("error") ?: JSONObject.NULL)
            .put("units", end?.optJSONObject("progress"))
            .put("downloadMs", if (firstDownload > 0 && firstTranslating > 0) firstTranslating - firstDownload else 0)
            .put("translateMs", translateMs)
            .put("totalMs", doneAt - t0)
            .put("chars", chars)
            .put("charsPerSecond", if (translateMs > 0) chars * 1000L / translateMs else 0)
            .also { Log.i(tag, "translate $tabId: $it (last download ${lastDownload ?: "-"})") }
    }

    /** Poll a tab's translate state (logging changes) until `done(status)` holds. */
    private fun awaitStatus(tabId: String, timeoutMs: Long, done: (String) -> Boolean): JSONObject? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last = ""
        while (SystemClock.uptimeMillis() < deadline) {
            val state = tabState(tabId)
            val status = state?.optString("status") ?: "none"
            val key = "$status ${state?.optJSONObject("download")?.let { "${it.optLong("received")}/${it.optLong("total")}" } ?: ""} " +
                "${state?.optJSONObject("progress")?.let { "${it.optInt("done")}/${it.optInt("total")}" } ?: ""}"
            if (key != last) {
                last = key
                Log.i(tag, "[${SystemClock.uptimeMillis() - startedAt} ms] $tabId: $key source=${state?.opt("source")} target=${state?.opt("target")}")
            }
            if (state != null && done(status)) return state
            SystemClock.sleep(200)
        }
        Log.w(tag, "timed out waiting on $tabId (last $last)")
        return tabState(tabId)
    }

    private fun tabState(tabId: String): JSONObject? =
        await("window.zen.invoke('app.getState').then(function(s){return s.translate.tabs[${JSONObject.quote(tabId)}]||null})", 15_000)

    private fun awaitLateContent(): String? {
        val deadline = SystemClock.uptimeMillis() + 40_000
        while (SystemClock.uptimeMillis() < deadline) {
            val text = pageString(ES_TAB, "(function(){var p=document.getElementById('aviso');return p.hidden?null:p.textContent})()")
            if (text != null && !text.startsWith("Aviso de última hora")) return text
            SystemClock.sleep(400)
        }
        return null
    }

    // --- the chrome's core through window.zen ----------------------------------------------------

    private fun awaitCore() {
        val deadline = SystemClock.uptimeMillis() + 60_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (chrome("typeof window.zen!=='undefined'&&typeof window.zen.invoke==='function'") == "true") return
            SystemClock.sleep(500)
        }
        error("the chrome never exposed window.zen")
    }

    private fun invoke(name: String, args: String = "{}", timeoutMs: Long = 60_000): JSONObject? =
        await("window.zen.invoke(${JSONObject.quote(name)}, $args)", timeoutMs)

    /** Fire a command without waiting for its promise (its progress is followed through the state). */
    private fun startInvoke(name: String, args: String) {
        chrome("window.zen.invoke(${JSONObject.quote(name)}, $args).catch(function(e){console.warn('translate demo: '+(e&&e.message||e))})")
    }

    /**
     * Run a promise-returning expression in the chrome and wait for it to settle. The result lands
     * in a window slot that is polled, since `evaluateJavascript` cannot await.
     */
    private fun await(expression: String, timeoutMs: Long): JSONObject? {
        val id = nextId++
        chrome(
            "(function(){var s=window.__translateDemo=window.__translateDemo||{};" +
                "Promise.resolve().then(function(){return ($expression)}).then(" +
                "function(v){s[$id]={ok:true,value:v===undefined?null:v}}," +
                "function(e){s[$id]={ok:false,error:String(e&&e.message||e)}})})()"
        )
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val raw = chrome("(function(){var s=window.__translateDemo;var r=s&&s[$id];if(r){delete s[$id]}return r||null})()")
            if (raw != null && raw != "null") {
                val settled = JSONObject(raw)
                if (!settled.optBoolean("ok")) error("${expression.take(80)} failed: ${settled.optString("error")}")
                return settled.optJSONObject("value")
            }
            SystemClock.sleep(150)
        }
        error("timed out on ${expression.take(80)}")
    }

    /** Evaluate in the chrome WebView; the answer is the JSON text of the value (`null` when none). */
    private fun chrome(script: String): String? {
        val latch = CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            (activity as MainActivity).host.chrome.evaluateJavascript(script) { value ->
                result = value
                latch.countDown()
            }
        }
        latch.await(15, TimeUnit.SECONDS)
        return result
    }

    // --- the page in a tab ------------------------------------------------------------------------

    private fun page(tabId: String, script: String): String? {
        val latch = CountDownLatch(1)
        var result: String? = null
        instrumentation.runOnMainSync {
            val tab = (activity as MainActivity).host.tabs.get(tabId)
            if (tab == null) {
                latch.countDown()
            } else {
                tab.evaluate(script) { value ->
                    result = value
                    latch.countDown()
                }
            }
        }
        latch.await(15, TimeUnit.SECONDS)
        return result
    }

    private fun pageString(tabId: String, script: String): String? {
        val raw = page(tabId, script) ?: return null
        if (raw == "null") return null
        return runCatching { org.json.JSONTokener(raw).nextValue() as? String }.getOrNull() ?: raw
    }

    private fun pageInt(tabId: String, script: String): Int = page(tabId, script)?.toIntOrNull() ?: 0

    private fun awaitLoaded(tabId: String, urlPart: String) {
        val deadline = SystemClock.uptimeMillis() + 30_000
        while (SystemClock.uptimeMillis() < deadline) {
            var url = ""
            var progress = 0
            instrumentation.runOnMainSync {
                val tab = (activity as MainActivity).host.tabs.get(tabId)
                url = tab?.url ?: ""
                progress = tab?.progress ?: 0
            }
            if (url.contains(urlPart) && progress == 100) {
                Log.i(tag, "loaded $url")
                return
            }
            SystemClock.sleep(250)
        }
        Log.w(tag, "gave up waiting for $urlPart")
    }

    companion object {
        private const val ES_TAB = "tab_es"
        private const val DE_TAB = "tab_de"
    }
}
