package app.zen.chromium

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.SystemClock
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/**
 * The startup scene's first act (W5-16: OS-26 the splash, OS-27 the cold start's speed). The
 * scene itself is the runner's (android-startup-demo.sh): the process gone, `am start -W` from
 * the launcher, the splash held to the chrome's first real frame, the restored tab's picture
 * under the chrome until the page paints, the hot start with neither – an instrumentation
 * shares the app's process and can neither outlive the `am force-stop` a cold start begins with
 * nor begin one. So this driver does what only the process can do for the scene: it boots the
 * browser on the fixture page the runner serves (`fixture`: `http://10.0.2.2:<port>/fixture`,
 * the emulator's host loopback, answered at once now and held during the cold start), waits for
 * the page to paint, sends the browser home so `Host.onPause` writes the tab's picture
 * ([Thumbnails], the card-width JPEG stamped with the document the cold start will restore),
 * checks that picture is on disk under the tab's id and stamped for the fixture, and leaves the
 * runner its notes: the tab's id, the page view's rectangle on the screen (where the runner reads
 * its pixels), the bar's dock, the picture's size. Then it ends – the instrumentation's exit
 * stops the process – and the cold start that follows restores this very session.
 *
 * The one still, `android-startup-seeded.png`, is the chrome with the live fixture page: the
 * look the restored picture is judged against. `-e assert true` fails the act when the picture
 * is not on disk (the scene's premise); otherwise it only reports.
 *
 * The scene's last act is a web app's cold launch (PWA-06: the app's tile on its
 * `background_color`, held to the page's first frame). What only the process can do for it is
 * done here too: the install's record and tile for a fixture app on the runner's `/webapp` page
 * are written where the window reads them ([WebAppStore]; the tile a flat cyan layer the
 * recording tells from the app's purple ground and the page's green), and the notes carry the
 * `am start` arguments of the app's launch intent ([WebAppLauncherActivity.launchIntent],
 * `webapp-start:`) and of the pinned tile's own ([Shortcuts.launchIntent], `tile-start:`: the
 * trampoline's path, as the home screen sends it) for the runner to fire as root once the
 * process is gone. The launcher icon's own path needs no note: the runner fires the launcher's
 * intent at the enabled alias itself.
 */
@RunWith(AndroidJUnit4::class)
class StartupDemo : DemoHarness("startup-demo-state.json", "android-startup", "startup-demo") {
    override val tag = "StartupDemo"
    private val fixture = InstrumentationRegistry.getArguments().getString("fixture") ?: DEFAULT_FIXTURE
    private val assertive = InstrumentationRegistry.getArguments().getString("assert") == "true"
    private lateinit var notes: File
    private var failures = 0

    @Test
    fun record() {
        runDemo()
        if (assertive) assertEquals("the seed's claims did not hold (see android-startup-notes.txt)", 0, failures)
    }

    /** The one tab on the runner's fixture page, the scheme from the run, the hints done. */
    override fun patchState(json: String): String {
        val state = JSONObject(json)
        val tabs = state.getJSONArray("tabs")
        for (i in 0 until tabs.length()) {
            val tab = tabs.getJSONObject(i)
            if (tab.optString("id") == TAB) tab.put("url", fixture)
        }
        state.getJSONObject("settings").put("colorScheme", THEME)
        return state.toString()
    }

    override fun warmUp() {
        notes = File(out, "android-startup-notes.txt")
        val version = runCatching { app.packageManager.getPackageInfo(app.packageName, 0).versionName }.getOrNull() ?: "?"
        notes.writeText("Zenium Android startup seed (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, app $version, theme $THEME)\n\n")
        note("fixture: $fixture")
        val title = waitTitle(20_000) { it.startsWith("SU|") }
        note("seeded tab: $TAB title \"$title\" (${if (title.startsWith("SU|")) "the fixture painted" else "the fixture never answered"})")
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        shot("seeded")
        val host = (activity as MainActivity).host
        val view = host.tabs.get(TAB)
        if (view == null) {
            fail("the seeded tab has a page view")
        } else {
            val rect = IntArray(4)
            instrumentation.runOnMainSync {
                val at = IntArray(2)
                view.getLocationOnScreen(at)
                rect[0] = at[0]; rect[1] = at[1]; rect[2] = at[0] + view.width; rect[3] = at[1] + view.height
            }
            // The runner reads its pixels here: `slot: left top right bottom` in display pixels.
            note("slot: ${rect[0]} ${rect[1]} ${rect[2]} ${rect[3]}")
        }
        note("bar: ${barEdge() ?: "?"}")
        seedWebApp()
        val file = File(File(app.cacheDir, Thumbnails.DIR), "$TAB${Thumbnails.SUFFIX}")
        val before = if (file.isFile) file.lastModified() else 0L
        // Home: Host.onPause takes every page's picture on the way to the background (BH-33's
        // capture) – the one the cold start restores under the chrome.
        shellCommand("input keyevent KEYCODE_HOME")
        val written = poll(8_000) { file.isFile && file.lastModified() > before }
        SystemClock.sleep(1_000)
        val picture = host.thumbnails.loadPicture(TAB, fixture)
        check("the tab's picture was written on the way home", written, if (written) "${file.name}, ${file.length()} B" else "no newer ${file.name} within 8 s")
        check(
            "the picture is stamped for the fixture document",
            picture != null,
            if (picture != null) "${picture.width}x${picture.height}, ${picture.jpeg.size} B" else "loadPicture($TAB, fixture) gave null (another document's, or none)"
        )
        if (picture == null && file.isFile) {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeFile(file.path, bounds)
            note("  the file on disk decodes to ${bounds.outWidth}x${bounds.outHeight}")
        }
        note("\nend: ${if (failures == 0) "the session is seeded for the cold start" else "$failures claim(s) failed"}")
    }

