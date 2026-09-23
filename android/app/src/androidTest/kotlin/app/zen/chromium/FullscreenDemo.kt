package app.zen.chromium

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.app.UiAutomation
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
 * Records fullscreen video and the file chooser's camera (MED-01, GN-20, OS-22; the exit toast
 * MED-03 and rotate-to-fullscreen MED-02; the enter and exit's motion measured, MOT-32) on the
 * phone, on the media demos' base ([MediaDemoBase]: the loopback page server, real fingers on a page's
 * button and on any window's node, picture-in-picture, the notes) with a page of its own
 * (`fullscreen-demo-page.html`): a landscape WebM clip (#223's), a portrait one, a same-origin
 * `<iframe>` with the landscape clip in its own document (`fullscreen-demo-embed.html`, an
 * embedded player's shape), a canvas, an `<input type=file>` for images with the `capture`
 * attribute and a plain one for images.
 *
 *  1. The landscape clip into fullscreen under a finger: the screen turns to landscape (the
 *     display's rotation, `dumpsys window`, the activity's `SENSOR_LANDSCAPE`) and the first-time
 *     exit hint stands along the bottom edge of the page, in its top layer.
 *  2. Back: the layer goes, the screen turns back, the chrome fades in over 120 ms (sampled per
 *     frame in the chrome), the hint is gone; the page's resize events are logged one by one –
 *     none may lay it out beyond the portrait window (`TabHost.setBounds` refuses the chrome's
 *     stale landscape frame, BH-32) – and the fade's start is placed against the page's landing.
 *  3. The same clip into fullscreen again: no hint the second time; the enter and the exit are
 *     the performance program's two measured scenes (`traceFrames`: `fullscreen-enter`,
 *     `fullscreen-exit`), then the clip goes fullscreen a third time for step 4.
 *  4. Home while it plays fullscreen: #223's auto-enter into picture-in-picture, the engine's
 *     fullscreen ending as the window goes small (the layer and the orientation given back, the
 *     tab's view filling the small window); the app brought back shows the page inline, portrait.
 *  5. The portrait clip into fullscreen: the screen does not turn.
 *  6. The capture input, the camera refused at the system's prompt (a finger on Don't allow):
 *     the picker alone, and once it is cancelled the toast on why – the chrome's toast card,
 *     measured against its frame for the hint's twin to be held to (§9.33).
 *  7. The capture input again, While using the app under a finger: straight to the camera app
 *     (no chooser), its shutter and Done under fingers, the photo back in the page (name, size).
 *  8. The plain image input: the system chooser with Camera beside the files; Camera under a
 *     finger opens the camera app, its shutter and Done under fingers, the photo back in the page
 *     through the chooser; the chooser again, Camera, and Back cancels it: the photo file it
 *     would have written is gone while the kept ones stay.
 *  9. The once-key reset and the colour scheme flipped to dark through the core: the hint again,
 *     in the dark palette (the design still beside step 1's light one).
 * 10. The embed: a finger on the iframe's clip takes it fullscreen from the frame's document (the
 *     main document's fullscreen element is the `<iframe>`, with no video in its subtree): the
 *     frame's own size report turns the screen, and the hint (its key reset) stands.
 * 11. The canvas: fullscreen with no video in it: the exit toast (its key reset) stands all the
 *     same, in the light palette (the design still), the screen does not turn, and the toast
 *     goes on its own after its stand.
 * 12. The canvas again with the key left set, under the dark scheme: the toast stands every time
 *     for an element that is not a video (MED-03, the design still in dark), and a real finger
 *     on the page takes it down at once; Back exits.
 * 13. Rotate-to-fullscreen (MED-02): the landscape clip given the browser's controls and playing
 *     inline goes fullscreen when the screen is turned to landscape (`setRotation`; the engine's
 *     own rotate delegate, on in WebView for a phone as in Chrome); with auto-rotate on and the
 *     device turned to match (`Host.onDeviceAngle`, the emulator's sensor cannot be turned) the
 *     host's lock gives way to the sensor a second on and the screen turning back exits. A
 *     paused clip is left alone by the turn; the portrait clip goes fullscreen on the turn to
 *     portrait, with no lock, and leaves on the turn to landscape. The rotation is given back as
 *     it was found, nothing fullscreen.
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
        val embed = "text/html; charset=utf-8" to readAsset("fullscreen-demo-embed.html").toByteArray()
        server = DemoServer(
            PORT,
            mapOf(
                "/fullscreen" to page,
                // The same origin as the page: the frame's document is the page's own, as a site's
                // own player embed is; the fullscreen report the frame sends is the one A2 lets through.
                "/embed" to embed,
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
        // The embed's document has the clip too; its size is the frame's own report (step 10).
        poll(10_000) { embedState()?.optInt("videoWidth") ?: 0 > 0 }
        note("embed: ${embedState()}")
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
        embedFullscreenTurnsAndHints()
        canvasFullscreenHints()
        canvasToastEveryTimeAndAtTheTouch()
        rotateToFullscreen()
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
            // The card's place is its layout's: a read that caught it moving (runs 4 and 5, on the
            // emulator's stalled frames: the spring in or out is a translateY on the host element
            // and nothing else) has the travel taken out again.
            val travel = translateYOf(hint)
            val restBottom = viewport - bottom + travel
            note("  hint $seenAt ms after the touch; ${if (travel == 0.0) "at rest" else "read under translateY(${travel}px), its rest ${travel}px up"}: $hint; top layer through popover: ${hint.optBoolean("popover")}")
            check("the hint is along the bottom edge (a toast, not the top bubble)", restBottom in 0.0..60.0 && hint.optDouble("top") - travel > viewport / 2)
            check("the hint is the one 44 px row", hint.optDouble("height") in 40.0..72.0)
            check("the hint wears the light palette", paletteOf(hint) == "light")
            // The lead's L1, the hint's half: its card against the page's viewport (the frame it is
            // in), as the toast card is measured against its frame in step 6.
            val vw = hint.optDouble("viewportWidth")
            note("  L1: the hint's card: left ${hint.optDouble("left")}, right ${vw - hint.optDouble("left") - hint.optDouble("width")}, bottom $restBottom" +
                (if (travel != 0.0) " (read ${viewport - bottom} under translateY(${travel}px))" else "") +
                ", height ${hint.optDouble("height")}, width ${hint.optDouble("width")} of $vw")
            check("L1: the hint's card is 8 px inside the viewport's sides and bottom, one 44 px row",
                near(hint.optDouble("left"), TOAST_INSET) && near(vw - hint.optDouble("left") - hint.optDouble("width"), TOAST_INSET) &&
                    near(restBottom, TOAST_INSET) && near(hint.optDouble("height"), TOAST_ROW))
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
        // The sampler's clock started inside the call above: the driver's own reading of it is a
        // little behind, which puts the landing's start (below) a little early – the lenient way.
        val samplerAt = SystemClock.uptimeMillis()
        val resizesBefore = field("resizes")?.toIntOrNull() ?: 0
        pageJs("window.__resizeMark && window.__resizeMark()")
        val leftAt = SystemClock.uptimeMillis()
        back()
        val left = poll(10_000) { host.fullscreenTab == null }
        // The landing began when the host's exit reached the chrome (useFullscreenReturn starts
        // LANDING_TIMEOUT_MS there): read here up to a poll step late, so a step is given back.
        val leftSeenOnSampler = (SystemClock.uptimeMillis() - POLL_STEP_MS - samplerAt).coerceAtLeast(0)
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
        val resizes = resizeEntries()
        note("  the page's resize events over the exit: ${resizesAfter - resizesBefore}; each (ms after the back, the viewport, fullscreen): ${resizeLog(resizes)}")
        // The portrait window in CSS px (the emulator's 720 x 1600 at 1.75 is 411 x 914). Run 3's
        // exit laid the page out 806 x 324 for ~0.9 s: the chrome's stale landscape measurement,
        // which TabHost.setBounds now refuses; no frame may be wider or taller than the window.
        val windowW = kotlin.math.ceil(width / density).toInt()
        val windowH = kotlin.math.ceil(height / density).toInt()
        val oversized = resizes.filter { it.optInt("w") > windowW + 1 || it.optInt("h") > windowH + 1 }
        note("  the portrait window is ${windowW}x$windowH CSS px; frames beyond it: ${if (oversized.isEmpty()) "none" else resizeLog(oversized)}")
        check("no resize laid the page out beyond the portrait window (TabHost.setBounds refuses the stale landscape frame, BH-32)", oversized.isEmpty())
        // MOT-32: the host holds the tab's frame through the landing, so the page is laid out once
        // for the exit – the portrait window – rather than for every stage of the chrome's return
        // (before it: four, the stale landscape frame among them). A second resize is the fit's
        // re-judgement at the hold's release, a pixel's worth; more is the hold gone.
        check("the exit lays the page out at most twice (the host holds the frame through the landing, MOT-32)", resizesAfter - resizesBefore in 1..2)
        // The lead's L2: the chrome's fade starts once the page has landed inline, not over the
        // hand-back. The landing is the page's last resize that fits the window – the page's own
        // fullscreen flag may still be up at it (the resize is dispatched before the
        // fullscreenchange, MOT-32's one layout coming as the layer goes); both clocks were started
        // just before the back (the sampler's a few ms ahead).
        val landing = resizes.lastOrNull { it.optInt("w") <= windowW + 1 && it.optInt("h") <= windowH + 1 }
        val fadeAt = fades.firstOrNull(::isTheReturnFade)?.optInt("at")
        note("  L2: the page's inline landing at ${landing?.optInt("at")} ms (${landing?.let { "${it.optInt("w")}x${it.optInt("h")}" }}); the fade's animate() at $fadeAt ms; " +
            "the fade ${if (landing != null && fadeAt != null) (if (fadeAt >= landing.optInt("at")) "follows the landing by ${fadeAt - landing.optInt("at")} ms" else "leads the landing by ${landing.optInt("at") - fadeAt} ms") else "or the landing unread"}")
        check("the chrome's fade starts on the page's landing, not before it (L2)", landing != null && fadeAt != null && fadeAt >= landing.optInt("at"))
        // The chrome's own account, on the fade's clock (lib/fullscreenLanding.ts): the bars
        // settling and at rest, the placements it reported, the sizes the host drew. The landing
        // is `hasLanded`'s: the bars at rest, the tab's placement laid out on settled insets (no
        // `~`) and the host's drawn size equal to it (a pixel's tolerance) – the first entry of the
        // store's account that says so. MOT-32 keeps the placement from before the fullscreen
        // through the exit (`beginLanding(keepPlacement)`), so the landing is no longer the
        // placement's return from empty but its settling at the host's size.
        val story = landingLog()
        note("  L2: the landing store (ms: settling, placed, sized): ${story.joinToString(" ") { "${it.optInt("at")}: ${it.opt("settling")} ${it.optJSONArray("placed")} ${it.optJSONArray("sized")}" }.ifEmpty { "nothing logged" }}")
        val settledAt = story.firstOrNull { it.opt("settling") == false && story.indexOf(it) > 0 && story[story.indexOf(it) - 1].opt("settling") == true }?.optInt("at")
            ?: story.firstOrNull { it.opt("settling") == false }?.optInt("at")
        val sizedAt = story.zipWithNext().lastOrNull { (a, b) -> a.optJSONArray("sized")?.toString() != b.optJSONArray("sized")?.toString() }?.second?.optInt("at")
            ?: story.firstOrNull()?.optInt("at")
        val landedAt = story.firstOrNull { it.opt("settling") == false && landedIn(it) }?.optInt("at")
        // The fade waits on the landing for LANDING_TIMEOUT_MS at most (lib/fullscreenLanding.ts)
        // and goes on that clock when the host is slower – the nightly's run 35728999647: the
        // landing begun at 2739 ms, the fade at 5240 (the 2500 ms cap), the host's frame at the
        // placed size at 5431. That is the product's designed cap on a host too slow for it (the
        // emulator's software GPU), not a fade over the shrink, so the one check is two: the fade
        // never EARLIER than the landing or the cap (hard), and the landing itself inside the cap
        // (the software renderer's bound: noted). The landing began when the host's exit reached
        // the chrome: the earlier of the store's first word after the back and the driver's own
        // sight of the layer gone (leftSeenOnSampler), the lenient way for the cap.
        val landingBeganAt = listOfNotNull(story.firstOrNull()?.optInt("at"), leftSeenOnSampler.toInt()).minOrNull()
        val capAt = landingBeganAt?.let { it + LANDING_TIMEOUT_MS - CLOCK_TOLERANCE_MS }
        val onTheCap = fadeAt != null && capAt != null && landedAt != null && fadeAt < landedAt && fadeAt >= capAt
        note("  L2: the bars at rest at $settledAt ms; the host's last size drawn at $sizedAt ms; the placement settled at the drawn size (hasLanded) at $landedAt ms; the landing begun at $landingBeganAt ms; the fade at $fadeAt ms (one clock)${if (onTheCap) " – on the landing's $LANDING_TIMEOUT_MS ms cap, the host's frame ${landedAt!! - fadeAt!!} ms behind it" else ""}")
        check("the chrome's fade starts on the landing – the bars at rest, the placement settled at the host's drawn size – or on the landing's $LANDING_TIMEOUT_MS ms cap – never over the shrink (L2, the chrome's clock)",
            fadeAt != null && landedAt != null && (fadeAt >= landedAt || (capAt != null && fadeAt >= capAt)))
        note("  ${if (fadeAt != null && landedAt != null && fadeAt >= landedAt) "PASS " else "SOFT MISS"}  the landing came inside its cap (a software renderer's bound: noted, not enforced)")
    }

    /** The tab's entry in a landing-store list (`tab:WxH`, a placement laid out on settling bars ending in `~`): width, height, settled. */
    private fun landingSize(list: JSONArray?, tab: String): Triple<Int, Int, Boolean>? {
        if (list == null) return null
        for (i in 0 until list.length()) {
            val entry = list.optString(i)
            if (!entry.startsWith("$tab:")) continue
            val dims = entry.removePrefix("$tab:").removeSuffix("~").split("x")
            val w = dims.getOrNull(0)?.toIntOrNull() ?: return null
            val h = dims.getOrNull(1)?.toIntOrNull() ?: return null
            return Triple(w, h, !entry.endsWith("~"))
        }
        return null
    }

    /** `hasLanded`'s placement half for an entry of the landing store's account: the tab's placement settled and the host's drawn size equal to it. */
    private fun landedIn(entry: JSONObject): Boolean {
        val placed = landingSize(entry.optJSONArray("placed"), TAB) ?: return false
        val sized = landingSize(entry.optJSONArray("sized"), TAB) ?: return false
        return placed.third && kotlin.math.abs(placed.first - sized.first) <= 1 && kotlin.math.abs(placed.second - sized.second) <= 1
    }

    /** The page's resize events since its last mark (`__resizeMark`), one entry each: when, the viewport's size, whether it was fullscreen. */
    private fun resizeEntries(): List<JSONObject> {
        val raw = pageJs("window.__resizeLog ? window.__resizeLog() : null")
        val text = (JSONTokener(raw).nextValue() as? String) ?: return emptyList()
        val all = runCatching { JSONArray(text) }.getOrNull() ?: return emptyList()
        return (0 until all.length()).mapNotNull { all.optJSONObject(it) }
    }

    private fun resizeLog(entries: List<JSONObject>): String =
        if (entries.isEmpty()) "none"
        else entries.joinToString(" ") { "${it.optInt("at")}ms:${it.optInt("w")}x${it.optInt("h")}${if (it.optInt("fs") == 1) "(fullscreen)" else ""}" }

    /**
     * 3. Fullscreen again: no hint – and the two scenes the performance program measures (PERF-5's
     * method, `traceFrames`: HWUI's frames and the chrome WebView's Chromium trace, the renderer
     * main thread's layouts, paints and style recalculations per frame and its long tasks). The
     * enter: the finger on the page's button to the layer up, the screen turned and a second of
     * rest. The exit: Back to the layer gone, the screen back and the chrome's return landed
     * (its fade waits on the landing for `LANDING_TIMEOUT_MS` at most). Only host-side reads
     * inside the blocks (`host.fullscreenTab`, the display's rotation): a read of the page or the
     * chrome would be renderer work the user did not ask for. The clip goes fullscreen a third
     * time after the measured exit, for step 4's Home.
     */
    private fun secondTimeNoHint() {
        note("\n3. the same clip into fullscreen again (no hint; the enter and the exit measured)")
        val button = pageElementRect("fs-land")?.let { touchPoint(it) }
        check("the page's button is where a finger can reach it", button != null)
        if (button == null) return
        val enter = traceFrames("fullscreen-enter", JankBudget.Kind.OPEN) {
            Finger().tap(button.x, button.y)
            poll(15_000) { host.fullscreenTab?.tabId == TAB }
            poll(10_000) { landscape() }
            SystemClock.sleep(SCENE_REST_MS)
        }
        check("the video went fullscreen again", host.fullscreenTab?.tabId == TAB)
        check("the screen turned to landscape again", landscape())
        val hint = awaitHint(3_500, present = true)
        check("no hint the second time", hint == null)
        shot("05-second-fullscreen-no-hint")
        val exit = traceFrames("fullscreen-exit", JankBudget.Kind.OPEN) {
            back()
            poll(10_000) { host.fullscreenTab == null }
            poll(10_000) { !landscape() }
            SystemClock.sleep(LANDING_TIMEOUT_MS + SCENE_REST_MS)
        }
        check("back left the measured fullscreen", host.fullscreenTab == null && !landscape())
        note("  the scenes: enter ${enter.summary?.frames ?: 0} frames in ${enter.durationMs} ms, exit ${exit.summary?.frames ?: 0} frames in ${exit.durationMs} ms; the tables in frames.txt")
        shot("05b-after-the-measured-exit")
        // In again, for step 4's Home while it plays fullscreen.
        tapPageButton("fs-land", "Play landscape fullscreen", "the video goes fullscreen a third time", 15_000) {
            host.fullscreenTab?.tabId == TAB || field("fs") == "1"
        }
        check("the screen turned to landscape a third time", poll(10_000) { landscape() })
        SystemClock.sleep(1_000)
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
        // The lead's L1: the chrome's toast card as this device lays it out, against its frame,
        // beside the hint's twin from step 1 (`__hint`: the same insets and row are demanded).
        val card = awaitToastCardAtRest(4_000)
        note("  L1: the chrome's toast card at rest: $card")
        if (card != null) {
            check("L1: the toast card is 8 px inside its frame's sides and bottom, one 44 px row", cardInsetsAre(card, TOAST_INSET, TOAST_ROW))
            check("L1: the toast card's radius, type and padding are §9.33's (8 px; 15/20 at 400; 3 px 14 px)",
                card.optString("radius") == "8px" && card.optString("font") == "15px/20px 400" && card.optString("padding").startsWith("3px 14px"))
        } else {
            check("L1: the toast card is there to be measured", false)
        }
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

    /**
     * 8. The plain image input: Camera beside the files in the chooser. First the round trip
     * through Camera (the shutter, Done, the photo in the page: the `EXTRA_INITIAL_INTENTS`
     * entry carries the output URI and its grant as Chrome's does); then Camera again, cancelled.
     */
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
        val earlier = field("file")
        val keptBefore = captureFiles()
        if (cameraEntry == null) {
            back()
            poll(8_000) { frontPackage() == app.packageName }
            check("the page still shows the earlier photo", field("file") == earlier)
            shot("17-end")
            return
        }
        // 8a. Camera, the shutter, Done: the photo reaches the page through the chooser.
        check("Camera in the chooser opens the camera app", touchChooserCamera(cameraEntry))
        SystemClock.sleep(3_000)
        settleCameraApp()
        shot("16-camera-from-chooser")
        check("the camera app's shutter is touched (from the chooser)", touchCamera(SHUTTER_LABELS, SHUTTER_IDS, "the shutter"))
        SystemClock.sleep(2_500)
        val returned = poll(6_000) { field("file") != earlier && field("file") != "none" }
        if (!returned) note("  Done touched: ${touchCamera(DONE_LABELS, DONE_IDS, "Done")}")
        val delivered = poll(15_000) { field("file") != earlier && field("file") != "none" }
        note("  the page after the chooser's Camera: file=${field("file")} size=${field("size")} type=${field("type")} count=${field("count")}; in front ${frontPackage()}")
        check("the photo taken through the chooser's Camera reached the page", delivered)
        check("it is a new camera output file (photo-<time>.jpg), not step 7's", field("file")?.matches(Regex("photo-\\d+\\.jpg")) == true && field("file") != earlier)
        check("the photo has a size", (field("size")?.toLongOrNull() ?: 0L) > 0L)
        check("the app is in front again", poll(8_000) { frontPackage() == app.packageName })
        SystemClock.sleep(1_500)
        shot("16b-chooser-photo-in-the-page")
        val kept = captureFiles()
        note("  capture directory: $kept (before: $keptBefore; both photos kept for their uploads)")
        check("both kept photos are in the capture directory", kept.size == keptBefore.size + 1)
        // 8b. The chooser again, Camera, Back: the file the cancelled capture would have written is gone.
        val taken = field("file")
        check("Choose an image is touched again", tapPageButton("pick-label", "Choose an image", "the chooser comes up again", 12_000) { foreignInFront() })
        SystemClock.sleep(2_000)
        val cameraAgain = awaitInWindows(8_000) { it == CAMERA_ENTRY }
        check("the chooser offers Camera again", cameraAgain != null)
        if (cameraAgain != null) {
            check("Camera in the chooser opens the camera app again", touchChooserCamera(cameraAgain))
            SystemClock.sleep(2_000)
            settleCameraApp()
            back()
            check("back cancels the camera", poll(10_000) { frontPackage() == app.packageName })
            SystemClock.sleep(1_500)
            val now = captureFiles()
            note("  after the cancel: capture directory $now (before this chooser: $kept)")
            check("the cancelled capture's file is gone, the kept photos stay", now == kept)
        } else {
            back()
            poll(8_000) { frontPackage() == app.packageName }
        }
        check("the page still shows the photo from the chooser", field("file") == taken)
        shot("17-end")
    }

    /** A real touch on the chooser's Camera entry, then the camera app in front; a touch fault when it went in for nothing. */
    private fun touchChooserCamera(entry: AccessibilityNodeInfo): Boolean {
        val point = touchTapPoint(entry) ?: run {
            note("  the chooser's Camera has no bounds a finger can reach")
            return false
        }
        val opened = poll(20_000) { frontPackage() == cameraApp }
        if (!opened) touchFault("a touch on the chooser's Camera at ${point.x.toInt()},${point.y.toInt()} did not open the camera app")
        else note("  finger on the chooser's Camera at ${point.x.toInt()},${point.y.toInt()}: the camera app in front")
        return opened
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

    /**
     * 10. The embed (A2): a finger on the iframe's clip. The frame's document takes its video
     * fullscreen; the main document's fullscreen element is the `<iframe>`, which has no video in
     * its subtree, so the main frame's report is 0 x 0 and the turn rides the frame's own report,
     * heard through `TabWebView.onPageMessage` and taken by `Host.fullscreenVideo` while the layer
     * is up. The hint's key reset first: the hint is the layer's cue, embed or not (B3).
     */
    private fun embedFullscreenTurnsAndHints() {
        note("\n10. the same-origin iframe's clip into fullscreen (an embedded player)")
        coreInvoke("settings.update", """{"fullscreenHintDone":false}""")
        check("the once-key is reset for the embed", poll(4_000) { !hintDone() })
        SystemClock.sleep(800)
        note("  before: ${embedState()}; page fs=${field("fs")} el=${field("el")}")
        val touchedAt = SystemClock.uptimeMillis()
        // The iframe fills with its clip, so the frame's box is the finger's target.
        check("the embed's clip is touched", tapPageButton("embed", "Embedded player", "the frame's video goes fullscreen", 15_000) {
            host.fullscreenTab?.tabId == TAB && embedState()?.optInt("fs") == 1
        })
        val seen = awaitHint(6_000, present = true)
        val hint = if (seen == null) null else awaitHintAtRest(2_500) ?: seen
        shot("19-embed-fullscreen-hint")
        note("  ${SystemClock.uptimeMillis() - touchedAt} ms after the touch: host fullscreenTab=${host.fullscreenTab?.tabId}; the main document: fs=${field("fs")} el=${field("el")}; the frame: ${embedState()}")
        check("the main document's fullscreen element is the iframe (no video of its own to report)", field("el") == "embed")
        check("the frame's document has its video fullscreen", embedState()?.optString("el") == "v")
        check("the hint stands for the embed's fullscreen", seen != null)
        if (hint != null) note("  hint: $hint")
        val turned = poll(10_000) { landscape() }
        note("  screen landscape ${SystemClock.uptimeMillis() - touchedAt} ms after the touch: $turned; rotation ${rotation()}; requestedOrientation ${requested()}; dumpsys window: ${dumpsysRotation()}")
        check("the screen turned to landscape on the frame's own size report", turned)
        check("the activity asks for SENSOR_LANDSCAPE", requested() == ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
        check("the host holds the orientation for the embed's video", host.fullscreenLandscape)
        awaitHint(6_000, present = false)
        SystemClock.sleep(600)
        shot("20-embed-fullscreen-landscape")
        back()
        check("back leaves the embed's fullscreen", poll(10_000) { host.fullscreenTab == null })
        check("the screen is portrait again", poll(10_000) { !landscape() })
        check("the orientation is given back (UNSPECIFIED)", requested() == ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED)
        check("the frame's document left fullscreen too", poll(5_000) { embedState()?.optInt("fs") == 0 })
        SystemClock.sleep(2_000)
        pageJs("(function(){var w=document.getElementById('embed').contentWindow;var v=w&&w.document.getElementById('v');if(v)v.pause()})()")
        shot("21-after-embed")
    }

    /**
     * 11. The canvas (B3, MED-03): fullscreen with no video in it – the exit toast all the same,
     * no turn; the toast goes on its own after its stand (the design still, light).
     */
    private fun canvasFullscreenHints() {
        note("\n11. the canvas into fullscreen (no video: the exit toast is the layer's cue)")
        coreInvoke("settings.update", """{"fullscreenHintDone":false}""")
        check("the once-key is reset for the canvas", poll(4_000) { !hintDone() })
        SystemClock.sleep(800)
        val touchedAt = SystemClock.uptimeMillis()
        check("the canvas is touched", tapPageButton("stage", "Canvas", "the canvas goes fullscreen", 15_000) {
            host.fullscreenTab?.tabId == TAB && field("el") == "stage"
        })
        val seen = awaitHint(6_000, present = true)
        val seenAt = SystemClock.uptimeMillis() - touchedAt
        val hint = if (seen == null) null else awaitHintAtRest(2_500) ?: seen
        shot("22-canvas-fullscreen-hint")
        shot("design-exit-toast-light")
        note("  host fullscreenTab=${host.fullscreenTab?.tabId}; page fs=${field("fs")} el=${field("el")}; toast $seenAt ms after the touch: $hint")
        check("the exit toast stands for a fullscreen with no video in it", seen != null)
        check("the exit toast wears the light palette", hint != null && paletteOf(hint) == "light")
        check("the once-key is set again", poll(4_000) { hintDone() })
        val turned = poll(3_000) { landscape() }
        note("  rotation ${rotation()} requested ${requested()} held=${host.fullscreenLandscape}")
        check("the screen stays portrait for a fullscreen without a video", !turned)
        check("the activity asks for nothing (UNSPECIFIED)", requested() == ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED)
        val gone = awaitHint(6_000, present = false) == null
        note("  toast gone on its own ${SystemClock.uptimeMillis() - touchedAt} ms after the touch: $gone")
        check("the exit toast fades on its own after its stand", gone)
        back()
        check("back leaves the canvas's fullscreen", poll(10_000) { host.fullscreenTab == null })
        SystemClock.sleep(1_500)
        shot("23-after-the-canvas")
    }

    /**
     * 12. The canvas again, the once-key left set and the colour scheme dark (MED-03): an
     * element that is not a video shows the exit toast every time, not once – Chrome's toast –
     * and the page's first touch takes it down before its stand is over (the design still, dark).
     * A real finger on the fullscreen page, high and clear of the toast.
     */
    private fun canvasToastEveryTimeAndAtTheTouch() {
        note("\n12. the canvas into fullscreen again (the key set, the dark scheme): the toast every time, down at the first touch")
        check("the once-key is still set from step 11", hintDone())
        coreInvoke("settings.update", """{"colorScheme":"dark"}""")
        SystemClock.sleep(1_500)
        val touchedAt = SystemClock.uptimeMillis()
        check("the canvas is touched again", tapPageButton("stage", "Canvas", "the canvas goes fullscreen again", 15_000) {
            host.fullscreenTab?.tabId == TAB && field("el") == "stage"
        })
        val seen = awaitHint(6_000, present = true)
        val seenAt = SystemClock.uptimeMillis()
        val hint = if (seen == null) null else awaitHintAtRest(2_500) ?: seen
        shot("design-exit-toast-dark")
        note("  toast ${seenAt - touchedAt} ms after the touch, its key set: $hint")
        check("the exit toast stands again for an element that is not a video (every time, key or no key)", seen != null)
        check("the exit toast wears the dark palette", hint != null && paletteOf(hint) == "dark")
        // The finger: on the fullscreen canvas (it fills the screen), well above the toast's row.
        val x = width / 2f
        val y = height * 0.3f
        val fingerAt = SystemClock.uptimeMillis() - seenAt
        Finger().tap(x, y)
        val down = awaitHint(1_500, present = false) == null
        val downAt = SystemClock.uptimeMillis() - seenAt
        note("  finger on the page at ${x.toInt()},${y.toInt()} $fingerAt ms after the toast was first seen (its stand is $TOAST_STAND_MS ms); toast gone $downAt ms after: $down")
        // The stand could have run out on a slow emulator between the sight and the finger: then
        // the fall says nothing about the touch, and the check is noted, not failed.
        if (fingerAt <= TOAST_STAND_MS - TOAST_TOUCH_MARGIN_MS) check("the page's first touch takes the exit toast down at once (MED-03)", down)
        else note("  ${if (down) "PASS " else "SOFT MISS"}  the first touch takes the toast down – the finger came $fingerAt ms after the sight, inside the stand's last $TOAST_TOUCH_MARGIN_MS ms: noted, not enforced")
        check("the canvas stays fullscreen under the touch", host.fullscreenTab?.tabId == TAB && field("el") == "stage")
        shot("24-toast-down-at-the-touch")
        back()
        check("back leaves the canvas's fullscreen again", poll(10_000) { host.fullscreenTab == null })
        coreInvoke("settings.update", """{"colorScheme":"light"}""")
        SystemClock.sleep(1_500)
        shot("25-light-again")
    }

    /**
     * 13. Rotate-to-fullscreen (MED-02), Chrome's rule: the landscape clip given the browser's
     * controls and playing inline; the screen turned to landscape (`UiAutomation.setRotation`,
     * the emulator's sensor cannot be turned from a test) takes it fullscreen – the engine's own
     * `MediaControlsRotateToFullscreenDelegate`, which content turns on for the phone form
     * factor in WebView as in Chrome, on its own gates (the browser's controls, playing, three
     * quarters in view, a `deviceorientation` reading with beta and gamma); with auto-rotate on,
     * the device turned to match (`Host.onDeviceAngle`, the sensor's stand-in) has MED-01's
     * landscape lock give way to the sensor a second on (the host's part, `RotateUnlock`), and
     * the screen turning back exits (the engine's delegate and the host both, on the one turn).
     * Then the edge cases: a paused clip is left alone by the turn; the portrait clip goes
     * fullscreen on the turn to portrait, with no lock, and leaves on the turn to landscape. The
     * clip is narrowed for the scene so that three quarters of it stay in the landscape's
     * shorter viewport (Chrome's visibility threshold), and the screen's rotation is given back
     * as it was found, with nothing fullscreen (the clips paused before the last turn).
     */
    private fun rotateToFullscreen() {
        note("\n13. rotate-to-fullscreen: the playing clip and the screen's turn (MED-02)")
        val autoRotateBefore = shell("settings get system accelerometer_rotation").trim()
        val userRotationBefore = shell("settings get system user_rotation").trim()
        note("  before: accelerometer_rotation=$autoRotateBefore user_rotation=$userRotationBefore rotation ${rotation()} requested ${requested()}")
        pageJs("window.scrollTo(0,0)")
        pageJs("(function(){var v=document.getElementById('land');v.setAttribute('controls','');v.style.width='40%';v.play()})()")
        check("the landscape clip plays inline with the browser's controls", poll(5_000) { field("state") == "playing" && field("fs") == "0" } &&
            pageJs("document.getElementById('land').controls") == "true")
        note("  the clip's box in portrait: ${landBox()}")
        shot("26-clip-playing-inline-with-controls")
        // 13a. The turn to landscape takes the playing clip fullscreen.
        val turnedAt = SystemClock.uptimeMillis()
        val turned = turnScreen(UiAutomation.ROTATION_FREEZE_90, toLandscape = true)
        val entered = poll(10_000) { host.fullscreenTab?.tabId == TAB && field("el") == "land" }
        note("  the turn to landscape: $turned; fullscreen ${SystemClock.uptimeMillis() - turnedAt} ms after it: $entered (the engine's own rotate delegate, on the turn's orientationchange); " +
            "el=${field("el")} state=${field("state")} rotation ${rotation()} requested ${requested()}")
        check("the screen turned to landscape", turned)
        check("the playing clip went fullscreen on the turn to landscape (rotate-to-fullscreen)", entered)
        check("the fullscreen element is the clip itself, the kind the host's lock gives way for (rotate)", field("el") == "land" && host.fullscreenElementRotate)
        check("the clip keeps playing", field("state") == "playing")
        check("the fullscreen holds the screen in landscape (MED-01's lock, SENSOR_LANDSCAPE)", requested() == ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE && host.fullscreenLandscape)
        check("no hint for a video with its once-key set", awaitHint(2_500, present = true) == null)
        shot("27-turned-into-fullscreen")
        // 13b. Auto-rotate on, the device turned to match: the lock gives way, and the screen
        // turning back exits.
        ui.setRotation(UiAutomation.ROTATION_UNFREEZE)
        val autoRotateOn = poll(5_000) { shell("settings get system accelerometer_rotation").trim() == "1" }
        SystemClock.sleep(1_000)
        note("  auto-rotate on: $autoRotateOn; still landscape: ${landscape()}; requested ${requested()}; unlocked=${host.fullscreenUnlocked}")
        check("the screen stays landscape under the lock with auto-rotate on", landscape() && requested() == ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE)
        check("the lock has not given way before the device is turned", !host.fullscreenUnlocked)
        val matchedAt = SystemClock.uptimeMillis()
        instrumentation.runOnMainSync { host.onDeviceAngle(90) }
        val unlocked = poll(5_000) { requested() == ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR }
        val unlockedAt = SystemClock.uptimeMillis() - matchedAt
        note("  the device turned to landscape (onDeviceAngle 90): the lock gave way to the sensor (FULL_SENSOR) $unlockedAt ms on: $unlocked; unlocked=${host.fullscreenUnlocked}")
        check("the lock gives way to the sensor once the device is turned to match (Chrome's lock-to-any)", unlocked && host.fullscreenUnlocked)
        check("the lock gives way about a second on (${RotateToFullscreen.UNLOCK_DELAY_MS} ms), not at once", unlockedAt >= RotateToFullscreen.UNLOCK_DELAY_MS - CLOCK_TOLERANCE_MS)
        // The emulator's sensor holds the device upright: with the sensor's word taken the
        // screen turns back on its own; where it does not, the turn is driven.
        var left = poll(6_000) { host.fullscreenTab == null }
        if (!left) {
            note("  the sensor did not turn the screen back within 6 s; turning it")
            turnScreen(UiAutomation.ROTATION_FREEZE_0, toLandscape = false)
            left = poll(10_000) { host.fullscreenTab == null }
        } else {
            note("  the screen turned back on the sensor's word")
        }
        val portrait = poll(10_000) { !landscape() }
        note("  left fullscreen: $left; portrait: $portrait; rotation ${rotation()} requested ${requested()} state=${field("state")} fs=${field("fs")}")
        check("the screen turning back exits the fullscreen (rotate-to-fullscreen's way back)", left && portrait)
        check("the orientation is given back (UNSPECIFIED)", requested() == ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED)
        SystemClock.sleep(1_000)
        shot("28-turned-back-out-of-fullscreen")
        // 13c. A paused clip is left alone by the turn.
        pageJs("document.getElementById('land').pause()")
        check("the clip is paused", poll(3_000) { field("state") == "paused" })
        turnScreen(UiAutomation.ROTATION_FREEZE_90, toLandscape = true)
        val pausedEntered = poll(4_000) { host.fullscreenTab != null }
        note("  paused, turned to landscape: fullscreen=$pausedEntered fs=${field("fs")} rotation ${rotation()}; the clip's box in the landscape viewport (what the turn judged): ${landBox()}")
        check("a paused clip never goes fullscreen on a turn", !pausedEntered)
        shot("29-paused-clip-stays-inline-in-landscape")
        turnScreen(UiAutomation.ROTATION_FREEZE_0, toLandscape = false)
        // 13d. The portrait clip: the turn to landscape leaves it, the turn to portrait takes it
        // (no lock: a portrait video asks nothing of the orientation), the next turn exits.
        pageJs("(function(){document.getElementById('land').removeAttribute('controls');var p=document.getElementById('port');p.setAttribute('controls','');p.play()})()")
        check("the portrait clip plays inline with the browser's controls", poll(5_000) { field("state") == "playing" && field("fs") == "0" })
        turnScreen(UiAutomation.ROTATION_FREEZE_90, toLandscape = true)
        val portraitOnLandscape = poll(4_000) { host.fullscreenTab != null }
        note("  the portrait clip playing, turned to landscape: fullscreen=$portraitOnLandscape el=${field("el")}")
        check("the turn to landscape leaves a playing portrait clip alone", !portraitOnLandscape)
        val backAt = SystemClock.uptimeMillis()
        turnScreen(UiAutomation.ROTATION_FREEZE_0, toLandscape = false)
        val portraitEntered = poll(10_000) { host.fullscreenTab?.tabId == TAB && field("el") == "port" }
        note("  turned to portrait: fullscreen ${SystemClock.uptimeMillis() - backAt} ms after: $portraitEntered; el=${field("el")}; requested ${requested()} held=${host.fullscreenLandscape}")
        check("the turn to portrait takes the playing portrait clip fullscreen", portraitEntered)
        check("a portrait clip's fullscreen asks nothing of the orientation (UNSPECIFIED, no lock)", requested() == ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED && !host.fullscreenLandscape)
        shot("30-portrait-clip-fullscreen-on-the-turn-to-portrait")
        turnScreen(UiAutomation.ROTATION_FREEZE_90, toLandscape = true)
        val portraitLeft = poll(10_000) { host.fullscreenTab == null }
        note("  turned to landscape again: left fullscreen: $portraitLeft fs=${field("fs")}")
        check("the turn to landscape exits the portrait clip's fullscreen", portraitLeft)
        // The page as it was before the screen's last turn: a playing portrait clip would go
        // fullscreen again on the turn to portrait (the first run's end did).
        pageJs("(function(){var p=document.getElementById('port');p.pause();p.removeAttribute('controls');document.getElementById('land').style.width=''})()")
        check("the portrait clip is paused before the last turn", poll(3_000) { field("state") == "paused" })
        turnScreen(UiAutomation.ROTATION_FREEZE_0, toLandscape = false)
        if (autoRotateBefore == "1") ui.setRotation(UiAutomation.ROTATION_UNFREEZE)
        SystemClock.sleep(1_500)
        note("  after: accelerometer_rotation=${shell("settings get system accelerometer_rotation").trim()} user_rotation=${shell("settings get system user_rotation").trim()} rotation ${rotation()} requested ${requested()} state=${field("state")} fullscreenTab=${host.fullscreenTab?.tabId}")
        check("the screen is portrait at the end", !landscape())
        check("nothing is fullscreen at the end (a paused clip is left alone by the last turn)", host.fullscreenTab == null && field("fs") == "0")
        shot("31-end")
    }

    /**
     * The screen turned through the automation (`setRotation`, which also locks the system's
     * rotation to it) and waited for, `landscape` or portrait, within 10 s; the time noted.
     */
    private fun turnScreen(to: Int, toLandscape: Boolean): Boolean {
        val at = SystemClock.uptimeMillis()
        ui.setRotation(to)
        val turned = poll(10_000) { landscape() == toLandscape }
        note("  the screen turned to ${if (toLandscape) "landscape" else "portrait"} (setRotation $to) ${SystemClock.uptimeMillis() - at} ms on: $turned; rotation ${rotation()}")
        return turned
    }

    /** The landscape clip's box against the page's viewport (the engine's delegate wants three quarters of it in view). */
    private fun landBox(): String {
        val raw = pageJs("(function(){var v=document.getElementById('land'),r=v.getBoundingClientRect();return JSON.stringify({top:Math.round(r.top),left:Math.round(r.left),w:Math.round(r.width),h:Math.round(r.height),vw:innerWidth,vh:innerHeight})})()")
        return (JSONTokener(raw).nextValue() as? String) ?: raw
    }

    /** What the embed's document sees (`__embedState` through the top document; same origin). */
    private fun embedState(): JSONObject? {
        val raw = pageJs("window.__embed ? window.__embed() : null")
        val text = (JSONTokener(raw).nextValue() as? String) ?: return null
        return runCatching { JSONObject(text) }.getOrNull()
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

    /**
     * The hint once its spring has landed (`translateY` within 2 px of 0, or no transform under
     * reduced motion); when it never does in time – the emulator's stalls can spend the 2.8 s stand
     * between two reads, so the spring out is under way before the spring in was seen landed – the
     * read nearest its rest, whose travel the callers take out again. Null when there is no hint.
     */
    private fun awaitHintAtRest(timeoutMs: Long): JSONObject? {
        var nearest: JSONObject? = null
        poll(timeoutMs) {
            val now = hint()
            if (now != null && (nearest == null || kotlin.math.abs(translateYOf(now)) < kotlin.math.abs(translateYOf(nearest!!)))) nearest = now
            now != null && kotlin.math.abs(translateYOf(now)) < 2.0
        }
        return nearest
    }

    /** The hint's travel (`translateY`, px) at the read: 0 at rest or without a transform. */
    private fun translateYOf(hint: JSONObject): Double =
        Regex("translateY\\((-?[0-9.]+)px\\)").find(hint.optString("transform"))?.groupValues?.get(1)?.toDoubleOrNull() ?: 0.0

    private fun hintDone(): Boolean = coreState().getJSONObject("settings").optBoolean("fullscreenHintDone")

    // --- the toast card (the hint's original, for the lead's L1) ---------------------------------

    /**
     * The chrome's toast card (`.zen-message-toast`) as laid out, against the message layer it
     * sits in (the content frame's box): its insets from the layer's sides and bottom, its size,
     * and the computed radius, type, padding and hairline – the numbers the hint's twin carries
     * by value (`@shared/toastCard`).
     */
    private fun toastCard(): JSONObject? {
        val raw = chromeJs(
            "(function(){var c=document.querySelector('.zen-message-toast');var l=document.querySelector('.zen-message-layer');if(!c||!l)return null;" +
                "var r=c.getBoundingClientRect(),f=l.getBoundingClientRect(),s=getComputedStyle(c),t=c.querySelector('.zen-message-text'),ts=t?getComputedStyle(t):s;" +
                "return JSON.stringify({left:r.left-f.left,right:f.right-r.right,bottom:f.bottom-r.bottom,width:r.width,height:r.height,frameWidth:f.width,frameHeight:f.height," +
                "radius:s.borderRadius,shadow:s.boxShadow,font:ts.fontSize+'/'+ts.lineHeight+' '+ts.fontWeight,padding:s.padding,border:s.borderTopWidth,transform:s.transform,text:c.textContent})})()"
        )
        val text = (JSONTokener(raw).nextValue() as? String) ?: return null
        return runCatching { JSONObject(text) }.getOrNull()
    }

    /** The toast card once its spring has landed (two reads 150 ms apart at the same place), or as last seen. */
    private fun awaitToastCardAtRest(timeoutMs: Long): JSONObject? {
        var last: JSONObject? = null
        poll(timeoutMs) {
            val a = toastCard() ?: return@poll false
            SystemClock.sleep(150)
            val b = toastCard() ?: return@poll false
            last = b
            near(a.optDouble("bottom"), b.optDouble("bottom")) && near(a.optDouble("left"), b.optDouble("left"))
        }
        return last
    }

    private fun cardInsetsAre(card: JSONObject, inset: Double, row: Double): Boolean =
        near(card.optDouble("left"), inset) && near(card.optDouble("right"), inset) && near(card.optDouble("bottom"), inset) && near(card.optDouble("height"), row)

    /** Within a CSS pixel: the emulator's density (1.75) rounds a device pixel into fractions. */
    private fun near(a: Double, b: Double): Boolean = kotlin.math.abs(a - b) <= 1.0

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
            "(function(){window.__fade=[];window.__fadeCalls=[];window.__landing=[];window.__fadeT0=performance.now();var t0=window.__fadeT0;" +
                "if(!window.__fadeHooked){window.__fadeHooked=true;var orig=Element.prototype.animate;" +
                "Element.prototype.animate=function(k,o){if(this.classList&&this.classList.contains('zen-window'))" +
                "window.__fadeCalls.push({at:Math.round(performance.now()-window.__fadeT0),keyframes:k,options:o});return orig.apply(this,arguments)};" +
                // The landing store's every change (lib/fullscreenLanding.ts, registered under its
                // key): the bars' word, the placements the chrome reported and the sizes the host drew.
                "var st=window.__zenStores&&window.__zenStores['fullscreen-landing'];if(st)st.subscribe(function(){var s=st.get();" +
                "window.__landing.push({at:Math.round(performance.now()-window.__fadeT0),settling:s.settling," +
                "placed:Array.from(s.placed,function(e){return e[0]+':'+Math.round(e[1].rect.width)+'x'+Math.round(e[1].rect.height)+(e[1].settled?'':'~')})," +
                "sized:Array.from(s.sized,function(e){return e[0]+':'+Math.round(e[1].width)+'x'+Math.round(e[1].height)})})})}" +
                "(function s(){var w=document.querySelector('.zen-window');" +
                "window.__fade.push(Math.round(performance.now()-t0)+':'+(w?getComputedStyle(w).opacity:'none'));" +
                "if(window.__fade.length<900)requestAnimationFrame(s)})()})()"
        )
    }

    /**
     * The landing store's changes since the sampler went in (`at` on the sampler's clock; `settling`;
     * the placements as `tab:WxH`, `~` for one laid out on settling bars; the drawn sizes).
     */
    private fun landingLog(): List<JSONObject> {
        val raw = chromeJs("JSON.stringify(window.__landing||[])")
        val text = (JSONTokener(raw).nextValue() as? String) ?: return emptyList()
        val all = runCatching { JSONArray(text) }.getOrNull() ?: return emptyList()
        return (0 until all.length()).mapNotNull { all.optJSONObject(it) }
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
        /** The toast card's inset from its frame's edges and its row (§9.33, `@shared/toastCard`): what the hint's twin is held to (L1). */
        private const val TOAST_INSET = 8.0
        private const val TOAST_ROW = 44.0
        /** How long the return fade waits on the landing at most (`LANDING_TIMEOUT_MS`, lib/fullscreenLanding.ts), and a timer's tolerance against the sampler's clock. */
        private const val LANDING_TIMEOUT_MS = 2_500
        private const val CLOCK_TOLERANCE_MS = 60
        /** `poll`'s step (MediaDemoBase): how late a sight of the host's state may be. */
        private const val POLL_STEP_MS = 200L
        /** A measured scene's rest after its motion, for the last frames to land in the record. */
        private const val SCENE_REST_MS = 1_000L
        /** The exit toast's stand (`TOAST_SHOW_MS`, @shared/toastCard), and how close to its end a finger's dismissal is still told from the stand's own. */
        private const val TOAST_STAND_MS = 2_800L
        private const val TOAST_TOUCH_MARGIN_MS = 500L
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
