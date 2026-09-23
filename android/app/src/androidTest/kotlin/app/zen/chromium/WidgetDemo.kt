package app.zen.chromium

import android.accessibilityservice.AccessibilityService
import android.app.Activity
import android.app.ActivityOptions
import android.app.Application
import android.app.PendingIntent
import android.appwidget.AppWidgetHost
import android.appwidget.AppWidgetHostView
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProviderInfo
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutManager
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.SurfaceTexture
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.speech.RecognitionListener
import android.system.Os
import android.system.OsConstants
import android.util.Log
import android.util.SizeF
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Drives the Home-screen search widget and the launcher's deep links (WID-01, WID-07, OMN-33) so
 * the `android-widget-demo` workflow and the nightly can record them:
 *
 *  - the widget's face on a launcher's host: the provider is installed with its 4×1 size, the
 *    id is bound through `appwidget grantbind` on an `AppWidgetHost` of the driver's, and the
 *    RemoteViews the provider delivers are inflated in a configuration the launcher would have
 *    (the system's night mode, `Theme.DeviceDefault`) over a wallpaper-like backdrop – the face
 *    still, light or dark by the `theme` argument – with its accessible names read off the tree;
 *  - a real finger on each part of the face with Zenium in front: the mic lands in voice search
 *    (a stand-in recogniser, the sheet reads Listening), the pill in the omnibox with the keyboard
 *    up (traced: RULING 5's long tasks by the renderer's own clock), the mask in a new private
 *    tab – or, on a WebView without profiles, in the toast that says so;
 *  - the COLD landings (the WID-07 rule): the browser's task removed, the widget's own
 *    `PendingIntent` sent for `search`, `scan` and `private`, and every frame from the send to
 *    the landing grabbed and read for the previous tab's page – a full-bleed orange page the
 *    profile restores as its active tab – which must never paint: the landing opens its own new
 *    tab in the boot's run, before the chrome's first frame. The frames go on a sheet
 *    (`widget-<theme>-frames-cold-<landing>.png`); the send-to-landing wall time and the main
 *    thread's CPU time over it are on record;
 *  - the launcher's four static shortcuts read from the manifest in rank order with their
 *    landings, the Search shortcut fired cold through the trampoline with the same frame read,
 *    Scan QR code and New tab fired warm from Home.
 *
 * Every check is a finding line (`widget-findings.txt`); one that fails fails the run at the end,
 * after the stills are down. Handshake and screenshots (`widget-<theme>-*.png`) as in the other
 * demos, under `files/widget-demo/`.
 */
private typealias Face = SearchWidgetProvider.Face

@RunWith(AndroidJUnit4::class)
class WidgetDemo : DemoHarness("widget-demo-state.json", "widget-$THEME", "widget-demo") {
    override val tag = "WidgetDemo"
    private lateinit var server: DemoServer
    private lateinit var findings: File
    private val failures = ArrayList<String>()
    private val recognizer = StandInRecognizer()
    private val camera = StandInCamera()
    private val host get() = (activity as MainActivity).host

    private var widgetHost: AppWidgetHost? = null
    private var widgetId = AppWidgetManager.INVALID_APPWIDGET_ID
    private var widgetView: View? = null
    private var overlay: FrameLayout? = null
    private var frame: FrameLayout? = null

    @Test
    fun record() {
        server = DemoServer(PORT, routes()).also { it.start() }
        var fault: Throwable? = null
        try {
            runDemo()
        } catch (e: Throwable) {
            fault = e
        } finally {
            server.close()
            Voice.recognizerFactory = null
            Voice.availabilityOverride = null
            QrScan.cameraFactory = null
            QrScan.availabilityOverride = null
            PrivateBrowsing.captureForRecording = false
        }
        if (failures.isNotEmpty() || fault != null) {
            throw AssertionError(
                "${failures.size} check(s) failed: ${failures.joinToString("; ")}" +
                    (fault?.let { "; and: ${it.message}" } ?: "")
            )
        }
    }

    override fun patchState(json: String): String =
        json.replace("\"colorScheme\": \"light\"", "\"colorScheme\": \"$THEME\"")

    /**
     * The system's night mode is the widget's colour scheme (the launcher inflates the face in its
     * own configuration), set before the app starts so nothing relaunches under it; the voice and
     * QR stand-ins, since the emulator has neither a recogniser nor a camera; the permissions the
     * two sheets would otherwise prompt for; the screenshot guard off so a private surface records.
     */
    override fun beforeLaunch() {
        shellCommand("cmd uimode night ${if (THEME == "dark") "yes" else "no"}")
        SystemClock.sleep(2_500)
        shellCommand("pm grant ${app.packageName} android.permission.RECORD_AUDIO")
        shellCommand("pm grant ${app.packageName} android.permission.CAMERA")
        Voice.availabilityOverride = true
        Voice.recognizerFactory = { recognizer }
        QrScan.availabilityOverride = true
        QrScan.cameraFactory = { camera.reset() }
        PrivateBrowsing.captureForRecording = true
    }

    // --- the pages -------------------------------------------------------------------------------

    /** The previous tab: a page nothing in the chrome could be mistaken for, full-bleed orange. */
    private fun routes(): Map<String, Pair<String, ByteArray>> = mapOf(
        "/previous.html" to ("text/html; charset=utf-8" to (
            "<!doctype html><html><head><meta charset=utf-8>" +
                "<meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Previous tab</title>" +
                "<style>html,body{margin:0;height:100%;background:$PREVIOUS_CSS;color:#fff;font-family:sans-serif}" +
                "main{padding:48px 24px}h1{font-size:34px;margin:0 0 16px}p{font-size:19px;line-height:1.45;margin:0}</style></head>" +
                "<body><main><h1>Previous tab</h1><p>The page the profile restores. A widget or shortcut landing must never show it.</p></main></body></html>"
            ).toByteArray())
    )

    // --- sequence --------------------------------------------------------------------------------

    override fun warmUp() {
        findings = File(out, "widget-findings.txt")
        findings.writeText(
            "Zenium Android search widget and deep links (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density, " +
                "theme $THEME, night mode ${nightModeWord()})\n\n"
        )
        finding("demo server: ${server.selfCheck()}")
        finding("capabilities.privateTabs per the core: ${privateTabsCapability()}; multi-profile WebView: ${onMain { Profiles.supported }}")
        expect("the profile restores the previous tab as its active tab", awaitTrue(10_000) { activeCoreTab()?.optString("id") == PREVIOUS_TAB })
        expect("the previous tab's page paints (orange on screen)", awaitOrange(15_000))
        // The first omnibox open pays for its layout: open and close it once off camera.
        watchToasts()
        val f = Finger()
        f.tap(pillCenterX, pillY)
        if (awaitOmniboxOpen(8_000).ok) {
            awaitIme(true, 4_000)
            SystemClock.sleep(600)
            closeUrlField()
            awaitIme(false, 4_000)
        }
        SystemClock.sleep(1_000)
        finding("warm-up done: active ${describeActive()}")
    }

    override fun demo() {
        ensureForeground()
        shot("00-previous-tab")

        faceOnAHost()
        touchTheMic()
        touchTheFace()
        touchTheMask()
        takeDownTheHost()

        coldLanding(SearchWidgetProvider.FACES[0], "search") { searchLanded(30_000) }
        coldLanding(SearchWidgetProvider.FACES[2], "private") { privateLanded(30_000) }
        coldLanding(
            Face(R.id.widget_search_face, Landing.SCAN, SCAN_REPLAY_CODE),
            "scan",
            send = { app.startActivity(SearchWidgetProvider.intent(app, Landing.SCAN)) }
        ) { scanLanded(30_000) }

        shortcuts()
        finding("\nend: ${describeActive()}; ${failures.size} failed check(s)")
    }

    // --- 1. the face on a host -------------------------------------------------------------------

    /**
     * The provider as the launcher's picker lists it, an id bound on the driver's own host (the
     * bind permission granted through the shell, as a launcher has it), the RemoteViews the
     * provider answers the bind with inflated in the launcher's configuration over a wallpaper,
     * and the face's words in the tree. The still is of the face alone at the window's pixels.
     */
    private fun faceOnAHost() {
        val manager = AppWidgetManager.getInstance(app)
        val provider = ComponentName(app, SearchWidgetProvider::class.java)
        val info = manager.getInstalledProvidersForPackage(app.packageName, null).firstOrNull { it.provider == provider }
        expect("the search widget's provider is installed for ${app.packageName}", info != null)
        info ?: return
        finding("\nprovider: ${describe(info)}")
        expect("the widget asks for four cells by one (minWidth 250 dp, minHeight 40 dp)", info.minWidth == dp(250) && info.minHeight == dp(40))
        expect("the widget resizes horizontally only", info.resizeMode == AppWidgetProviderInfo.RESIZE_HORIZONTAL)
        expect("the widget is for the home screen", info.widgetCategory and AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN != 0)
        expect("the widget names itself for the picker", info.loadLabel(app.packageManager) == WIDGET_LABEL)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            expect("the picker's target is 4×1 with a description", info.targetCellWidth == 4 && info.targetCellHeight == 1 && !info.loadDescription(app).isNullOrEmpty())
        }

        val grant = shellCommand("appwidget grantbind --package ${app.packageName} --user 0").trim()
        val widgetHost = AppWidgetHost(app, HOST_ID).also { widgetHost = it }
        onMain { widgetHost.startListening() }
        val id = widgetHost.allocateAppWidgetId().also { widgetId = it }
        val bound = onMain { manager.bindAppWidgetIdIfAllowed(id, provider) }
        finding("bind: grantbind '${grant.ifEmpty { "(no output)" }}', id $id bound $bound")
        expect("the id binds to the provider on the driver's host", bound)

        val launcherContext = launcherContext()
        val hostView = onMain {
            if (bound) widgetHost.createView(launcherContext, id, info) else null
        }
        val face: View = if (hostView != null) {
            // The provider hears the bind (APPWIDGET_UPDATE) and answers with its views; the host
            // view shows the initial layout until then – the same layout, without the clicks.
            val delivered = awaitTrue(8_000) {
                onMain { hostView.findViewById<View>(R.id.widget_search_face)?.hasOnClickListeners() == true }
            }
            expect("the provider's RemoteViews reach the host after the bind (the face has its click)", delivered)
            if (!delivered) onMain { hostView.updateAppWidget(SearchWidgetProvider.views(launcherContext)) }
            hostView
        } else {
            finding("bind refused: the provider's views applied in-process instead")
            onMain { SearchWidgetProvider.views(launcherContext).apply(launcherContext, FrameLayout(launcherContext)) }
        }
        widgetView = face
        showOnTheBackdrop(face, hostView)
        SystemClock.sleep(1_500)

        expect(
            "the face reads the omnibox's hint, the mic and the private mask in the tree",
            awaitTrue(8_000) { labelsInFrame(HINT_TEXT) && labelsInFrame(MIC_LABEL) && labelsInFrame(MASK_LABEL) }
        )
        expect("the mark carries no name of its own (decorative)", onMain { face.findViewById<View>(R.id.widget_search_mark)?.importantForAccessibility == View.IMPORTANT_FOR_ACCESSIBILITY_NO })
        finding("face bounds on screen: ${frameBounds()}, pill ${viewBounds(R.id.widget_search_face)}, mic ${viewBounds(R.id.widget_search_mic)}, mask ${viewBounds(R.id.widget_search_private)}")
        expect("the mic and the mask stand in 44 dp boxes", viewBounds(R.id.widget_search_mic).let { it.width() == dp(44) && it.height() == dp(44) })
        saveFace()
        shot("01-face-on-a-launcher-backdrop")
    }

    /**
     * What a launcher would inflate the face with: the SYSTEM's night mode (the app's own scheme
     * rewrites the activity's configuration, never the launcher's) on the device's default theme.
     */
    private fun launcherContext(): Context {
        val configuration = Configuration(app.resources.configuration)
        configuration.uiMode = (configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
            (if (THEME == "dark") Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
        return ContextThemeWrapper(app.createConfigurationContext(configuration), android.R.style.Theme_DeviceDefault_DayNight)
    }

    /** The face in a 4×1 frame near the top of a wallpaper-like backdrop laid over the window, taking the touches. */
    private fun showOnTheBackdrop(face: View, hostView: AppWidgetHostView?) {
        onMain {
            val content = activity.findViewById<ViewGroup>(android.R.id.content)
            val backdrop = FrameLayout(activity).apply {
                background = wallpaper()
                isClickable = true
                isFocusable = false
            }
            val cells = FrameLayout(activity)
            val frameWidth = dp(FRAME_WIDTH_DP)
            val frameHeight = dp(FRAME_HEIGHT_DP)
            val frameTop = (this@WidgetDemo.height * FRAME_TOP_SHARE).roundToInt()
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                hostView?.updateAppWidgetSize(Bundle(), listOf(SizeF(FRAME_WIDTH_DP.toFloat(), FRAME_HEIGHT_DP.toFloat())))
            } else {
                @Suppress("DEPRECATION")
                hostView?.updateAppWidgetSize(null, FRAME_WIDTH_DP, FRAME_HEIGHT_DP, FRAME_WIDTH_DP, FRAME_HEIGHT_DP)
            }
            hostView?.setPadding(0, 0, 0, 0)
            cells.addView(face, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
            backdrop.addView(
                cells,
                FrameLayout.LayoutParams(frameWidth, frameHeight, Gravity.TOP or Gravity.CENTER_HORIZONTAL).apply {
                    topMargin = frameTop
                }
            )
            content.addView(backdrop, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
            overlay = backdrop
            frame = cells
        }
    }

    /** A home screen's wallpaper, near enough: a diagonal gradient in the theme's tones. */
    private fun wallpaper(): GradientDrawable {
        val colors = if (THEME == "dark") intArrayOf(0xFF1B1F3A.toInt(), 0xFF3A2352.toInt(), 0xFF0F172A.toInt())
        else intArrayOf(0xFFDCE7FF.toInt(), 0xFFF5D9EC.toInt(), 0xFFE9F5E1.toInt())
        return GradientDrawable(GradientDrawable.Orientation.TL_BR, colors)
    }

    /** The face's frame with a 24 dp margin, at the window's pixels, from the overlay's own drawing (no tree, no timing). */
    private fun saveFace() {
        val backdrop = overlay ?: return
        val bounds = frameBounds()
        val margin = dp(24)
        val band = Rect(bounds).apply { inset(-margin, -margin) }
        val bitmap = Bitmap.createBitmap(band.width(), band.height(), Bitmap.Config.ARGB_8888)
        onMain {
            val canvas = Canvas(bitmap)
            val at = IntArray(2).also { backdrop.getLocationOnScreen(it) }
            canvas.translate((at[0] - band.left).toFloat(), (at[1] - band.top).toFloat())
            backdrop.draw(canvas)
        }
        File(out, "widget-$THEME-face.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun frameBounds(): Rect = onMain {
        val cells = frame ?: return@onMain Rect()
        val at = IntArray(2).also { cells.getLocationOnScreen(it) }
        Rect(at[0], at[1], at[0] + cells.width, at[1] + cells.height)
    }

    private fun viewBounds(id: Int): Rect = onMain {
        val view = widgetView?.findViewById<View>(id) ?: return@onMain Rect()
        val at = IntArray(2).also { view.getLocationOnScreen(it) }
        Rect(at[0], at[1], at[0] + view.width, at[1] + view.height)
    }

    /** A node reading `label` (text or description) whose bounds lie in the face's frame. */
    private fun labelsInFrame(label: String): Boolean {
        val within = frameBounds()
        return findNodes { it == label }.any { node ->
            val bounds = Rect().also { node.getBoundsInScreen(it) }
            within.contains(bounds.centerX(), bounds.centerY())
        }
    }

    private fun hideOverlay() = onMain { overlay?.visibility = View.GONE }
    private fun showOverlay() = onMain { overlay?.visibility = View.VISIBLE }

    // --- 2–4. a finger on the face, Zenium in front ----------------------------------------------

    /** A real finger on the middle of a face part: the RemoteViews' click sends the part's PendingIntent. */
    private fun touchPart(id: Int): Boolean {
        val bounds = viewBounds(id)
        if (bounds.isEmpty) return false
        Finger().tap(bounds.exactCenterX(), bounds.exactCenterY())
        return true
    }

    private fun touchTheMic() {
        val before = activeCoreTab()?.optString("id").orEmpty()
        val intentBefore = onMain { activity.intent }
        val starts = recognizer.starts
        expect("a finger reaches the mic on the face", touchPart(R.id.widget_search_mic))
        SystemClock.sleep(150)
        hideOverlay()
        val up = awaitVoicePhase(setOf("starting", "listening"), 10_000)
        expect("the mic lands in voice search: the sheet is up (phase ${voicePhase()})", up)
        expect("the widget's intent arrived through onNewIntent (the running activity, no relaunch)", onMain { activity.intent } !== intentBefore && !onMain { activity.isDestroyed })
        expect("the recogniser was started for it", awaitTrue(4_000) { recognizer.starts > starts })
        expect("the sheet reads Listening", awaitVoicePhase(setOf("listening"), 6_000) && waitFor(LISTENING_TITLE, 5_000) != null)
        val tab = activeCoreTab()
        expect("the landing opened a tab of its own, blank, sent by another app (fromIntent)", tab?.optString("id") != before && emptyTabUrl(tab?.optString("url")) && tab?.optBoolean("fromIntent") == true)
        SystemClock.sleep(800)
        shot("02-mic-listening")
        finding("after the mic: ${describeActive()}, voice phase ${voicePhase()}, recogniser starts ${recognizer.starts}")
        back()
        expect("a back closes the listening sheet", awaitSurface(false, 6_000))
        expect("the cancelled session let the recogniser go", awaitTrue(3_000) { recognizer.cancels + recognizer.destroys > 0 })
        backToThePrevious(tab?.optString("id"))
        showOverlay()
    }

    private fun touchTheFace() {
        val before = activeCoreTab()?.optString("id").orEmpty()
        var reading: OmniboxOpen? = null
        var keyboard = false
        val scene = traceFrames("widget-land-search-warm", JankBudget.Kind.OPEN) {
            expect("a finger reaches the pill on the face", touchPart(R.id.widget_search_face))
            SystemClock.sleep(150)
            hideOverlay()
            reading = awaitOmniboxOpen(10_000)
            keyboard = awaitIme(true, 8_000)
        }
        val open = reading
        expect("the pill lands in the omnibox, focused (${open?.describe()})", open?.ok == true)
        expect("the keyboard is up on the landing", keyboard)
        val tab = activeCoreTab()
        expect("the omnibox is the landing tab's own, in new-tab mode", chromeJsString(URLBAR_MODE_JS) == "new-tab" && chromeJsString(URLBAR_TAB_JS) == tab?.optString("id"))
        expect("the landing opened a tab of its own, blank, sent by another app (fromIntent)", tab?.optString("id") != before && emptyTabUrl(tab?.optString("url")) && tab?.optBoolean("fromIntent") == true)
        SystemClock.sleep(600)
        shot("03-pill-omnibox-keyboard")
        finding("after the pill: ${describeActive()}, ${open?.describe()}, keyboard $keyboard")
        finding("  RULING 5, the warm landing traced: " + (scene.trace?.describe() ?: "trace: none read (${scene.traceMissing ?: "no trace asked"})"))
        closeUrlField()
        awaitIme(false, 4_000)
        backToThePrevious(tab?.optString("id"))
        showOverlay()
    }

    private fun touchTheMask() {
        val before = activeCoreTab()?.optString("id").orEmpty()
        watchToasts()
        expect("a finger reaches the mask on the face", touchPart(R.id.widget_search_private))
        SystemClock.sleep(150)
        hideOverlay()
        val landed = privateLanded(12_000)
        expect("the mask lands in a new private tab, or in the toast where this WebView has no profiles ($landed)", landed != null)
        val tab = activeCoreTab()
        if (landed == PRIVATE_TAB) {
            expect("the private tab is a tab another app sent (fromIntent)", tab?.optString("id") != before && tab?.optBoolean("fromIntent") == true)
            expect("the chrome is on the private theme", awaitTrue(6_000) { host.themeDark && host.privateSurface })
            waitFor(PRIVATE_TITLE, 8_000)
            SystemClock.sleep(600)
            shot("04-mask-private-tab")
        } else {
            expect("no tab opened for a private landing this WebView cannot keep private", tab?.optString("id") == before)
            shot("04-mask-private-unavailable")
        }
        finding("after the mask: ${describeActive()}, landing $landed, private surface ${host.privateSurface}")
        if (landed == PRIVATE_TAB) backToThePrevious(tab?.optString("id"))
        showOverlay()
    }

    private fun takeDownTheHost() {
        onMain {
            overlay?.let { (it.parent as? ViewGroup)?.removeView(it) }
            overlay = null
            frame = null
            widgetView = null
            widgetHost?.let { host ->
                if (widgetId != AppWidgetManager.INVALID_APPWIDGET_ID) host.deleteAppWidgetId(widgetId)
                host.stopListening()
            }
            widgetHost = null
        }
        SystemClock.sleep(500)
    }

    // --- 5–7. the cold landings ------------------------------------------------------------------

    /**
     * The browser's task removed, the previous tab on screen until then, and the landing's intent
     * sent as the widget sends it – `send` defaults to the face's own PendingIntent – with a frame
     * grabber running from the send until `landed` answers. The previous tab must never paint:
     * no grabbed frame carries its orange; the landing's tab is the active one, the previous tab
     * still in the state behind it; the previous tab's view, if the platform made one, is not
     * shown. On record: the send-to-landing wall time, the main thread's CPU time over it, the
     * frames' timeline (the sheet).
     */
    private fun coldLanding(
        face: Face,
        landing: String,
        send: () -> Unit = { sendAsTheLauncher(SearchWidgetProvider.pendingIntent(app, face)) },
        landed: () -> String?
    ) {
        finding("\ncold $landing landing: preparing the previous tab")
        expect("before the cold $landing landing the previous tab is active and painted", preparePrevious())
        val hostBefore = host
        val hitsBefore = server.hits(PREVIOUS_PATH)
        val tabsBefore = coreState().optJSONObject("tabs")?.length() ?: 0
        onMain { activity.finishAndRemoveTask() }
        awaitDestroyed()
        SystemClock.sleep(1_500)
        expect("the browser's task is gone before the send", onMain { activity.isDestroyed } && frontPackage() != app.packageName)

        val started = watchStarts { send() }
        val grabber = FrameGrabber().also { it.start() }
        val cpuBefore = mainThreadCpuMs()
        val t0 = SystemClock.uptimeMillis()
        started.send()
        val created = started.awaitMain(20_000)
        expect("the intent creates one MainActivity (a cold start)", created is MainActivity)
        if (created !is MainActivity) {
            // Nothing came up: the scenes after this one need a browser, so launch it plainly.
            grabber.halt()
            finding("  cold $landing: no MainActivity within 20 s of the send (${grabber.frames().size} frames read); relaunching for the next scene")
            launch()
            ensureForeground()
            backToThePrevious(null)
            return
        }
        activity = created
        expect("the new activity brings a host of its own: the core boots anew", host !== hostBefore)
        val result = landed()
        val landedAt = SystemClock.uptimeMillis() - t0
        val cpuAfter = mainThreadCpuMs()
        SystemClock.sleep(700)
        grabber.halt()
        val frames = grabber.frames()
        expect("the $landing landing is up after the cold start ($result)", result != null)
        if (!awaitChromeUp(15_000)) {
            // The core never answered in the new activity: nothing below can be read.
            finding("  cold $landing: the chrome never came up in the new activity (${frames.size} frames read)")
            grabber.sheet("frames-cold-$landing", frames, "cold $landing landing: send at 0 ms, the chrome never came up")
            ensureForeground()
            return
        }
        val tab = activeCoreTab()
        val state = coreState()
        val previous = state.optJSONObject("tabs")?.optJSONObject(PREVIOUS_TAB)
        val flashes = frames.filter { it.orange >= FLASH_SHARE }
        val previousView = onMain { host.tabs.get(PREVIOUS_TAB) }
        val previousShown = onMain { previousView?.isShown == true && previousView.visibility == View.VISIBLE }
        if (result == PRIVATE_TOAST) {
            // No profiles on this WebView: there is nothing private to land in, so the restored tab
            // is the right page to paint, under the toast that says why (the same as the warm mask).
            expect("with no profiles the cold private landing stays on the restored tab and says so", tab != null && tab.optString("id") == PREVIOUS_TAB)
            finding("  the frame read is not applied to this landing: the restored tab is the page to paint here")
        } else {
            expect("the active tab is the landing's own, not the restored one", tab != null && tab.optString("id") != PREVIOUS_TAB && tab.optBoolean("fromIntent"))
            expect("no frame from the send to the landing shows the previous tab's page (${frames.size} frames read)", frames.isNotEmpty() && flashes.isEmpty())
            expect("the previous tab's view is not the one shown at the landing", !previousShown)
        }
        expect("the previous tab is restored behind it, not closed", previous != null && previous.optString("url").endsWith(PREVIOUS_PATH))
        finding(
            "  cold $landing: landed ${result ?: "no"} at +$landedAt ms wall, main thread CPU over it ${cpuMs(cpuBefore, cpuAfter)}, " +
                "frames ${frames.size} (first at +${frames.firstOrNull()?.at ?: "-"} ms, last at +${frames.lastOrNull()?.at ?: "-"} ms, max orange ${"%.2f".format(frames.maxOfOrNull { it.orange } ?: 0f)}), " +
                "tabs ${tabsBefore} -> ${state.optJSONObject("tabs")?.length() ?: 0}, active ${describeActive()}, previous view ${describeView(previousView)}, " +
                "previous page requests since the send ${server.hits(PREVIOUS_PATH) - hitsBefore}"
        )
        for (flash in flashes) finding("    ${if (result == PRIVATE_TOAST) "restored page" else "FLASH"} at +${flash.at} ms: orange ${"%.2f".format(flash.orange)}")
        grabber.sheet(
            "frames-cold-$landing",
            frames,
            "cold $landing landing: send at 0 ms, landed at +$landedAt ms" + (if (result == PRIVATE_TOAST) " (no profiles: the restored tab under the toast)" else "")
        )
        shot("0${5 + COLD_ORDER.indexOf(landing)}-cold-$landing")
        leaveLanding(result)
        backToThePrevious(tab?.optString("id"))
    }

    /** The omnibox open and focused with the keyboard up: the search landing's word. */
    private fun searchLanded(timeoutMs: Long): String? {
        val reading = awaitOmniboxOpen(timeoutMs)
        if (!reading.ok) return null
        val keyboard = awaitIme(true, 8_000)
        return if (keyboard) "omnibox focused, keyboard up" else "omnibox focused, keyboard down"
    }

    /** The QR sheet up and scanning (the stand-in camera reports ready): the scan landing's word. */
    private fun scanLanded(timeoutMs: Long): String? {
        if (!awaitQrPhase(setOf("starting", "scanning"), timeoutMs)) return null
        val scanning = awaitQrPhase(setOf("scanning"), 8_000)
        return if (scanning) "scanner up and scanning" else "scanner up (phase ${qrPhase()})"
    }

    /** A private tab active, or the toast on a WebView without profiles: the private landing's word. */
    private fun privateLanded(timeoutMs: Long): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        if (!awaitChromeUp(timeoutMs)) return null
        while (SystemClock.uptimeMillis() < deadline) {
            if (activeCoreTab()?.optString("containerId") == Profiles.PRIVATE_CONTAINER) return PRIVATE_TAB
            if (toastSeen(PRIVATE_UNAVAILABLE_TOAST)) return PRIVATE_TOAST
            SystemClock.sleep(100)
        }
        return null
    }

    /** The landing's surface closed (the sheet backed away, the field closed), so the next scene starts plain. */
    private fun leaveLanding(result: String?) {
        result ?: return
        if (result.startsWith("omnibox")) {
            closeUrlField()
            awaitIme(false, 4_000)
        } else if (result.startsWith("scanner")) {
            back()
            awaitSurface(false, 6_000)
        }
        SystemClock.sleep(400)
    }

    /** The previous tab active and on screen (a landing's tab closed first, when given). */
    private fun backToThePrevious(landingTab: String?) {
        val active = activeCoreTab()?.optString("id")
        if (landingTab != null && landingTab != PREVIOUS_TAB && landingTab == active) {
            coreInvoke("tab.close", json("tabId" to landingTab).toString())
            SystemClock.sleep(600)
        }
        if (activeCoreTab()?.optString("id") != PREVIOUS_TAB) {
            coreInvoke("tab.activate", json("tabId" to PREVIOUS_TAB).toString())
        }
        awaitTrue(6_000) { activeCoreTab()?.optString("id") == PREVIOUS_TAB }
        SystemClock.sleep(800)
    }

    /** The previous tab active and painted, the state given time to persist, before a cold start. */
    private fun preparePrevious(): Boolean {
        backToThePrevious(null)
        val painted = awaitOrange(10_000)
        settle()
        return activeCoreTab()?.optString("id") == PREVIOUS_TAB && painted
    }

    // --- 8. the launcher's shortcuts -------------------------------------------------------------

    private fun shortcuts() {
        val shortcuts = manifestShortcuts()
        finding("\nmanifest shortcuts of ${app.packageName}: ${shortcuts.map { "${it.id} -> ${it.intent?.action} @ ${it.intent?.component?.className} landing ${it.intent?.getStringExtra(Landing.EXTRA)}" }}")
        expect("the launcher lists the four shortcuts in rank order", shortcuts.map { it.id } == SHORTCUT_IDS)
        val trampoline = ComponentName(app.packageName, LauncherIconActivity::class.java.name)
        expect("every shortcut targets this build's package at the trampoline", shortcuts.isNotEmpty() && shortcuts.all { it.intent?.component == trampoline })
        val landings = shortcuts.associate { it.id to Landing.forwarded(it.intent?.action, it.intent?.getStringExtra(Landing.EXTRA)) }
        expect(
            "each shortcut's intent forwards as its landing (newTab, private, search, scan)",
            landings == mapOf("new-tab" to Landing.NEW_TAB, PrivateBrowsing.SHORTCUT_ID to Landing.PRIVATE, "search" to Landing.SEARCH, "scan-qr" to Landing.SCAN)
        )
        val labels = shortcuts.map { "${it.id}: '${it.shortLabel}' / '${it.longLabel}'" }
        finding("shortcut labels: $labels")
        expect(
            "the shortcuts carry their labels",
            shortcuts.all { !it.shortLabel.isNullOrEmpty() && !it.longLabel.isNullOrEmpty() }
        )

        val search = shortcuts.firstOrNull { it.id == "search" }?.intent?.let { Intent(it) }
        if (search != null) {
            coldLanding(
                Face(R.id.widget_search_face, Landing.SEARCH, SHORTCUT_REPLAY_CODE),
                "shortcut-search",
                send = { fireAsTheLauncher(search) }
            ) { searchLanded(30_000) }
            val records = awaitActivityRecords()
            expect("dumpsys after the cold shortcut: one MainActivity and no trampoline left", records["MainActivity"] == 1 && (records["LauncherIconActivity"] ?: 0) == 0)
            finding("  activity records after the cold shortcut: $records")
        } else {
            expect("the Search shortcut is installed", false)
        }

        warmShortcut(shortcuts.firstOrNull { it.id == "scan-qr" }?.intent, "scan-qr", "09-shortcut-scan-warm") { scanLanded(15_000) }
        warmShortcut(shortcuts.firstOrNull { it.id == "new-tab" }?.intent, "new-tab", "10-shortcut-new-tab-warm") {
            if (awaitTrue(15_000) { activeCoreTab().let { it != null && it.optString("id") != PREVIOUS_TAB && emptyTabUrl(it.optString("url")) } }) {
                if (urlbarOpen()) "new tab page with the field open" else "new tab page"
            } else null
        }
    }

    /**
     * Zenium in the background on the previous tab (Home), then the shortcut as the launcher
     * fires it: the trampoline relays the landing into the running activity's onNewIntent, and
     * Zenium comes back in front in the landing's state.
     */
    private fun warmShortcut(template: Intent?, id: String, still: String, landed: () -> String?) {
        if (template == null) {
            expect("the $id shortcut is installed", false)
            return
        }
        backToThePrevious(null)
        val activityBefore = activity
        val hostBefore = host
        val intentBefore = onMain { activity.intent }
        home()
        expect("Home puts Zenium behind the launcher", awaitFront(ours = false))
        SystemClock.sleep(1_200)
        val started = watchStarts { fireAsTheLauncher(template) }
        val t0 = SystemClock.uptimeMillis()
        started.send()
        val created = started.awaitMain(6_000)
        val result = landed()
        val at = SystemClock.uptimeMillis() - t0
        expect("the warm $id shortcut lands ($result)", result != null)
        expect("the warm shortcut creates no MainActivity: the running one takes the landing through onNewIntent", created == null && activity === activityBefore && host === hostBefore && onMain { activity.intent } !== intentBefore)
        expect("Zenium comes back in front", awaitFront(ours = true))
        val tab = activeCoreTab()
        expect("the landing's tab is a new one another app sent", tab?.optString("id") != PREVIOUS_TAB && tab?.optBoolean("fromIntent") == true)
        SystemClock.sleep(800)
        shot(still)
        finding("  warm $id: landed ${result ?: "no"} at +$at ms, trampoline created ${started.trampoline != null}, ${describeActive()}")
        leaveLanding(result)
        backToThePrevious(tab?.optString("id"))
    }

    private fun manifestShortcuts() =
        runCatching { app.getSystemService(ShortcutManager::class.java)?.manifestShortcuts }.getOrNull().orEmpty()
            .sortedBy { it.rank }

    /** The system stamps a manifest shortcut's intent with CLEAR_TASK and TASK_ON_HOME (ShortcutParser); the same here. */
    private fun fireAsTheLauncher(template: Intent) {
        app.startActivity(Intent(template).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_TASK_ON_HOME))
    }

    /**
     * The widget's PendingIntent sent as a launcher sends it. Since Android 14 the SENDER's own
     * standing counts towards a background start only when its send says so
     * (`setPendingIntentBackgroundActivityStartMode`, as Launcher3's does); the driver's is the
     * instrumentation's, the launcher's its visible window. The first run sent it bare and the
     * platform logged 'Background activity launch blocked … without BAL hardening this activity
     * start would be allowed'.
     */
    private fun sendAsTheLauncher(pendingIntent: PendingIntent) {
        val options = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ActivityOptions.makeBasic()
                .setPendingIntentBackgroundActivityStartMode(ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED)
                .toBundle()
        } else null
        pendingIntent.send(app, 0, null, null, null, null, options)
    }

    // --- what an intent started ------------------------------------------------------------------

    /**
     * Watches what `send` starts: a MainActivity created is a cold start (the application's
     * lifecycle callbacks, `onActivityCreated` fires for a creation alone), none within the wait a
     * warm one; the trampoline's creation is noted for the shortcut path. [send] arms the watch
     * and fires; [awaitMain] hands back the created MainActivity, or null.
     */
    private inner class Start(private val fire: () -> Unit) {
        private val created = CopyOnWriteArrayList<Activity>()
        private val trampolines = CopyOnWriteArrayList<Activity>()
        private val callbacks = object : Application.ActivityLifecycleCallbacks {
            override fun onActivityCreated(a: Activity, savedInstanceState: Bundle?) {
                when (a) {
                    is MainActivity -> created += a
                    is LauncherIconActivity -> trampolines += a
                }
            }
            override fun onActivityStarted(a: Activity) {}
            override fun onActivityResumed(a: Activity) {}
            override fun onActivityPaused(a: Activity) {}
            override fun onActivityStopped(a: Activity) {}
            override fun onActivitySaveInstanceState(a: Activity, outState: Bundle) {}
            override fun onActivityDestroyed(a: Activity) {}
        }
        private val application = app.applicationContext as Application
        val trampoline: Activity? get() = trampolines.firstOrNull()

        fun send() {
            application.registerActivityLifecycleCallbacks(callbacks)
            fire()
        }

        fun awaitMain(timeoutMs: Long): Activity? {
            val deadline = SystemClock.uptimeMillis() + timeoutMs
            while (created.isEmpty() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(50)
            application.unregisterActivityLifecycleCallbacks(callbacks)
            return created.firstOrNull()
        }
    }

    private fun watchStarts(fire: () -> Unit) = Start(fire)

    /** The browser's activity has been destroyed (after `finishAndRemoveTask`), or 10 s passed. */
    private fun awaitDestroyed() {
        val deadline = SystemClock.uptimeMillis() + 10_000
        while (!onMain { activity.isDestroyed } && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(200)
    }

    /** The system's Home, through UiAutomation: Zenium goes to the background, the launcher comes up. */
    private fun home() {
        ui.performGlobalAction(AccessibilityService.GLOBAL_ACTION_HOME)
    }

    private fun frontPackage(): String? = ui.rootInActiveWindow?.packageName?.toString()

    private fun awaitFront(ours: Boolean, timeoutMs: Long = 10_000): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val front = frontPackage()
            if (front != null && (front == app.packageName) == ours) return true
            SystemClock.sleep(250)
        }
        return (frontPackage() == app.packageName) == ours
    }

    /** The app's activities per `dumpsys activity activities` (class name → records), once the trampoline has left them. */
    private fun awaitActivityRecords(): Map<String, Int> {
        val deadline = SystemClock.uptimeMillis() + 6_000
        var records = activityRecords()
        while ((records["LauncherIconActivity"] ?: 0) > 0 && SystemClock.uptimeMillis() < deadline) {
            SystemClock.sleep(500)
            records = activityRecords()
        }
        return records
    }

    private fun activityRecords(): Map<String, Int> {
        val dump = shellCommand("dumpsys activity activities")
        val byClass = HashMap<String, MutableSet<String>>()
        for (match in ACTIVITY_RECORD.findAll(dump)) {
            val component = match.groupValues[2]
            if (!component.startsWith("${app.packageName}/")) continue
            byClass.getOrPut(component.substringAfterLast('.')) { HashSet() }.add(match.groupValues[1])
        }
        return byClass.mapValues { it.value.size }.toSortedMap()
    }

    // --- the frames ------------------------------------------------------------------------------

    private class GrabbedFrame(val at: Long, val orange: Float, val luminance: Float, val thumb: Bitmap)

    /**
     * Screenshots in a loop from a thread of its own, each stamped with its time since the loop
     * started, read for the previous tab's orange and the mean luminance, and kept as a thumbnail
     * for the sheet. The emulator's screenshot takes a few hundred milliseconds, so the read is
     * of a few frames a second: a page that painted for a frame or two may fall between grabs –
     * the previous tab's view being shown at the landing ([coldLanding]) is read beside it.
     */
    private inner class FrameGrabber : Thread("widget-frame-grabber") {
        @Volatile private var running = true
        private val grabbed = CopyOnWriteArrayList<GrabbedFrame>()
        private var t0 = 0L

        override fun start() {
            t0 = SystemClock.uptimeMillis()
            super.start()
        }

        override fun run() {
            while (running) {
                val bitmap = runCatching { ui.takeScreenshot() }.getOrNull()
                val at = SystemClock.uptimeMillis() - t0
                if (bitmap == null) {
                    SystemClock.sleep(80)
                    continue
                }
                val (orange, luminance) = read(bitmap)
                val thumb = Bitmap.createScaledBitmap(bitmap, max(1, bitmap.width / THUMB_SCALE), max(1, bitmap.height / THUMB_SCALE), true)
                if (thumb !== bitmap) bitmap.recycle()
                grabbed += GrabbedFrame(at, orange, luminance, thumb)
            }
        }

        fun halt() {
            running = false
            join(5_000)
        }

        fun frames(): List<GrabbedFrame> = grabbed.toList()

        /** The share of sampled pixels within tolerance of the previous tab's orange, and the mean luminance (0–1). */
        private fun read(bitmap: Bitmap): Pair<Float, Float> {
            var orange = 0
            var total = 0
            var luminance = 0.0
            var y = 0
            while (y < bitmap.height) {
                var x = 0
                while (x < bitmap.width) {
                    val c = bitmap.getPixel(x, y)
                    val r = Color.red(c)
                    val g = Color.green(c)
                    val b = Color.blue(c)
                    if (kotlin.math.abs(r - PREVIOUS_R) <= TOLERANCE && kotlin.math.abs(g - PREVIOUS_G) <= TOLERANCE && kotlin.math.abs(b - PREVIOUS_B) <= TOLERANCE) orange++
                    luminance += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
                    total++
                    x += SAMPLE_STEP
                }
                y += SAMPLE_STEP
            }
            return if (total == 0) 0f to 0f else (orange.toFloat() / total) to (luminance / total).toFloat()
        }

        /** `widget-<theme>-<name>.png`: the thumbnails in rows, each captioned with its time and its orange share. */
        fun sheet(name: String, frames: List<GrabbedFrame>, caption: String) {
            if (frames.isEmpty()) return
            val thumbWidth = frames.first().thumb.width
            val thumbHeight = frames.first().thumb.height
            val columns = minOf(SHEET_COLUMNS, frames.size)
            val rows = (frames.size + columns - 1) / columns
            val pad = 12
            val label = 30
            val header = 44
            val sheet = Bitmap.createBitmap(
                pad + columns * (thumbWidth + pad),
                header + pad + rows * (thumbHeight + label + pad),
                Bitmap.Config.ARGB_8888
            )
            val canvas = Canvas(sheet)
            canvas.drawColor(0xFF15141A.toInt())
            val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 22f }
            val small = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFB8B7C0.toInt(); textSize = 19f }
            val flash = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFF7A00.toInt(); style = Paint.Style.STROKE; strokeWidth = 4f }
            canvas.drawText("$caption · ${frames.size} frames · orange = the previous tab's page", pad.toFloat(), 30f, text)
            frames.forEachIndexed { i, frame ->
                val x = pad + (i % columns) * (thumbWidth + pad)
                val y = header + pad + (i / columns) * (thumbHeight + label + pad)
                canvas.drawBitmap(frame.thumb, x.toFloat(), y.toFloat(), null)
                if (frame.orange >= FLASH_SHARE) canvas.drawRect(x - 2f, y - 2f, x + thumbWidth + 2f, y + thumbHeight + 2f, flash)
                canvas.drawText("+${frame.at} ms  orange ${"%.1f".format(frame.orange * 100)}%", x.toFloat(), (y + thumbHeight + 22).toFloat(), small)
            }
            File(out, "widget-$THEME-$name.png").outputStream().use { sheet.compress(Bitmap.CompressFormat.PNG, 100, it) }
            sheet.recycle()
            for (frame in frames) frame.thumb.recycle()
        }
    }

    /** The previous tab's orange on screen now (its share of the window's pixels). */
    private fun orangeOnScreen(): Float {
        val bitmap = ui.takeScreenshot() ?: return 0f
        var orange = 0
        var total = 0
        var y = 0
        while (y < bitmap.height) {
            var x = 0
            while (x < bitmap.width) {
                val c = bitmap.getPixel(x, y)
                if (kotlin.math.abs(Color.red(c) - PREVIOUS_R) <= TOLERANCE && kotlin.math.abs(Color.green(c) - PREVIOUS_G) <= TOLERANCE && kotlin.math.abs(Color.blue(c) - PREVIOUS_B) <= TOLERANCE) orange++
                total++
                x += SAMPLE_STEP
            }
            y += SAMPLE_STEP
        }
        bitmap.recycle()
        return if (total == 0) 0f else orange.toFloat() / total
    }

    private fun awaitOrange(timeoutMs: Long): Boolean = awaitTrue(timeoutMs) { orangeOnScreen() >= PAGE_SHARE }

    // --- the stand-ins ---------------------------------------------------------------------------

    /** A recogniser that is ready and hears speech begin shortly after each start, so the sheet reads Listening. */
    private class StandInRecognizer : Voice.Recognizer {
        private val main = Handler(Looper.getMainLooper())
        @Volatile private var listener: RecognitionListener? = null
        @Volatile var starts = 0
        @Volatile var cancels = 0
        @Volatile var destroys = 0

        override fun start(intent: Intent, listener: RecognitionListener) {
            starts++
            this.listener = listener
            main.postDelayed({
                val live = this.listener ?: return@postDelayed
                live.onReadyForSpeech(Bundle())
                live.onBeginningOfSpeech()
            }, 300)
        }

        override fun cancel() {
            cancels++
            listener = null
        }

        override fun destroy() {
            destroys++
            listener = null
        }
    }

    /** A camera that reports ready with a torch and paints a dark viewfinder into the preview, nothing to decode. */
    private class StandInCamera : QrScan.Camera {
        private val main = Handler(Looper.getMainLooper())
        @Volatile private var listener: QrScan.Listener? = null
        private var view: TextureView? = null
        private var surface: Surface? = null
        @Volatile var starts = 0

        fun reset(): StandInCamera = this

        override fun start(preview: TextureView, listener: QrScan.Listener) {
            starts++
            this.listener = listener
            view = preview
            preview.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(texture: SurfaceTexture, width: Int, height: Int) = paint(texture)
                override fun onSurfaceTextureSizeChanged(texture: SurfaceTexture, width: Int, height: Int) = paint(texture)
                override fun onSurfaceTextureDestroyed(texture: SurfaceTexture): Boolean {
                    surface?.release()
                    surface = null
                    return true
                }
                override fun onSurfaceTextureUpdated(texture: SurfaceTexture) {}
            }
            preview.surfaceTexture?.let { paint(it) }
            main.postDelayed({ this.listener?.ready(true) }, 250)
        }

        private fun paint(texture: SurfaceTexture) {
            val target = surface ?: Surface(texture).also { surface = it }
            val canvas = runCatching { target.lockCanvas(null) }.getOrNull() ?: return
            canvas.drawColor(0xFF2A2F3A.toInt())
            target.unlockCanvasAndPost(canvas)
        }

        override fun setTorch(on: Boolean) {
            main.post { listener?.torch(on) }
        }

        override fun close() {
            listener = null
            main.post {
                view?.surfaceTextureListener = null
                view = null
                surface?.release()
                surface = null
            }
        }
    }

    // --- readings --------------------------------------------------------------------------------

    private fun voicePhase(): String = jsString("(function(){var s=document.querySelector('[data-testid=voice-sheet]');return s?(s.dataset.voicePhase||''):''})()")

    private fun awaitVoicePhase(phases: Set<String>, timeoutMs: Long): Boolean = awaitTrue(timeoutMs) { voicePhase() in phases }

    private fun qrPhase(): String = jsString("(function(){var s=document.querySelector('[data-testid=qr-sheet]');return s?(s.dataset.qrPhase||''):''})()")

    private fun awaitQrPhase(phases: Set<String>, timeoutMs: Long): Boolean = awaitTrue(timeoutMs) { qrPhase() in phases }

    /** The chrome answers with its bridge and its stores up: a core read ([coreInvoke]) can be made without a 15 s timeout. */
    private fun chromeUp(): Boolean =
        jsString("(function(){return (window.zen&&window.zen.invoke&&window.__zenStores)?'up':''})()") == "up"

    private fun awaitChromeUp(timeoutMs: Long): Boolean = awaitTrue(timeoutMs) { chromeUp() }

    private fun privateTabsCapability(): Boolean =
        runCatching { coreState().getJSONObject("capabilities").optBoolean("privateTabs") }.getOrDefault(false)

    private fun emptyTabUrl(url: String?): Boolean = url.isNullOrEmpty() || url == BLANK_URL

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} '${it?.optString("url")}' fromIntent ${it?.optBoolean("fromIntent")} container ${it?.optString("containerId")}" }

    private fun describeView(view: TabWebView?): String =
        if (view == null) "none made" else onMain { "made, visibility ${view.visibility}, shown ${view.isShown}, progress ${view.progress}, url '${view.url}'" }

    private fun describe(info: AppWidgetProviderInfo): String =
        "minWidth ${info.minWidth} minHeight ${info.minHeight} minResizeWidth ${info.minResizeWidth} minResizeHeight ${info.minResizeHeight} " +
            (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) "maxResizeWidth ${info.maxResizeWidth} maxResizeHeight ${info.maxResizeHeight} targetCells ${info.targetCellWidth}x${info.targetCellHeight} previewLayout ${info.previewLayout} description '${info.loadDescription(app)}' " else "") +
            "resizeMode ${info.resizeMode} category ${info.widgetCategory} updatePeriod ${info.updatePeriodMillis} previewImage ${info.previewImage} label '${info.loadLabel(app.packageManager)}'"

    private fun nightModeWord(): String =
        if (app.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES) "night" else "day"

    /** The main thread's CPU time (user + system) in ms per `/proc`; null where the read fails. */
    private fun mainThreadCpuMs(): Long? = runCatching {
        val stat = File("/proc/self/task/${Process.myPid()}/stat").readText()
        val rest = stat.substring(stat.lastIndexOf(')') + 2).split(' ')
        val ticks = rest[11].toLong() + rest[12].toLong()
        val hz = Os.sysconf(OsConstants._SC_CLK_TCK).takeIf { it > 0 } ?: 100L
        ticks * 1000L / hz
    }.getOrNull()

    private fun cpuMs(before: Long?, after: Long?): String =
        if (before == null || after == null) "unread" else "${after - before} ms"

    private fun dp(value: Int): Int = (value * density).roundToInt()

    private fun jsString(code: String): String =
        runCatching { JSONTokener(chromeJs(code)).nextValue() }.getOrNull()?.takeIf { it != JSONObject.NULL }?.toString() ?: ""

    private fun json(vararg pairs: Pair<String, Any?>): JSONObject =
        JSONObject().also { for ((key, value) in pairs) it.put(key, value ?: JSONObject.NULL) }

    private fun <T> onMain(block: () -> T): T {
        var result: T? = null
        instrumentation.runOnMainSync { result = block() }
        @Suppress("UNCHECKED_CAST")
        return result as T
    }

    private fun expect(name: String, ok: Boolean) {
        Log.i(tag, "check \"$name\": ${if (ok) "ok" else "FAILED"}")
        finding("  $name ${if (ok) "PASS" else "FAIL"}")
        if (!ok) failures.add(name)
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private val THEME = InstrumentationRegistry.getArguments().getString("theme").let {
            if (it == "dark") "dark" else "light"
        }

        private const val PORT = 18171
        private const val PREVIOUS_PATH = "/previous.html"
        /** The seeded tab (`widget-demo-state.json`). */
        private const val PREVIOUS_TAB = "tab_previous"
        private const val BLANK_URL = "zen://blank"
        private const val HOST_ID = 1979

        /** The previous tab's orange (`#FF7A00`), a colour the chrome never paints. */
        private const val PREVIOUS_CSS = "#ff7a00"
        private const val PREVIOUS_R = 0xFF
        private const val PREVIOUS_G = 0x7A
        private const val PREVIOUS_B = 0x00
        private const val TOLERANCE = 28
        private const val SAMPLE_STEP = 6
        /** A frame with this share of the previous tab's orange shows its page. */
        private const val FLASH_SHARE = 0.01f
        /** The previous tab on screen: most of the window is its page. */
        private const val PAGE_SHARE = 0.3f
        private const val THUMB_SCALE = 5
        private const val SHEET_COLUMNS = 8

        /** A launcher's 4×1 frame on a 412 dp phone, and where on the backdrop it sits. */
        private const val FRAME_WIDTH_DP = 330
        private const val FRAME_HEIGHT_DP = 80
        private const val FRAME_TOP_SHARE = 0.18f

        /** Request codes the replays use where no face part fires (the widget's own are 1–3). */
        private const val SCAN_REPLAY_CODE = 11
        private const val SHORTCUT_REPLAY_CODE = 12

        private val COLD_ORDER = listOf("search", "private", "scan", "shortcut-search")

        /** The face's words (`strings.xml`): the omnibox's hint, the mic's and the mask's names. Harness contracts. */
        private const val HINT_TEXT = "Search or enter address"
        private const val MIC_LABEL = "Search with your voice"
        private const val MASK_LABEL = "New private tab"
        private const val WIDGET_LABEL = "Zenium search"
        private const val LISTENING_TITLE = "Listening"
        private const val PRIVATE_TITLE = "You're browsing privately"
        private const val PRIVATE_UNAVAILABLE_TOAST = "Private tabs need a newer Android System WebView"
        private const val PRIVATE_TAB = "private tab"
        private const val PRIVATE_TOAST = "toast: no profiles on this WebView"

        /** The launcher's static shortcuts (`shortcuts.xml`), in rank order from the icon. */
        private val SHORTCUT_IDS = listOf("new-tab", PrivateBrowsing.SHORTCUT_ID, "search", "scan-qr")

        private const val URLBAR_MODE_JS = "(function(){var u=((((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).urlbar||{});return String(u.mode||'')})()"
        private const val URLBAR_TAB_JS = "(function(){var u=((((window.__zenStores||{}).ui||{get:function(){return {}}}).get()||{}).urlbar||{});return String(u.tabId||'')})()"

        private val ACTIVITY_RECORD = Regex("ActivityRecord\\{([0-9a-f]+) u\\d+ ([\\w.]+/[\\w.$]+)")
    }
}
