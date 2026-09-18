package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Records the certificate interstitial on the phone: the three badssl.com pages (an expired
 * certificate, a self-signed one and one for another host) each land on the certificate variant
 * of `zen://error`, Advanced reveals the certificate's details and the proceed button, Back to
 * safety returns to the page before, Proceed records the session's exception and loads the page
 * over the broken certificate, whose site information reads not secure with the reason; the
 * excepted site asked for again loads without a question. Notes go to
 * `<shotPrefix>-notes.txt` next to the screenshots. See [DemoHarness] for the plumbing.
 */
@RunWith(AndroidJUnit4::class)
class CertInterstitialDemo : DemoHarness("share-demo-state.json", "services-cert-interstitial-android", "cert-interstitial-demo") {
    override val tag = "CertInterstitialDemo"
    private lateinit var notes: File

    private val host: Host get() = (activity as MainActivity).host

    @Test
    fun record() = runDemo()

    override fun warmUp() {
        notes = File(out, "services-cert-interstitial-android-notes.txt")
        notes.writeText("Zenium Android certificate interstitial demo (expired, self-signed, wrong.host badssl.com)\n\n")
        // The seeded tab loads over a valid certificate: the page Back to safety returns to.
        navigate(START)
        waitForTitle("Example Domain", 30_000)
        note("start: ${describeTab(state())}")
        note("exceptions on the WebView side: ${exceptions()}")
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        val f = Finger()

        // 1. An expired certificate: the interstitial, its Advanced block, Back to safety.
        note("\n1. $EXPIRED: expired certificate")
        navigate(EXPIRED)
        var tab = waitForInterstitial(EXPIRED)
        note("  ${describeTab(tab)}")
        shot("01-expired-interstitial")
        beat()
        showAdvanced(f)
        note("  page: ${pageText().replace('\n', '|')}")
        shot("02-expired-advanced")
        beat()

        note("\n1b. Back to safety")
        pressInterstitial(f, "Back to safety", "back", EXPIRED)
        tab = waitForTitle("Example Domain", 25_000)
        note("  ${describeTab(tab)}")
        shot("03-expired-back-to-safety")
        beat()

        // 2. The same site, Proceed: the exception is recorded and the page loads, not secure.
        note("\n2. $EXPIRED again, Proceed (unsafe)")
        navigate(EXPIRED)
        tab = waitForInterstitial(EXPIRED)
        showAdvanced(f)
        pressInterstitial(f, "Proceed to expired.badssl.com (unsafe)", "proceed", EXPIRED)
        tab = waitForSite(EXPIRED)
        note("  ${describeTab(tab)}")
        note("  exceptions on the WebView side: ${exceptions()}")
        note("  page: ${pageText().replace('\n', '|')}")
        shot("04-expired-proceeded")
        beat()

        note("\n2b. Site information of the page loaded over the expired certificate")
        openSiteInfo(f)
        note("  site info: ${describeSiteInfo()}")
        shot("05-expired-site-info")
        beat()
        back()
        SystemClock.sleep(1_500)

        // 3. A self-signed certificate.
        note("\n3. $SELF_SIGNED: self-signed certificate")
        navigate(SELF_SIGNED)
        tab = waitForInterstitial(SELF_SIGNED)
        note("  ${describeTab(tab)}")
        shot("06-self-signed-interstitial")
        beat()
        showAdvanced(f)
        shot("07-self-signed-advanced")
        pressInterstitial(f, "Proceed to self-signed.badssl.com (unsafe)", "proceed", SELF_SIGNED)
        tab = waitForSite(SELF_SIGNED)
        note("  ${describeTab(tab)}")
        note("  exceptions on the WebView side: ${exceptions()}")
        shot("08-self-signed-proceeded")
        beat()

        // 4. A certificate for another host.
        note("\n4. $WRONG_HOST: certificate for another host")
        navigate(WRONG_HOST)
        tab = waitForInterstitial(WRONG_HOST)
        note("  ${describeTab(tab)}")
        shot("09-wrong-host-interstitial")
        beat()
        showAdvanced(f)
        shot("10-wrong-host-advanced")
        pressInterstitial(f, "Proceed to wrong.host.badssl.com (unsafe)", "proceed", WRONG_HOST)
        tab = waitForSite(WRONG_HOST)
        note("  ${describeTab(tab)}")
        note("  exceptions on the WebView side: ${exceptions()}")
        shot("11-wrong-host-proceeded")
        beat()

        // 5. The first site again: remembered for the session, no interstitial.
        note("\n5. $EXPIRED once more: the session remembers")
        navigate(START)
        waitForTitle("Example Domain", 25_000)
        navigate(EXPIRED)
        tab = waitForSite(EXPIRED)
        note("  ${describeTab(tab)}")
        shot("12-expired-remembered")
        beat()
        note("\nend: exceptions on the WebView side: ${exceptions()}")
        note("done")
    }

