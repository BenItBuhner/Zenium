package app.zen.chromium

import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewGroup
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The second act of the boot heal scene (W6-HF2, `android-boot-heal-demo.sh`): the first-run
 * tour over a page. The script's first act cold-started a FRESH profile through a link
 * (`am start -W -a VIEW -d https://example.com/`, LinkDispatchActivity's path) and read the
 * platform's `Fully drawn` before the splash's watchdog, the tour standing over the intent's
 * page; the process is gone after it (an instrumentation shares the process). This driver
 * starts the browser again on THAT profile (`keepProfile`: `onboardingDone` still false, the
 * intent's tab the space's one tab) – the tour stands over the restored page the same way –
 * and proves what the script cannot from the shell: the page's view is in the window but GONE
 * under the tour (the reporter says the content is hidden while the phone's tour stands, so the
 * host never places it), its text out of the accessibility tree; then the tour walked to its end
 * (Get started, Continue, Continue, then Skip beside Set as default where the host has a browser
 * role to give, Start browsing where it has not), after which the core's rule on a host without
 * the new tab page puts the omnibox up in new-tab mode over the page, no tab made – and the
 * page's view is VISIBLE with the slot's size: placed by the first layout after the tour. A back
 * closes the omnibox and the page stands, its text in the tree.
 *
 * Only asserts that it could run; one PASS or FAIL per claim in `boot-heal-findings.txt` beside
 * the stills (`boot-heal-01-tour-over-page`, `-02-tour-ended-omnibox`, `-03-page-placed`), which
 * the script pulls under the scene's names per colour scheme.
 */
@RunWith(AndroidJUnit4::class)
class BootHealDemo : DemoHarness(stateAsset = null, shotPrefix = "boot-heal", handshakeDir = "boot-heal-demo", keepProfile = true) {
    override val tag = "BootHealDemo"

    private lateinit var findings: File

    @Test
    fun record() {
        runDemo()
    }

    /** The profile as the link's cold start left it, read before the browser starts on it. */
    override fun beforeLaunch() {
        findings = File(out, "boot-heal-findings.txt")
        findings.writeText(
            "Zenium Android boot heal, act 2: the first-run tour over a link's page (API ${Build.VERSION.SDK_INT})\n\n"
        )
        val file = File(File(app.filesDir, "zen"), "state.json")
        if (!file.exists()) {
            finding("profile on disk before the relaunch: no state.json (the link's cold start left nothing) FAIL")
            return
        }
        val persisted = runCatching { JSONObject(file.readText()) }.getOrNull()
        if (persisted == null) {
            finding("profile on disk before the relaunch: state.json unreadable FAIL")
            return
        }
        val tabs = persisted.optJSONArray("tabs")
        val urls = (0 until (tabs?.length() ?: 0)).map { tabs!!.getJSONObject(it).optString("url") }
        val done = persisted.optJSONObject("settings")?.optBoolean("onboardingDone", false) ?: false
        finding(
            "profile on disk before the relaunch: ${urls.size} tab(s) $urls, onboardingDone $done " +
                verdict(urls == listOf(LINK) && !done)
        )
    }

    /** The tour is the first frame of the relaunch: make sure it is there. */
    override fun warmUp() {
        val welcome = waitFor("Get started", 20_000) != null
        if (!welcome) Log.w(tag, "the tour never showed on the relaunch")
        finding("the tour stands on the relaunch of the profile the link's cold start left ${verdict(welcome)}")
        SystemClock.sleep(1_500)
    }

    override fun demo() {
        val f = Finger()

        // 1. Under the tour: the core has the intent's page as the one tab, the host has its view
        //    – GONE (never placed while the tour stands), out of the accessibility tree.
        val before = coreState()
        val activeBefore = activeCoreTab(before)?.optString("url")
        val doneBefore = before.getJSONObject("settings").optBoolean("onboardingDone", false)
        finding(
            "core under the tour: ${before.getJSONObject("tabs").length()} tab(s), active $activeBefore, onboardingDone $doneBefore " +
                verdict(before.getJSONObject("tabs").length() == 1 && activeBefore == LINK && !doneBefore)
        )
        val hidden = pageViews()
        finding("page view under the tour: ${hidden.describe()} ${verdict(hidden.count == 1 && hidden.visible == 0)}")
        finding("the page's text is out of the tree under the tour ${verdict(findNode { it.contains(PAGE_TEXT) } == null)}")
        shot("01-tour-over-page")

        // 2. The tour to its end: the first step's Get started, then whichever of Skip (the
        //    default step, left with the role up for grabs), Start browsing (the last step where
        //    the host has no role to give) or Continue is up, until none is.
        if (!tapLabel(f, "Get started")) Log.w(tag, "no Get started")
        step()
        var taps = 0
        while (taps < 5) {
            val label = listOf("Skip", "Start browsing", "Continue").firstOrNull { findByLabel(it) != null } ?: break
            if (!tapLabel(f, label)) break
            taps++
            step()
        }
        val ended = waitForGone("Get started", 5_000) && findAny("Continue", "Skip", "Start browsing") == null
        finding("the tour walked to its end in ${taps + 1} taps ${verdict(ended)}")

        // 3. The tour's end, as the core rules it on a host without the new tab page: the flag
        //    up, no tab made, the omnibox in new-tab mode over the page – and the page's view
        //    placed by the first layout after the tour.
        SystemClock.sleep(3_500)
        val after = coreState()
        val activeAfter = activeCoreTab(after)?.optString("url")
        val doneAfter = after.getJSONObject("settings").optBoolean("onboardingDone", false)
        finding(
            "core after the tour: ${after.getJSONObject("tabs").length()} tab(s), active $activeAfter, onboardingDone $doneAfter " +
                verdict(after.getJSONObject("tabs").length() == 1 && activeAfter == LINK && doneAfter)
        )
        val omnibox = urlbarOpen()
        finding("the tour ended in the omnibox, new-tab mode, over the page (the core's rule) ${verdict(omnibox && findByLabel(OMNIBOX_LABEL) != null)}")
        val placed = pageViews()
        finding("page view once the tour ended: ${placed.describe()} ${verdict(placed.count == 1 && placed.visible == 1 && placed.sized == 1)}")
        shot("02-tour-ended-omnibox")

        // 4. A back closes the omnibox; the page stands placed, its text in the tree.
        val close = closeUrlField()
        finding("the omnibox closed by back, the page kept ${verdict(close.ok)} (${close.describe()})")
        val text = waitFor({ it.contains(PAGE_TEXT) }, 8_000) != null
        SystemClock.sleep(1_500)
        val standing = pageViews()
        finding("page view after the omnibox closed: ${standing.describe()} ${verdict(standing.count == 1 && standing.visible == 1 && standing.sized == 1)}")
        finding("the page's text in the tree after the tour ${verdict(text)}")
        shot("03-page-placed")
        SystemClock.sleep(1_000)
    }

    /** A step's content slides in on SPRING_GENTLE; let it settle before the next touch. */
    private fun step() = SystemClock.sleep(1_500)

    /** The host's page views in the window: how many, how many visible, how many laid out with a size. */
    private class PageViews(val count: Int, val visible: Int, val sized: Int, private val detail: String) {
        fun describe(): String = "$count page view(s)" + if (count == 0) "" else " – $detail"
    }

    private fun pageViews(): PageViews {
        val found = mutableListOf<String>()
        var visible = 0
        var sized = 0
        instrumentation.runOnMainSync {
            fun walk(v: View) {
                if (v is TabWebView) {
                    val state = when (v.visibility) {
                        View.VISIBLE -> "VISIBLE"
                        View.INVISIBLE -> "INVISIBLE"
                        else -> "GONE"
                    }
                    if (v.visibility == View.VISIBLE) visible++
                    if (v.width > 0 && v.height > 0) sized++
                    found += "${v.tabId} $state ${v.width}x${v.height} at ${v.left},${v.top}"
                }
                if (v is ViewGroup) for (i in 0 until v.childCount) walk(v.getChildAt(i))
            }
            walk(activity.window.decorView)
        }
        return PageViews(found.size, visible, sized, found.joinToString("; "))
    }

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        /** The link the script's cold start opened (the intent's page). */
        private const val LINK = "https://example.com/"
        /** The page's heading, in the accessibility tree once its view is placed. */
        private const val PAGE_TEXT = "Example Domain"
        /** The omnibox field's label (components/urlbar/Urlbar.tsx). */
        private const val OMNIBOX_LABEL = "Search or enter address"
    }
}
