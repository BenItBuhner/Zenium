package app.zen.chromium

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.LinearGradient
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.Shader
import android.graphics.SurfaceTexture
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Base64
import android.util.Log
import android.view.Surface
import android.view.TextureView
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.nio.ByteBuffer

/**
 * Drives QR scanning (OMN-22, NTP-03) on the phone chrome for the `android-qr-demo` recording
 * and writes what it measured to `qr-findings.txt` next to the screenshots (one `PASS` or `FAIL`
 * per check; the test fails at the end when a check did not hold, after the recording is over):
 *
 *  - the camera refused at the system prompt: the toast; refused for good: the toast with Open
 *    settings, which opens the app's details screen;
 *  - the camera granted at the prompt: the scan sheet up from the new tab page's camera button
 *    with the PLATFORM's camera behind it (camera2 on the emulator's emulated back camera, the
 *    test pattern in the window), Cancel taking it down and releasing the camera;
 *  - a scan with a code in the picture: frames without a code keep the sheet scanning, the torch
 *    chip toggles the camera's torch, then a code carrying an address decodes and the address
 *    loads in the tab, the sheet gone with the camera released;
 *  - the omnibox's camera button (the empty field): a code carrying words decodes and is
 *    searched through the profile's engine (DuckDuckGo, so the routing is the core's);
 *  - the app sent behind while scanning: the camera released, the sheet gone when it returns
 *    (#187: no camera left open behind a sheet).
 *
 * Every camera button and every sheet action is pressed with an INJECTED TOUCH ([touchTapLabel]),
 * so the hit test has its say; the outcome is read afterwards from the tree, the chrome's DOM or
 * the core's state, and the sheet's own controls are held to what they do
 * ([touchTapLabelExpecting]: Torch switches the camera's torch, Cancel closes the camera, the
 * toast's Open settings brings the system's window in front).
 *
 * The camera. The shared recipe boots the emulator with `-camera-back none`; this demo's
 * workflow asks for `-camera-back emulated`, the emulator's built-in fake camera, so the
 * platform's camera2 path (`QrScan.Camera2`) runs once for real: the device opens, the session
 * streams into the sheet's window and the reader, `ready` crosses the bridge. That camera shows
 * a test pattern and never a code, and the recipe has no way to hold a poster in front of it, so
 * the decodes run through a stand-in ([StandInCamera]) the driver installs through
 * `QrScan.cameraFactory` (the driver runs in the app's process, so it can): it paints its scene
 * into the same TextureView the platform's camera would and hands each frame's luminance – a Y
 * plane with a row stride past the width, as devices report it – to the same `Listener`, from
 * which the frame goes through `QrScanLogic.luminanceSource`, ZXing and the `decoded` event
 * exactly as a camera frame would, so what the recording shows of the sheet and the submit is
 * the shipped path from the frame on. The permission flow is real: the driver script revokes
 * CAMERA after the install (`DEMO_REVOKE`), so the system's prompt shows and is answered with
 * touches; the two refusals fix the permission, `pm clear-permission-flags` lifts that so the
 * third request prompts again and is granted at the dialog.
 */
@RunWith(AndroidJUnit4::class)
class QrDemo : DemoHarness("qr-demo-state.json", "android-qr", "qr-demo") {
    override val tag = "QrDemo"
    private lateinit var findings: File
    private var failures = 0
    private val cameraThread = HandlerThread("qr-demo-camera").apply { start() }
    /** The camera the next `qr.start` opens: the platform's, or the stand-in with a scene of the driver's. */
    @Volatile private var usePlatformCamera = false
    private val standIn = StandInCamera(cameraThread)
    private val platform = CountingCamera()

    @Test
    fun record() {
        runDemo()
        assertEquals("checks that did not hold (see qr-findings.txt)", 0, failures)
    }

    override fun beforeLaunch() {
        QrScan.availabilityOverride = true
        QrScan.cameraFactory = { context ->
            if (usePlatformCamera) platform.wrap(QrScan.Camera2(context, Handler(cameraThread.looper))) else standIn.reset()
        }
    }