    // --- the interstitial -----------------------------------------------------------------------

    /** Reveal the Advanced block: a touch on its button, else the button's own click through the page. */
    private fun showAdvanced(f: Finger) {
        if (!tapLabel(f, "Advanced", 8_000) && !clickByLabel("Advanced")) {
            note("  (no 'Advanced' node; clicking the button in the page)")
            tabJs("(function(){var b=document.querySelector('[aria-controls=zen-error-advanced]');if(b)b.click();return b?'clicked':'none'})()")
        }
        SystemClock.sleep(1_500)
        note("  advanced: ${tabJs("(function(){var a=document.getElementById('zen-error-advanced');return a?(a.hidden?'hidden':'shown'):'absent'})()")}")
    }

    /**
     * Press a button of the interstitial: a real touch on its label first; when the tab is still
     * on the page after that, the page's own message (what the button posts), through the tab's
     * WebView, so a label the accessibility tree does not carry cannot end the demo.
     */
    private fun pressInterstitial(f: Finger, label: String, action: String, url: String) {
        val warning = tabState().optString("url")
        val tapped = tapLabel(f, label, 8_000)
        if (!tapped) note("  (no node labelled '$label'; clicking through the tree)")
        if (!tapped && !clickByLabel(label)) {
            note("  (no clickable '$label'; posting the page's message)")
            postInterstitial(action, url)
            return
        }
        val deadline = SystemClock.uptimeMillis() + 8_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (tabState().optString("url") != warning) return
            SystemClock.sleep(300)
        }
        note("  (the tab stayed on the warning page after '$label'; posting the page's message)")
        postInterstitial(action, url)
    }

    /** What the button's onclick does: `window.postMessage` of the interstitial action, in the page. */
    private fun postInterstitial(action: String, url: String) {
        tabJs("window.postMessage({zeniumInterstitial:{action:${JSONObject.quote(action)},url:${JSONObject.quote(url)}}},'*');'posted'")
    }

    // --- the chrome ------------------------------------------------------------------------------

    /** The site icon sits at the start of the pill; the sheet it opens is the site information. */
    private fun openSiteInfo(f: Finger) {
        val icon = findByLabel(SITE_ICON_LABEL)?.takeIf { it.top > height * 0.6 }
        if (icon != null) f.tap(icon.exactCenterX(), icon.exactCenterY())
        else {
            note("  (site icon not in the accessibility tree; tapping the start of the pill)")
            f.tap(pill.left + 22 * density, pill.exactCenterY())
        }
        SystemClock.sleep(3_500)
    }

    /** What the site-information sheet says of the connection (the core's reading of the tab). */
    private fun describeSiteInfo(): String {
        val tabId = activeTabId() ?: return "no active tab"
        return runCatching {
            val info = JSONObject(invoke("site.info", """{"tabId":"$tabId"}"""))
            val security = info.getJSONObject("security")
            "state=${security.optString("state")} certificateError=${security.opt("certificateError")} " +
                "certificate=${security.opt("certificate")}"
        }.getOrElse { e -> "site.info failed: ${e.message}; labels on screen: ${labelsMatching(Regex("secure|certificate", RegexOption.IGNORE_CASE))}" }
    }

    private fun labelsMatching(pattern: Regex): List<String> {
        val root = ui.rootInActiveWindow ?: return emptyList()
        val found = ArrayList<String>()
        val queue = ArrayDeque(listOf(root))
        var visited = 0
        while (queue.isNotEmpty() && visited < 6_000) {
            val node = queue.removeFirst()
            visited++
            for (label in listOfNotNull(node.text?.toString(), node.contentDescription?.toString())) {
                if (pattern.containsMatchIn(label)) found += label
            }
            for (i in 0 until node.childCount) node.getChild(i)?.let(queue::add)
        }
        return found
    }

    // --- the bridge and the tab ------------------------------------------------------------------

    private fun invoke(name: String, args: String = "null"): String = coreInvoke(name, args)

    private fun state(): JSONObject = coreState()

    private fun activeTabId(state: JSONObject = state()): String? {
        val spaces = state.getJSONArray("spaces")
        val active = state.getString("activeSpaceId")
        for (i in 0 until spaces.length()) {
            val space = spaces.getJSONObject(i)
            if (space.getString("id") == active) return space.optString("activeTabId", "").takeIf { it.isNotEmpty() }
        }
        return null
    }

    private fun tabState(state: JSONObject = state()): JSONObject =
        activeCoreTab(state) ?: JSONObject()

    private fun navigate(url: String) {
        val tabId = activeTabId() ?: error("no active tab")
        invoke("tab.navigate", """{"tabId":"$tabId","input":${JSONObject.quote(url)}}""")
    }

    /** The tab's url, title, error code and certificate error. */
    private fun describeTab(s: JSONObject): String {
        val tab = activeCoreTab(s) ?: return "no active tab"
        return "url=${tab.optString("url")} title=\"${tab.optString("title")}\" errorCode=${tab.opt("errorCode")} " +
            "certificateError=${tab.opt("certificateError")}"
    }

    /** The certificate interstitial for `failed` is the page: a `zen://error` that names it, not loading. */
    private fun waitForInterstitial(failed: String, timeoutMs: Long = 30_000): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = state()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab(s)
            val url = tab?.optString("url") ?: ""
            if (url.startsWith(ERROR_PREFIX) && java.net.URLDecoder.decode(url, "UTF-8").contains(failed) && tab?.optBoolean("loading") == false) {
                SystemClock.sleep(2_000)
                return state()
            }
            SystemClock.sleep(400)
            s = state()
        }
        Log.w(tag, "no interstitial for $failed")
        note("  (no interstitial for $failed; ${describeTab(s)})")
        return s
    }

    /** The site itself is the page (proceeded past the warning, or remembered), loaded. */
    private fun waitForSite(url: String, timeoutMs: Long = 30_000): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = state()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab(s)
            if (tab != null && tab.optString("url").startsWith(url) && !tab.optBoolean("loading") && tab.isNull("errorCode")) {
                SystemClock.sleep(2_000)
                return state()
            }
            SystemClock.sleep(400)
            s = state()
        }
        Log.w(tag, "$url never loaded")
        note("  ($url never loaded; ${describeTab(s)})")
        return s
    }

    private fun waitForTitle(prefix: String, timeoutMs: Long): JSONObject {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var s = state()
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab(s)
            if (tab != null && tab.optString("title").startsWith(prefix) && !tab.optBoolean("loading")) {
                SystemClock.sleep(1_200)
                return state()
            }
            SystemClock.sleep(500)
            s = state()
        }
        Log.w(tag, "title '$prefix' never showed up")
        note("  (title '$prefix' never showed up; ${describeTab(s)})")
        return s
    }

    /** Evaluate in the active tab's WebView (the page, not the chrome); the value as text. */
    private fun tabJs(code: String): String {
        val tabId = activeTabId() ?: return "(no active tab)"
        val tab = host.tabs.get(tabId) ?: return "(no WebView for $tabId)"
        var result = "(no answer)"
        val latch = CountDownLatch(1)
        instrumentation.runOnMainSync {
            tab.evaluateJavascript(code) { value ->
                result = value ?: "(null)"
                latch.countDown()
            }
        }
        latch.await(5, TimeUnit.SECONDS)
        return runCatching { (JSONTokener(result).nextValue() as? String) ?: result }.getOrDefault(result)
    }

    private fun pageText(): String = tabJs("(document.body&&document.body.innerText||'').slice(0,700)")

    /** The Kotlin side's mirror of the session's exceptions (what `onReceivedSslError` consults). */
    private fun exceptions(): String {
        var size = -1
        instrumentation.runOnMainSync { size = host.security.certificateExceptions.size }
        return "$size"
    }

    private fun note(line: String) {
        Log.i(tag, line)
        notes.appendText(line + "\n")
    }

    companion object {
        private const val START = "https://example.com/"
        private const val EXPIRED = "https://expired.badssl.com/"
        private const val SELF_SIGNED = "https://self-signed.badssl.com/"
        private const val WRONG_HOST = "https://wrong.host.badssl.com/"
        private const val ERROR_PREFIX = "zen://error"
        private const val SITE_ICON_LABEL = "Site information"
    }
}
