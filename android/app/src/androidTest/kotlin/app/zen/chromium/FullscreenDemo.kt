package app.zen.chromium

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.content.Intent
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.SystemClock
import android.provider.MediaStore
import android.util.Log
import android.view.Surface
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Records fullscreen video and the file chooser's camera (MED-01, GN-20, OS-22) on the phone,
 * on the media demos' base ([MediaDemoBase]: the loopback page server, real fingers on a page's
 * button and on any window's node, picture-in-picture, the notes) with a page of its own
 * (`fullscreen-demo-page.html`): a landscape WebM clip (#223's), a portrait one, an
 * `<input type=file>` for images with the `capture` attribute and a plain one for images.
 *
 *  1. The landscape clip into fullscreen under a finger: the screen turns to landscape (the
 *     display's rotation, `dumpsys window`, the activity's `SENSOR_LANDSCAPE`) and the first-time
 *     exit hint stands along the bottom edge of the page, in its top layer.
 *  2. Back: the layer goes, the screen turns back, the chrome fades in over 120 ms (sampled per
 *     frame in the chrome), the hint is gone; the page's resize count says how often it relaid.
 *  3. The same clip into fullscreen again: no hint the second time.
 *  4. Home while it plays fullscreen: #223's auto-enter into picture-in-picture, the engine's
 *     fullscreen ending as the window goes small (the layer and the orientation given back, the
 *     tab's view filling the small window); the app brought back shows the page inline, portrait.
 *  5. The portrait clip into fullscreen: the screen does not turn.
 *  6. The capture input, the camera refused at the system's prompt (a finger on Don't allow):
 *     the picker alone, and once it is cancelled the toast on why.
 *  7. The capture input again, While using the app under a finger: straight to the camera app
 *     (no chooser), its shutter and Done under fingers, the photo back in the page (name, size).
 *  8. The plain image input: the system chooser with Camera beside the files; Camera under a
 *     finger opens the camera app, Back cancels it, and the photo file it would have written is
 *     gone while the kept one from step 7 stays.
 *  9. The once-key reset and the colour scheme flipped to dark through the core: the hint again,
 *     in the dark palette (the design still beside step 1's light one).
 *
 * The emulator's camera is `-camera-back emulated` (the workflow), so the camera app has one; the
 * permission flow is real (CAMERA revoked after the install, `DEMO_REVOKE`). Every touch a step
 * injects has an assertion on what it did; a check that does not hold fails the run at the end.
 */
@RunWith(AndroidJUnit4::class)
class FullscreenDemo : MediaDemoBase("android-fullscreen") {
    override val tag = "FullscreenDemo"
    private var failures = 0
    /** The camera app behind `ACTION_IMAGE_CAPTURE` on this image (the AOSP one, `com.android.camera2`, on the emulator's). */
    private var cameraApp = "com.android.camera2"

    @Test
    fun record() {
        val page = "text/html; charset=utf-8" to readAsset("fullscreen-demo-page.html").toByteArray()
        server = DemoServer(
            PORT,
            mapOf(
                "/fullscreen" to page,
                "/land.webm" to ("video/webm" to readAssetBytes("media-demo-clip.webm")),
                "/port.webm" to ("video/webm" to readAssetBytes("fullscreen-demo-portrait.webm"))
            )
        ).also { it.start() }
        try {
            runDemo()
        } finally {
            server.close()
        }
        assertEquals("checks that did not hold (see android-fullscreen-notes.txt)", 0, failures)
    }

    /** The media demos' profile with its tab on this demo's page, and the gesture hint already shown (its toast would share the run). */
    override fun patchState(json: String): String {
        val state = JSONObject(json)
        val tabs = state.getJSONArray("tabs")
        for (i in 0 until tabs.length()) {
            val tab = tabs.getJSONObject(i)
            if (tab.optString("id") == TAB) {
                tab.put("url", "http://127.0.0.1:$PORT/fullscreen")
                tab.put("title", "Zenium fullscreen demo")
            }
        }
        state.getJSONObject("settings").put("gestureHintDone", true)
        return state.toString()
    }

    override fun warmUp() {
        notes = File(out, "android-fullscreen-notes.txt")
        notes.writeText("Zenium Android fullscreen video and file chooser camera checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        // The system's one-time "Viewing full screen" notice (a device shows it once, ever) would
        // stand over the video and take the Back of step 2; it counts as seen, as the error pages
        // demo has it.
        shell("settings put secure immersive_mode_confirmations confirmed")
        note("the system's one-time immersive notice counted as seen (settings put secure immersive_mode_confirmations confirmed)")
        note("demo server: ${server.selfCheck()}")
        val webView = runCatching { WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" } }.getOrNull()
        note("webview: ${webView ?: "unknown"}")
        note("picture-in-picture feature: ${host.media.pictureInPictureSupported}")
        Intent(MediaStore.ACTION_IMAGE_CAPTURE).resolveActivity(app.packageManager)?.packageName?.let { cameraApp = it }
        note("camera feature: ${app.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)}; " +
            "ACTION_IMAGE_CAPTURE answered by: ${resolves(MediaStore.ACTION_IMAGE_CAPTURE)}; ACTION_VIDEO_CAPTURE by: ${resolves(MediaStore.ACTION_VIDEO_CAPTURE)}")
        check("CAMERA starts out not granted (DEMO_REVOKE)", !cameraGranted())
        check("the exit hint has not been shown yet", !hintDone())
        waitTitle(TAB, 20_000) { it.startsWith("FS|") }
        note("seeded tab: ${describeTab(TAB)}; rotation ${rotation()}")
        // The clips' metadata, so the first fullscreen has the sizes to turn by.
        poll(10_000) { pageJs("document.getElementById('land').videoWidth") != "0" && pageJs("document.getElementById('port').videoWidth") != "0" }
        note("clips: landscape ${pageJs("document.getElementById('land').videoWidth")}x${pageJs("document.getElementById('land').videoHeight")}, " +
            "portrait ${pageJs("document.getElementById('port').videoWidth")}x${pageJs("document.getElementById('port').videoHeight")}")
        note("capture directory at start: ${captureFiles()}")
        Log.i(tag, "warm-up done")
    }

    override fun demo() {
        shot("00-page")
        landscapeFullscreenWithTheHint()
        backOutWithTheFade()
        secondTimeNoHint()
        homeIntoPictureInPicture()
        portraitStaysPortrait()
        captureRefusedOnce()
        captureGranted()
        chooserWithCameraAndFiles()
        hintInTheDarkScheme()
        note("\nend: fullscreenTab=${host.fullscreenTab?.tabId} rotation ${rotation()} requested ${requested()} capture directory ${captureFiles()}")
    }

    // --- the sequence ----------------------------------------------------------------------------

    /** 1. A finger on "Play landscape fullscreen": the layer, the hint (read while it stands), the turn. */
    private fun landscapeFullscreenWithTheHint() {
        note("\n1. the landscape clip into fullscreen")
        val enteredAt = SystemClock.uptimeMillis()
        tapPageButton("fs-land", "Play landscape fullscreen", "the video goes fullscreen", 15_000) {
            host.fullscreenTab?.tabId == TAB || field("fs") == "1"
        }
        val fullscreenAt = SystemClock.uptimeMillis() - enteredAt
        // The hint first: it stands 2.8 s, less than the emulator takes to turn the screen. Its
        // host element is in the page's top layer, along the bottom edge; it rides in on a spring
        // from below the edge, so its place is read once it has landed.
        val seen = awaitHint(6_000, present = true)
        val seenAt = SystemClock.uptimeMillis() - enteredAt
        val hint = if (seen == null) null else awaitHintAtRest(2_500) ?: seen
        shot("01-landscape-fullscreen-hint")
        shot("design-hint-toast-light")
        note("  fullscreen $fullscreenAt ms after the touch: host fullscreenTab=${host.fullscreenTab?.tabId} page fs=${field("fs")} el=${field("el")} state=${field("state")}")
        check("the first-time exit hint stands in the page", seen != null)
        if (hint != null) {
            val viewport = hint.optDouble("viewportHeight")
            val bottom = hint.optDouble("top") + hint.optDouble("height")
            note("  hint $seenAt ms after the touch; at rest: $hint; top layer through popover: ${hint.optBoolean("popover")}")
            check("the hint is along the bottom edge (a toast, not the top bubble)", viewport - bottom in 0.0..60.0 && hint.optDouble("top") > viewport / 2)
            check("the hint is the one 44 px row", hint.optDouble("height") in 40.0..72.0)
            check("the hint wears the light palette", paletteOf(hint) == "light")
        }
        val turned = poll(10_000) { landscape() }
        note("  screen landscape ${SystemClock.uptimeMillis() - enteredAt} ms after the touch: $turned; rotation ${rotation()}; requestedOrientation ${requested()}; dumpsys window: ${dumpsysRotation()}")
        check("the screen turned to landscape for the landscape clip", turned)
        check("the activity asks for SENSOR_LANDSCAPE", requested() == ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
        check("the host holds the orientation for the video", host.fullscreenLandscape)
        check("the once-key is set (fullscreenHintDone)", poll(4_000) { hintDone() })
        // Its stand is 2.8 s: it goes on its own before the exit below.
        val gone = awaitHint(6_000, present = false) == null
        note("  hint gone on its own: $gone")
        SystemClock.sleep(800)
        shot("02-landscape-fullscreen")
    }

    /** 2. Back: portrait again, the chrome fading in, the hint gone. */
    private fun backOutWithTheFade() {
        note("\n2. back out of fullscreen")
        installFadeSampler()
        val resizesBefore = field("resizes")?.toIntOrNull() ?: 0
        pageJs("window.__resizeMark && window.__resizeMark()")
        val leftAt = SystemClock.uptimeMillis()
        back()
        val left = poll(10_000) { host.fullscreenTab == null }
        shot("03-leaving-fullscreen")
        val portrait = poll(10_000) { !landscape() }
        note("  left fullscreen ${SystemClock.uptimeMillis() - leftAt} ms after back: $left; portrait again: $portrait; rotation ${rotation()}")
        check("back leaves fullscreen", left)
        check("the screen is portrait again", portrait)
        check("the activity's orientation is given back (UNSPECIFIED)", requested() == ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED)
        check("the host no longer holds the orientation", !host.fullscreenLandscape)
        SystemClock.sleep(2_500)
        shot("04-back-in-portrait")
        val samples = fadeSamples()
        val fades = fadeCalls()
        note("  chrome opacity per frame around the return (ms:opacity, the frames under 1 with their neighbours): $samples")
        note("  animate() calls on the chrome window since the back: $fades")
        check("the chrome's return started the 120 ms opacity fade on the window (animate() 0 to 1 over 120 ms)", fades.any(::isTheReturnFade))
        check("the fade was started once", fades.count(::isTheReturnFade) == 1)
        // At the emulator's frame rate (swiftshader) 120 ms is a frame or two: mid-fade frames are noted, not demanded.
        note("  frames with the chrome under full opacity seen: ${samples.contains(":0")}")
        check("the chrome is fully back", chromeOpacity() == "1")
        check("the hint left with the fullscreen", awaitHint(3_000, present = false) == null)
        val resizesAfter = field("resizes")?.toIntOrNull() ?: 0
        note("  the page's resize events over the exit: ${resizesAfter - resizesBefore}; each (ms after the back, the viewport, fullscreen): ${resizeLog()}")
    }

    /** The page's resize events since its last mark (`__resizeMark`), one entry each: when, the viewport's size, whether it was fullscreen. */
    private fun resizeLog(): String {
        val raw = pageJs("window.__resizeLog ? window.__resizeLog() : null")
        val text = (JSONTokener(raw).nextValue() as? String) ?: return "none"
        val all = runCatching { JSONArray(text) }.getOrNull() ?: return "none"
        if (all.length() == 0) return "none"
        return (0 until all.length()).mapNotNull { all.optJSONObject(it) }
            .joinToString(" ") { "${it.optInt("at")}ms:${it.optInt("w")}x${it.optInt("h")}${if (it.optInt("fs") == 1) "(fullscreen)" else ""}" }
    }

    /** 3. Fullscreen again: no hint. */
    private fun secondTimeNoHint() {
        note("\n3. the same clip into fullscreen again")
        tapPageButton("fs-land", "Play landscape fullscreen", "the video goes fullscreen again", 15_000) {
            host.fullscreenTab?.tabId == TAB || field("fs") == "1"
        }
        check("the screen turned to landscape again", poll(10_000) { landscape() })
        val hint = awaitHint(3_500, present = true)
        check("no hint the second time", hint == null)
        shot("05-second-fullscreen-no-hint")
    }

    /**
     * 4. Home while playing fullscreen: #223's auto-enter. The engine hides its custom view as the
     * window goes small (Chrome's fullscreen ends the same way), so the host gives the layer and
     * the orientation back and the tab's own view fills the small window ([TabHost.fillWindow]:
     * one owner of the bounds at a time); the expand brings the page back inline in the chrome,
     * as Chrome does, in portrait.
     */
    private fun homeIntoPictureInPicture() {
        note("\n4. Home while the clip plays fullscreen (#223's auto-enter)")
        if (field("state") != "playing") note("  the clip is not playing (state=${field("state")}); the auto-enter needs it playing")
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
        val auto = awaitPip(true, 10_000)
        check("Home with the video playing fullscreen enters picture-in-picture by itself", auto)
        SystemClock.sleep(1_500)
        note("  in picture-in-picture: $auto; window ${appWindowBounds()} (${ratio(appWindowBounds())}); rotation ${rotation()}; requested ${requested()}; " +
            "host fullscreenTab=${host.fullscreenTab?.tabId} pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling} state=${field("state")}")
        check("in the small window the fullscreen layer is gone and the tab's view fills it (one owner of the bounds)", host.fullscreenTab == null && host.tabs.filling == TAB)
        check("the orientation is given back with the layer (UNSPECIFIED)", requested() == ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED)
        shot("06-pip-auto-enter")
        bringToFront()
        val expanded = awaitPip(false, 8_000)
        val inline = poll(8_000) { host.fullscreenTab == null && host.tabs.filling == null && !landscape() }
        SystemClock.sleep(1_500)
        note("  expanded back: $expanded; inline in the chrome: $inline; rotation ${rotation()}; requested ${requested()}; host fullscreenTab=${host.fullscreenTab?.tabId} pip tab=${host.media.pictureInPictureTab} filling=${host.tabs.filling}; ${describeTab(TAB)}")
        check("the window expands back out of picture-in-picture", expanded)
        check("the page is back inline in the chrome, in portrait, the view filling nothing", inline)
        check("the page is still there after the round trip", field("fs") == "0")
        shot("07-expanded-from-pip")
        // The clip keeps playing behind; pause it so the portrait step's play is the one playing.
        pageJs("document.getElementById('land').pause()")
    }

    /** 5. The portrait clip: fullscreen without a turn. */
    private fun portraitStaysPortrait() {
        note("\n5. the portrait clip into fullscreen")
        tapPageButton("fs-port", "Play portrait fullscreen", "the portrait video goes fullscreen", 15_000) {
            host.fullscreenTab?.tabId == TAB && field("el") == "port"
        }
        val turned = poll(3_000) { landscape() }
        note("  rotation ${rotation()} requested ${requested()} held=${host.fullscreenLandscape} el=${field("el")}")
        check("the screen stays portrait for the portrait clip", !turned)
        check("the activity asks for nothing (UNSPECIFIED)", requested() == ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED)
        check("no hint (shown once already)", awaitHint(2_500, present = true) == null)
        shot("08-portrait-fullscreen")
        back()
        check("back leaves the portrait fullscreen", poll(10_000) { host.fullscreenTab == null })
        SystemClock.sleep(2_000)
        pageJs("document.getElementById('port').pause()")
    }

    /** 6. The capture input, Don't allow: the picker alone, then the toast. */
    private fun captureRefusedOnce() {
        note("\n6. the capture input with the camera refused once")
        watchToasts()
        check("Take a photo (capture) is touched", tapPageButton("cap-label", "Take a photo (capture)", "the system's permission prompt comes up", 12_000) { permissionPromptUp() })
        SystemClock.sleep(800)
        shot("09-camera-permission-prompt")
        check("Don't allow is touched", touchDialog(DENY_LABELS, "the prompt goes") { !permissionPromptUp() })
        val picker = poll(12_000) { foreignInFront() }
        note("  after Don't allow: in front ${frontPackage()}; camera granted=${cameraGranted()}")
        check("the picker alone comes up (the camera is out of the plan)", picker && frontPackage() != cameraApp)
        SystemClock.sleep(1_500)
        dumpWindows("the picker after the refusal")
        shot("10-picker-after-refusal")
        back()
        check("the app is in front again", poll(8_000) { frontPackage() == app.packageName })
        check("the toast says why the camera was left out", awaitToastSeen(DENIED_TOAST, 10_000))
        SystemClock.sleep(600)
        shot("11-refusal-toast")
        check("no file reached the page", field("file") == "none")
        check("no photo file was made for a camera that never ran", captureFiles().isEmpty())
    }

    /** 7. The capture input, While using the app: the camera app, its shutter, Done, the photo in the page. */
    private fun captureGranted() {
        note("\n7. the capture input with the camera allowed")
        check("Take a photo (capture) is touched again", tapPageButton("cap-label", "Take a photo (capture)", "the prompt comes up again", 12_000) { permissionPromptUp() })
        check("While using the app is touched", touchDialog(ALLOW_LABELS, "the permission is granted") { cameraGranted() })
        val camera = poll(20_000) { frontPackage() == cameraApp || (foreignInFront() && !permissionPromptUp()) }
        note("  after the grant: in front ${frontPackage()} (capture-only: no chooser expected)")
        check("the camera app opens straight away (capture-only skips the picker)", camera && frontPackage() == cameraApp)
        SystemClock.sleep(3_000)
        settleCameraApp()
        dumpWindows("the camera app")
        shot("12-camera-app")
        val fileBefore = field("file")
        val shutter = touchCamera(SHUTTER_LABELS, SHUTTER_IDS, "the shutter")
        check("the camera app's shutter is touched", shutter)
        SystemClock.sleep(2_500)
        dumpWindows("the camera app after the shutter")
        shot("13-camera-after-shutter")
        // The camera app's review of the shot (Done), where it has one; some answer at the shutter.
        val returned = poll(6_000) { field("file") != fileBefore && field("file") != "none" }
        if (!returned) {
            val done = touchCamera(DONE_LABELS, DONE_IDS, "Done")
            note("  Done touched: $done")
        }
        val file = poll(15_000) { field("file") != "none" }
        note("  the page: file=${field("file")} size=${field("size")} type=${field("type")} count=${field("count")}; in front ${frontPackage()}")
        check("the photo reached the page", file)
        check("the photo has a size", (field("size")?.toLongOrNull() ?: 0L) > 0L)
        check("the photo is the camera output file (photo-<time>.jpg)", field("file")?.matches(Regex("photo-\\d+\\.jpg")) == true)
        SystemClock.sleep(1_500)
        shot("14-photo-in-the-page")
        note("  capture directory: ${captureFiles()} (the kept photo stays for the upload; swept at a later start)")
        check("the kept photo is in the capture directory", captureFiles().size == 1)
    }

    /** 8. The plain image input: Camera beside the files in the chooser; Camera under a finger, cancelled. */
    private fun chooserWithCameraAndFiles() {
        note("\n8. the plain image input: the chooser")
        check("Choose an image is touched", tapPageButton("pick-label", "Choose an image", "the system chooser comes up", 12_000) { foreignInFront() })
        SystemClock.sleep(2_500)
        dumpWindows("the chooser")
        val cameraEntry = awaitInWindows(8_000) { it == CAMERA_ENTRY }
        val filesEntry = awaitInWindows(3_000) { label -> FILES_ENTRIES.any { it.equals(label, ignoreCase = true) } }
        note("  chooser: in front ${frontPackage()}; Camera entry ${cameraEntry?.let(::bounds)}; files entry ${filesEntry?.let { "${label(it)} ${bounds(it)}" }}")
        check("the chooser offers Camera", cameraEntry != null)
        check("the chooser offers the files beside it", filesEntry != null)
        shot("15-chooser-camera-and-files")
        val kept = captureFiles()
        if (cameraEntry != null) {
            val point = touchTapPoint(cameraEntry)
            val opened = point != null && poll(20_000) { frontPackage() == cameraApp }
            if (point != null && !opened) touchFault("a touch on the chooser's Camera did not open the camera app")
            check("Camera in the chooser opens the camera app", opened)
            SystemClock.sleep(2_000)
            settleCameraApp()
            shot("16-camera-from-chooser")
            back()
            check("back cancels the camera", poll(10_000) { frontPackage() == app.packageName })
            SystemClock.sleep(1_500)
            val now = captureFiles()
            note("  after the cancel: capture directory $now (before the chooser: $kept)")
            check("the cancelled capture's file is gone, the kept photo stays", now == kept)
        } else {
            back()
            poll(8_000) { frontPackage() == app.packageName }
        }
        check("the page still shows the earlier photo", field("file")?.matches(Regex("photo-\\d+\\.jpg")) == true)
        shot("17-end")
    }

    /**
     * 9. The hint under the dark colour scheme, for the design still: the once-key reset and the
     * scheme flipped through the core (`settings.update`), the landscape clip into fullscreen
     * again, the hint in the dark palette, Back, the scheme given back.
     */
    private fun hintInTheDarkScheme() {
        note("\n9. the hint under the dark colour scheme (design still)")
        coreInvoke("settings.update", """{"colorScheme":"dark","fullscreenHintDone":false}""")
        check("the once-key is reset through settings.update", poll(4_000) { !hintDone() })
        SystemClock.sleep(1_000)
        tapPageButton("fs-land", "Play landscape fullscreen", "the video goes fullscreen under the dark scheme", 15_000) {
            host.fullscreenTab?.tabId == TAB || field("fs") == "1"
        }
        poll(10_000) { landscape() }
        val seen = awaitHint(6_000, present = true)
        val hint = if (seen == null) null else awaitHintAtRest(2_500) ?: seen
        shot("design-hint-toast-dark")
        check("the hint stands again once its key is reset", seen != null)
        note("  hint under dark: $hint")
        check("the hint wears the dark palette", hint != null && paletteOf(hint) == "dark")
        check("the once-key is set again", poll(4_000) { hintDone() })
        awaitHint(6_000, present = false)
        back()
        check("back leaves fullscreen under the dark scheme", poll(10_000) { host.fullscreenTab == null })
        poll(10_000) { !landscape() }
        coreInvoke("settings.update", """{"colorScheme":"light"}""")
        SystemClock.sleep(1_500)
        shot("18-light-again")
    }

    // --- the screen ------------------------------------------------------------------------------

    private fun rotation(): Int {
        var value = -1
        instrumentation.runOnMainSync {
            value = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) activity.display?.rotation ?: -1
            else @Suppress("DEPRECATION") activity.windowManager.defaultDisplay.rotation
        }
        return value
    }

    /** The screen is landscape: by the display's rotation and the activity's configuration together. */
    private fun landscape(): Boolean {
        var configLandscape = false
        instrumentation.runOnMainSync {
            configLandscape = activity.resources.configuration.orientation == Configuration.ORIENTATION_LANDSCAPE
        }
        val r = rotation()
        return configLandscape && (r == Surface.ROTATION_90 || r == Surface.ROTATION_270)
    }

    private fun requested(): Int {
        var value = 0
        instrumentation.runOnMainSync { value = activity.requestedOrientation }
        return value
    }

    /** The rotation lines of `dumpsys window displays`, the system's own word. */
    private fun dumpsysRotation(): String {
        val dump = shell("dumpsys window displays")
        return dump.lineSequence().filter { it.contains("Rotation", ignoreCase = true) && !it.contains("mRotationAnim") }
            .map { it.trim().take(120) }.take(3).joinToString(" | ").ifEmpty { "no rotation line" }
    }

    // --- the hint --------------------------------------------------------------------------------

    private fun hint(): JSONObject? {
        val raw = pageJs("window.__hint ? window.__hint() : null")
        val text = (JSONTokener(raw).nextValue() as? String) ?: return null
        return runCatching { JSONObject(text) }.getOrNull()
    }

    /** Poll for the hint to be there (`present`) or gone; the hint as last seen, or null when none. */
    private fun awaitHint(timeoutMs: Long, present: Boolean): JSONObject? {
        var last: JSONObject? = null
        poll(timeoutMs) {
            last = hint()
            (last != null) == present
        }
        return last
    }

    /** The hint once its spring has landed (`translateY` within 2 px of 0, or no transform under reduced motion); null when it never does in time. */
    private fun awaitHintAtRest(timeoutMs: Long): JSONObject? {
        var last: JSONObject? = null
        val landed = poll(timeoutMs) {
            last = hint()
            val transform = last?.optString("transform").orEmpty()
            val y = Regex("translateY\\((-?[0-9.]+)px\\)").find(transform)?.groupValues?.get(1)?.toDoubleOrNull()
            last != null && (transform.isEmpty() || (y != null && kotlin.math.abs(y) < 2.0))
        }
        return if (landed) last else null
    }

    private fun hintDone(): Boolean = coreState().getJSONObject("settings").optBoolean("fullscreenHintDone")

    /**
     * The palette the hint wears, by its host's text colour (the panel sits in a closed shadow
     * root the page cannot read): `#15141a` in light, `#fbfbfe` in dark (`HINT_PALETTE`).
     */
    private fun paletteOf(hint: JSONObject): String = when (hint.optString("color").replace(" ", "")) {
        "rgb(21,20,26)" -> "light"
        "rgb(251,251,254)" -> "dark"
        else -> "unknown(${hint.optString("color")})"
    }

    // --- the chrome's fade -----------------------------------------------------------------------

    /**
     * Sample the chrome window's opacity every frame (some seconds' worth) so the 120 ms fade is
     * on record, and log every `animate()` the window starts (its keyframes and timing: the fade
     * itself, whatever the frame rate makes of it).
     */
    private fun installFadeSampler() {
        chromeJs(
            "(function(){window.__fade=[];window.__fadeCalls=[];window.__fadeT0=performance.now();var t0=window.__fadeT0;" +
                "if(!window.__fadeHooked){window.__fadeHooked=true;var orig=Element.prototype.animate;" +
                "Element.prototype.animate=function(k,o){if(this.classList&&this.classList.contains('zen-window'))" +
                "window.__fadeCalls.push({at:Math.round(performance.now()-window.__fadeT0),keyframes:k,options:o});return orig.apply(this,arguments)}}" +
                "(function s(){var w=document.querySelector('.zen-window');" +
                "window.__fade.push(Math.round(performance.now()-t0)+':'+(w?getComputedStyle(w).opacity:'none'));" +
                "if(window.__fade.length<900)requestAnimationFrame(s)})()})()"
        )
    }

    /** The `animate()` calls the chrome window made since the sampler went in (`at`, `keyframes`, `options`). */
    private fun fadeCalls(): List<JSONObject> {
        val raw = chromeJs("JSON.stringify(window.__fadeCalls||[])")
        val text = (JSONTokener(raw).nextValue() as? String) ?: return emptyList()
        val all = runCatching { JSONArray(text) }.getOrNull() ?: return emptyList()
        return (0 until all.length()).mapNotNull { all.optJSONObject(it) }
    }

    /**
     * Whether an `animate()` call is the chrome's return fade: opacity 0 to 1 over 120 ms
     * (`useFullscreenReturn`; the options may be the bare duration).
     */
    private fun isTheReturnFade(call: JSONObject): Boolean {
        val duration = call.optJSONObject("options")?.optInt("duration") ?: call.optInt("options")
        val frames = call.optJSONArray("keyframes") ?: return false
        if (frames.length() < 2) return false
        val first = frames.optJSONObject(0)?.optDouble("opacity", -1.0) ?: -1.0
        val last = frames.optJSONObject(frames.length() - 1)?.optDouble("opacity", -1.0) ?: -1.0
        return duration == 120 && first == 0.0 && last == 1.0
    }

    /** The samples where the chrome was not fully opaque, with a neighbour on each side. */
    private fun fadeSamples(): String {
        val raw = chromeJs("JSON.stringify(window.__fade||[])")
        val text = (JSONTokener(raw).nextValue() as? String) ?: return "none"
        val all = runCatching { org.json.JSONArray(text) }.getOrNull() ?: return "none"
        val samples = (0 until all.length()).map { all.getString(it) }
        val kept = LinkedHashSet<Int>()
        samples.forEachIndexed { i, s ->
            val opacity = s.substringAfter(':').toDoubleOrNull()
            if (opacity != null && opacity < 1.0) { kept += maxOf(0, i - 1); kept += i; kept += minOf(samples.size - 1, i + 1) }
        }
        val picked = kept.sorted().map { samples[it] }
        val missing = samples.count { it.endsWith(":none") }
        return "${samples.size} frames${if (missing > 0) " ($missing without the window)" else ""}; ${if (picked.isEmpty()) "every frame at 1" else picked.joinToString(" ")}"
    }

    private fun chromeOpacity(): String {
        val raw = chromeJs("(function(){var w=document.querySelector('.zen-window');return w?getComputedStyle(w).opacity:'none'})()")
        return (JSONTokener(raw).nextValue() as? String) ?: raw
    }

    // --- the chooser, the prompt, the camera app ---------------------------------------------------

    private fun cameraGranted(): Boolean =
        ContextCompat.checkSelfPermission(app, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun resolves(action: String): String =
        Intent(action).resolveActivity(app.packageManager)?.flattenToShortString() ?: "nothing"

    /**
     * The package in front: the active window's root or, when the automation has none (the
     * camera app's viewfinder stood in front of run 2 with `rootInActiveWindow` null while its
     * window was plainly in the windows list), the foremost application window's root.
     */
    private fun frontPackage(): String {
        ui.rootInActiveWindow?.packageName?.let { return it.toString() }
        val foremost = ui.windows.filter { it.type == AccessibilityWindowInfo.TYPE_APPLICATION }
            .sortedWith(compareByDescending<AccessibilityWindowInfo> { it.isActive }.thenByDescending { it.isFocused }.thenByDescending { it.layer })
            .firstOrNull()
        return foremost?.root?.packageName?.toString() ?: "?"
    }

    private fun foreignInFront(): Boolean {
        val front = frontPackage()
        return front != "?" && front != app.packageName
    }

    private fun permissionPromptUp(): Boolean =
        frontPackage().contains("permissioncontroller") || findInWindows { label -> (DENY_LABELS + ALLOW_LABELS).any { sameLabel(label, it) } } != null

    private fun captureFiles(): List<String> =
        File(app.cacheDir, CapturedPhotos.DIR).listFiles()?.map { "${it.name} (${it.length()} B)" }?.sorted() ?: emptyList()

    /**
     * The camera app's own first words, where it has them (AOSP's Camera2 asks "Remember photo
     * locations?" on its first start, and a camera app may ask for its own permissions): a
     * finger on the way past, noted; nothing when the app went straight to its viewfinder.
     */
    private fun settleCameraApp() {
        repeat(3) {
            val node = awaitInWindows(2_500) { label -> CAMERA_APP_DIALOG_LABELS.any { sameLabel(label, it) } } ?: return
            val text = label(node)
            val point = touchTapPoint(node) ?: return
            note("  the camera app asked something; finger on '$text' at ${point.x.toInt()},${point.y.toInt()}")
            SystemClock.sleep(1_500)
        }
    }

    /**
     * A real touch on the first of `labels` in the window in front (the system's prompt spells
     * "Don't" with a typographic apostrophe on recent releases), then `took`; false and a fault
     * when the touch went in and nothing came of it, false and a note when nothing read a label.
     */
    private fun touchDialog(labels: List<String>, effect: String, took: () -> Boolean): Boolean {
        val node = awaitInWindows(8_000) { label -> labels.any { sameLabel(label, it) } } ?: run {
            note("  none of $labels in any window")
            dumpWindows("looking for $labels")
            return false
        }
        val point = touchTapPoint(node) ?: run {
            note("  '${label(node)}' has no bounds a finger can reach")
            return false
        }
        if (poll(8_000, took)) {
            note("  finger on '${label(node)}' at ${point.x.toInt()},${point.y.toInt()}: $effect")
            return true
        }
        touchFault("a touch on '${label(node)}' did not take: not $effect")
        return false
    }

    /**
     * A real touch on the camera app's control read by one of `labels` or, where its tree names
     * none, by one of its view ids `ids`; false when neither is found (the windows dumped).
     */
    private fun touchCamera(labels: List<String>, ids: List<String>, what: String): Boolean {
        val node = awaitInWindows(8_000) { label -> labels.any { sameLabel(label, it) } } ?: findViewId(ids, 4_000) ?: run {
            note("  $what: nothing reads $labels and no view id in $ids")
            dumpWindows("looking for $what")
            return false
        }
        val point = touchTapPoint(node) ?: run {
            note("  $what ('${label(node)}' ${node.viewIdResourceName}) has no bounds a finger can reach")
            return false
        }
        note("  finger on $what ('${label(node)}' ${node.viewIdResourceName}) at ${point.x.toInt()},${point.y.toInt()}")
        return true
    }

    private fun findViewId(ids: List<String>, timeoutMs: Long): AccessibilityNodeInfo? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            for (window in ui.windows) {
                val root = window.root ?: continue
                for (id in ids) {
                    root.findAccessibilityNodeInfosByViewId(id).firstOrNull()?.let { return it }
                }
            }
            SystemClock.sleep(250)
        }
        return null
    }

    private fun sameLabel(a: String, b: String): Boolean =
        a.replace('\u2019', '\'').trim().equals(b.replace('\u2019', '\''), ignoreCase = true)

    // --- findings --------------------------------------------------------------------------------

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        note("  ${if (ok) "PASS" else "FAIL"}  $what")
    }

    companion object {
        /** The chooser's entry for `ACTION_IMAGE_CAPTURE`: the camera app's label. */
        private const val CAMERA_ENTRY = "Camera"
        private val FILES_ENTRIES = listOf("Files", "Documents", "Gallery", "Photos", "Media")
        /** The toast for the camera refused this once (`FileChooserPlan.cameraRefusedMessage`). */
        private const val DENIED_TOAST = "Camera access is needed to take a photo"
        /** The system prompt's buttons, by release (API 30+ first). */
        private val DENY_LABELS = listOf("Don't allow", "Deny")
        private val ALLOW_LABELS = listOf("While using the app", "Only this time", "Allow")
        /** The camera app's shutter and its review's Done, by label and by view id. */
        private val SHUTTER_LABELS = listOf("Shutter", "Take photo", "Capture", "Take picture")
        private val SHUTTER_IDS = listOf("com.android.camera2:id/shutter_button", "com.android.camera:id/shutter_button")
        private val DONE_LABELS = listOf("Done", "OK", "Accept", "Use photo")
        private val DONE_IDS = listOf("com.android.camera2:id/done_button", "com.android.camera:id/btn_done")
        /** What a camera app's own first-start dialog offers: the way past it without a location or a grant. */
        private val CAMERA_APP_DIALOG_LABELS = listOf("No thanks", "NO THANKS", "While using the app", "Only this time", "Allow", "Got it")
    }
}
