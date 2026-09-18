package app.zen.chromium

import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * Drives the first run and the default-browser prompts from a cleared profile so the
 * `android-firstrun-demo` workflow can record them: the welcome flow step by step (a look picked,
 * a search engine, the Set as default step left with Skip, so the role stays up for grabs and
 * the promos later have something to ask for), a first page with the one-time gesture hint; then
 * the app started again for two more sessions until the promo sheet is due (the third session –
 * the rules in `shared/defaultBrowser.ts` run unchanged, nothing is lowered), "Not now", the
 * banner (#72's top banner carrying the default-browser message) in the session after, swiped
 * away, and Settings > About with the row still offering the role. Only asserts that it could
 * run; what the chrome does is what the recording shows, with one PASS or FAIL per surface in
 * `firstrun-findings.txt` next to the screenshots. The role dialog itself is on record from the
 * functional half's run (#46).
 *
 * Handshake with the workflow through files under `files/firstrun-demo/` as in GestureDemo;
 * screenshots land next to them as `firstrun-*.png`.
 */
@RunWith(AndroidJUnit4::class)
class FirstRunDemo : DemoHarness(stateAsset = null, shotPrefix = "firstrun", handshakeDir = "firstrun-demo") {
    override val tag = "FirstRunDemo"

    private lateinit var findings: File

    @Test
    fun record() {
        runDemo()
    }

    /** Nothing to warm up: the welcome step is the first frame. Just make sure it is there. */
    override fun warmUp() {
        findings = File(out, "firstrun-findings.txt")
        findings.writeText(
            "Zenium Android first run and default-browser prompts (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n"
        )
        val welcome = waitFor("Get started", 20_000) != null
        if (!welcome) Log.w(tag, "the welcome step never showed")
        finding("first run: welcome step from the cleared profile ${verdict(welcome)}")
    }

    override fun demo() {
        val f = Finger()

        // 1. The first run: welcome, the look (a preset recolours the whole screen), the engine.
        SystemClock.sleep(1_500)
        shot("01-welcome")
        tapLabel(f, "Get started")
        step()
        shot("02-look")
        val look = findByLabel("Ocean") != null
        tapLabel(f, "Ocean")
        SystemClock.sleep(1_800)
        shot("03-look-ocean")
        finding("look step: preset tiles ${verdict(look)}, Ocean picked and applied live (see 03-look-ocean)")
        tapLabel(f, "Continue")
        step()
        shot("04-search")
        val search = findByLabel("DuckDuckGo") != null
        tapLabel(f, "DuckDuckGo")
        SystemClock.sleep(1_200)
        finding("search step: engine rows ${verdict(search)}")
        tapLabel(f, "Continue")
        step()
        shot("05-set-as-default")

        // 2. The Set as default step, left with Skip: the promos later need the role to still be
        //    up for grabs. Either button ends the first run.
        val defaultStep = findAny("Skip") != null
        finding("default step: Skip beside Set as default ${verdict(defaultStep)}")
        if (!tapLabel(f, "Skip")) Log.w(tag, "no Skip on the default step")
        // The first run ends in the omnibox, offered for the first address (so the pill is not in
        // the tree yet: the field is); let it settle.
        SystemClock.sleep(4_000)
        shot("06-first-session")
        val browsing = findByLabel(OMNIBOX_LABEL) != null || findByLabelPrefix(PILL_LABEL) != null
        finding("first run ended in the browser ${verdict(browsing)}")

        // 3. A first page, arriving the way a link from another app does (the omnibox the first
        //    run ends in keeps no input focus for injected keys), once that omnibox is out of the
        //    way. The one-time gesture hint then shows beside the pill.
        closeUrlbar()
        openLink("https://example.com/")
        SystemClock.sleep(5_000)
        shot("07-gesture-hint")
        finding("gesture hint after the first page ${verdict(hintShown())}")
        SystemClock.sleep(2_000)

        // 4. Two more sessions: the promo sheet is due in the third.
        launch()
        SystemClock.sleep(1_000)
        launch()
        val sheet = waitFor("Not now", 15_000) != null
        SystemClock.sleep(1_500)
        shot("08-promo-sheet")
        finding("promo sheet in the third session ${verdict(sheet)}")
        tapLabel(f, "Not now")
        SystemClock.sleep(2_500)
        finding("sheet gone after Not now ${verdict(findByLabel("Not now") == null)}")

        // 5. The session after: the banner. Swiped off to the side, the way #72's cards go.
        launch()
        val banner = waitFor(BANNER_TITLE, 10_000)
        SystemClock.sleep(1_500)
        shot("09-banner")
        finding("banner in the fourth session ${verdict(banner != null)}")
        if (banner != null) {
            // From the title, not the action: a touch on a control stays the control's.
            f.down(banner.left + 0.3f * banner.width(), banner.exactCenterY())
            f.moveBy(NUDGE, 0f, 80)
            f.moveBy(0.6f * width, 0f, 260)
            f.up()
            SystemClock.sleep(1_800)
            shot("10-banner-swiped")
            finding("banner gone after the swipe ${verdict(findByLabel(BANNER_TITLE) == null)}")
        }

        // 6. Settings > About: the row still offers the role.
        openAbout(f)
        shot("11-settings-set-as-default")
        finding(
            "Settings > About row: Default browser ${verdict(findByLabel("Default browser") != null)}, " +
                "Set as default ${verdict(findByLabel("Set as default") != null)}"
        )
        SystemClock.sleep(1_500)
    }

    /** A step's content slides in on SPRING_GENTLE; let it settle before the next touch. */
    private fun step() = SystemClock.sleep(1_500)

    /** The hint is a status line starting with its first words; the rest may wrap. */
    private fun hintShown(): Boolean = findNode { it.startsWith("Swipe the address bar") } != null

    /**
     * Menu, expanded, scrolled to its end, Settings, then the About section. Rows are picked
     * through the accessibility tree, as MenuSheetDemo does. Settings takes seconds to come up on
     * the emulator, so its tabs and the row are waited for, not slept for.
     */
    private fun openAbout(f: Finger) {
        ensureForeground()
        val menu = waitFor("Menu", 8_000) ?: run {
            Log.w(tag, "no menu button")
            return
        }
        f.tap(menu.exactCenterX(), menu.exactCenterY())
        val handle = waitFor("Resize menu", 5_000) ?: run {
            Log.w(tag, "the menu never opened")
            return
        }
        SystemClock.sleep(800)
        f.down(handle.exactCenterX(), handle.exactCenterY())
        f.moveBy(0f, -0.4f * height, 130)
        f.up()
        beat()
        f.down(width / 2f, height * 0.6f)
        f.moveBy(0f, -0.6f * height, 500)
        f.up()
        beat()
        if (!clickByLabel("Settings")) {
            Log.w(tag, "no Settings row")
            back()
            return
        }
        if (waitFor("About", 10_000) == null || !clickByLabel("About")) {
            Log.w(tag, "no About section")
            return
        }
        if (waitFor("Default browser", 5_000) == null) Log.w(tag, "no Default browser row")
        SystemClock.sleep(1_500)
    }

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val BANNER_TITLE = "Open links in Zenium"
        /** The omnibox field's label (components/urlbar/Urlbar.tsx). */
        private const val OMNIBOX_LABEL = "Search or enter address"
    }
}
