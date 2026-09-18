package app.zen.chromium

import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Drives the first run and the default-browser prompts from a cleared profile so the
 * `android-firstrun-demo` workflow can record them: the welcome flow step by step (a look picked,
 * a search engine, "Set as default" opening the system's browser-role dialog, cancelled there so
 * there is still something to ask for), a first page with the one-time gesture hint, the Settings
 * row offering the role; then the app started again for two more sessions until the promo sheet
 * is due (the third session – the rules in `shared/defaultBrowser.ts` run unchanged, nothing is
 * lowered), "Not now", the lighter banner in the session after, and the banner's "Set as default"
 * taking the role in the dialog, so Settings ends on "Zenium is your default browser". Only
 * asserts that it could run; what the chrome does is what the recording shows.
 *
 * Handshake with the workflow through files under `files/firstrun-demo/` as in GestureDemo;
 * screenshots land next to them as `firstrun-*.png`.
 */
@RunWith(AndroidJUnit4::class)
class FirstRunDemo : DemoHarness(stateAsset = null, shotPrefix = "firstrun", handshakeDir = "firstrun-demo") {
    override val tag = "FirstRunDemo"

    @Test
    fun record() {
        runDemo()
    }

    /** Nothing to warm up: the welcome step is the first frame. Just make sure it is there. */
    override fun warmUp() {
        if (waitFor("Get started", 20_000) == null) Log.w(tag, "the welcome step never showed")
    }

    override fun demo() {
        val f = Finger()

        // 1. The first run: welcome, the look (a preset recolours the whole screen), the engine.
        SystemClock.sleep(1_500)
        shot("01-welcome")
        tapLabel(f, "Get started")
        step()
        shot("02-look")
        tapLabel(f, "Ocean")
        SystemClock.sleep(1_800)
        shot("03-look-ocean")
        tapLabel(f, "Continue")
        step()
        shot("04-search")
        tapLabel(f, "DuckDuckGo")
        SystemClock.sleep(1_200)
        tapLabel(f, "Continue")
        step()
        shot("05-set-as-default")

        // 2. "Set as default" hands over to the system's role dialog. Cancel it: the promos later
        //    need the role to still be up for grabs. Either answer ends the first run; when the
        //    dialog never comes, Skip does, so the rest of the demo still runs.
        if (tapPrimary(f) && awaitSystemWindow()) {
            SystemClock.sleep(1_500)
            shot("06-role-dialog")
            if (!tapLabel(f, "Cancel")) back()
        } else {
            Log.w(tag, "no role dialog came up; skipping the step")
            tapLabel(f, "Skip")
        }
        // The first run ends in the omnibox, offered for the first address; let it settle.
        SystemClock.sleep(4_000)
        shot("07-first-session")

        // 3. A first page, arriving the way a link from another app does (the omnibox the first
        //    run ends in keeps no input focus for injected keys after the role dialog), once that
        //    omnibox is out of the way. The one-time gesture hint then shows beside the pill.
        closeUrlbar()
        openLink("https://example.com/")
        SystemClock.sleep(5_000)
        shot("08-gesture-hint")
        SystemClock.sleep(2_000)

        // 4. Settings > About: the row offers the role.
        openAbout(f)
        shot("09-settings-set-as-default")
        back()
        SystemClock.sleep(1_500)

        // 5. Two more sessions: the promo sheet is due in the third.
        launch()
        SystemClock.sleep(1_000)
        launch()
        waitFor("Not now", 10_000)
        SystemClock.sleep(1_500)
        shot("10-promo-sheet")
        tapLabel(f, "Not now")
        SystemClock.sleep(2_500)

        // 6. The session after: the lighter banner. Its button takes the role for real this time.
        launch()
        waitFor("Open links in Zenium", 10_000)
        SystemClock.sleep(1_500)
        shot("11-banner")
        tapLabel(f, "Set as default")
        if (awaitSystemWindow()) {
            SystemClock.sleep(1_500)
            shot("12-role-dialog-again")
            grantRole(f)
        } else {
            Log.w(tag, "no role dialog came up from the banner")
        }
        SystemClock.sleep(3_000)
        shot("13-default-held")

        // 7. Settings > About once more: "Zenium is your default browser".
        openAbout(f)
        shot("14-settings-default")
        SystemClock.sleep(1_500)
    }

    /** A step's content slides in on SPRING_GENTLE; let it settle before the next touch. */
    private fun step() = SystemClock.sleep(1_500)

    /**
     * The last step's primary button. Looked up by label like everything else; when the tree has
     * no such node, Skip, its mirror image in the same row, gives the place to touch: the row is
     * centred and both buttons share one width. Three recordings on the API 34 emulator exposed
     * Skip and never this button (Blink names both, as the preview host's tree shows; clearing
     * UiAutomation's cache made no difference), while the banner's identical button is found.
     */
    private fun tapPrimary(f: Finger): Boolean {
        waitFor("Set as default", 8_000)?.let {
            f.tap(it.exactCenterX(), it.exactCenterY())
            return true
        }
        val skip = findByLabel("Skip") ?: run {
            Log.w(tag, "neither Set as default nor Skip is in the tree")
            return false
        }
        Log.w(tag, "no node labelled 'Set as default'; touching the mirror of Skip")
        f.tap(width - skip.exactCenterX(), skip.exactCenterY())
        return true
    }

    /** Android 12+ lists the browsers with Zenium preselected; older dialogs confirm directly. */
    private fun grantRole(f: Finger) {
        if (tapLabel(f, "Zenium")) SystemClock.sleep(1_000)
        if (!tapLabel(f, "Set as default")) Log.w(tag, "no confirm button in the role dialog")
    }

    /**
     * Menu, expanded, scrolled to its end, Settings, then the About section. Rows are picked
     * through the accessibility tree, as MenuSheetDemo does. Settings takes seconds to come up on
     * the emulator after the role dialog, so its tabs and the row are waited for, not slept for.
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
}
