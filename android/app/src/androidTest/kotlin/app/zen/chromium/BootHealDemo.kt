package app.zen.chromium

import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.view.ViewGroup
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The second act of the boot heal scene (W6-HF2, `android-boot-heal-demo.sh`): the first-run
 * tour over a link's page, walked to its end. The script's first act cold-started a FRESH
 * profile through a link from the shell (`am start -W -a VIEW -d https://example.com/`,
 * LinkDispatchActivity's path) and read the platform's `Fully drawn` before the splash's
 * watchdog, the intent's page view in the window but GONE under the tour; the shell can read no
 * further (the process is not its own). This driver does the same launch in ITS process: the
 * harness clears the profile and starts the browser (the tour stands, no tab: a fresh phone has
 * no new tab page), then MainActivity is started again with the package's VIEW intent for the
 * link, the task cleared – a new Host, the chrome booting again on the fresh profile, the
 * intent's tab created active and loaded before the arm (`openExternalUrl`), exactly the link's
 * first launch – and proves what the shell could not: the page's view in the window but GONE
 * under the tour (the reporter says the content is hidden while the phone's tour stands, so the
 * host never places it), its text out of the accessibility tree; then the tour walked to its end
 * (Get started, then Continue / Skip / Start browsing until none is up), after which the core's
 * rule on a host without the new tab page puts the omnibox up in new-tab mode over the page, no
 * tab made; a back closes the omnibox and the page stands PLACED – its view VISIBLE with the
 * slot's size, its text in the tree – by the ordinary layout path, once nothing covers it.
 *
 * Only asserts that it could run; one PASS or FAIL per claim in `boot-heal-findings.txt` beside
 * the stills (`boot-heal-01-tour-hides-page`, `-02-tour-ended-omnibox`, `-03-page-placed`),
 * which the script pulls under the scene's names per colour scheme.
 */
@RunWith(AndroidJUnit4::class)
class BootHealDemo : DemoHarness(stateAsset = null, shotPrefix = "boot-heal", handshakeDir = "boot-heal-demo") {
    override val tag = "BootHealDemo"

    private lateinit var findings: File

    @Test
    fun record() {
        runDemo()
    }

    /** The tour is the first frame of the fresh profile's launch: make sure it is there. */
    override fun warmUp() {
        findings = File(out, "boot-heal-findings.txt")
        findings.writeText(
            "Zenium Android boot heal, act 2: the first-run tour over a link's page (API ${Build.VERSION.SDK_INT})\n\n"
        )
        val welcome = waitFor("Get started", 20_000) != null
        if (!welcome) Log.w(tag, "the tour never showed on the fresh profile")
        finding("the tour stands on the fresh profile's launch ${verdict(welcome)}")
        SystemClock.sleep(1_500)
    }

    override fun demo() {
        // 0. The fresh profile under its tour, no link: no tab (a phone has no new tab page to
        //    open), the first run not done. The page the link brings has nothing to share it with.
        val fresh = coreState()
        val freshTabs = fresh.getJSONObject("tabs").length()
        val freshDone = fresh.getJSONObject("settings").optBoolean("onboardingDone", false)
        finding("fresh profile under the tour: $freshTabs tab(s), onboardingDone $freshDone ${verdict(freshTabs == 0 && !freshDone)}")

        // 1. The link's launch in this process: MainActivity again with the package's VIEW intent,
        //    the task cleared (a new Host, the chrome booting again on the fresh profile), the
        //    intent's tab created active and loaded before the arm – the link's first launch.
        val intent = Intent(app, MainActivity::class.java)
            .setAction(Intent.ACTION_VIEW)
            .setData(Uri.parse(LINK))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        activity = instrumentation.startActivitySync(intent) as MainActivity
        val welcome = waitFor("Get started", 30_000) != null
        if (!welcome) Log.w(tag, "the tour never showed on the link's launch")
        finding("the tour stands on the link's launch ${verdict(welcome)}")
        // The page loads under the tour; the reporter's first reports have gone out.
        SystemClock.sleep(3_000)
        ensureForeground()

        // 2. Under the tour: the core has the intent's page as the one tab, the host has its view
        //    – GONE (never placed while the tour stands), out of the accessibility tree.
        val before = coreState()
        val activeBefore = activeCoreTab(before)?.optString("url")
        val doneBefore = before.getJSONObject("settings").optBoolean("onboardingDone", false)
        finding(
            "core under the tour: ${before.getJSONObject("tabs").length()} tab(s), active $activeBefore, onboardingDone $doneBefore " +
                verdict(before.getJSONObject("tabs").length() == 1 && activeBefore == LINK && !doneBefore)
        )
        val hidden = pageViews()
        finding("page view under the tour, in the window but hidden: ${hidden.describe()} ${verdict(hidden.count == 1 && hidden.visible == 0)}")
        finding("the page's text is out of the tree under the tour ${verdict(findNode { it.contains(PAGE_TEXT) } == null)}")
        shot("01-tour-hides-page")

        // 3. The tour to its end: the first step's Get started, then whichever of Skip (the
        //    default step, left with the role up for grabs), Start browsing (the last step where
        //    the host has no role to give) or Continue is up, until none is.
        val f = Finger()
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

        // 4. The tour's end, as the core rules it on a host without the new tab page: the flag
        //    up, no tab made, the omnibox in new-tab mode over the page. The omnibox covers the
        //    content too (overlayCoversContent), so the page's view is read here and judged
        //    once the omnibox has closed.
        val omnibox = waitFor(OMNIBOX_LABEL, 8_000) != null && urlbarOpen()
        val after = coreState()
        val activeAfter = activeCoreTab(after)?.optString("url")
        val doneAfter = after.getJSONObject("settings").optBoolean("onboardingDone", false)
        finding(
            "core after the tour: ${after.getJSONObject("tabs").length()} tab(s), active $activeAfter, onboardingDone $doneAfter " +
                verdict(after.getJSONObject("tabs").length() == 1 && activeAfter == LINK && doneAfter)
        )
        finding("the tour ended in the omnibox, new-tab mode, over the page (the core's rule) ${verdict(omnibox)}")
        SystemClock.sleep(1_000)
        val under = pageViews()
        finding("page view under the omnibox: ${under.describe()} ${verdict(under.count == 1)}")
        shot("02-tour-ended-omnibox")

        // 5. A back closes the omnibox; nothing covers the page: placed by the ordinary layout
        //    path – VISIBLE with the slot's size, its text in the tree.
        val close = closeUrlField()
        finding("the omnibox closed by back, the page kept ${verdict(close.ok)} (${close.describe()})")
        val text = waitFor({ it.contains(PAGE_TEXT) }, 10_000) != null
        SystemClock.sleep(1_500)
        val placed = pageViews()
        finding("page view once nothing covers it, placed: ${placed.describe()} ${verdict(placed.count == 1 && placed.visible == 1 && placed.sized == 1)}")
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
        /** The link the launches open (the intent's page). */
        private const val LINK = "https://example.com/"
        /** The page's heading, in the accessibility tree once its view is placed. */
        private const val PAGE_TEXT = "Example Domain"
        /** The omnibox field's label (components/urlbar/Urlbar.tsx). */
        private const val OMNIBOX_LABEL = "Search or enter address"
    }
}