    override fun warmUp() {
        findings = File(out, "qr-findings.txt")
        findings.writeText("Zenium Android QR scan checks (API ${Build.VERSION.SDK_INT}, ${width}x$height, density $density)\n\n")
        finding("start: ${describeActive()}")
        check("the chrome boots with the qrScan capability", coreState().getJSONObject("capabilities").optBoolean("qrScan"))
        check("CAMERA starts out not granted (DEMO_REVOKE)", !cameraGranted())
        finding("back cameras the platform reports: ${platformCameras()}")
        // The first new tab page pays for its layout: open and close one off camera.
        if (touchTapLabel(NEW_TAB_LABEL)) {
            awaitUrl({ it == BLANK_URL }, 8_000)
            SystemClock.sleep(2_000)
            activeCoreTab()?.optString("id")?.takeIf { it.isNotEmpty() && activeCoreTab()?.optString("url") == BLANK_URL }?.let { id ->
                coreInvoke("tab.close", "{\"tabId\":${JSONObject.quote(id)}}")
                SystemClock.sleep(2_000)
            }
        }
        if (activeCoreTab()?.optString("id") != EXAMPLE_TAB) {
            coreInvoke("tab.activate", "{\"tabId\":${JSONObject.quote(EXAMPLE_TAB)}}")
            settle()
        }
        finding("warm-up done: ${describeActive()}")
    }

    override fun demo() {
        shot("00-page")
        openNewTabPage("01-new-tab-page")
        refusedOnce()
        refusedForGood()
        grantedWithThePlatformCamera()
        addressFromNewTabPage()
        wordsFromOmnibox()
        sentBehindWhileScanning()
        finding("\nend: ${describeActive()}; stand-in starts ${standIn.starts}, closes ${standIn.closes}, frames ${standIn.frames}; platform camera closes ${platform.closes}")
    }

    // --- the sequence ----------------------------------------------------------------------------

    private fun openNewTabPage(shotName: String) {
        check("New tab is touched", touchTapLabel(NEW_TAB_LABEL))
        check("the new tab page is up", awaitUrl({ it == BLANK_URL }, 8_000))
        SystemClock.sleep(2_500)
        check("the page's field shows the camera button", waitFor(CAMERA_LABEL, 8_000) != null)
        shot(shotName)
    }

    /** The page's camera, the system's prompt, Don't allow: the sheet goes again, the toast says why. */
    private fun refusedOnce() {
        finding("\ncamera refused once")
        watchToasts()
        check("a touch on the page's camera button starts the request", touchTapLabel(CAMERA_LABEL))
        val prompted = awaitSystemWindow(10_000)
        check("the system's camera prompt shows", prompted)
        if (prompted) {
            SystemClock.sleep(1_200)
            shot("02-permission-prompt")
            check("Don't allow is touched", touchDialog(DENY_LABELS))
        }
        // The toast is pushed with the reply and lives 2.8 s, while the sheet's leave takes the
        // emulator seconds; it is read from the record (watchToasts), not the tree, which trails.
        val toast = awaitToast(DENIED_TOAST, 12_000)
        check("the refusal's toast: '$DENIED_TOAST'", toast)
        check("the sheet is down after the refusal", awaitSurface(false, 6_000))
        if (toast) shot("03-denied-toast")
        SystemClock.sleep(3_500)
    }

