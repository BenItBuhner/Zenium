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
 * away, and Settings > About with the row still offering the role (the row's labels are the
 * shared names in [DemoHarness] – `DEFAULT_BROWSER_OFFER`, `DEFAULT_BROWSER_HELD`,
 * `OPEN_BY_DEFAULT_ROW` – read through the harness's Settings readers: the document's word for
 * the row, its accessible name and that it is exposed, the tree's node for it on record beside
 * them). Only asserts that it could run; what the chrome does is what the recording shows, with
 * one PASS or FAIL per surface in `firstrun-findings.txt` next to the screenshots. The role dialog
 * itself is on record from the functional half's run (#46).
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
        //    way. The one-time gesture hint then comes up as a toast at the frame's bottom edge.
        val close = closeUrlField()
        finding("the first run's omnibox closed by back, the tab kept ${verdict(close.ok)} (${close.describe()})")
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

        // 6. Settings > About: the row still offers the role – the shared names for the row's two
        // states, the offering one expected after the tour's Skip. The claim is the document's,
        // through the harness's Settings readers (settingsRowListed: the row whose label reads the
        // name; settingsRowName: what it is named for assistive technology, the label and the line
        // under it as one; settingsRowExposed: laid out, visible, not inert): the tree read the
        // two runs before made (a 5 s wait, then findNode) listed neither row while both stood on
        // screen (11-settings-set-as-default of 36216598268 and 36221053673) – the emulator's tree
        // trails the screen by seconds (TREE_WINDOW_MS), so the tree's node is the record beside
        // the claim, waited for the harness's way (awaitSettingsRowInTree, with its nudges), never
        // the verdict.
        openAbout(f)
        shot("11-settings-set-as-default")
        val roleLabel = listOf(DEFAULT_BROWSER_OFFER, DEFAULT_BROWSER_HELD).firstOrNull { settingsRowListed(it) }
        val name = roleLabel?.let { settingsRowName(it) } ?: "no browser-role row"
        val exposed = roleLabel?.let { settingsRowExposed(it) } == true
        val openByDefault = settingsRowListed(OPEN_BY_DEFAULT_ROW)
        val tree = when (roleLabel) {
            null -> "not awaited (the document lists no such row)"
            else -> awaitSettingsRowInTree(roleLabel)?.let { "reads '${it.text ?: it.contentDescription}'" }
                ?: "did not come within ${TREE_WINDOW_MS / 1_000} s (the record, not the claim)"
        }
        finding(
            "Settings > About row: the browser-role row ${verdict(roleLabel != null)} (named '$name', exposed ${verdict(exposed)}), " +
                "still offers the role ('$DEFAULT_BROWSER_OFFER') ${verdict(roleLabel == DEFAULT_BROWSER_OFFER)}, " +
                "Open by default beside it ${verdict(openByDefault)}; the tree's node for it $tree"
        )
        SystemClock.sleep(1_500)
    }

    /** A step's content slides in on SPRING_GENTLE; let it settle before the next touch. */
    private fun step() = SystemClock.sleep(1_500)

    /** The hint is a toast (a status line) starting with its first words; the rest may wrap. */
    private fun hintShown(): Boolean = findNode { it.startsWith("Swipe the address bar") } != null

    /**
     * Menu, expanded, scrolled to its end, Settings (its row under a finger, the landing proven
     * by the document's `data-section`), then the About section the harness's way
     * ([openSettingsSection]: its category row under a finger, the section proven by the
     * document, the tree's click when the touch never took). Settings takes seconds to come up on
     * the emulator, so the landing, the section and the row are waited for, not slept for – by
     * the document, which lists a row the moment it is laid out (the tree trails it by seconds:
     * [TREE_WINDOW_MS]).
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
        // A finger on the row (the menu flow's injected touch): the Settings tab comes up on its
        // landing, the document's word (the About category the tree's sign when the chrome does
        // not answer). The tree's click when the row is not on screen to touch.
        val landing = { settingsSectionIs(SETTINGS_LANDING, treeSign = "About") }
        if (!touchTapLabelExpecting("Settings", "the Settings tab is up on its landing", timeoutMs = 10_000, took = landing) &&
            !landing() && !(clickByLabel("Settings") && awaitTrue(10_000, landing))
        ) {
            Log.w(tag, "no Settings row (section '${settingsSection()}')")
            back()
            return
        }
        if (!openSettingsSection("about", timeoutMs = 10_000)) {
            Log.w(tag, "no About section")
            return
        }
        if (!awaitTrue(8_000) { settingsRowListed(DEFAULT_BROWSER_OFFER) || settingsRowListed(DEFAULT_BROWSER_HELD) }) {
            Log.w(tag, "the document lists no browser-role row ($DEFAULT_BROWSER_OFFER / $DEFAULT_BROWSER_HELD)")
        }
        SystemClock.sleep(1_500)
    }

    /** The shared helpers' notes (how long the tree took to list the row) go to the findings too. */
    override fun noteLine(line: String) = finding(line)

    private fun verdict(ok: Boolean) = if (ok) "PASS" else "FAIL"

    /** A line of the findings: the log, and the file once [warmUp] has opened it (a shared helper's note may come before). */
    private fun finding(line: String) {
        Log.i(tag, line.trim())
        if (::findings.isInitialized) findings.appendText(line + "\n")
    }

    companion object {
        private const val BANNER_TITLE = "Open links in Zenium"
        /** The omnibox field's label (components/urlbar/Urlbar.tsx). */
        private const val OMNIBOX_LABEL = "Search or enter address"
    }
}
