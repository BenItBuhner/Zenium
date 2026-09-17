package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.FileInputStream

/**
 * Drives Settings → Look and Feel → App icon so the `android-appicon-demo` workflow can record
 * it on an emulator: opens Settings from the menu, screenshots the swatch grid, picks Sunset,
 * screenshots it marked, then goes home and shows the launcher's app drawer with the switched
 * icon – once as is and once with Android 13's themed icons on (the monochrome layer) – and
 * Recents, before coming back to the app. Asserts that the Sunset alias is the one enabled.
 *
 * The `theme` instrumentation argument (`light`, the default, or `dark`) seeds the profile's
 * colour scheme and puts the system in the matching night mode so the launcher matches.
 * Handshake and screenshots (`appicon-<theme>-*.png`) as in the other demos, under
 * `files/appicon-demo/`.
 */
@RunWith(AndroidJUnit4::class)
class AppIconDemo : DemoHarness("appicon-demo-state.json", "appicon-$THEME", "appicon-demo") {
    override val tag = "AppIconDemo"

    @Test
    fun record() = runDemo()

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    override fun warmUp() {
        shell("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        SystemClock.sleep(2_500)
        ensureForeground()
    }

    override fun demo() {
        val f = Finger()
        val launcherIcon = LauncherIcon(app)
        Log.i(tag, "launcher icon at start: ${launcherIcon.current()}")

        // 1. Settings, from the menu sheet (the row is near its end: scroll it into view first).
        val menu = findByLabel(MENU_LABEL) ?: error("no menu button")
        f.tap(menu.exactCenterX(), menu.exactCenterY())
        SystemClock.sleep(2_500)
        reveal("Settings")
        if (!clickByLabel("Settings")) error("no Settings row in the menu")
        SystemClock.sleep(3_000)

        // 2. Look and Feel is the first section; the App icon group sits under Appearance.
        reveal(swatch("Indigo"))
        SystemClock.sleep(1_200)
        shot("settings-indigo")

        // 3. Pick Sunset: the ring moves, the row names it, the launcher alias flips underneath –
        //    and the browser stays where it is (the system removes tasks rooted at a disabled
        //    alias; ours is rooted at MainActivity, see LauncherIconActivity).
        val task = activity.taskId
        if (!clickByLabel(swatch("Sunset"))) error("no Sunset swatch")
        SystemClock.sleep(3_000)
        shot("settings-sunset")
        Log.i(tag, "launcher icon after the pick: ${launcherIcon.current()}")
        assertTrue("the browser closed on the icon switch", !activity.isFinishing && !activity.isDestroyed)
        assertEquals("the browser is still in front", app.packageName, ui.rootInActiveWindow?.packageName?.toString())

        // 4. The launcher: home, then the app drawer scrolled to Zenium.
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        SystemClock.sleep(3_500)
        openAppDrawer(f)
        shot("launcher-drawer")

        // 5. Themed icons (Android 13) only apply on the home screen: drag Zenium out of the
        //    drawer onto it, then switch the launcher's themed icons on and off around a capture.
        val zen = reveal("Zenium")
        if (zen != null) {
            f.press(zen.exactCenterX(), zen.exactCenterY())
            f.moveBy(0f, -0.3f * height, 700)
            f.hold(700)
            f.up()
            SystemClock.sleep(3_000)
            ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
            SystemClock.sleep(2_500)
            shot("home")
            if (setThemedIcons(true)) {
                SystemClock.sleep(4_000)
                shot("home-themed")
                setThemedIcons(false)
                SystemClock.sleep(2_500)
            }
        }

        // 6. Recents: the browser's card is still there, under the new icon.
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_RECENTS)
        SystemClock.sleep(3_000)
        shot("recents")

        // 7. Back into the app through the alias the launcher now resolves: the same task returns.
        val intent = app.packageManager.getLaunchIntentForPackage(app.packageName) ?: error("no launcher entry")
        Log.i(tag, "launch intent now targets ${intent.component}")
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        app.startActivity(intent)
        SystemClock.sleep(4_000)
        shot("relaunched")

        assertEquals("sunset", launcherIcon.current())
        assertTrue("Sunset alias enabled", launcherIcon.isEnabled("sunset"))
        assertTrue("Indigo alias disabled", !launcherIcon.isEnabled("indigo"))
        assertEquals("app.zen.chromium.icon.Sunset", intent.component?.className)
        assertTrue("the browser was recreated", !activity.isDestroyed)
        assertEquals("the launch came back to the same task", task, activity.taskId)
    }

    /** Swipe up from the bottom of the home screen, then bring Zenium (last alphabetically) into view. */
    private fun openAppDrawer(f: Finger) {
        val x = width / 2f
        f.down(x, height * 0.92f)
        f.moveBy(0f, -height * 0.6f, 350)
        f.up()
        SystemClock.sleep(2_500)
        if (reveal("Zenium") == null) {
            // No accessibility hit: scroll the drawer to its end by hand.
            repeat(3) {
                f.down(x, height * 0.75f)
                f.moveBy(0f, -height * 0.5f, 300)
                f.up()
                SystemClock.sleep(800)
            }
        }
        SystemClock.sleep(1_200)
    }

    /**
     * Launcher3's grid-control provider (the wallpaper picker's switch), on the Pixel launcher of
     * the Google APIs image. False when this launcher has no such switch.
     */
    private fun setThemedIcons(on: Boolean): Boolean {
        val out = shell(
            "content update --uri content://com.google.android.apps.nexuslauncher.grid_control/icon_themed " +
                "--bind boolean_value:b:$on"
        )
        val ok = !out.contains("Error", ignoreCase = true) && !out.contains("Exception")
        Log.i(tag, "themed icons $on: ${if (ok) "ok" else out.trim().take(200)}")
        return ok
    }

    /** Run a shell command with the instrumentation's shell permissions; returns its output. */
    private fun shell(command: String): String {
        val fd = ui.executeShellCommand(command)
        return FileInputStream(fd.fileDescriptor).bufferedReader().use { it.readText() }.also { fd.close() }
    }

    companion object {
        private const val MENU_LABEL = "Menu"
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }

        /** The swatch buttons' accessible names (`AppIconPicker.tsx`). */
        private fun swatch(name: String) = "$name app icon"
    }
}