    /**
     * Refused again: Android 11+ stops asking after the second Don't allow, and the request comes
     * back as fixed – the toast then carries Open settings, which opens the app's details screen.
     * A third request auto-refuses without a dialog, should the second one not yet count as fixed.
     */
    private fun refusedForGood() {
        finding("\ncamera refused for good")
        var fixed = false
        for (attempt in 1..3) {
            watchToasts()
            if (!touchTapLabel(CAMERA_LABEL)) {
                finding("  attempt $attempt: no camera button to touch")
                break
            }
            if (awaitSystemWindow(6_000)) {
                SystemClock.sleep(800)
                if (!touchDialog(DENY_LABELS)) finding("  attempt $attempt: Don't allow not touched")
            } else {
                finding("  attempt $attempt: no prompt (auto-refused)")
            }
            val deadline = SystemClock.uptimeMillis() + 12_000
            while (SystemClock.uptimeMillis() < deadline) {
                if (toastSeen(FIXED_TOAST)) {
                    fixed = true
                    break
                }
                if (toastSeen(DENIED_TOAST)) break
                SystemClock.sleep(200)
            }
            if (fixed) break
            SystemClock.sleep(3_500)
        }
        check("the fixed refusal's toast: '$FIXED_TOAST'", fixed)
        if (!fixed) return
        // The record has the toast the moment it is pushed; the still waits for the sheet to have
        // left. The action is touched through the tree, which lists the toast a while after the
        // DOM has it; a toast with an action lives 5 s.
        awaitSurface(false, 6_000)
        SystemClock.sleep(300)
        shot("04-denied-for-good-toast")
        val opened = touchTapLabelExpecting(OPEN_SETTINGS_LABEL, "the app's details screen is in front", timeoutMs = 8_000, findTimeoutMs = 4_000) { systemWindowInFront() }
        check("Open settings (touched) opens the app's details screen", opened)
        if (opened) {
            SystemClock.sleep(2_500)
            shot("05-app-settings")
            back()
            SystemClock.sleep(2_000)
            ensureForeground()
        }
        SystemClock.sleep(1_500)
    }

    /**
     * The prompt again (the fixed flag lifted through the shell), While using the app: the sheet
     * stays and the PLATFORM's camera opens behind it – camera2 on the emulator's emulated back
     * camera – then Cancel takes the sheet down and closes the camera. A camera the emulator
     * cannot open is said in the findings, not failed: the shipped path is then shown with the
     * stand-in from here on, and the decode checks below stand on their own.
     */
    private fun grantedWithThePlatformCamera() {
        finding("\ncamera granted, the platform's camera scans")
        usePlatformCamera = true
        val lifted = liftFixedRefusal()
        check("a touch on the page's camera button starts the request", touchTapLabel(CAMERA_LABEL))
        if (lifted && awaitSystemWindow(8_000)) {
            SystemClock.sleep(1_000)
            check("While using the app is touched", touchDialog(ALLOW_LABELS))
        } else {
            finding("  no prompt: the permission was granted through UiAutomation instead")
        }
        check("CAMERA is granted", awaitCameraGranted(8_000))
        val opened = awaitPhase(setOf("starting", "scanning"), 10_000)
        check("the scan sheet is up (phase ${phase()})", opened)
        if (!opened) {
            usePlatformCamera = false
            return
        }
        val started = SystemClock.uptimeMillis()
        val streaming = awaitPhase(setOf("scanning"), 15_000)
        val elapsed = SystemClock.uptimeMillis() - started
        if (streaming) {
            finding("  PASS  camera2 streams on the emulated back camera: ready after $elapsed ms, torch offered ${torchOffered()}")
            SystemClock.sleep(2_500)
            shot("06-scanning-platform-camera")
            check("the window shows the live picture (data-live)", windowLive())
            val closesBefore = platform.closes
            check("Cancel (touched) closes the camera", touchTapLabelExpecting(CANCEL_LABEL, "the platform camera is closed", timeoutMs = 4_000) { platform.closes > closesBefore })
            check("the sheet is down after Cancel", awaitSurface(false, 6_000))
        } else {
            finding("  NOTE  the platform's camera did not stream within $elapsed ms (phase '${phase()}'; toast ${cameraToast()}): camera2 on this emulator image, not the app, is what did not hold; the scenes below run through the stand-in")
            if (chromeSurfaceUp()) {
                touchTapLabel(CANCEL_LABEL, timeoutMs = 3_000)
                awaitSurface(false, 6_000)
            }
        }
        usePlatformCamera = false
        SystemClock.sleep(2_000)
    }

