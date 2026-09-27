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
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.speech.RecognitionListener
import android.system.Os
import android.system.OsConstants
import android.util.Log
import android.util.SizeF
import android.util.TypedValue
import android.view.ContextThemeWrapper
import android.view.Gravity
import android.view.PixelCopy
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.ViewTreeObserver
import android.view.Window
import android.widget.FrameLayout
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import kotlin.math.abs
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
 *    its colours read against the system's Material You roles on Android 12+ (WID-03: the pill
 *    colorSurfaceContainerHigh at Chrome's 0.9 over the wallpaper and without a hairline, the
 *    ink colorOnSurfaceVariant at full alpha, as Chrome's widget; the drawn pill sampled against
 *    the wallpaper it composites over and over black and white for its alpha, its top edge read
 *    for the absent hairline), and the provider's floor read off its info: four cells, no face
 *    below 240 dp, as Chrome's;
 *  - a real finger on each part of the face with Zenium in front: the mic lands in voice search
 *    (a stand-in recogniser, the sheet reads Listening), the pill in the omnibox with the keyboard
 *    up (traced: RULING 5's long tasks by the renderer's own clock), the mask in a new private
 *    tab – or, on a WebView without profiles, in the toast that says so;
 *  - the COLD landings (the WID-07 rule): the browser's task removed, the widget's own
 *    `PendingIntent` sent for `search`, `scan` and `private`, and the new window's frames grabbed
 *    from its first buffer to the landing (`PixelCopy`, up to 20 a second) and read for the
 *    previous tab's page – a full-bleed orange page the profile restores as its active tab –
 *    which must never paint: the landing rides the core's boot answer and opens its own new tab
 *    in the boot's run, before the chrome's first frame. Beside the pixels, every draw of the
 *    window is counted with whether the previous tab's view was shown in it (an `OnDrawListener`,
 *    the frame-exact signal). The frames go on a sheet (`widget-<theme>-frames-cold-<landing>.png`);
 *    the send-to-landing wall time, the main thread's CPU time over it and the grab rate are on
 *    record;
 *  - the launcher's four static shortcuts read from the manifest in rank order with their
 *    landings, the Search shortcut fired cold through the trampoline with the same frame read,
 *    Scan QR code and New tab fired warm from Home;
 *  - the Quick Actions widget (WID-02), Chrome's second provider – the search bar with the
 *    Voice, Private and QR-scan buttons in one resizable widget: its info read (Chrome's floor,
 *    48 dp, resizable both ways), an id bound on the driver's host and the face laid at each of
 *    Chrome's three forms by height (xsmall under 72 dp, small under 155, medium from there) with
 *    the host's default padding kept, so the PROVIDER is handed the exact size a launcher hands
 *    it; the form read off the host (its row, the bar's click, each button's visibility by the
 *    drop rule), the three surfaces read against the system's roles and the drawn pixels – opaque
 *    and without a hairline, as Chrome's quick action widget is; the floor scene at the
 *    provider's minimum width, where the scan button drops on xsmall and small as Chrome's Lens
 *    does; a finger on each part of the small form (voice search, the omnibox, a private tab or
 *    the toast, the QR scanner). A still of each form (`widget-<theme>-quick-actions-<form>.png`);
 *  - the game widget (WID-04 / ERR-03, gate #607 (f)), Roll's one-cell face: its info read (one
 *    cell, fixed, the gate's words), an id bound on the same host and the face laid at a
 *    launcher's cell with the host's padding kept, the card read against the quick actions
 *    widget's surface role (opaque, no hairline on Android 12+) and the glyph's indigo and ink
 *    found on it, a still (`widget-<theme>-game.png`); a finger on the face (a new tab on
 *    `zen://game` sent by another app, the stage up – its label in the tree, or the document's
 *    own word of the mounted region where the WebView exposes no node for it), and the COLD landing with
 *    the same frame read as the others.
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
        coldLanding(SearchWidgetProvider.FACES[2], "private") { privateLanded(30_000, armToastRecord = true) }
        coldLanding(
            Face(R.id.widget_search_face, Landing.SCAN, SCAN_REPLAY_CODE),
            "scan",
            send = { app.startActivity(SearchWidgetProvider.intent(app, Landing.SCAN)) }
        ) { scanLanded(30_000) }

        shortcuts()
        quickActions()
        gameWidget()
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
        expect("the widget asks for four cells by one (minWidth 240 dp as Chrome's search_widget_info, minHeight 40 dp)", info.minWidth == dp(FOUR_CELLS_DP) && info.minHeight == dp(40))
        expect("the widget resizes horizontally only", info.resizeMode == AppWidgetProviderInfo.RESIZE_HORIZONTAL)
        expect("the widget is for the home screen", info.widgetCategory and AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN != 0)
        expect("the widget is offered in the searchbox category too, as Chrome's is", info.widgetCategory and AppWidgetProviderInfo.WIDGET_CATEGORY_SEARCHBOX != 0)
        // The provider declares no minResizeWidth, so the platform makes the floor the minWidth
        // itself (AppWidgetServiceImpl.java:2735): a launcher honouring the floor refuses every
        // frame below 240 dp, and no narrower face exists – as Chrome's widget has none.
        expect(
            "the provider's floor is four cells: minResizeWidth is the minWidth (${info.minResizeWidth} px, ${dp(FOUR_CELLS_DP)} px for 240 dp), refused below 240 dp",
            info.minResizeWidth == info.minWidth && info.minResizeWidth == dp(FOUR_CELLS_DP)
        )
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
        theFacesColours(launcherContext, face)
    }

    /**
     * The face's colours (WID-03): on Android 12+ the roles Chrome's widget takes from Material
     * You – the pill's fill colorSurfaceContainerHigh at Chrome's 0.9 over the wallpaper
     * (search_widget_template.xml:19), the hint's and the glyphs' ink colorOnSurfaceVariant, no
     * hairline – resolved in the launcher's configuration and read against the system's own
     * tokens: the platform's role colours on 34+, the neutral-variant palette steps MDC gives the
     * roles on 31–33. Below 31 the v2 face, opaque with its border. The mark keeps the brand
     * indigo on every API. The alpha rides the fill alone: the pill's view and every child stand
     * at full alpha, the ink and the mark are opaque colours. Then the drawn pill itself: a pixel
     * of its interior, clear of the mark, must be the fill composited over the wallpaper's pixel
     * beneath it (the wallpaper drawn alone for the read); the same pixel drawn over black and
     * over white gives the pill's alpha a channel (255 minus the two draws' difference), which
     * must read 0.9 on 12+ and opaque below; its top edge, where a 1 dp hairline would lie, must
     * be the interior's colour on 12+ and the border's below.
     */
    private fun theFacesColours(launcherContext: Context, face: View) {
        val res = launcherContext.resources
        val theme = launcherContext.theme
        val dark = THEME == "dark"
        val dynamic = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
        val fill = res.getColor(R.color.widget_search_fill, theme)
        val ink = res.getColor(R.color.widget_search_ink, theme)
        val hint = res.getColor(R.color.widget_search_hint, theme)
        val mark = res.getColor(R.color.widget_search_mark, theme)
        val v2Panel = res.getColor(if (dark) R.color.v2_panel_dark else R.color.v2_panel_light, theme)
        finding("\nface colours in the launcher's configuration ($THEME): fill ${hex(fill)} (alpha ${Color.alpha(fill)} of 255) ink ${hex(ink)} hint ${hex(hint)} mark ${hex(mark)}; the v2 panel would be ${hex(v2Panel)}")
        when {
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> {
                val systemFill = res.getColor(if (dark) android.R.color.system_surface_container_high_dark else android.R.color.system_surface_container_high_light, theme)
                val systemInk = res.getColor(if (dark) android.R.color.system_on_surface_variant_dark else android.R.color.system_on_surface_variant_light, theme)
                finding("the system's roles: surfaceContainerHigh ${hex(systemFill)} onSurfaceVariant ${hex(systemInk)}")
                expect("the pill fills with the system's colorSurfaceContainerHigh, as Chrome's does", rgb(fill) == rgb(systemFill))
                expect("the ink is the system's colorOnSurfaceVariant, as Chrome's hint and mic are", ink == systemInk)
            }
            dynamic -> {
                val systemInk = res.getColor(if (dark) android.R.color.system_neutral2_200 else android.R.color.system_neutral2_700, theme)
                finding("the system's neutral-variant step: ink ${hex(systemInk)}")
                expect("the ink is the neutral-variant step MDC gives colorOnSurfaceVariant", ink == systemInk)
                expect("the fill left the v2 panel for the system's palette (colorSurfaceContainerHigh re-lit)", rgb(fill) != rgb(v2Panel))
            }
            else -> expect("below Android 12 the face keeps the v2 panel, opaque", fill == v2Panel && Color.alpha(fill) == 0xFF)
        }
        if (dynamic) {
            expect("the fill carries Chrome's 0.9 alpha over the wallpaper ($FILL_ALPHA of 255)", Color.alpha(fill) == FILL_ALPHA)
            expect("the hint reads in the ink's role at full alpha, as Chrome's default_text_color_secondary does", hint == ink)
            expect("the ink and the mark are opaque colours: the alpha rides the fill alone", Color.alpha(ink) == 0xFF && Color.alpha(mark) == 0xFF)
        } else {
            expect("below Android 12 the hint is the ink at 69 %", Color.alpha(hint) in 170..182)
        }
        expect("the mark keeps the brand indigo on the system's surface", mark == (if (dark) 0xFF8284F0.toInt() else 0xFF6264DC.toInt()))
        val viewAlphas = onMain { FACE_VIEWS.map { face.findViewById<View>(it)?.alpha ?: -1f } }
        finding("the pill's view and its children (pill, mark, hint, mic, mask) at alpha $viewAlphas")
        expect("the pill's view, the mark, the hint, the mic and the mask stand at full alpha (no view fades, as Chrome's text_container does)", viewAlphas.all { it == 1f })

        val drawn = drawFace() ?: return
        val (bitmap, band) = drawn
        val pill = viewBounds(R.id.widget_search_face)
        val x = pill.left + dp(30) - band.left
        val y = pill.top + dp(4) - band.top
        // The edge read on the straight run of the top edge (the pill's middle, clear of the 24 dp
        // corners and of every glyph), one row in – where a 1 dp hairline would be.
        val edgeX = pill.centerX() - band.left
        val edgeY = pill.top + 1 - band.top
        val pixel = pixelAt(bitmap, x, y)
        val edge = pixelAt(bitmap, edgeX, edgeY)
        bitmap.recycle()
        // The wallpaper alone under the same pixel; then the face over black and over white – a
        // known backdrop each – so the pill's alpha reads off the two draws a channel:
        // 255 - (over white - over black).
        val beneath = drawFace(withFace = false)?.let { (wallpaper, _) -> pixelAt(wallpaper, x, y).also { wallpaper.recycle() } } ?: 0
        val onBlack = drawFace(backdrop = Color.BLACK)?.let { (b, _) -> pixelAt(b, x, y).also { b.recycle() } } ?: 0
        val onWhite = drawFace(backdrop = Color.WHITE)?.let { (b, _) -> pixelAt(b, x, y).also { b.recycle() } } ?: 0
        val measuredAlpha = listOf(
            255 - (Color.red(onWhite) - Color.red(onBlack)),
            255 - (Color.green(onWhite) - Color.green(onBlack)),
            255 - (Color.blue(onWhite) - Color.blue(onBlack))
        )
        val expectedAlpha = if (dynamic) FILL_ALPHA else 0xFF
        finding(
            "the drawn pill's interior at (+30 dp, +4 dp): ${hex(pixel)} over the wallpaper's ${hex(beneath)} (the fill over it would be ${hex(over(fill, beneath))}); " +
                "over black ${hex(onBlack)}, over white ${hex(onWhite)}: the pill's alpha reads $measuredAlpha of 255 a channel; the top edge at its middle, +1 px: ${hex(edge)}"
        )
        expect("the drawn pill is the fill composited over the wallpaper", near(pixel, over(fill, beneath)))
        expect(
            if (dynamic) "the drawn pill's alpha reads Chrome's 0.9 ($FILL_ALPHA ± 3 of 255) over black and over white" else "below Android 12 the drawn pill reads opaque (255 of 255)",
            measuredAlpha.all { abs(it - expectedAlpha) <= 3 }
        )
        if (dynamic) {
            expect("no hairline: the pill's top edge is its interior's colour", near(edge, pixel))
        } else {
            expect("below Android 12 the pill keeps its v2 border: the top edge is not the interior", !near(edge, pixel))
        }
    }

    private fun hex(color: Int): String = "#%08X".format(color)

    private fun rgb(color: Int): Int = color and 0xFFFFFF

    private fun pixelAt(bitmap: Bitmap, x: Int, y: Int): Int =
        if (x in 0 until bitmap.width && y in 0 until bitmap.height) bitmap.getPixel(x, y) else 0

    /** `src` composited over an opaque `dst` (source-over, as the software canvas blends). */
    private fun over(src: Int, dst: Int): Int {
        val a = Color.alpha(src) / 255f
        fun channel(s: Int, d: Int) = (s * a + d * (1f - a)).roundToInt().coerceIn(0, 255)
        return Color.rgb(channel(Color.red(src), Color.red(dst)), channel(Color.green(src), Color.green(dst)), channel(Color.blue(src), Color.blue(dst)))
    }

    /** Two opaque colours within a few steps a channel (a software draw's rounding). */
    private fun near(a: Int, b: Int): Boolean =
        Color.alpha(a) == Color.alpha(b) &&
            abs(Color.red(a) - Color.red(b)) <= 3 &&
            abs(Color.green(a) - Color.green(b)) <= 3 &&
            abs(Color.blue(a) - Color.blue(b)) <= 3

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

    /**
     * The face in a 4×1 frame near the top of a wallpaper-like backdrop laid over the window,
     * taking the touches. [fourCells] sizes the host as the search widget's scenes have it – the
     * frame's size handed to the provider, the host's padding zeroed so the face fills the frame;
     * false leaves the frame to [layTheFace], which keeps the host's padding.
     */
    private fun showOnTheBackdrop(face: View, hostView: AppWidgetHostView?, fourCells: Boolean = true) {
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
            if (fourCells) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    hostView?.updateAppWidgetSize(Bundle(), listOf(SizeF(FRAME_WIDTH_DP.toFloat(), FRAME_HEIGHT_DP.toFloat())))
                } else {
                    @Suppress("DEPRECATION")
                    hostView?.updateAppWidgetSize(null, FRAME_WIDTH_DP, FRAME_HEIGHT_DP, FRAME_WIDTH_DP, FRAME_HEIGHT_DP)
                }
                hostView?.setPadding(0, 0, 0, 0)
            }
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
    private fun saveFace(name: String = "widget-$THEME-face") {
        val (bitmap, _) = drawFace() ?: return
        File(out, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    /**
     * The band the face still is cut from – the frame with a 24 dp margin – drawn, with its screen
     * rect; null before the host is up. For the colour reads: the wallpaper alone (`withFace`
     * false, the frame hidden for the draw) or the face over a flat [backdrop] colour in the
     * wallpaper's place – swapped in and back within the one main-thread pass, so no frame shows it.
     */
    private fun drawFace(withFace: Boolean = true, backdrop: Int? = null): Pair<Bitmap, Rect>? {
        val overlay = overlay ?: return null
        val bounds = frameBounds()
        val margin = dp(24)
        val band = Rect(bounds).apply { inset(-margin, -margin) }
        val bitmap = Bitmap.createBitmap(band.width(), band.height(), Bitmap.Config.ARGB_8888)
        onMain {
            val canvas = Canvas(bitmap)
            val at = IntArray(2).also { overlay.getLocationOnScreen(it) }
            canvas.translate((at[0] - band.left).toFloat(), (at[1] - band.top).toFloat())
            val wallpaper = overlay.background
            if (backdrop != null) overlay.background = ColorDrawable(backdrop)
            if (!withFace) frame?.visibility = View.INVISIBLE
            overlay.draw(canvas)
            if (!withFace) frame?.visibility = View.VISIBLE
            if (backdrop != null) overlay.background = wallpaper
        }
        return bitmap to band
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

    /** The [part] (its view [id] on the face) under a finger: voice search; [still] the shot's name. */
    private fun touchTheMic(id: Int = R.id.widget_search_mic, still: String = "02-mic-listening", part: String = "the mic") {
        val before = activeCoreTab()?.optString("id").orEmpty()
        val intentBefore = onMain { activity.intent }
        val starts = recognizer.starts
        expect("a finger reaches $part on the face", touchPart(id))
        SystemClock.sleep(150)
        hideOverlay()
        val up = awaitVoicePhase(setOf("starting", "listening"), 10_000)
        expect("$part lands in voice search: the sheet is up (phase ${voicePhase()})", up)
        expect("the widget's intent arrived through onNewIntent (the running activity, no relaunch)", onMain { activity.intent } !== intentBefore && !onMain { activity.isDestroyed })
        expect("the recogniser was started for it", awaitTrue(4_000) { recognizer.starts > starts })
        expect("the sheet reads Listening", awaitVoicePhase(setOf("listening"), 6_000) && waitFor(LISTENING_TITLE, 5_000) != null)
        val tab = activeCoreTab()
        expect("the landing opened a tab of its own, blank, sent by another app (fromIntent)", tab?.optString("id") != before && emptyTabUrl(tab?.optString("url")) && tab?.optBoolean("fromIntent") == true)
        SystemClock.sleep(800)
        shot(still)
        finding("after $part: ${describeActive()}, voice phase ${voicePhase()}, recogniser starts ${recognizer.starts}")
        back()
        expect("a back closes the listening sheet", awaitSurface(false, 6_000))
        expect("the cancelled session let the recogniser go", awaitTrue(3_000) { recognizer.cancels + recognizer.destroys > 0 })
        backToThePrevious(tab?.optString("id"))
        showOverlay()
    }

    /** The [part] (its view [id]) under a finger: the omnibox, the landing traced as [scene]; [still] the shot's name. */
    private fun touchTheFace(
        id: Int = R.id.widget_search_face,
        still: String = "03-pill-omnibox-keyboard",
        scene: String = "widget-land-search-warm",
        part: String = "the pill"
    ) {
        val before = activeCoreTab()?.optString("id").orEmpty()
        var reading: OmniboxOpen? = null
        var keyboard = false
        val traced = traceFrames(scene, JankBudget.Kind.OPEN) {
            expect("a finger reaches $part on the face", touchPart(id))
            SystemClock.sleep(150)
            hideOverlay()
            reading = awaitOmniboxOpen(10_000)
            keyboard = awaitIme(true, 8_000)
        }
        val open = reading
        expect("$part lands in the omnibox, focused (${open?.describe()})", open?.ok == true)
        expect("the keyboard is up on the landing", keyboard)
        val tab = activeCoreTab()
        expect("the omnibox is the landing tab's own, in new-tab mode", chromeJsString(URLBAR_MODE_JS) == "new-tab" && chromeJsString(URLBAR_TAB_JS) == tab?.optString("id"))
        expect("the landing opened a tab of its own, blank, sent by another app (fromIntent)", tab?.optString("id") != before && emptyTabUrl(tab?.optString("url")) && tab?.optBoolean("fromIntent") == true)
        SystemClock.sleep(600)
        shot(still)
        finding("after $part: ${describeActive()}, ${open?.describe()}, keyboard $keyboard")
        finding("  RULING 5, the warm landing traced: " + (traced.trace?.describe() ?: "trace: none read (${traced.traceMissing ?: "no trace asked"})"))
        closeUrlField()
        awaitIme(false, 4_000)
        backToThePrevious(tab?.optString("id"))
        showOverlay()
    }

    /** The [part] (its view [id]) under a finger: a private tab, or the toast; [still] the shot's stem (`-tab` / `-unavailable`). */
    private fun touchTheMask(id: Int = R.id.widget_search_private, still: String = "04-mask-private", part: String = "the mask") {
        val before = activeCoreTab()?.optString("id").orEmpty()
        watchToasts()
        expect("a finger reaches $part on the face", touchPart(id))
        SystemClock.sleep(150)
        hideOverlay()
        val landed = privateLanded(12_000)
        expect("$part lands in a new private tab, or in the toast where this WebView has no profiles ($landed)", landed != null)
        val tab = activeCoreTab()
        if (landed == PRIVATE_TAB) {
            expect("the private tab is a tab another app sent (fromIntent)", tab?.optString("id") != before && tab?.optBoolean("fromIntent") == true)
            expect("the chrome is on the private theme", awaitTrue(6_000) { host.themeDark && host.privateSurface })
            waitFor(PRIVATE_TITLE, 8_000)
            SystemClock.sleep(600)
            shot("$still-tab")
        } else {
            expect("no tab opened for a private landing this WebView cannot keep private", tab?.optString("id") == before)
            shot("$still-unavailable")
        }
        finding("after $part: ${describeActive()}, landing $landed, private surface ${host.privateSurface}")
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
     * grabber on the new window from its first buffer until `landed` answers, and the window's
     * draws counted with whether the previous tab's view was shown in them. The previous tab must
     * never paint: no drawn frame had its view shown (the frame-exact claim: every draw of the
     * window is counted), no grabbed frame carries its orange (the pixels' corroboration, read
     * from the window's first buffer to past the landing); the landing's tab is the active one,
     * the previous tab still in the state behind it; the previous tab's view, if the platform made
     * one, is not shown at the landing. The grabber's rate is REPORTED, not gated: on the CI
     * emulator the cold boot saturates the CPU and `PixelCopy` runs at 1.5–6.5 frames a second
     * while the app boots (18–19 once it is idle – run 35947928467), so a cadence gate fails for
     * the emulator's reason; the draw watch is what makes a pass evidence. On record: the
     * send-to-landing wall time, the main thread's CPU time over it, the grab rate, the draw
     * counts, the frames' timeline (the sheet).
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
        val grabber = FrameGrabber { started.main?.window }.also { it.start() }
        val cpuBefore = mainThreadCpuMs()
        val t0 = SystemClock.uptimeMillis()
        started.send()
        val created = started.awaitMain(20_000)
        expect("the intent creates one MainActivity (a cold start)", created is MainActivity)
        if (created !is MainActivity) {
            // Nothing came up: the scenes after this one need a browser, so launch it plainly.
            grabber.halt()
            started.stopWatchingDraws()
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
        started.stopWatchingDraws()
        val frames = grabber.frames()
        val drawn = started.framesDrawn
        val drawnWithPrevious = started.framesWithPrevious
        val rate = grabber.rate(frames)
        val grabs = "${frames.size} grabs by ${grabber.source} from +${grabber.windowAt} ms at ${"%.1f".format(rate)}/s"
        expect("the $landing landing is up after the cold start ($result)", result != null)
        if (!awaitChromeUp(15_000)) {
            // The core never answered in the new activity: nothing below can be read.
            finding("  cold $landing: the chrome never came up in the new activity ($grabs; window drawn $drawn frames)")
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
        // The pixel read must span the whole landing (the window's first buffer to past the landing)
        // to corroborate anything; its cadence is the emulator's during a boot and is reported.
        val lastGrabAt = frames.lastOrNull()?.at ?: -1L
        expect("the grabber's read spans the window's first buffer to the landing ($grabs, the last at +$lastGrabAt ms, landed at +$landedAt ms)", grabber.windowAt >= 0 && lastGrabAt >= landedAt)
        if (result == PRIVATE_TOAST) {
            // No profiles on this WebView: there is nothing private to land in, so the restored tab
            // is the right page to paint, under the toast that says why (the same as the warm mask).
            expect("with no profiles the cold private landing stays on the restored tab and says so", tab != null && tab.optString("id") == PREVIOUS_TAB)
            finding("  the frame read is not applied to this landing: the restored tab is the page to paint here")
        } else {
            expect("the active tab is the landing's own, not the restored one", tab != null && tab.optString("id") != PREVIOUS_TAB && tab.optBoolean("fromIntent"))
            expect("no frame the window drew had the previous tab's view shown ($drawnWithPrevious of $drawn frames drawn)", drawn > 0 && drawnWithPrevious == 0)
            expect("no grabbed frame from the window's first buffer to the landing carries the previous tab's page ($grabs)", frames.isNotEmpty() && flashes.isEmpty())
            expect("the previous tab's view is not the one shown at the landing", !previousShown)
        }
        expect("the previous tab is restored behind it, not closed", previous != null && previous.optString("url").endsWith(PREVIOUS_PATH))
        // A null is the wait's limit, never written as a landing time.
        val landedWord = if (result != null) "landed $result at +$landedAt ms wall" else "no landing read within +$landedAt ms (the wait's limit)"
        finding(
            "  cold $landing: $landedWord, main thread CPU over it ${cpuMs(cpuBefore, cpuAfter)}, " +
                "$grabs (first at +${frames.firstOrNull()?.at ?: "-"} ms, last at +${frames.lastOrNull()?.at ?: "-"} ms, max orange ${"%.2f".format(frames.maxOfOrNull { it.orange } ?: 0f)}, copy errors ${grabber.copyErrors}), " +
                "window drawn $drawn frames from +${started.firstDrawAt} ms, the previous tab's view shown in $drawnWithPrevious of them, " +
                "tabs ${tabsBefore} -> ${state.optJSONObject("tabs")?.length() ?: 0}, active ${describeActive()}, previous view ${describeView(previousView)}, " +
                "previous page requests since the send ${server.hits(PREVIOUS_PATH) - hitsBefore}"
        )
        val word = if (result == PRIVATE_TOAST) "restored page" else "FLASH"
        for (flash in flashes.take(MAX_FLASH_LINES)) finding("    $word at +${flash.at} ms: orange ${"%.2f".format(flash.orange)}")
        if (flashes.size > MAX_FLASH_LINES) finding("    … and ${flashes.size - MAX_FLASH_LINES} more such frames, the last at +${flashes.last().at} ms")
        grabber.sheet(
            "frames-cold-$landing",
            frames,
            "cold $landing landing: send at 0 ms, window at +${grabber.windowAt} ms, " +
                (if (result != null) "landed at +$landedAt ms" else "no landing read within +$landedAt ms") +
                ", ${"%.0f".format(rate)} grabs/s" +
                (if (result == PRIVATE_TOAST) " (the WebView-113 fallback: the restored tab in front, the toast said within the wait)" else "")
        )
        shot(if (landing in COLD_ORDER) "0${5 + COLD_ORDER.indexOf(landing)}-cold-$landing" else "21-cold-$landing")
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

    /**
     * A private tab active, or the toast on a WebView without profiles: the private landing's word.
     * Cold ([armToastRecord]) the new activity's chrome document has no toast record yet, so one is
     * put on it as soon as the chrome answers – the landing's toast is a plain toast (2.8 s) said in
     * the chrome's first frame, and a read from the live tree alone would race it under the boot's
     * load; warm the caller has armed the record before its tap, and re-arming would clear it.
     */
    private fun privateLanded(timeoutMs: Long, armToastRecord: Boolean = false): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        if (!awaitChromeUp(timeoutMs)) return null
        if (armToastRecord) watchToasts()
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
        // The landing read first, so its wall time is the landing's own; the watch is read after
        // it (a MainActivity created meanwhile is still in it). The authorised run's "+6054 ms"
        // was the watch's six-second wait, not the landing.
        val result = landed()
        val at = SystemClock.uptimeMillis() - t0
        val created = started.awaitMain(0)
        started.stopWatchingDraws()
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

    // --- 9. the Quick Actions widget (WID-02) ----------------------------------------------------

    /**
     * Chrome's second widget: the search bar with the Voice, Private and QR-scan buttons in one
     * resizable widget (the Lens slot the scanner's, the Dino slot absent until the offline game
     * exists). Its provider as the picker lists it – Chrome's floor (300 dp, 220 under sw240, 260
     * from sw280: 260 on a phone) by 48 dp, resizable both ways, home screen and searchbox, no
     * target cells and no ceiling – then an id bound on the driver's host, the face shown with
     * the host's default padding KEPT so the provider is handed the exact size a launcher hands
     * it, and laid at each of Chrome's three forms by height (xsmall under 72 dp, small under 155,
     * medium from there): the form's row read in the host, the bar's click, each button's
     * visibility against the provider's drop rule (one button per button width short of the
     * reference width, in Chrome's order less the Dino), the size the host recorded, the parts'
     * words in the tree, the card's and the buttons' boxes, the three surfaces against the
     * system's roles and the drawn pixels; the floor scene at the provider's minimum width, where
     * the scan button drops on xsmall and small – as Chrome's Lens and Dino drop there, leaving
     * Voice and Incognito – and medium keeps all three; then a finger on each part of the small
     * form, laid wide.
     */
    private fun quickActions() {
        ensureForeground()
        val manager = AppWidgetManager.getInstance(app)
        val provider = ComponentName(app, QuickActionsWidgetProvider::class.java)
        val info = manager.getInstalledProvidersForPackage(app.packageName, null).firstOrNull { it.provider == provider }
        expect("the quick actions widget's provider is installed for ${app.packageName}", info != null)
        info ?: return
        finding("\nquick actions provider: ${describe(info)}")
        val floorPx = app.resources.getDimensionPixelSize(R.dimen.widget_quick_actions_width)
        val floorDp = (floorPx / density).roundToInt()
        finding("the provider's floor in this configuration: $floorDp dp ($floorPx px; smallest width ${app.resources.configuration.smallestScreenWidthDp} dp – Chrome's 300, 220 under sw240, 260 from sw280)")
        expect("the widget asks for Chrome's floor by 48 dp (minWidth the quick action width, minHeight the xsmall form)", info.minWidth == floorPx && info.minHeight == dp(QUICK_XSMALL_CARD_DP))
        expect(
            "the widget resizes both ways and its floor is its minimum (minResizeWidth = minWidth, minResizeHeight = minHeight), as Chrome's info",
            info.resizeMode == (AppWidgetProviderInfo.RESIZE_HORIZONTAL or AppWidgetProviderInfo.RESIZE_VERTICAL) && info.minResizeWidth == info.minWidth && info.minResizeHeight == info.minHeight
        )
        expect(
            "the widget is for the home screen and the searchbox category, as Chrome's",
            info.widgetCategory and AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN != 0 && info.widgetCategory and AppWidgetProviderInfo.WIDGET_CATEGORY_SEARCHBOX != 0
        )
        expect("the widget names itself for the picker", info.loadLabel(app.packageManager) == QUICK_ACTIONS_LABEL)
        expect("the widget asks for no periodic update", info.updatePeriodMillis == 0)
        expect("a preview image for pickers without a preview layout", info.previewImage == R.drawable.widget_quick_actions_preview)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            expect(
                "no target cells and no ceiling, as Chrome's info declares none; a description and a preview layout for the picker",
                info.targetCellWidth == 0 && info.targetCellHeight == 0 && info.maxResizeWidth == 0 && info.maxResizeHeight == 0 &&
                    !info.loadDescription(app).isNullOrEmpty() && info.previewLayout == R.layout.widget_quick_actions_preview
            )
        }

        val grant = shellCommand("appwidget grantbind --package ${app.packageName} --user 0").trim()
        val widgetHost = AppWidgetHost(app, HOST_ID).also { widgetHost = it }
        onMain { widgetHost.startListening() }
        val id = widgetHost.allocateAppWidgetId().also { widgetId = it }
        val bound = onMain { manager.bindAppWidgetIdIfAllowed(id, provider) }
        finding("bind: grantbind '${grant.ifEmpty { "(no output)" }}', id $id bound $bound")
        expect("the id binds to the quick actions provider on the driver's host", bound)
        if (!bound) {
            takeDownTheHost()
            return
        }
        val launcherContext = launcherContext()
        val hostView = onMain { widgetHost.createView(launcherContext, id, info) }
        // The provider hears the bind and answers with its views for the options it finds – no
        // sizes yet, so the orientation pair for 0 × 0 dp: xsmall, every button dropped. The first
        // laying hands it a size.
        val delivered = awaitTrue(8_000) { onMain { hostView.findViewById<View>(R.id.widget_quick_actions_bar)?.hasOnClickListeners() == true } }
        expect("the provider's RemoteViews reach the host after the bind (the bar has its click)", delivered)
        widgetView = hostView
        showOnTheBackdrop(hostView, hostView, fourCells = false)
        val padding = onMain { Rect(hostView.paddingLeft, hostView.paddingTop, hostView.paddingRight, hostView.paddingBottom) }
        val wideDp = FRAME_WIDTH_DP - ((padding.left + padding.right) / density).roundToInt()
        finding(
            "the host's default padding ${padding.left}/${padding.top}/${padding.right}/${padding.bottom} px, kept: the frame is the provider's size plus it; " +
                "the wide scenes hand the provider $wideDp dp (the search widget's $FRAME_WIDTH_DP dp frame less the padding), the floor scene $floorDp dp"
        )

        val forms = QuickActionsWidgetProvider.Variant.values()
        for (variant in forms) {
            theForm(manager, id, hostView, variant, wideDp)
            saveFace("widget-$THEME-quick-actions-${variant.name.lowercase()}")
            shot("${11 + variant.ordinal}-quick-actions-${variant.name.lowercase()}")
            theQuickActionsColours(launcherContext, variant)
        }
        for (variant in forms) {
            theForm(manager, id, hostView, variant, floorDp)
            saveFace("widget-$THEME-quick-actions-floor-${variant.name.lowercase()}")
            if (variant == QuickActionsWidgetProvider.Variant.SMALL) shot("14-quick-actions-floor-small")
        }
        expect(
            "at Chrome's phone floor ($floorDp dp) the xsmall and small forms keep Voice and Private and drop the scan button, as Chrome's drop Dino and Lens there and keep Voice and Incognito",
            QuickActionsWidgetProvider.Variant.XSMALL.shown(floorDp) == listOf(QuickActionsWidgetProvider.VOICE, QuickActionsWidgetProvider.PRIVATE) &&
                QuickActionsWidgetProvider.Variant.SMALL.shown(floorDp) == listOf(QuickActionsWidgetProvider.VOICE, QuickActionsWidgetProvider.PRIVATE)
        )
        expect(
            "at Chrome's phone floor the medium form keeps all three, as Chrome's keeps Voice, Incognito and Lens and drops the Dino alone",
            QuickActionsWidgetProvider.Variant.MEDIUM.shown(floorDp) == QuickActionsWidgetProvider.BUTTONS
        )

        theForm(manager, id, hostView, QuickActionsWidgetProvider.Variant.SMALL, wideDp)
        touchTheMic(R.id.widget_quick_actions_voice, "15-quick-actions-voice-listening", "the voice button")
        touchTheFace(R.id.widget_quick_actions_bar, "16-quick-actions-bar-omnibox-keyboard", "widget-quick-actions-land-search-warm", "the bar")
        touchTheMask(R.id.widget_quick_actions_private, "17-quick-actions-private", "the private button")
        touchTheScanner(R.id.widget_quick_actions_scan, "18-quick-actions-scan")
        takeDownTheHost()
    }

    /**
     * The frame re-laid so the PROVIDER is handed exactly [widthDp] × [heightDp]: a launcher's host
     * subtracts its default padding (`default_app_widget_padding_*`, 8 dp a side on a phone) from
     * the frame before the sizes reach the provider's options, and the face fills the padded area;
     * the padding is kept here so the drawn face is the width the provider measured for.
     */
    private fun layTheFace(hostView: AppWidgetHostView, widthDp: Int, heightDp: Int) {
        onMain {
            val cells = frame ?: return@onMain
            val padX = hostView.paddingLeft + hostView.paddingRight
            val padY = hostView.paddingTop + hostView.paddingBottom
            cells.layoutParams = (cells.layoutParams as FrameLayout.LayoutParams).apply {
                width = dp(widthDp) + padX
                height = dp(heightDp) + padY
            }
            val frameWidthDp = widthDp + padX / density
            val frameHeightDp = heightDp + padY / density
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                hostView.updateAppWidgetSize(Bundle(), listOf(SizeF(frameWidthDp, frameHeightDp)))
            } else {
                @Suppress("DEPRECATION")
                hostView.updateAppWidgetSize(null, frameWidthDp.roundToInt(), frameHeightDp.roundToInt(), frameWidthDp.roundToInt(), frameHeightDp.roundToInt())
            }
        }
    }

    /**
     * The face laid at [widthDp] by the form's height and the provider's answer awaited in the
     * host: the form's row, the bar's click, each button's visibility as the drop rule has it at
     * that width; the size the host recorded in the widget's options; the parts' words in the tree
     * and the dropped buttons' absent; the card's and the buttons' boxes; the row's ORDER as laid –
     * the bar first, then the shown buttons left to right in Chrome's order less the Dino: Voice,
     * Incognito, Lens, Dino in every one of Chrome's three layouts at the tag
     * (`chrome/browser/ui/android/quickactionsearchwidget/java/res/layout/quick_action_search_widget_small_layout.xml:65/72/79/86`,
     * the xsmall's :65/72/79/86, the medium's :61/68/75/82), so ours Voice, Private, Scan; and on
     * xsmall the hint READ off the TextView: 13 sp (the chassis's floor, §4; Chrome's 11), the word
     * 'Search' measured against the room the row leaves it, drawn whole (no ellipsis) – gate #599 (c).
     */
    private fun theForm(manager: AppWidgetManager, id: Int, hostView: AppWidgetHostView, variant: QuickActionsWidgetProvider.Variant, widthDp: Int) {
        val form = variant.name.lowercase()
        val heightDp = formHeightDp(variant)
        val shown = variant.shown(widthDp)
        val hidden = QuickActionsWidgetProvider.BUTTONS - shown.toSet()
        finding("\nquick actions $form at $widthDp × $heightDp dp: the rule shows ${wordsOf(shown)}" + (if (hidden.isEmpty()) "" else " and drops ${wordsOf(hidden)}"))
        layTheFace(hostView, widthDp, heightDp)
        val answered = awaitTrue(8_000) {
            onMain {
                hostView.findViewById<View>(variant.rowId) != null &&
                    hostView.findViewById<View>(R.id.widget_quick_actions_bar)?.hasOnClickListeners() == true &&
                    QuickActionsWidgetProvider.BUTTONS.all { hostView.findViewById<View>(it.viewId)?.visibility == (if (it in shown) View.VISIBLE else View.GONE) }
            }
        }
        val options = manager.getAppWidgetOptions(id)
        val sizes: List<SizeF>? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) sizesIn(options) else null
        val rows = onMain { QuickActionsWidgetProvider.Variant.values().filter { hostView.findViewById<View>(it.rowId) != null }.map { it.name.lowercase() } }
        finding(
            "  the host's options: sizes $sizes, min ${options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)}×${options.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT)} dp, " +
                "max ${options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_WIDTH)}×${options.getInt(AppWidgetManager.OPTION_APPWIDGET_MAX_HEIGHT)} dp; the host shows the row(s) $rows, buttons ${describeButtons(hostView)}"
        )
        expect(
            "the provider answers $widthDp × $heightDp dp with the $form form: its row in the host, the bar clickable, ${wordsOf(shown)} visible" + (if (hidden.isEmpty()) "" else ", ${wordsOf(hidden)} gone"),
            answered
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            expect(
                "the host handed the provider exactly $widthDp × $heightDp dp (the frame less its default padding, one size)",
                sizes != null && sizes.size == 1 && abs(sizes[0].width - widthDp) < 0.5f && abs(sizes[0].height - heightDp) < 0.5f
            )
        }
        SystemClock.sleep(600)
        expect(
            "the $form face reads the omnibox's hint and the shown buttons' names in the tree (${wordsOf(shown)})",
            awaitTrue(6_000) { labelsInFrame(HINT_TEXT) && shown.all { labelsInFrame(labelOf(it)) } }
        )
        if (hidden.isNotEmpty()) expect("the dropped buttons (${wordsOf(hidden)}) have no node in the tree", hidden.none { labelsInFrame(labelOf(it)) })
        expect("the mark carries no name of its own (decorative)", onMain { hostView.findViewById<View>(R.id.widget_quick_actions_mark)?.importantForAccessibility == View.IMPORTANT_FOR_ACCESSIBILITY_NO })
        val card = viewBounds(android.R.id.background)
        val buttonDp = formButtonDp(variant)
        finding(
            "  card ${card.width()}×${card.height()} px (${dpOf(card.width())}×${dpOf(card.height())} dp) at $card, bar ${viewBounds(R.id.widget_quick_actions_bar)}, " +
                "buttons ${shown.map { "${wordOf(it)} ${viewBounds(it.viewId)}" }}"
        )
        expect("the $form card is the form's fixed height (${variant.heightDp} dp) at the provider's width ($widthDp dp)", card.height() == dp(variant.heightDp) && card.width() == dp(widthDp))
        expect("the shown buttons stand in Chrome's $buttonDp dp boxes", shown.all { viewBounds(it.viewId).let { box -> box.width() == dp(buttonDp) && box.height() == dp(buttonDp) } })
        theRowsOrder(form, variant, shown)
        if (variant == QuickActionsWidgetProvider.Variant.XSMALL) theXsmallWord(hostView, widthDp, shown.size)
    }

    /**
     * Gate #599 (h): the row's order READ off the laid face – the shown buttons' left edges strictly
     * ascending in the provider's [QuickActionsWidgetProvider.BUTTONS] order (Voice, Private, Scan),
     * which is Chrome's Voice, Incognito, Lens, Dino less the Dino in every one of the tag's three
     * layouts (`quick_action_search_widget_small_layout.xml:65/72/79/86`, xsmall :65/72/79/86,
     * medium :61/68/75/82); the bar before the first button on the one-row forms, above the row
     * on medium.
     */
    private fun theRowsOrder(form: String, variant: QuickActionsWidgetProvider.Variant, shown: List<Face>) {
        val boxes = shown.map { it to viewBounds(it.viewId) }
        val bar = viewBounds(R.id.widget_quick_actions_bar)
        finding(
            "  the $form row as laid, left to right: bar $bar, then " + (if (boxes.isEmpty()) "no button" else boxes.joinToString(", ") { (face, box) -> "${wordOf(face)} at x ${box.left}" }) +
                " – Chrome's Voice, Incognito, Lens, Dino (quick_action_search_widget_${form}_layout.xml) less the Dino"
        )
        if (boxes.size > 1) {
            expect(
                "the $form row lays its buttons left to right in Chrome's order less the Dino: ${wordsOf(shown)} (quick_action_search_widget_small_layout.xml:65/72/79/86 – Voice, Incognito, Lens, Dino)",
                boxes.map { it.second.left }.zipWithNext().all { (left, right) -> left < right }
            )
        }
        if (boxes.isNotEmpty()) {
            val first = boxes.first().second
            if (variant == QuickActionsWidgetProvider.Variant.MEDIUM) {
                expect("the medium bar stands above its row (the bar's bottom at or above ${wordOf(shown.first())}'s top)", bar.bottom <= first.top)
            } else {
                expect("the $form bar stands before its first button (the bar's right at or before ${wordOf(shown.first())}'s left)", bar.right <= first.left)
            }
        }
    }

    private class HintRead(val word: String, val textSizePx: Float, val wordPx: Float, val ellipsisCount: Int, val roomPx: Int)

    /**
     * Gate #599 (c): the xsmall hint read off its TextView in the host – its size 13 sp in the
     * launcher's metrics (`widget_quick_actions_xsmall_hint`; the chassis's floor, Chrome's 11 sp),
     * the word 'Search' measured by the view's own paint against the room the row leaves it (the
     * widget's width less the card's 2 × 8, the bar's 2 × 3, the mark's 8 + 16 + 5 and the hint's 8
     * dp, less 38 dp a shown button – the face test's arithmetic), and drawn WHOLE: an ellipsis
     * count of 0 on its one line, the word's width within the room.
     */
    private fun theXsmallWord(hostView: AppWidgetHostView, widthDp: Int, shownButtons: Int) {
        val sp13Px = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 13f, hostView.resources.displayMetrics)
        val read = onMain {
            hostView.findViewById<TextView>(R.id.widget_quick_actions_hint)?.let { hint ->
                val word = hint.text.toString()
                HintRead(word, hint.textSize, hint.paint.measureText(word), hint.layout?.getEllipsisCount(0) ?: -1, hint.width - hint.compoundPaddingLeft - hint.compoundPaddingRight)
            }
        }
        val roomDp = widthDp - 59 - QuickActionsWidgetProvider.Variant.XSMALL.buttonWidthDp * shownButtons
        finding(
            if (read == null) "  the xsmall hint: no TextView in the host" else
                "  the xsmall hint '${read.word}' at ${read.textSizePx} px (13 sp is $sp13Px px here), the word ${read.wordPx} px (${dpOf(read.wordPx.roundToInt())} dp) " +
                    "in ${read.roomPx} px (${dpOf(read.roomPx)} dp) of room – the arithmetic's $roomDp dp at $widthDp dp with $shownButtons button(s); ellipsis count ${read.ellipsisCount}"
        )
        expect("the xsmall hint is set at 13 sp (the chassis's floor; Chrome's xsmall is 11)", read != null && abs(read.textSizePx - sp13Px) < 1f)
        expect("the xsmall hint's room at $widthDp dp is the arithmetic's $roomDp dp (within 2 dp of rounding)", read != null && abs(dpOf(read.roomPx) - roomDp) <= 2)
        expect("the xsmall word '${read?.word}' is drawn whole at $widthDp dp: no ellipsis on its line, its width within the room", read != null && read.ellipsisCount == 0 && read.wordPx <= read.roomPx)
    }

    /**
     * The face's colours: the three surfaces Chrome's quick action widget takes from Material You
     * – the card colorSurface (`widget_bg`), the bar colorSurfaceContainerHigh (`widget_searchbox_bg`,
     * the search widget's fill at full alpha), the buttons colorSurfaceContainer (`widget_button_bg`)
     * – resolved in the launcher's configuration and read against the system's own roles on 34+
     * (the palette re-lit on 31–33; the v2 page and panel below 31), every one opaque: Chrome's
     * quick action widget carries no 0.9 (that is the classic search widget's alone). Then the
     * drawn face: a pixel of the card's interior, of the bar's and of a button's disc – or, on
     * xsmall, where the button is a bare ripple, the card showing through – each its surface's
     * colour with nothing composited; the card over black and over white for its alpha (255); its
     * top edge the interior's colour on 12+ (no hairline), the v2 border's below.
     */
    private fun theQuickActionsColours(launcherContext: Context, variant: QuickActionsWidgetProvider.Variant) {
        val res = launcherContext.resources
        val theme = launcherContext.theme
        val dark = THEME == "dark"
        val dynamic = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
        val form = variant.name.lowercase()
        val surface = res.getColor(R.color.widget_quick_actions_surface, theme)
        val bar = res.getColor(R.color.widget_quick_actions_bar, theme)
        val button = res.getColor(R.color.widget_quick_actions_button, theme)
        val ink = res.getColor(R.color.widget_search_ink, theme)
        val searchFill = res.getColor(R.color.widget_search_fill, theme)
        finding("  quick actions colours in the launcher's configuration ($THEME): card ${hex(surface)} bar ${hex(bar)} buttons ${hex(button)} ink ${hex(ink)}; the search widget's fill ${hex(searchFill)}")
        if (variant == QuickActionsWidgetProvider.Variant.XSMALL) {
            when {
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE -> {
                    val systemSurface = res.getColor(if (dark) android.R.color.system_surface_dark else android.R.color.system_surface_light, theme)
                    val systemBar = res.getColor(if (dark) android.R.color.system_surface_container_high_dark else android.R.color.system_surface_container_high_light, theme)
                    val systemButton = res.getColor(if (dark) android.R.color.system_surface_container_dark else android.R.color.system_surface_container_light, theme)
                    finding("  the system's roles: surface ${hex(systemSurface)} surfaceContainerHigh ${hex(systemBar)} surfaceContainer ${hex(systemButton)}")
                    expect("the card is the system's colorSurface, as Chrome's widget_bg", surface == systemSurface)
                    expect("the bar is the system's colorSurfaceContainerHigh, as Chrome's widget_searchbox_bg", bar == systemBar)
                    expect("the buttons are the system's colorSurfaceContainer, as Chrome's widget_button_bg", button == systemButton)
                }
                dynamic -> {
                    val v2Page = res.getColor(if (dark) R.color.v2_page_dark else R.color.v2_page_light, theme)
                    val v2Panel = res.getColor(if (dark) R.color.v2_panel_dark else R.color.v2_panel_light, theme)
                    expect("on Android 12 and 13 the three surfaces are the system's neutral-variant palette re-lit: distinct, none the v2 tokens", setOf(surface, bar, button).size == 3 && surface != v2Page && bar != v2Panel && button != v2Panel)
                }
                else -> {
                    val v2Page = res.getColor(if (dark) R.color.v2_page_dark else R.color.v2_page_light, theme)
                    val v2Panel = res.getColor(if (dark) R.color.v2_panel_dark else R.color.v2_panel_light, theme)
                    expect("below Android 12 the card is the v2 page and the bar and the buttons the v2 panel", surface == v2Page && bar == v2Panel && button == v2Panel)
                }
            }
            expect("the three surfaces are opaque: Chrome's quick action widget has no 0.9", Color.alpha(surface) == 0xFF && Color.alpha(bar) == 0xFF && Color.alpha(button) == 0xFF)
            expect("the bar's role is the search widget's fill, at full alpha", rgb(bar) == rgb(searchFill))
            expect("the ink is the search widget's (colorOnSurfaceVariant), opaque", Color.alpha(ink) == 0xFF)
        }

        val drawn = drawFace() ?: return
        val (bitmap, band) = drawn
        val card = viewBounds(android.R.id.background)
        val pill = viewBounds(R.id.widget_quick_actions_bar)
        val disc = viewBounds(R.id.widget_quick_actions_private)
        // The card's interior in its side padding at mid-height (clear of the corners); the bar's
        // interior at its trailing end, past the hint, inside the small form's 3.5 dp inset; the
        // disc under its top, clear of the glyph (the small form's inset 3.5 dp, the xsmall form's
        // bare ripple leaves the card); the card's top edge at its middle, one row in.
        val cardX = card.left + dp(3) - band.left
        val cardY = card.centerY() - band.top
        val pillX = pill.right - dp(8) - band.left
        val pillY = pill.centerY() - band.top
        val discX = disc.centerX() - band.left
        val discY = disc.top + dp(formDiscInsetDp(variant)) - band.top
        val edgeX = card.centerX() - band.left
        val edgeY = card.top + 1 - band.top
        val cardPixel = pixelAt(bitmap, cardX, cardY)
        val pillPixel = pixelAt(bitmap, pillX, pillY)
        val discPixel = pixelAt(bitmap, discX, discY)
        val edge = pixelAt(bitmap, edgeX, edgeY)
        bitmap.recycle()
        val onBlack = drawFace(backdrop = Color.BLACK)?.let { (b, _) -> pixelAt(b, cardX, cardY).also { b.recycle() } } ?: 0
        val onWhite = drawFace(backdrop = Color.WHITE)?.let { (b, _) -> pixelAt(b, cardX, cardY).also { b.recycle() } } ?: 0
        val measuredAlpha = listOf(
            255 - (Color.red(onWhite) - Color.red(onBlack)),
            255 - (Color.green(onWhite) - Color.green(onBlack)),
            255 - (Color.blue(onWhite) - Color.blue(onBlack))
        )
        finding(
            "  the drawn $form face: card ${hex(cardPixel)} (+3 dp, mid-height), bar ${hex(pillPixel)} (trailing end −8 dp), ${wordOf(QuickActionsWidgetProvider.PRIVATE)} ${hex(discPixel)} (+${formDiscInsetDp(variant)} dp under its top), " +
                "top edge ${hex(edge)}; the card over black ${hex(onBlack)}, over white ${hex(onWhite)}: alpha $measuredAlpha of 255 a channel"
        )
        expect("the drawn $form card is colorSurface, nothing composited", near(cardPixel, surface))
        expect("the drawn $form bar is colorSurfaceContainerHigh", near(pillPixel, bar))
        if (variant == QuickActionsWidgetProvider.Variant.XSMALL) {
            expect("the xsmall buttons draw no disc – Chrome's bare ripple – so the card shows through them", near(discPixel, surface))
        } else {
            expect("the drawn $form button disc is colorSurfaceContainer", near(discPixel, button))
        }
        expect("the drawn $form card reads opaque (255 of 255) over black and over white: no 0.9 on the quick action widget, as Chrome's", measuredAlpha.all { abs(it - 0xFF) <= 3 })
        if (dynamic) {
            expect("no hairline on the $form card: its top edge is its interior's colour", near(edge, cardPixel))
        } else {
            expect("below Android 12 the $form card keeps its v2 border: the top edge is not the interior", !near(edge, cardPixel))
        }
    }

    /** The scan button (its view [id]) under a finger: the QR scanner up on the stand-in camera; [still] the shot's name. */
    private fun touchTheScanner(id: Int, still: String) {
        val before = activeCoreTab()?.optString("id").orEmpty()
        val intentBefore = onMain { activity.intent }
        val starts = camera.starts
        expect("a finger reaches the scan button on the face", touchPart(id))
        SystemClock.sleep(150)
        hideOverlay()
        val landed = scanLanded(12_000)
        expect("the scan button lands in the QR scanner ($landed)", landed != null)
        expect("the widget's intent arrived through onNewIntent (the running activity, no relaunch)", onMain { activity.intent } !== intentBefore && !onMain { activity.isDestroyed })
        expect("the camera stand-in was started for it", awaitTrue(4_000) { camera.starts > starts })
        val tab = activeCoreTab()
        expect("the landing opened a tab of its own, blank, sent by another app (fromIntent)", tab?.optString("id") != before && emptyTabUrl(tab?.optString("url")) && tab?.optBoolean("fromIntent") == true)
        SystemClock.sleep(800)
        shot(still)
        finding("after the scan button: ${describeActive()}, QR phase ${qrPhase()}, camera starts ${camera.starts}")
        back()
        expect("a back closes the scanner", awaitSurface(false, 6_000))
        backToThePrevious(tab?.optString("id"))
        showOverlay()
    }

    private fun sizesIn(options: Bundle): List<SizeF>? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) options.getParcelableArrayList(AppWidgetManager.OPTION_APPWIDGET_SIZES, SizeF::class.java)
        else @Suppress("DEPRECATION") options.getParcelableArrayList(AppWidgetManager.OPTION_APPWIDGET_SIZES)

    /** The height handed to the provider for each form: inside the form's band, room for its fixed card with a little of the cells around it. */
    private fun formHeightDp(variant: QuickActionsWidgetProvider.Variant): Int = when (variant) {
        QuickActionsWidgetProvider.Variant.XSMALL -> QUICK_XSMALL_FRAME_DP
        QuickActionsWidgetProvider.Variant.SMALL -> QUICK_SMALL_FRAME_DP
        QuickActionsWidgetProvider.Variant.MEDIUM -> QUICK_MEDIUM_FRAME_DP
    }

    /** Chrome's button boxes (`QuickActionSearchWidgetProviderDelegate.java:216-249`): 28 / 48 / 54 dp. */
    private fun formButtonDp(variant: QuickActionsWidgetProvider.Variant): Int = when (variant) {
        QuickActionsWidgetProvider.Variant.XSMALL -> 28
        QuickActionsWidgetProvider.Variant.SMALL -> 48
        QuickActionsWidgetProvider.Variant.MEDIUM -> 54
    }

    /** Where under a button's top its disc is read: past the small form's 3.5 dp inset, before any glyph (17 / 15.5 / 6 dp of padding). */
    private fun formDiscInsetDp(variant: QuickActionsWidgetProvider.Variant): Int = when (variant) {
        QuickActionsWidgetProvider.Variant.XSMALL -> 3
        QuickActionsWidgetProvider.Variant.SMALL -> 7
        QuickActionsWidgetProvider.Variant.MEDIUM -> 6
    }

    private fun labelOf(face: Face): String = when (face.landing) {
        Landing.VOICE -> MIC_LABEL
        Landing.PRIVATE -> MASK_LABEL
        Landing.SCAN -> SCAN_LABEL
        else -> HINT_TEXT
    }

    private fun wordOf(face: Face): String = when (face.landing) {
        Landing.VOICE -> "Voice"
        Landing.PRIVATE -> "Private"
        Landing.SCAN -> "Scan"
        else -> "the bar"
    }

    private fun wordsOf(faces: List<Face>): String = if (faces.isEmpty()) "no button" else faces.joinToString(" + ") { wordOf(it) }

    private fun describeButtons(hostView: View): String = onMain {
        QuickActionsWidgetProvider.BUTTONS.joinToString(", ") { face ->
            val visibility = hostView.findViewById<View>(face.viewId)?.visibility
            "${wordOf(face)} " + when (visibility) {
                View.VISIBLE -> "visible"
                View.INVISIBLE -> "invisible"
                View.GONE -> "gone"
                else -> "absent"
            }
        }
    }

    private fun dpOf(px: Int): Int = (px / density).roundToInt()

    // --- 10. the game widget (WID-04) ------------------------------------------------------------

    /**
     * Roll's one-cell face (ERR-03 / WID-04, gate #607 (f)): its provider as the picker lists it –
     * one cell by one, fixed, the platform's one-cell minimum, the Home screen alone, the gate's
     * words – then an id bound on the driver's host and the face laid at a launcher's cell with the
     * host's default padding kept, so the PROVIDER is handed the cell a launcher hands it; the face's
     * name in the tree, the card read against the quick actions widget's surface role and its top
     * edge for the absent hairline (Android 12+), the glyph's indigo found on the card (the mark's
     * brand colour, lifted for the dark theme); a still (`widget-<theme>-game.png`); then a finger
     * on the face with Zenium in front – a new tab on `zen://game` sent by another app, Roll's
     * document up (the stage's label in the tree, or the document's word of the mounted region) –
     * and the COLD landing (the WID-07 rule), the
     * browser's task removed and the widget's own `PendingIntent` sent: every frame read for the
     * previous tab's page, which must never paint.
     */
    private fun gameWidget() {
        ensureForeground()
        val manager = AppWidgetManager.getInstance(app)
        val provider = ComponentName(app, GameWidgetProvider::class.java)
        val info = manager.getInstalledProvidersForPackage(app.packageName, null).firstOrNull { it.provider == provider }
        expect("the game widget's provider is installed for ${app.packageName}", info != null)
        info ?: return
        finding("\ngame widget provider: ${describe(info)}")
        expect("the widget asks for one cell (minWidth and minHeight the platform's 40 dp one-cell minimum)", info.minWidth == dp(GAME_MIN_DP) && info.minHeight == dp(GAME_MIN_DP))
        expect("the widget does not resize: one cell, fixed", info.resizeMode == AppWidgetProviderInfo.RESIZE_NONE)
        expect("the widget is for the home screen alone – a one-cell face is no search box", info.widgetCategory == AppWidgetProviderInfo.WIDGET_CATEGORY_HOME_SCREEN)
        expect("the widget names itself for the picker as the gate ruled", info.loadLabel(app.packageManager) == GAME_LABEL)
        expect("the widget asks for no periodic update", info.updatePeriodMillis == 0)
        expect("a preview image for pickers without a preview layout", info.previewImage == R.drawable.widget_game_preview)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            expect(
                "the picker's target is 1×1, its description the gate's, its preview the layout",
                info.targetCellWidth == 1 && info.targetCellHeight == 1 && info.loadDescription(app) == GAME_DESCRIPTION && info.previewLayout == R.layout.widget_game_preview
            )
        }

        val grant = shellCommand("appwidget grantbind --package ${app.packageName} --user 0").trim()
        val widgetHost = AppWidgetHost(app, HOST_ID).also { widgetHost = it }
        onMain { widgetHost.startListening() }
        val id = widgetHost.allocateAppWidgetId().also { widgetId = it }
        val bound = onMain { manager.bindAppWidgetIdIfAllowed(id, provider) }
        finding("bind: grantbind '${grant.ifEmpty { "(no output)" }}', id $id bound $bound")
        expect("the id binds to the game provider on the driver's host", bound)
        if (!bound) {
            takeDownTheHost()
            return
        }
        val launcherContext = launcherContext()
        val hostView = onMain { widgetHost.createView(launcherContext, id, info) }
        val delivered = awaitTrue(8_000) { onMain { hostView.findViewById<View>(R.id.widget_game_face)?.hasOnClickListeners() == true } }
        expect("the provider's RemoteViews reach the host after the bind (the face has its click)", delivered)
        if (!delivered) onMain { hostView.updateAppWidget(GameWidgetProvider.views(launcherContext)) }
        widgetView = hostView
        showOnTheBackdrop(hostView, hostView, fourCells = false)
        layTheFace(hostView, GAME_CELL_DP, GAME_CELL_DP)
        SystemClock.sleep(1_500)

        expect("the face reads its name in the tree – what a tap does", awaitTrue(8_000) { labelsInFrame(GAME_FACE_LABEL) })
        val card = viewBounds(android.R.id.background)
        val face = viewBounds(R.id.widget_game_face)
        finding("face bounds on screen: frame ${frameBounds()}, card $card (${dpOf(card.width())} × ${dpOf(card.height())} dp for the $GAME_CELL_DP dp cell), face $face")
        expect("the card fills the cell the launcher gives and the face is the whole card", card.width() == dp(GAME_CELL_DP) && card.height() == dp(GAME_CELL_DP) && face == card)
        saveFace("widget-$THEME-game")
        shot("19-game-face-on-a-launcher-backdrop")
        theGameFacesColours(launcherContext)

        touchTheGame()
        takeDownTheHost()

        coldLanding(GameWidgetProvider.FACE, "game") { gameLanded(30_000) }
    }

    /**
     * The face's colours (gate #607 (f) on WID-02's roles): the card the quick actions widget's
     * surface – read at its side padding, clear of the glyph – opaque, and on Android 12+ without a
     * hairline (its top edge is the card's own colour, not the v2 border's); the glyph's ring in the
     * mark's indigo, found among the drawn pixels of the glyph's box, and the ground in the ink.
     */
    private fun theGameFacesColours(launcherContext: Context) {
        val res = launcherContext.resources
        val theme = launcherContext.theme
        val surface = res.getColor(R.color.widget_quick_actions_surface, theme)
        val hairline = res.getColor(R.color.widget_quick_actions_hairline, theme)
        val mark = res.getColor(R.color.widget_search_mark, theme)
        val ink = res.getColor(R.color.widget_search_ink, theme)
        finding("  game face colours in the launcher's configuration ($THEME): card ${hex(surface)} mark ${hex(mark)} ink ${hex(ink)}; the v2 border would be ${hex(hairline)}")
        expect("the card and the mark are opaque", Color.alpha(surface) == 0xFF && Color.alpha(mark) == 0xFF)
        expect("the mark keeps the brand indigo (${if (THEME == "dark") "#8284F0 lifted for the dark theme" else "#6264DC"})", rgb(mark) == (if (THEME == "dark") 0x8284F0 else 0x6264DC))
        val (bitmap, band) = drawFace() ?: return
        val card = viewBounds(android.R.id.background)
        val cardX = card.left + dp(3) - band.left
        val cardY = card.centerY() - band.top
        val edgeX = card.centerX() - band.left
        val edgeY = card.top + 1 - band.top
        val cardPixel = pixelAt(bitmap, cardX, cardY)
        val edge = pixelAt(bitmap, edgeX, edgeY)
        // The glyph's 32 dp box at the card's centre: every pixel of it read for the ring's indigo and the ground's ink.
        val glyph = dp(GAME_GLYPH_DP)
        val left = card.centerX() - glyph / 2 - band.left
        val top = card.centerY() - glyph / 2 - band.top
        var indigo = 0
        var inked = 0
        for (y in top until top + glyph) for (x in left until left + glyph) {
            val pixel = pixelAt(bitmap, x, y)
            if (near(pixel, mark)) indigo++
            if (near(pixel, ink)) inked++
        }
        bitmap.recycle()
        finding("  the drawn face: card ${hex(cardPixel)} (+3 dp, mid-height), top edge ${hex(edge)}; in the glyph's box $indigo px of the mark's indigo, $inked px of the ink")
        expect("the drawn card is the quick actions surface, nothing composited", near(cardPixel, surface))
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            expect("no hairline on the dynamic face: the top edge is the card's colour", near(edge, surface) && !near(edge, hairline))
        } else {
            expect("below Android 12 the card wears the v2 border as its hairline", near(edge, hairline))
        }
        expect("the ring is drawn in the mark's indigo", indigo > 0)
        expect("the ground line is drawn in the ink", inked > 0)
    }

    /** The face under a finger with Zenium in front: a new tab on `zen://game`, Roll's document up. */
    private fun touchTheGame() {
        val before = activeCoreTab()?.optString("id").orEmpty()
        val intentBefore = onMain { activity.intent }
        expect("a finger reaches the face", touchPart(R.id.widget_game_face))
        SystemClock.sleep(150)
        hideOverlay()
        val landed = gameLanded(12_000)
        expect("the face lands in a new tab on $GAME_URL with Roll's stage up ($landed)", landed in GAME_STAGED_WORDS)
        expect("the widget's intent arrived through onNewIntent (the running activity, no relaunch)", onMain { activity.intent } !== intentBefore && !onMain { activity.isDestroyed })
        val tab = activeCoreTab()
        expect("the game's tab is a new tab another app sent (fromIntent)", tab?.optString("id") != before && tab?.optBoolean("fromIntent") == true)
        SystemClock.sleep(800)
        shot("20-game-tab")
        finding("after the face: ${describeActive()}, landing $landed")
        val glyphs = chromeJs(ROLL_GLYPHS_JS).toIntOrNull() ?: -1
        expect("the game tab's favicon slot wears Roll's picture (§9.17): a `lucide-roll` glyph in the chrome, drawn from `shared/game/mark.ts` ($glyphs)", glyphs > 0)
        rollToTheNight()
        theGlyphInTheOverview()
        backToThePrevious(tab?.optString("id"))
        showOverlay()
    }

    /**
     * Roll's night on the device, for the still the lead asked for ((g-look) on #607): a REAL tap
     * on the stage starts the game (the hint by device reads "Tap to start" here), then an
     * auto-player is put into the document ([GAME_BOT_JS]) – it takes over `requestAnimationFrame`,
     * hands the runtime's loop one 60 Hz frame per turn, reads the canvas for what stands in the
     * runner's lane and presses Space on the document eight frames ahead of it – until the 700-point
     * night has painted eight frames, where it holds the next frame so the still is the runtime's
     * own paint of the night, the auto-player's word (frames, jumps, starts, the theme, the sky's
     * corner) beside it. A crashed run is started again by the same key; the game's device stays
     * the touch the mount read.
     */
    private fun rollToTheNight() {
        val stage = gameStageBounds()
        expect("the stage's box is read (the tree's region, else the document's canvas)", stage != null && !stage.isEmpty)
        stage ?: return
        Finger().tap(stage.exactCenterX(), stage.exactCenterY())
        SystemClock.sleep(400)
        val running = awaitTrue(4_000) { gameTabJs(GAME_RUNNING_JS) == "true" }
        expect("a finger on the stage starts the game (the hint gone, the region live)", running)
        gameTabJs(GAME_BOT_JS)
        var word = JSONObject()
        val reached = awaitTrue(150_000) {
            // The object itself: `evaluateJavascript` hands an object back as its JSON literal, a
            // string back JSON-quoted (`"{\"a\":1}"`), which is not an object for [JSONObject] –
            // the first run's stringified word fell to `{}` every poll and `done` was never read.
            word = runCatching { JSONObject(gameTabJs("window.__zenBot||{}") ?: "{}") }.getOrDefault(JSONObject())
            word.optBoolean("done")
        }
        finding("Roll's auto-player: $word")
        expect("the auto-player reaches the 700-point night and holds its frame (frames ${word.optInt("frames")}, jumps ${word.optInt("jumps")}, starts again ${word.optInt("starts")})", reached && word.optBoolean("night"))
        expect("the night's sky is the runtime's rounded box: the canvas's corner clear, the sky inside it opaque", word.optInt("corner", -1) == 0 && word.optInt("sky", -1) == 255)
        expect("the night is the stage's alone: the region wears the other theme while the page keeps its own", word.optString("theme").isNotEmpty() && word.optString("theme") != word.optString("page"))
        SystemClock.sleep(600)
        shot("21-game-night")
    }

    /**
     * The overview's grid with Roll's tab in it: its card's favicon slot wears the picture. The grid
     * is waited for ON SCREEN the way the overview drivers wait ([FirstTapDemo], [ThumbsDemo]: the
     * header's Spaces button in the tree, then the emulator's seconds for its software GPU to paint
     * and settle the grid) – the first run shot 1.5 s after the tap, when the store already said
     * open and the chrome already held the card's glyph, and the still showed the page.
     */
    private fun theGlyphInTheOverview() {
        val tabs = tabsButton(6_000)
        val point = tabs?.let { touchPoint(it) }
        expect("the bar's Tabs button is under a finger", point != null)
        point ?: return
        Finger().tap(point.x, point.y)
        val open = awaitTrue(8_000) { overviewOpen() }
        expect("the Tabs button opens the overview (the stage store's phase leaves `closed`)", open)
        val onScreen = waitFor("Spaces", 8_000) != null
        expect("the overview's grid is on screen (the header's Spaces button in the tree)", onScreen)
        SystemClock.sleep(3_500)
        val glyphs = chromeJs(ROLL_GLYPHS_JS).toIntOrNull() ?: -1
        expect("the overview draws Roll's picture in the game tab's card ($glyphs `lucide-roll` glyphs in the chrome)", glyphs > 0)
        shot("22-game-glyph-overview")
        finding("the overview with Roll's tab: $glyphs roll glyph(s), ${chromeJs(GLOBE_GLYPHS_JS)} globe(s) in the chrome")
        back()
        awaitTrue(6_000) { !overviewOpen() }
        SystemClock.sleep(600)
    }

    /** The stage store's overview phase is not `closed`; false with no store to ask, never a hollow yes. */
    private fun overviewOpen(): Boolean =
        chromeJs("(function(){var s=(window.__zenStores||{}).stage;if(!s||!s.get)return false;var o=(s.get()||{}).overview;return !!o&&o.phase!=='closed'})()") == "true"

    /** Roll's region on screen: the tree's node by its label, else the document's canvas box under the shown tab's view. */
    private fun gameStageBounds(): Rect? {
        waitFor({ it.startsWith(GAME_STAGE_LABEL) }, 3_000)?.takeIf { !it.isEmpty }?.let { return it }
        val raw = gameTabJs(GAME_STAGE_BOX_JS)?.trim('"') ?: return null
        val css = raw.split(',').map { it.toFloatOrNull() ?: return null }
        if (css.size != 4) return null
        var origin = IntArray(2)
        instrumentation.runOnMainSync {
            val view = host.tabs.all().firstOrNull { it.isShown }
            origin = IntArray(2).also { view?.getLocationOnScreen(it) }
        }
        return Rect(
            origin[0] + (css[0] * density).toInt(),
            origin[1] + (css[1] * density).toInt(),
            origin[0] + (css[2] * density).toInt(),
            origin[1] + (css[3] * density).toInt()
        )
    }

    /** `code` evaluated in the shown tab's document (Roll's), its JSON answer; null with no view or in 5 s. */
    private fun gameTabJs(code: String): String? {
        val done = ArrayBlockingQueue<String>(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.all().firstOrNull { it.isShown }
            if (view == null) done.offer("") else view.evaluateJavascript(code) { value -> done.offer(value ?: "null") }
        }
        return done.poll(5, TimeUnit.SECONDS)?.takeIf { it.isNotEmpty() }
    }

    /**
     * A tab on `zen://game` active and sent by another app, Roll's stage up: the game landing's
     * word. The stage is read two ways, the tree first – the region's label (`role="application"`,
     * `page.ts`'s `GAME_ARIA_LABEL`), what TalkBack would say – and then the document's own word
     * ([gameStageMounted]: the runtime's mounted mark on the region, the canvas inside it). The
     * profiles leg's Chromium snapshot WebView (156 on the AOSP image) drew the stage in the first
     * run and exposed no node for it within 8 s while the API 34 image's WebView did; a stage the
     * document says is mounted and drawn is up whichever way the tree reads, and the word says which.
     */
    private fun gameLanded(timeoutMs: Long): String? {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        if (!awaitChromeUp(timeoutMs)) return null
        while (SystemClock.uptimeMillis() < deadline) {
            val tab = activeCoreTab()
            if (tab?.optString("url") == GAME_URL && tab.optBoolean("fromIntent")) {
                if (waitFor({ it.startsWith(GAME_STAGE_LABEL) }, 8_000) != null) return GAME_STAGED
                return if (awaitTrue(4_000) { gameStageMounted() }) GAME_STAGED_BY_DOCUMENT else "Roll's tab on $GAME_URL, the stage not read in the tree nor mounted by the document's word"
            }
            SystemClock.sleep(100)
        }
        return null
    }

    /** The shown tab's document says Roll's region is mounted (the runtime's mark) and its canvas is in it. */
    private fun gameStageMounted(): Boolean {
        val done = ArrayBlockingQueue<String>(1)
        instrumentation.runOnMainSync {
            val view = host.tabs.all().firstOrNull { it.isShown }
            if (view == null) {
                done.offer("")
            } else {
                view.evaluateJavascript(GAME_STAGE_MOUNTED_JS) { value -> done.offer(value ?: "") }
            }
        }
        return done.poll(5, TimeUnit.SECONDS) == "true"
    }

    // --- what an intent started ------------------------------------------------------------------

    /**
     * Watches what `send` starts: a MainActivity created is a cold start (the application's
     * lifecycle callbacks, `onActivityCreated` fires for a creation alone), none within the wait a
     * warm one; the trampoline's creation is noted for the shortcut path. [send] arms the watch
     * and fires; [awaitMain] hands back the created MainActivity, or null – once its `onCreate`
     * has RUN THROUGH (`onActivityPostCreated`): `onActivityCreated` is dispatched from
     * `super.onCreate`, before the activity's own body makes its host (run 2's fault).
     *
     * From that moment the created window's draws are counted (`OnDrawListener` on its decor, the
     * main thread) with whether the previous tab's view was shown in each – in the tree, visible
     * through its parents, with a size: the frame-exact signal beside the pixel read, which grabs
     * at most 20 frames a second and could miss a frame of 16 ms. The pixel read stays the truth
     * for the page having painted (a shown view may still be blank); [stopWatchingDraws] ends it.
     */
    private inner class Start(private val fire: () -> Unit) {
        private val created = CopyOnWriteArrayList<Activity>()
        private val trampolines = CopyOnWriteArrayList<Activity>()
        /** The window's draws since the activity's creation; those with the previous tab's view shown; the first's time since the send. */
        @Volatile var framesDrawn = 0
        @Volatile var framesWithPrevious = 0
        @Volatile var firstDrawAt = -1L
        private var sentAt = 0L
        @Volatile private var detachDrawWatch: (() -> Unit)? = null
        private val callbacks = object : Application.ActivityLifecycleCallbacks {
            override fun onActivityCreated(a: Activity, savedInstanceState: Bundle?) {
                if (a is LauncherIconActivity) trampolines += a
            }
            override fun onActivityPostCreated(a: Activity, savedInstanceState: Bundle?) {
                if (a is MainActivity) {
                    if (created.isEmpty()) watchDraws(a)
                    created += a
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
        /** The MainActivity the send created, once its own `onCreate` ran through; null until then. */
        val main: MainActivity? get() = created.firstOrNull() as? MainActivity

        fun send() {
            application.registerActivityLifecycleCallbacks(callbacks)
            sentAt = SystemClock.uptimeMillis()
            fire()
        }

        fun awaitMain(timeoutMs: Long): Activity? {
            val deadline = SystemClock.uptimeMillis() + timeoutMs
            while (created.isEmpty() && SystemClock.uptimeMillis() < deadline) SystemClock.sleep(50)
            application.unregisterActivityLifecycleCallbacks(callbacks)
            return created.firstOrNull()
        }

        /** Main thread, from `onActivityPostCreated`: the activity's host exists, its decor is set. */
        private fun watchDraws(a: MainActivity) {
            val decor = a.window.decorView
            val listener = ViewTreeObserver.OnDrawListener {
                if (firstDrawAt < 0) firstDrawAt = SystemClock.uptimeMillis() - sentAt
                framesDrawn++
                val view = a.host.tabs.get(PREVIOUS_TAB)
                if (view != null && view.isShown && view.width > 0 && view.height > 0) framesWithPrevious++
            }
            decor.viewTreeObserver.addOnDrawListener(listener)
            detachDrawWatch = { decor.viewTreeObserver.removeOnDrawListener(listener) }
        }

        /** The draw watch off (on the main thread, never from within a draw). */
        fun stopWatchingDraws() {
            val detach = detachDrawWatch ?: return
            detachDrawWatch = null
            onMain { detach() }
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
     * The new window's frames from a thread of its own: `PixelCopy` of the created MainActivity's
     * window ([window] hands it over once the activity exists) – the window's last rendered buffer,
     * copied at a quarter of its size by the RenderThread in one synchronous call – every
     * [GRAB_PERIOD_MS] at most, twenty a second. (The authorised run grabbed the whole screen with
     * `UiAutomation.takeScreenshot`, which takes ~500 ms on the emulator: a read of ~2 frames a
     * second, no evidence against a half-second page.) Nothing is read before the window has a
     * surface with a frame in it: the previous tab's page can only paint inside that window (what
     * shows before it is the system's splash), so the grabs run from the window's first buffer
     * and [windowAt] says when that was. Each grab is stamped with its time since the send, read
     * for the previous tab's orange and the mean luminance, and kept as a thumbnail for the
     * sheet. Should the copies fail on a device (20 in a row with a surface up), the grabber
     * falls back to the screenshot and [source] says so. The per-frame view signal ([Start]'s
     * draw watch) is read beside the pixels.
     */
    private inner class FrameGrabber(private val window: () -> Window?) : Thread("widget-frame-grabber") {
        @Volatile private var running = true
        private val grabbed = CopyOnWriteArrayList<GrabbedFrame>()
        private var t0 = 0L
        /** When the window's first buffer was copied, ms since the start; -1 for never. */
        @Volatile var windowAt = -1L
        /** Copies that failed with a surface up (not the no-surface and no-frame-yet waits). */
        @Volatile var copyErrors = 0
        /** What the frames came from: `PixelCopy`, or `screenshot` after the fallback. */
        @Volatile var source = "PixelCopy"
        private var failedInARow = 0
        private var pixels = IntArray(0)
        private val results = HandlerThread("widget-frame-results").also { it.start() }
        private val resultHandler = Handler(results.looper)

        override fun start() {
            t0 = SystemClock.uptimeMillis()
            super.start()
        }

        override fun run() {
            while (running) {
                val began = SystemClock.uptimeMillis()
                val copy = if (source == "PixelCopy") copyWindow() else screenshot()
                if (copy == null) {
                    SystemClock.sleep(if (source == "PixelCopy") 5 else 80)
                    continue
                }
                val at = SystemClock.uptimeMillis() - t0
                if (windowAt < 0) windowAt = at
                val (orange, luminance) = read(copy)
                val thumb = thumbnail(copy)
                copy.recycle()
                if (grabbed.size < MAX_FRAMES) grabbed += GrabbedFrame(at, orange, luminance, thumb) else thumb.recycle()
                val spent = SystemClock.uptimeMillis() - began
                if (spent < GRAB_PERIOD_MS) SystemClock.sleep(GRAB_PERIOD_MS - spent)
            }
            results.quitSafely()
        }

        /**
         * The window's last buffer at a quarter size, or null while there is no window, no surface
         * or no frame in it yet – and after a failure with a surface up, which counts towards the
         * fallback.
         */
        private fun copyWindow(): Bitmap? {
            val win = window() ?: return null
            val decor = win.peekDecorView() ?: return null
            val width = decor.width
            val height = decor.height
            if (width <= 0 || height <= 0) return null
            val dest = Bitmap.createBitmap(max(1, width / COPY_SCALE), max(1, height / COPY_SCALE), Bitmap.Config.ARGB_8888)
            val result = try {
                val done = ArrayBlockingQueue<Int>(1)
                PixelCopy.request(win, null, dest, { done.offer(it) }, resultHandler)
                done.poll(2, TimeUnit.SECONDS) ?: PixelCopy.ERROR_TIMEOUT
            } catch (e: IllegalArgumentException) {
                // "Window doesn't have a backing surface!": not up yet.
                NO_SURFACE
            }
            if (result == PixelCopy.SUCCESS) {
                failedInARow = 0
                return dest
            }
            dest.recycle()
            if (result != NO_SURFACE && result != PixelCopy.ERROR_SOURCE_NO_DATA) {
                copyErrors++
                if (++failedInARow >= FALLBACK_AFTER) {
                    Log.w(tag, "PixelCopy failed $failedInARow times in a row (last $result); the grabber falls back to screenshots")
                    source = "screenshot"
                }
            }
            return null
        }

        /** The whole screen at the copy's scale (the fallback), or null. */
        private fun screenshot(): Bitmap? {
            val bitmap = runCatching { ui.takeScreenshot() }.getOrNull() ?: return null
            val scaled = Bitmap.createScaledBitmap(bitmap, max(1, bitmap.width / COPY_SCALE), max(1, bitmap.height / COPY_SCALE), true)
            if (scaled !== bitmap) bitmap.recycle()
            return scaled
        }

        fun halt() {
            running = false
            join(5_000)
        }

        fun frames(): List<GrabbedFrame> = grabbed.toList()

        /** Grabs a second over the frames read (their first to their last); 0 under two frames. */
        fun rate(frames: List<GrabbedFrame>): Float {
            if (frames.size < 2) return 0f
            val span = frames.last().at - frames.first().at
            return if (span <= 0) 0f else (frames.size - 1) * 1000f / span
        }

        /** The share of sampled pixels within tolerance of the previous tab's orange, and the mean luminance (0–1). */
        private fun read(bitmap: Bitmap): Pair<Float, Float> {
            val width = bitmap.width
            val height = bitmap.height
            if (pixels.size < width * height) pixels = IntArray(width * height)
            bitmap.getPixels(pixels, 0, width, 0, 0, width, height)
            var orange = 0
            var total = 0
            var luminance = 0.0
            var y = 0
            while (y < height) {
                var x = 0
                val row = y * width
                while (x < width) {
                    val c = pixels[row + x]
                    val r = Color.red(c)
                    val g = Color.green(c)
                    val b = Color.blue(c)
                    if (kotlin.math.abs(r - PREVIOUS_R) <= TOLERANCE && kotlin.math.abs(g - PREVIOUS_G) <= TOLERANCE && kotlin.math.abs(b - PREVIOUS_B) <= TOLERANCE) orange++
                    luminance += (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0
                    total++
                    x += COPY_STEP
                }
                y += COPY_STEP
            }
            return if (total == 0) 0f to 0f else (orange.toFloat() / total) to (luminance / total).toFloat()
        }

        /** The frame at a tenth of the window, 16-bit: a hundred frames keep to a few megabytes. */
        private fun thumbnail(copy: Bitmap): Bitmap {
            val thumb = Bitmap.createBitmap(max(1, copy.width * COPY_SCALE / THUMB_SCALE), max(1, copy.height * COPY_SCALE / THUMB_SCALE), Bitmap.Config.RGB_565)
            Canvas(thumb).drawBitmap(copy, null, Rect(0, 0, thumb.width, thumb.height), Paint(Paint.FILTER_BITMAP_FLAG))
            return thumb
        }

        /** `widget-<theme>-<name>.png`: the thumbnails in rows, each captioned with its time and its orange share. */
        fun sheet(name: String, frames: List<GrabbedFrame>, caption: String) {
            if (frames.isEmpty()) return
            val thumbWidth = frames.first().thumb.width
            val thumbHeight = frames.first().thumb.height
            val columns = minOf(SHEET_COLUMNS, frames.size)
            val rows = (frames.size + columns - 1) / columns
            val pad = 10
            val label = 40
            val header = 44
            val sheet = Bitmap.createBitmap(
                max(pad + columns * (thumbWidth + pad), 1400),
                header + pad + rows * (thumbHeight + label + pad),
                Bitmap.Config.ARGB_8888
            )
            val canvas = Canvas(sheet)
            canvas.drawColor(0xFF15141A.toInt())
            val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE; textSize = 22f }
            val small = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFB8B7C0.toInt(); textSize = 15f }
            val flash = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0xFFFF7A00.toInt(); style = Paint.Style.STROKE; strokeWidth = 4f }
            canvas.drawText("$caption · ${frames.size} frames · orange = the previous tab's page", pad.toFloat(), 30f, text)
            frames.forEachIndexed { i, frame ->
                val x = pad + (i % columns) * (thumbWidth + pad)
                val y = header + pad + (i / columns) * (thumbHeight + label + pad)
                canvas.drawBitmap(frame.thumb, x.toFloat(), y.toFloat(), null)
                if (frame.orange >= FLASH_SHARE) canvas.drawRect(x - 2f, y - 2f, x + thumbWidth + 2f, y + thumbHeight + 2f, flash)
                canvas.drawText("+${frame.at} ms", x.toFloat(), (y + thumbHeight + 17).toFloat(), small)
                canvas.drawText("orange ${"%.1f".format(frame.orange * 100)}%", x.toFloat(), (y + thumbHeight + 35).toFloat(), small)
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
        /** The whole-screen reads' (`orangeOnScreen`) sampling step in screen pixels. */
        private const val SAMPLE_STEP = 6
        /** A frame with this share of the previous tab's orange shows its page. */
        private const val FLASH_SHARE = 0.01f
        /** The previous tab on screen: most of the window is its page. */
        private const val PAGE_SHARE = 0.3f

        /** The grabber's copies at a quarter of the window, read every other pixel of the copy (every 8th of the window). */
        private const val COPY_SCALE = 4
        private const val COPY_STEP = 2
        /** Thumbnails at a tenth of the window; twelve to a row on the sheet. */
        private const val THUMB_SCALE = 10
        private const val SHEET_COLUMNS = 12
        /** At most one grab per 50 ms: twenty a second, a tenth of the RenderThread's time at worst. */
        private const val GRAB_PERIOD_MS = 50L
        /** Grabs kept with a thumbnail (thirty seconds at the cap); the read stops there. */
        private const val MAX_FRAMES = 600
        /** Frames with the previous tab's page listed one by one in the findings, the rest counted. */
        private const val MAX_FLASH_LINES = 12
        /** `PixelCopy.request` threw for a window without a surface yet (not one of its result codes). */
        private const val NO_SURFACE = -1
        /** Failed copies in a row, with a surface up, before the grabber falls back to screenshots. */
        private const val FALLBACK_AFTER = 20

        /** A launcher's 4×1 frame on a 412 dp phone, and where on the backdrop it sits. */
        private const val FRAME_WIDTH_DP = 330
        private const val FRAME_HEIGHT_DP = 80
        private const val FRAME_TOP_SHARE = 0.18f
        /** The provider's minWidth and, with no minResizeWidth declared, its floor: four cells' 240 dp, Chrome's (search_widget_info.xml:11). */
        private const val FOUR_CELLS_DP = 240
        /** Chrome's 0.9 on the pill (search_widget_template.xml:19) as the fill's state list carries it: (int) (255 * 0.9f + 0.5f). */
        private const val FILL_ALPHA = 230
        /** The pill's view and its children, every one at full alpha (the fill alone carries the 0.9). */
        private val FACE_VIEWS = listOf(R.id.widget_search_face, R.id.widget_search_mark, R.id.widget_search_hint, R.id.widget_search_mic, R.id.widget_search_private)

        /**
         * The Quick Actions widget's forms (Chrome's `QuickActionSearchWidgetProviderDelegate.java:216-249`,
         * `:464-471`): the xsmall card 48 dp, the provider's minHeight; the heights handed to the
         * provider for each form – inside its band (under 72 / under 155 / from 155 dp) with room
         * for the fixed card (48 / 72 / 155 dp) and a little of the cells around it.
         */
        private const val QUICK_XSMALL_CARD_DP = 48
        private const val QUICK_XSMALL_FRAME_DP = 56
        private const val QUICK_SMALL_FRAME_DP = 100
        private const val QUICK_MEDIUM_FRAME_DP = 170

        /** Request codes the replays use where no face part fires (the widgets' own are 1–3 and 21–24). */
        private const val SCAN_REPLAY_CODE = 11
        private const val SHORTCUT_REPLAY_CODE = 12

        private val COLD_ORDER = listOf("search", "private", "scan", "shortcut-search")

        /** The face's words (`strings.xml`): the omnibox's hint, the mic's and the mask's names. Harness contracts. */
        private const val HINT_TEXT = "Search or enter address"
        private const val MIC_LABEL = "Search with your voice"
        private const val MASK_LABEL = "New private tab"
        private const val WIDGET_LABEL = "Zenium search"
        /** The Quick Actions widget's words (`strings.xml`): the picker's label and the scan button's name. */
        private const val QUICK_ACTIONS_LABEL = "Zenium quick actions"
        private const val SCAN_LABEL = "Scan a QR code"
        /** The game widget's words (`strings.xml`, gate #607 (f)): the picker's label and description, the face's name. */
        private const val GAME_LABEL = "Zenium Roll"
        private const val GAME_DESCRIPTION = "Play Roll, Zenium's offline game"
        private const val GAME_FACE_LABEL = "Play Roll"
        /** Roll's page and its stage's label as `shared/game/page.ts` writes them (the region's aria-label, read from its start). */
        private const val GAME_URL = "zen://game"
        private const val GAME_STAGE_LABEL = "Roll, an offline game"
        private const val GAME_STAGED = "Roll's tab on zen://game, the stage up (read in the tree)"
        private const val GAME_STAGED_BY_DOCUMENT = "Roll's tab on zen://game, the stage up (the document's word; not read in the tree)"
        private val GAME_STAGED_WORDS = setOf(GAME_STAGED, GAME_STAGED_BY_DOCUMENT)
        /** The document's word: the region carries the runtime's mounted mark (`page.ts`) and its canvas is inside. */
        private const val GAME_STAGE_MOUNTED_JS =
            "(function(){var g=document.querySelector('.zen-game[data-zen-game-mounted]');return !!(g&&g.querySelector('canvas'))})()"
        /** The region's phase, as the runtime marks it (`data-phase`): the game is running. */
        private const val GAME_RUNNING_JS =
            "(function(){var g=document.querySelector('.zen-game[data-zen-game-mounted]');return !!g&&g.dataset.phase==='running'})()"
        /** The canvas's box in the document's CSS px: left,top,right,bottom. */
        private const val GAME_STAGE_BOX_JS =
            "(function(){var c=document.querySelector('.zen-game[data-zen-game-mounted] canvas');if(!c)return '';var r=c.getBoundingClientRect();return [r.left,r.top,r.right,r.bottom].join(',')})()"
        /** How many of Roll's glyphs (`PAGE_GLYPHS.roll`, the class Lucide gives it) the chrome draws; and how many globes. */
        private const val ROLL_GLYPHS_JS = "document.querySelectorAll('svg.lucide-roll').length"
        private const val GLOBE_GLYPHS_JS = "document.querySelectorAll('svg.lucide-globe').length"
        /**
         * Roll's auto-player, for the night still alone. The runtime asks the window for every frame
         * (`requestFrame` → `requestAnimationFrame`, `runtime.ts`); this takes the window's over and
         * answers each ask on the next turn of the event loop with a clock 1000/60 ahead – one game
         * frame a turn, the physics untouched, real time not waited for. After each frame it reads the
         * canvas: the lane the runner's body crosses (stage y 90–135 – the tall card's top at 90 to the
         * ground's hairline at 138; the parallax rings stay above 72 and a high note above 88) from the
         * runner's right edge (x 54) on, a column with four device px unlike the sky (the pixel at 2,100,
         * clear by day and the painted box at night) is the next obstacle's left edge; the speed is that
         * edge's shift a frame. Eight frames before it reaches the runner it presses Space on the
         * document (`onKeyDown`, as a keyboard would) and lifts it twenty frames on, past the jump's
         * peak so `endJump` cuts nothing. A frame in which the region carries `data-theme` is the
         * night; after eight of them it holds the next ask, so the still is the frame the runtime
         * painted, and reads the canvas's corner (0,0; clear outside the rounded box) and the sky
         * (2,75; opaque inside it). A run that crashed – or a game still waiting – asks for no frame:
         * every 1.5 s of no frames the same key starts it (again). Its word is `window.__zenBot`.
         */
        private val GAME_BOT_JS = """
            (function () {
              var root = document.querySelector('.zen-game[data-zen-game-mounted]');
              var canvas = root && root.querySelector('canvas');
              var ctx = canvas && canvas.getContext('2d');
              var status = (window.__zenBot = { error: null, frames: 0, jumps: 0, starts: 0, night: false, done: false, theme: '', page: document.documentElement.dataset.theme || 'light', corner: -1, sky: -1 });
              if (!ctx) { status.error = 'no stage'; return; }
              var FRAME = 1000 / 60, LOOKAHEAD = 8, AIR = 34, LIFT_AT = 20;
              var clock = performance.now(), airborne = 0, lastEdge = null, speed = 8, nightFrames = 0, held = null;
              function key(type, code) { document.dispatchEvent(new KeyboardEvent(type, { code: code, key: code === 'Space' ? ' ' : code, bubbles: true, cancelable: true })); }
              function ratio() { return canvas.width / (parseFloat(canvas.style.width) || canvas.clientWidth || 600); }
              function edge() {
                var k = ratio();
                var ref = ctx.getImageData(Math.round(2 * k), Math.round(100 * k), 1, 1).data;
                var x0 = 56, w = 150, y0 = 90, h = 45;
                var img = ctx.getImageData(Math.round(x0 * k), Math.round(y0 * k), Math.round(w * k), Math.round(h * k));
                var W = img.width, H = img.height, d = img.data, need = Math.max(3, Math.round(4 * k));
                for (var px = 0; px < W; px++) {
                  var run = 0;
                  for (var py = 0; py < H; py++) {
                    var i = (py * W + px) * 4;
                    var diff = Math.abs(d[i] - ref[0]) + Math.abs(d[i + 1] - ref[1]) + Math.abs(d[i + 2] - ref[2]) + Math.abs(d[i + 3] - ref[3]);
                    if (diff > 24) { if (++run >= need) return x0 + px / k; } else run = 0;
                  }
                }
                return null;
              }
              function decide() {
                var e = edge();
                if (e !== null && lastEdge !== null && lastEdge > e && lastEdge - e < 20) speed = lastEdge - e;
                lastEdge = e;
                if (airborne > 0) {
                  airborne++;
                  if (airborne === LIFT_AT) key('keyup', 'Space');
                  if (airborne > AIR) airborne = 0;
                  return;
                }
                if (e !== null && e - 54 <= LOOKAHEAD * speed) { key('keydown', 'Space'); airborne = 1; status.jumps++; }
              }
              window.requestAnimationFrame = function (cb) {
                if (status.done) { held = cb; return 1; }
                setTimeout(function () {
                  if (status.done) { held = cb; return; }
                  clock += FRAME;
                  cb(clock);
                  status.frames++;
                  var theme = root.getAttribute('data-theme');
                  if (theme !== null) {
                    status.night = true;
                    status.theme = theme;
                    if (++nightFrames >= 8) {
                      status.done = true;
                      var k = ratio();
                      status.corner = ctx.getImageData(0, 0, 1, 1).data[3];
                      status.sky = ctx.getImageData(Math.round(2 * k), Math.round(75 * k), 1, 1).data[3];
                      return;
                    }
                  }
                  decide();
                }, 0);
                return 1;
              };
              var seen = 0;
              var kick = setInterval(function () {
                if (status.done) { clearInterval(kick); return; }
                if (status.frames === seen) { key('keydown', 'Space'); key('keyup', 'Space'); status.starts++; airborne = 0; lastEdge = null; }
                seen = status.frames;
              }, 1500);
            })();
        """.trimIndent()
        /**
         * The game widget's measures (`values/dimens.xml`): the platform's one-cell minimum the info
         * declares, the glyph's box; and the cell handed to the provider – a launcher's 1×1 on a 412 dp
         * phone (five columns, ~82 dp) less the host's 8 dp padding a side, near enough 72 dp square.
         */
        private const val GAME_MIN_DP = 40
        private const val GAME_GLYPH_DP = 32
        private const val GAME_CELL_DP = 72
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