    /**
     * The fixture web app as an install left it: its record and a flat cyan tile under
     * `files/zen/webapps/` (the tile the launch's splash shows, the Recents icon), and the launch
     * intent's `am start` arguments in the notes (`webapp-start:`) – the record as extras, the
     * task URI as data, the flags – so the runner's launch is the tile's own, less the trampoline.
     */
    private fun seedWebApp() {
        val url = fixture.substringBeforeLast('/') + "/webapp"
        val scope = fixture.substringBeforeLast('/') + "/"
        val record = WebAppRecord(
            id = url, name = "Startup fixture app", startUrl = url, scope = scope,
            display = WebAppRules.Display.STANDALONE, themeColor = WEBAPP_THEME, backgroundColor = WEBAPP_BACKGROUND
        )
        val canvas = (ShortcutTile.CANVAS_DP * density).toInt()
        val tile = Bitmap.createBitmap(canvas, canvas, Bitmap.Config.ARGB_8888).apply { eraseColor(WEBAPP_TILE) }
        WebAppStore.save(app, record, tile)
        val saved = WebAppStore.tileFile(app, record.shortcutId)
        check("the web app's record and tile are on disk", WebAppStore.load(app, record.shortcutId) != null && saved.isFile, "${saved.name}, ${saved.length()} B, ${canvas}px")
        note("webapp-start: ${amStartArguments(WebAppLauncherActivity.launchIntent(app, record, url))}")
        // The pinned tile's own intent (Shortcuts.launchIntent: the trampoline, the record as
        // extras), for the runner's tile act – the launch as the home screen sends it.
        note("tile-start: ${amStartArguments(Shortcuts.launchIntent(app, url, record))}")
        note("webapp-colours: ground #%06x tile #%06x theme #%06x".format(WEBAPP_BACKGROUND and 0xffffff, WEBAPP_TILE and 0xffffff, WEBAPP_THEME and 0xffffff))
    }

    /** `am start`'s arguments for `intent`: action, data, component, flags, and the extras as `--es` / `--ei` (single-quoted for the device's shell). */
    private fun amStartArguments(intent: Intent): String {
        val parts = mutableListOf("-a", intent.action.orEmpty(), "-d", quote(intent.dataString.orEmpty()), "-n", intent.component!!.flattenToShortString(), "-f", intent.flags.toString())
        val extras = intent.extras
        if (extras != null) {
            for (key in extras.keySet().sorted()) {
                when (val value = extras.get(key)) {
                    is Int -> { parts += "--ei"; parts += key; parts += value.toString() }
                    is String -> { parts += "--es"; parts += key; parts += quote(value) }
                }
            }
        }
        return parts.joinToString(" ")
    }

    private fun quote(value: String): String = "'" + value.replace("'", "'\\''") + "'"

    /** Poll the seeded tab's title as the core has it until `accept`s it and the tab is not loading. */
    private fun waitTitle(timeoutMs: Long, accept: (String) -> Boolean): String {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var last = ""
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = coreState().getJSONObject("tabs").optJSONObject(TAB)
            last = tab?.optString("title").orEmpty()
            if (tab != null && accept(last) && !tab.optBoolean("loading")) {
                SystemClock.sleep(600)
                return last
            }
            SystemClock.sleep(400)
        }
        return last
    }

    private fun poll(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return true
            SystemClock.sleep(200)
        }
        return condition()
    }

    private fun note(line: String) {
        Log.i(tag, line)
        notes.appendText(line + "\n")
    }

    private fun check(claim: String, holds: Boolean, detail: String) {
        if (!holds) failures++
        note("${if (holds) "PASS" else "FAIL"}: $claim ($detail)")
    }

    private fun fail(claim: String) = check(claim, false, "not so")

    companion object {
        /** The seeded tab's id: the file under `zen-thumbs/` and the id the cold start's `restored picture` lines name. */
        const val TAB = "tab_startup"
        /** The runner's fixture server as the emulator reaches it (its host loopback is 10.0.2.2). */
        const val DEFAULT_FIXTURE = "http://10.0.2.2:18931/fixture"
        /**
         * The fixture web app's colours, the recording's classes (android-startup-frames.mjs): the
         * manifest's `background_color`, the tile, the `theme_color` – the last far from the other
         * two and from the page colours, since the reader knows the app's own window by its bar.
         */
        const val WEBAPP_BACKGROUND = 0xFF7A1FA2.toInt()
        const val WEBAPP_TILE = 0xFF00B8D9.toInt()
        const val WEBAPP_THEME = 0xFFE65100.toInt()
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }
    }
}