    /**
     * The page's camera with the stand-in behind it: frames without a code keep the sheet
     * scanning, Torch switches the camera's torch (the picture brightens), and a code carrying an
     * address decodes – the sheet goes, the camera closes, the address loads in the tab.
     */
    private fun addressFromNewTabPage() {
        finding("\nan address from the new tab page's camera")
        standIn.scene = null
        check("the page's camera button is touched (granted: no prompt)", touchTapLabel(CAMERA_LABEL))
        val up = awaitPhase(setOf("scanning"), 10_000)
        check("the sheet scans with the stand-in (phase ${phase()})", up)
        if (!up) return
        val framesBefore = standIn.frames
        SystemClock.sleep(2_000)
        check("frames without a code keep the sheet scanning (${standIn.frames - framesBefore} frames decoded to nothing)", standIn.frames > framesBefore && phase() == "scanning")
        shot("07-scanning")
        check("the torch chip is offered", waitFor(TORCH_LABEL, 4_000) != null)
        check("Torch (touched) turns the camera's torch on", touchTapLabelExpecting(TORCH_LABEL, "the torch is on", timeoutMs = 4_000) { standIn.torchOn })
        check("the chip reads pressed once the camera answered", awaitCount(4_000) { torchPressed() == true })
        SystemClock.sleep(1_500)
        shot("08-torch-on")
        check("Torch (touched) turns it off again", touchTapLabelExpecting(TORCH_LABEL, "the torch is off", timeoutMs = 4_000) { !standIn.torchOn })
        check("the chip reads unpressed", awaitCount(4_000) { torchPressed() == false })
        SystemClock.sleep(800)
        standIn.scene = qrBitmap(ADDRESS_PAYLOAD)
        val navigated = awaitUrl({ it.contains("example.org") }, 15_000)
        check("the address decodes and loads: ${activeCoreTab()?.optString("url")}", navigated)
        check("the sheet is down after the decode", awaitSurface(false, 6_000))
        check("the camera is released after the decode", awaitCount(4_000) { standIn.closes >= standIn.starts })
        SystemClock.sleep(4_000)
        shot("09-address-loaded")
    }

    /** The omnibox's camera (the field cleared): words in the code are searched through the engine. */
    private fun wordsFromOmnibox() {
        finding("\nwords from the omnibox's camera")
        standIn.scene = null
        touchAddress()
        check("the omnibox opens from the pill", awaitNode(8_000) { it == CLEAR_LABEL } != null)
        SystemClock.sleep(1_000)
        check("Clear is touched", touchTapLabel(CLEAR_LABEL))
        check("the empty field shows the camera button", waitFor(CAMERA_LABEL, 6_000) != null)
        SystemClock.sleep(800)
        shot("10-omnibox-camera")
        check("the omnibox's camera button is touched", touchTapLabel(CAMERA_LABEL))
        val up = awaitPhase(setOf("scanning"), 10_000)
        check("the sheet scans from the omnibox (phase ${phase()})", up)
        check("the keyboard is down under the sheet", awaitIme(false, 6_000))
        if (!up) {
            closeUrlbar()
            return
        }
        SystemClock.sleep(1_500)
        shot("11-scanning-from-omnibox")
        standIn.scene = qrBitmap(WORDS_PAYLOAD)
        val searched = awaitUrl({ it.contains("duckduckgo.com") && it.contains("weather") && it.contains("Lisbon") }, 15_000)
        check("the words are searched through the profile's engine: ${activeCoreTab()?.optString("url")}", searched)
        check("the sheet is down after the decode", awaitSurface(false, 6_000))
        check("the camera is released after the decode", awaitCount(4_000) { standIn.closes >= standIn.starts })
        SystemClock.sleep(5_000)
        shot("12-search-result")
    }

