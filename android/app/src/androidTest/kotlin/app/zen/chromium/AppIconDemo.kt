package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.drawable.AdaptiveIconDrawable
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
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

        // 1. Settings, from the menu sheet, on its landing (since #134 the phone's Settings opens
        //    on its categories, not on Look and Feel: the nightly's run took the landing's Look
        //    and Feel row for the section and found no swatch), then the Look and Feel section
        //    from the landing's row – the harness's shared flow, each step proven by the chrome's
        //    document (the tree trails the screen here by seconds).
        if (!openSettingsSection(LOOK_SECTION)) error("the Look and Feel section never came up")
        SystemClock.sleep(3_000)

        // 2. The App icon group sits under Appearance: the Indigo swatch (its accessible name
        //    `<name> app icon`, blocks.tsx) scrolled into view through the document, the tree's
        //    node awaited for the click below.
        scrollSwatchIntoView("Indigo")
        if (awaitNode(10_000) { it == swatch("Indigo") } == null) Log.w(tag, "the tree lists no ${swatch("Indigo")} yet")
        reveal(swatch("Indigo"))
        SystemClock.sleep(1_200)
        shot("settings-indigo")

        // 3. Pick Sunset: the ring moves, the row names it, the launcher alias flips underneath –
        //    and the browser stays where it is (the system removes tasks rooted at a disabled
        //    alias; ours is rooted at MainActivity, see LauncherIconActivity).
        val task = activity.taskId
        if (awaitNode(10_000) { it == swatch("Sunset") } == null || !clickByLabel(swatch("Sunset"))) {
            // The tree without the swatch (it trails the document here): the document's own click
            // on the radio is the way to the state; the claim is the alias flip below.
            Log.w(tag, "the tree has no ${swatch("Sunset")} to click; the document's swatch instead")
            if (chromeJs("(function(){var s=document.querySelector('[aria-label=\"${swatch("Sunset")}\"]');if(!s)return false;s.click();return true})()") != "true") error("no Sunset swatch")
        }
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
        //    drawer onto it the way Launcher3's own tests do (press until the drag starts, move in
        //    small steps, lift), then switch the launcher's themed icons on and off around a capture.
        val zen = reveal("Zenium")
        if (zen != null) {
            f.down(zen.exactCenterX(), zen.exactCenterY())
            f.hold(1_200)
            f.moveBy(0f, -NUDGE, 120)
            f.moveBy(0f, -(0.3f * height - NUDGE), 1_200)
            f.hold(800)
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
        // The Android 13 monochrome layer itself, drawn through the OS (what a themed launcher
        // tints), next to the full icon – in case the launcher above did not take the drop.
        saveLayers(launcherIcon)

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

    /**
     * `appicon-<theme>-layers.png`: for every variant, the adaptive icon as the launcher masks it
     * and its monochrome layer as Android 13 hands it to a themed launcher, tinted in the system
     * accent the way Launcher3 does.
     */
    private fun saveLayers(launcherIcon: LauncherIcon) {
        val res = app.resources
        val cell = (56 * density).toInt()
        val pad = (12 * density).toInt()
        val ids = LauncherIconVariants.ALIASES.keys.toList()
        val bitmap = Bitmap.createBitmap(pad + ids.size * (cell + pad), pad * 3 + cell * 2, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(res.getColor(if (THEME == "dark") android.R.color.system_neutral1_900 else android.R.color.system_neutral1_50, app.theme))
        val bg = res.getColor(if (THEME == "dark") android.R.color.system_accent2_800 else android.R.color.system_accent1_100, app.theme)
        val fg = res.getColor(if (THEME == "dark") android.R.color.system_accent1_200 else android.R.color.system_accent1_700, app.theme)
        ids.forEachIndexed { i, id ->
            val x = pad + i * (cell + pad)
            launcherIcon.iconBitmap(id)?.let { icon ->
                canvas.drawBitmap(icon, null, Rect(x, pad, x + cell, pad + cell), null)
            }
            val iconRes = res.getIdentifier("ic_launcher_$id", "mipmap", app.packageName)
            val adaptive = res.getDrawable(iconRes, app.theme) as? AdaptiveIconDrawable ?: return@forEachIndexed
            val mono = adaptive.monochrome ?: return@forEachIndexed
            val y = pad * 2 + cell
            val disc = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = bg }
            canvas.drawCircle(x + cell / 2f, y + cell / 2f, cell / 2f, disc)
            // The monochrome layer covers the 108 dp canvas; the launcher shows its middle 72 dp.
            val inset = (cell * (108 - 72) / 72f / 2f).toInt()
            mono.setBounds(x - inset, y - inset, x + cell + inset, y + cell + inset)
            mono.setTint(fg)
            canvas.save()
            canvas.clipRect(x, y, x + cell, y + cell)
            mono.draw(canvas)
            canvas.restore()
        }
        File(out, "appicon-$THEME-layers.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        Log.i(tag, "layers sheet written for ${ids.size} variants")
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

    /** Scroll the swatch named `name` to the middle of the Settings page through the chrome's document. */
    private fun scrollSwatchIntoView(name: String) {
        val found = chromeJs("(function(){var s=document.querySelector('[aria-label=\"${swatch(name)}\"]');if(!s)return false;s.scrollIntoView({block:'center',behavior:'instant'});return true})()")
        if (found != "true") Log.w(tag, "the document has no ${swatch(name)} to scroll to")
        SystemClock.sleep(800)
    }

    companion object {
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }

        /** The swatch buttons' accessible names (`AppIconGrid`, blocks.tsx: `<name> app icon`). */
        private fun swatch(name: String) = "$name app icon"
    }
}