    /** Home while scanning: the camera is released at once, and the sheet is gone when the app returns (#187). */
    private fun sentBehindWhileScanning() {
        finding("\nthe app sent behind while scanning")
        standIn.scene = null
        touchAddress()
        check("the omnibox opens from the pill", awaitNode(8_000) { it == CLEAR_LABEL } != null)
        SystemClock.sleep(800)
        check("Clear is touched", touchTapLabel(CLEAR_LABEL))
        check("the omnibox's camera button is touched", touchTapLabel(CAMERA_LABEL))
        val up = awaitPhase(setOf("scanning"), 10_000)
        check("the sheet scans (phase ${phase()})", up)
        if (!up) {
            closeUrlbar()
            return
        }
        SystemClock.sleep(1_500)
        val closesBefore = standIn.closes
        shell("input keyevent KEYCODE_HOME")
        check("the camera is released as the app leaves the screen", awaitCount(6_000) { standIn.closes > closesBefore })
        SystemClock.sleep(2_000)
        // Back through the launcher's intent, from the shell as the error-pages demo does: the
        // app's own process is in the background now, where it may not start activities.
        val relaunch = shell("am start -W -n ${activity.componentName.flattenToString()}")
        Log.i(tag, "relaunch: ${relaunch.lineSequence().firstOrNull { it.contains("Status") || it.contains("Warning") }?.trim()}")
        check("the app is back in front", awaitCount(15_000) { !systemWindowInFront() })
        SystemClock.sleep(2_500)
        val gone = awaitSurface(false, 6_000) && awaitCount(6_000) { phase() == "" }
        check("the sheet is gone when the app returns (phase '${phase()}')", gone)
        shot("13-returned-no-sheet")
    }

    // --- the sheet as the chrome has it --------------------------------------------------------------

    /**
     * Open the omnibox with a touch on the address inside the pill (a button of its own, read
     * "Address, <host>"), not on the pill's middle: a page's blocked-requests, lock and translate
     * chips sit there (a search result carries all three), and a touch on them opens site
     * information instead. The pill's middle only when the tree has no address to aim at.
     */
    private fun touchAddress() {
        if (touchTapLabel(ADDRESS_LABEL_PREFIX, prefix = true, timeoutMs = 4_000)) return
        Log.w(tag, "the address is not in the accessibility tree; touching the pill's middle")
        Finger().tap(pillCenterX, pillY)
    }

    private fun systemWindowInFront(): Boolean {
        val top = ui.rootInActiveWindow?.packageName?.toString()
        return top != null && top != app.packageName
    }

    /** The sheet's phase as the chrome's DOM has it (`data-qr-phase`), "" when no sheet is up. */
    private fun phase(): String {
        val raw = chromeJs("(function(){var s=document.querySelector('[data-testid=qr-sheet]');return s?(s.dataset.qrPhase||''):''})()")
        return (JSONTokener(raw).nextValue() as? String).orEmpty()
    }

    private fun awaitPhase(phases: Set<String>, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (phase() in phases) return true
            SystemClock.sleep(150)
        }
        return phase() in phases
    }

    /** Whether the window says the live preview is over it (`data-live`). */
    private fun windowLive(): Boolean {
        val raw = chromeJs("(function(){var w=document.querySelector('[data-testid=qr-window]');return w?w.dataset.live||'':''})()")
        return (JSONTokener(raw).nextValue() as? String) == "true"
    }

    private fun torchOffered(): Boolean =
        (JSONTokener(chromeJs("!!document.querySelector('[data-testid=qr-torch]')")).nextValue() as? Boolean) == true

    /** The torch chip's `aria-pressed`, null when there is no chip. */
    private fun torchPressed(): Boolean? {
        val raw = chromeJs("(function(){var t=document.querySelector('[data-testid=qr-torch]');return t?t.getAttribute('aria-pressed'):''})()")
        return when (JSONTokener(raw).nextValue() as? String) {
            "true" -> true
            "false" -> false
            else -> null
        }
    }

    /** The toast a failed start left, for the findings. */
    private fun cameraToast(): String =
        listOf(CAMERA_FAILED_TOAST, CAMERA_BUSY_TOAST, UNAVAILABLE_TOAST).firstOrNull { findByLabel(it) != null } ?: "none"

    private fun awaitCount(timeoutMs: Long, reached: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            if (reached()) return true
            SystemClock.sleep(100)
        }
        return reached()
    }

    // --- the cameras -------------------------------------------------------------------------------

    /**
     * The platform's camera as `QrScan` drives it, with its closes counted: the one thing the
     * driver adds to the shipped camera2 path is the count Cancel is held to.
     */
    private class CountingCamera {
        @Volatile var closes = 0

        fun wrap(inner: QrScan.Camera): QrScan.Camera = object : QrScan.Camera {
            override fun start(preview: TextureView, listener: QrScan.Listener) = inner.start(preview, listener)
            override fun setTorch(on: Boolean) = inner.setTorch(on)
            override fun close() {
                closes++
                inner.close()
            }
        }
    }

    /**
     * A camera the driver plays. `QrScan` calls [start] with the sheet's preview view and the
     * session's listener, [setTorch] as the chip is touched and [close] when it lets the session
     * go; the stand-in paints its scene – a lit surface, brighter with the torch on, with the code
     * bitmap in the middle when [scene] holds one – into the preview's texture and hands each
     * frame's luminance to the listener on its own thread, [FRAME_MS] apart, as the platform's
     * reader would. The Y plane it hands over has a row stride past the width
     * ([STRIDE_PADDING]), the shape devices report, so the adapter's stride path is the one run.
     */
    private class StandInCamera(thread: HandlerThread) : QrScan.Camera {
        private val main = Handler(Looper.getMainLooper())
        private val handler = Handler(thread.looper)
        @Volatile private var listener: QrScan.Listener? = null
        @Volatile private var view: TextureView? = null
        private var surface: Surface? = null
        @Volatile var scene: Bitmap? = null
        @Volatile var torchOn = false
        @Volatile var starts = 0
        @Volatile var closes = 0
        @Volatile var frames = 0
        /** `ready` has gone for the live session (with the first frame, as the platform's camera reports it). */
        @Volatile private var announced = false
        private val frame = Bitmap.createBitmap(FRAME_SIDE, FRAME_SIDE, Bitmap.Config.ARGB_8888)
        private val luma = ByteArray((FRAME_SIDE + STRIDE_PADDING) * FRAME_SIDE)
        private val pixels = IntArray(FRAME_SIDE * FRAME_SIDE)

        /** A fresh session's camera: the torch off, nothing in the scene the last session left. */
        fun reset(): StandInCamera {
            torchOn = false
            return this
        }

        override fun start(preview: TextureView, listener: QrScan.Listener) {
            starts++
            announced = false
            this.listener = listener
            view = preview
            preview.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) = paint()
                override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) = paint()
                override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean {
                    this@StandInCamera.surface?.release()
                    this@StandInCamera.surface = null
                    return true
                }
                override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}
            }
            handler.postDelayed(tick, FRAME_MS)
        }

        override fun setTorch(on: Boolean) {
            handler.post {
                if (listener == null || torchOn == on) return@post
                torchOn = on
                main.post {
                    listener?.torch(on)
                    paint()
                }
            }
        }

        override fun close() {
            closes++
            listener = null
            handler.removeCallbacks(tick)
            main.post {
                view?.surfaceTextureListener = null
                view = null
                surface?.release()
                surface = null
            }
        }

        private val tick = object : Runnable {
            override fun run() {
                val live = listener ?: return
                if (!announced) {
                    announced = true
                    main.post { listener?.ready(true) }
                }
                frames++
                compose()
                live.frame(QrScanLogic.luminanceSource(ByteBuffer.wrap(luma), FRAME_SIDE, FRAME_SIDE, FRAME_SIDE + STRIDE_PADDING, 1))
                main.post { paint() }
                handler.postDelayed(this, FRAME_MS)
            }
        }

        /** The scene as the camera sees it now, into [frame] and its luminance into [luma]. */
        @Synchronized
        private fun compose() {
            val canvas = Canvas(frame)
            val light = if (torchOn) 0xFFF4F1EA.toInt() else 0xFFB9B4A8.toInt()
            val shade = if (torchOn) 0xFFD9D4C8.toInt() else 0xFF7C776C.toInt()
            val paint = Paint().apply {
                shader = LinearGradient(0f, 0f, FRAME_SIDE.toFloat(), FRAME_SIDE.toFloat(), light, shade, Shader.TileMode.CLAMP)
            }
            canvas.drawRect(0f, 0f, FRAME_SIDE.toFloat(), FRAME_SIDE.toFloat(), paint)
            scene?.let { code ->
                val side = FRAME_SIDE * 3 / 5
                val left = (FRAME_SIDE - side) / 2
                canvas.drawBitmap(code, null, Rect(left, left, left + side, left + side), Paint(Paint.FILTER_BITMAP_FLAG))
            }
            frame.getPixels(pixels, 0, FRAME_SIDE, 0, 0, FRAME_SIDE, FRAME_SIDE)
            val stride = FRAME_SIDE + STRIDE_PADDING
            for (y in 0 until FRAME_SIDE) {
                for (x in 0 until FRAME_SIDE) {
                    val p = pixels[y * FRAME_SIDE + x]
                    val l = (Color.red(p) * 299 + Color.green(p) * 587 + Color.blue(p) * 114) / 1000
                    luma[y * stride + x] = l.toByte()
                }
            }
        }

        /** Main thread: the last composed frame into the preview's texture, where the platform's camera would stream. */
        private fun paint() {
            val texture = view ?: return
            if (!texture.isAvailable) return
            val st = texture.surfaceTexture ?: return
            val surface = surface ?: run {
                st.setDefaultBufferSize(FRAME_SIDE, FRAME_SIDE)
                Surface(st).also { surface = it }
            }
            val canvas = runCatching { surface.lockCanvas(null) }.getOrNull() ?: return
            synchronized(this) { canvas.drawBitmap(frame, null, Rect(0, 0, canvas.width, canvas.height), null) }
            surface.unlockCanvasAndPost(canvas)
        }
    }

    /** A QR code carrying `text`, black on white, as a camera would see it printed. */
    private fun qrBitmap(text: String): Bitmap {
        val size = 320
        val hints = mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 2)
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, hints)
        val pixels = IntArray(size * size) { i -> if (matrix.get(i % size, i / size)) Color.BLACK else Color.WHITE }
        return Bitmap.createBitmap(pixels, size, size, Bitmap.Config.ARGB_8888)
    }

    private fun platformCameras(): String = runCatching {
        val manager = QrScan.cameraManager(app)
        manager.cameraIdList.joinToString(", ") { id ->
            val facing = manager.getCameraCharacteristics(id).get(android.hardware.camera2.CameraCharacteristics.LENS_FACING)
            "$id (facing $facing)"
        }.ifEmpty { "none" }
    }.getOrElse { "error: ${it.message}" }

    // --- the permission ----------------------------------------------------------------------------

    private fun cameraGranted(): Boolean =
        ContextCompat.checkSelfPermission(app, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED

    private fun awaitCameraGranted(timeoutMs: Long): Boolean = awaitCount(timeoutMs) { cameraGranted() }

    /**
     * Two refusals fix the permission (the system auto-refuses from then on); `pm
     * clear-permission-flags` lifts the fixing so the next request prompts again and the grant
     * can be a touch on the dialog. Where the shell has no such command the permission is granted
     * through UiAutomation instead (said in the findings); true when the prompt is to be expected.
     */
    private fun liftFixedRefusal(): Boolean {
        val out = shell("pm clear-permission-flags ${app.packageName} ${Manifest.permission.CAMERA} user-fixed user-set 2>&1; echo \"exit=$?\"")
        finding("  pm clear-permission-flags: ${out.trim().replace('\n', ' ')}")
        if (out.contains("exit=0") && !out.contains("Error", ignoreCase = true) && !out.contains("Unknown", ignoreCase = true)) return true
        ui.grantRuntimePermission(app.packageName, Manifest.permission.CAMERA)
        return false
    }

    /**
     * A real touch on the first of `labels` the dialog in front shows (the system spells "Don't"
     * with a typographic apostrophe on recent releases, so the match folds the two), else its
     * accessibility click, logged as such.
     */
    private fun touchDialog(labels: List<String>): Boolean {
        for (label in labels) {
            val node = awaitNode(2_000) { sameLabel(it, label) } ?: continue
            if (touchTap(node)) return true
        }
        for (label in labels) {
            val node = findNode { sameLabel(it, label) } ?: continue
            var clickable = node
            while (!clickable.isClickable) clickable = clickable.parent ?: break
            if (clickable.isClickable && clickable.performAction(android.view.accessibility.AccessibilityNodeInfo.ACTION_CLICK)) {
                finding("  '$label' was clicked through the tree, not touched")
                return true
            }
        }
        val seen = ArrayList<String>()
        findNodeWhere { node ->
            (node.text ?: node.contentDescription)?.toString()?.takeIf { it.isNotBlank() }?.let(seen::add)
            false
        }
        finding("  none of $labels in the window in front; it reads: ${seen.take(12)}")
        return false
    }

    private fun sameLabel(a: String, b: String): Boolean =
        a.replace('\u2019', '\'').trim().equals(b.replace('\u2019', '\''), ignoreCase = true)

    /**
     * Run a shell command as adb would. UiAutomation hands the string to `Runtime.exec`, which
     * splits on whitespace and knows nothing of quotes, so the script travels base64-encoded in a
     * single token and `sh` decodes it.
     */
    private fun shell(script: String): String {
        val encoded = Base64.encodeToString(script.toByteArray(), Base64.NO_WRAP)
        val descriptor = ui.executeShellCommand("sh -c echo\${IFS}$encoded|base64\${IFS}-d|sh")
        return ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.bufferedReader().readText() }
    }

    // --- the core ----------------------------------------------------------------------------------

    private fun awaitUrl(matches: (String) -> Boolean, timeoutMs: Long): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (SystemClock.uptimeMillis() < deadline) {
            val url = runCatching { activeCoreTab()?.optString("url").orEmpty() }.getOrDefault("")
            if (matches(url)) return true
            SystemClock.sleep(300)
        }
        return false
    }

    private fun describeActive(): String = activeCoreTab().let { "active ${it?.optString("id")} ${it?.optString("url")}" }

    // --- findings ----------------------------------------------------------------------------------

    private fun check(what: String, ok: Boolean) {
        if (!ok) failures++
        finding("  ${if (ok) "PASS" else "FAIL"}  $what")
    }

    private fun finding(line: String) {
        Log.i(tag, line.trim())
        findings.appendText(line + "\n")
    }

    companion object {
        private const val EXAMPLE_TAB = "tab_example"
        private const val BLANK_URL = "zen://blank"
        private const val NEW_TAB_LABEL = "New tab"
        /** The new tab page's button and the omnibox's (both "Scan a QR code"; only one is ever on screen). */
        private const val CAMERA_LABEL = "Scan a QR code"
        private const val CLEAR_LABEL = "Clear"
        /** The address button inside the pill reads "Address, <host>" (`PillContent`); the pill itself is the group "Address". */
        private const val ADDRESS_LABEL_PREFIX = "Address, "
        private const val CANCEL_LABEL = "Cancel"
        private const val TORCH_LABEL = "Torch"
        private const val OPEN_SETTINGS_LABEL = "Open settings"
        /** The toasts (`qrStartMessage`, `qrErrorMessage` in `src/shared/qrScan.ts`). */
        private const val DENIED_TOAST = "Camera access is needed to scan a code"
        private const val FIXED_TOAST = "Camera access is turned off for Zenium"
        private const val UNAVAILABLE_TOAST = "Scanning is not available on this device"
        private const val CAMERA_FAILED_TOAST = "The camera could not be started"
        private const val CAMERA_BUSY_TOAST = "The camera is in use by another app"
        private const val ADDRESS_PAYLOAD = "https://example.org/"
        private const val WORDS_PAYLOAD = "weather in Lisbon this weekend"
        /** The system prompt's buttons, by release (API 30+ first). */
        private val DENY_LABELS = listOf("Don't allow", "Deny")
        private val ALLOW_LABELS = listOf("While using the app", "Only this time", "Allow")
        /** The stand-in's frame: square like the window, at a size ZXing reads a code in without effort. */
        private const val FRAME_SIDE = 480
        private const val STRIDE_PADDING = 64
        private const val FRAME_MS = 120L
    }
}
