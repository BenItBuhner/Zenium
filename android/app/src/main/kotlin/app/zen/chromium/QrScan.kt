package app.zen.chromium

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.graphics.Outline
import android.graphics.RectF
import android.graphics.SurfaceTexture
import android.hardware.camera2.CameraAccessException
import android.hardware.camera2.CameraCaptureSession
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraDevice
import android.hardware.camera2.CameraManager
import android.hardware.camera2.CaptureRequest
import android.media.ImageReader
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.WindowManager
import android.widget.FrameLayout
import com.google.zxing.LuminanceSource
import org.json.JSONObject
import java.io.ByteArrayOutputStream

/**
 * The scanner's host half (OMN-22, NTP-04): the device's back camera behind the chrome's camera
 * buttons. `qr.start` asks for the camera (the runtime prompt through [Permissions.requestForApp])
 * and opens it through camera2 into two streams – a [TextureView] the host lays over the scan
 * sheet's window as the chrome says (`qr.layout`), and an [ImageReader] whose YUV_420_888 frames
 * go, luminance plane only, through ZXing ([QrScanLogic.Decoder]) on the camera's own thread –
 * but only while the chrome says the window shows the live picture ([QrScanLogic.FrameGate]): a
 * sheet that moves, or is on its way out, reads no code. What the camera reports goes to the
 * chrome as `qr.event`s (`QrEvent` in `src/shared/qrScan.ts`): `ready` once frames flow (and
 * whether there is a torch), the `still`s the window shows while the live picture is hidden,
 * `torch` when it switches, one `decoded` per code, `error` when the camera fails, `aborted` when
 * the app leaves the screen. The chrome owns the sheet and the submit; this class owns nothing but
 * the camera, its preview view and their life – the camera is released on `qr.cancel`, on the
 * activity's stop and on destroy, so none is left open behind a sheet that is gone (#187).
 *
 * Whether the device has a back camera at all ([available]) goes to the chrome at boot as the
 * `qrScan` capability; without it no camera button shows.
 *
 * Testing seam: the emulator's camera shows a test pattern and never a code, so the demo driver
 * (`QrDemo` under androidTest) installs a stand-in through [cameraFactory] before the activity
 * starts and forces [availabilityOverride]; the frames it feeds reach [QrScanLogic.decode] through
 * the same [Listener] the platform's camera reports to, so the decode, the events and the submit
 * are the shipped path from the frame on.
 */
class QrScan(private val host: Host, private val root: FrameLayout) {
    /** What [QrScan] drives: the platform's back camera through camera2, or the driver's stand-in. */
    interface Camera {
        /**
         * Open the camera and stream: the picture into `preview` (whose surface may not exist yet;
         * the camera waits for it), every frame's luminance to `listener.frame`. Main thread.
         */
        fun start(preview: TextureView, listener: Listener)
        /** Turn the torch on or off; the camera answers `listener.torch` once it has. */
        fun setTorch(on: Boolean)
        /** Release the camera; nothing more reaches the listener. Main thread, may return before the camera is closed. */
        fun close()
    }

    /** The camera's reports; `frame` comes on the camera's thread, the rest on the main thread. */
    interface Listener {
        /** Frames flow; `torch` says whether the camera has one to toggle. */
        fun ready(torch: Boolean)
        /** One frame's luminance, valid for the call only (the frame is recycled after it). */
        fun frame(source: LuminanceSource)
        fun torch(on: Boolean)
        /** The camera stopped short of a decode: `camera`, `busy` or `disconnected`. */
        fun error(kind: String)
    }

    private val activity get() = host.activity
    private val main = Handler(Looper.getMainLooper())
    private var thread: HandlerThread? = null
    private var camera: Camera? = null
    private var preview: PreviewView? = null
    /** Counts the sessions, so a report from a camera already let go is ignored; the camera thread reads it. */
    @Volatile private var session = 0
    /** Whether the live session's frames are read: the window shown, the cadence, the pause after a decode. One per session. */
    private var gate = QrScanLogic.FrameGate()
    private val stillTick = object : Runnable {
        override fun run() {
            sendStill()
            main.postDelayed(this, STILL_INTERVAL_MS)
        }
    }

    /** The device has a back camera the chrome's camera buttons can scan with. */
    val available: Boolean
        get() = availabilityOverride ?: platformHasBackCamera

    /**
     * `FEATURE_CAMERA` is the platform's word for a camera facing away from the screen; the id
     * check behind it is belt and braces. Both are binder calls to the camera service, and a
     * device's cameras do not come and go, so they are made once (the boot path reads this).
     */
    private val platformHasBackCamera: Boolean by lazy {
        runCatching {
            activity.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA) && backCameraId(cameraManager(activity)) != null
        }.getOrDefault(false)
    }

    /**
     * `qr.start`: the camera permission first (granted before, or the system prompt now), then the
     * camera. `reply` gets a `QrStartOutcome`: `scanning` once the camera is opening (`ready`
     * follows as frames flow; a camera that fails to open reports `error`, whether it failed in
     * its callbacks or in `openCamera` itself), the grant's name for a refusal, `unavailable`
     * where there is no back camera or camera2 would not even take the request. A `qr.cancel`
     * while the prompt is up (the sheet backed away) is honoured by not opening; the reply then
     * still says what the prompt answered, which the chrome ignores for a sheet it has taken down.
     */
    fun start(reply: (Any?) -> Unit) {
        if (!available) {
            reply("unavailable")
            return
        }
        val id = ++session
        closeCamera()
        host.permissions.requestForApp(Manifest.permission.CAMERA) { grant ->
            if (grant != RuntimeGrant.GRANTED || id != session) {
                reply(QrScanLogic.outcome(grant))
                return@requestForApp
            }
            val failure = open(id)
            if (failure == null) {
                reply("scanning")
                return@requestForApp
            }
            // The camera is there but would not open – held by another app, disabled by policy:
            // the session fails as it would had the open failed in its callback, and the toast
            // says what happened (`qrErrorMessage`), not that the device has no camera.
            val kind = (failure as? CameraAccessException)?.let { QrScanLogic.accessErrorName(it.reason) }
            if (kind == null) {
                reply("unavailable")
                return@requestForApp
            }
            reply("scanning")
            event(json("kind" to "error", "error" to kind))
        }
    }

    /** `qr.cancel`: Cancel, the sheet dismissed, a payload submitted – the camera is released and says nothing more. */
    fun cancel() {
        session++
        closeCamera()
    }

    /**
     * The app left the screen while scanning: the camera is released, and the chrome hears
     * `aborted` so the sheet goes without a toast (the user did nothing wrong).
     */
    fun abort() {
        if (camera == null) return
        cancel()
        event(json("kind" to "aborted"))
    }

    /**
     * `qr.layout`: where the sheet's window is, in CSS px of the chrome's viewport, its corner
     * radius, and whether the live picture shows there now. The chrome hides it while the sheet
     * moves (a still, sent as it goes, stands in the window meanwhile) and shows it once the window
     * has held still; while shown, a still goes every [STILL_INTERVAL_MS] so the window always has
     * a recent one to fall back on. Frames are read for a code only while the window is shown
     * ([gate]): a sheet that moves – dragged, pulled by the back gesture, on its way out – reads
     * none, so a code held to the camera as the user dismisses the sheet loads nothing.
     */
    fun layout(args: JSONObject) {
        val view = preview ?: return
        val visible = args.bool("visible")
        if (!visible) {
            gate.shown = false
            if (view.shown) sendStill()
            view.shown = false
            stopStills()
            return
        }
        val rect = args.obj("rect")
        val density = activity.resources.displayMetrics.density
        val x = (rect.num("x") * density).toInt()
        val y = (rect.num("y") * density).toInt()
        val w = (rect.num("width") * density).toInt().coerceAtLeast(1)
        val h = (rect.num("height") * density).toInt().coerceAtLeast(1)
        val lp = (view.layoutParams as? FrameLayout.LayoutParams) ?: FrameLayout.LayoutParams(w, h)
        lp.leftMargin = x
        lp.topMargin = y
        lp.width = w
        lp.height = h
        view.layoutParams = lp
        view.setRadius((args.num("radius") * density).toFloat())
        view.shown = true
        gate.shown = true
        stopStills()
        main.postDelayed(stillTick, STILL_INTERVAL_MS)
    }

    /** `qr.setTorch`: the camera answers with a `torch` event once it has switched. */
    fun setTorch(on: Boolean) {
        camera?.setTorch(on)
    }

    /** `qr.openSettings`: the app's details page in Settings, where a refused camera is turned back on. */
    fun openSettings() {
        val intent = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))
        try {
            activity.startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            Log.w(TAG, "no application details screen")
        }
    }

    fun destroy() {
        cancel()
        thread?.quitSafely()
        thread = null
    }

    /** Open the camera for session `id`: null once it is opening, else what stopped it. */
    private fun open(id: Int): Throwable? {
        closeCamera()
        val view = PreviewView(activity)
        // One pixel at the corner until the chrome says where the window is: a TextureView only
        // gets its surface once it is drawn, and the camera's session needs that surface.
        root.addView(view, FrameLayout.LayoutParams(1, 1))
        preview = view
        val camera = runCatching {
            cameraFactory?.invoke(activity) ?: Camera2(activity, cameraHandler())
        }.getOrElse { e ->
            Log.w(TAG, "no camera: ${e.message}")
            closeCamera()
            return e
        }
        this.camera = camera
        val gate = QrScanLogic.FrameGate().also { this.gate = it }
        val started = runCatching { camera.start(view.texture, SessionListener(id, gate)) }
        started.exceptionOrNull()?.let { e ->
            Log.w(TAG, "the camera would not start: ${e.message}")
            closeCamera()
            return e
        }
        return null
    }

    private fun closeCamera() {
        stopStills()
        gate.shown = false
        val gone = camera
        camera = null
        runCatching { gone?.close() }
        preview?.let { root.removeView(it) }
        preview = null
    }

    private fun cameraHandler(): Handler {
        val running = thread ?: HandlerThread("zen-camera").also {
            it.start()
            thread = it
        }
        return Handler(running.looper)
    }

    private fun stopStills() = main.removeCallbacks(stillTick)

    /**
     * The window's picture as a small JPEG data URL for the chrome to show where the live one was:
     * the sheet's fall, a drag and the back gesture all move the window, and the last still moves
     * with it where the native view could only trail.
     */
    private fun sendStill() {
        val view = preview ?: return
        if (!view.texture.isAvailable || view.width < 2 || view.height < 2) return
        val scale = STILL_SIDE_PX.toFloat() / maxOf(view.width, view.height)
        val w = (view.width * scale).toInt().coerceAtLeast(1)
        val h = (view.height * scale).toInt().coerceAtLeast(1)
        val bitmap = runCatching { view.texture.getBitmap(w, h) }.getOrNull() ?: return
        val out = ByteArrayOutputStream()
        bitmap.compress(Bitmap.CompressFormat.JPEG, STILL_JPEG_QUALITY, out)
        bitmap.recycle()
        val dataUrl = "data:image/jpeg;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        event(json("kind" to "still", "dataUrl" to dataUrl))
    }

    private fun event(payload: Any?) = host.hostEvent("qr.event", payload)

    /**
     * The camera's reports for session `id`, each checked against the live session (a camera
     * keeps reporting for a moment after `close`). A frame is decoded where it arrives, on the
     * camera's thread, if the session's [gate] admits it – the window shown, the cadence kept,
     * no code found in the last [QrScanLogic.DECODE_COOL_DOWN_MS]; a code found goes to the main
     * thread as a still of the moment and the `decoded` event, unless the window has gone hidden
     * meanwhile (the fall began between the read and the report). The chrome cancels the session
     * on a payload it can act on, and a session it lets run (nothing to submit) goes on scanning
     * once the pause is over rather than firing the same code every frame.
     */
    private inner class SessionListener(private val id: Int, private val gate: QrScanLogic.FrameGate) : Listener {
        private val decoder = QrScanLogic.Decoder()

        private fun live(): Boolean = id == session && camera != null

        override fun ready(torch: Boolean) {
            if (!live()) return
            // Frames flow, so the preview's surface exists: the view may hide without losing it.
            preview?.onTextureReady()
            event(json("kind" to "ready", "torch" to torch))
        }

        override fun frame(source: LuminanceSource) {
            if (id != session) return
            val now = SystemClock.uptimeMillis()
            if (!gate.admits(now)) return
            val text = decoder.next(source) ?: return
            gate.decoded(now)
            main.post {
                if (!live() || !gate.shown) return@post
                sendStill()
                event(json("kind" to "decoded", "text" to text))
            }
        }

        override fun torch(on: Boolean) {
            if (live()) event(json("kind" to "torch", "on" to on))
        }

        override fun error(kind: String) {
            if (!live()) return
            closeCamera()
            event(json("kind" to "error", "error" to kind))
        }
    }

    /**
     * The native view over the sheet's window: a frame clipped to the window's corners around the
     * [TextureView] the camera draws into. Not clickable, so a touch on it falls through to the
     * chrome underneath (the sheet is dragged from anywhere on it). [shown] is what the chrome last
     * asked; it is honoured once the texture exists, since the view has to be drawn once, at its
     * one pixel, for the texture to come into being.
     */
    private class PreviewView(context: Context) : FrameLayout(context) {
        val texture = TextureView(context)
        private var radius = 0f
        private var textureReady = false
        var shown = false
            set(value) {
                field = value
                applyVisibility()
            }

        init {
            isClickable = false
            isFocusable = false
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
            clipToOutline = true
            outlineProvider = object : ViewOutlineProvider() {
                override fun getOutline(view: View, outline: Outline) {
                    outline.setRoundRect(0, 0, view.width, view.height, radius)
                }
            }
            addView(texture, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }

        fun setRadius(px: Float) {
            if (radius == px) return
            radius = px
            invalidateOutline()
        }

        /** The camera's listener has seen the texture: the view may now hide without losing it. */
        fun onTextureReady() {
            textureReady = true
            applyVisibility()
        }

        private fun applyVisibility() {
            val next = if (shown || !textureReady) View.VISIBLE else View.INVISIBLE
            if (visibility != next) visibility = next
        }
    }

    /**
     * The platform's back camera through camera2: the device is opened as soon as `start` is
     * called and its session made once the preview's surface exists too, with two targets – the
     * preview at a size that fills the window and a YUV_420_888 reader at a size the decoder keeps
     * pace with – on one repeating preview request with continuous focus. Frames are decoded from
     * the reader's latest image on the camera thread (older ones are dropped, never queued); the
     * preview's transform is set so the picture covers the window upright whichever way the
     * device is held. Everything runs on `handler`'s thread but the texture's callbacks, which the
     * view delivers on the main thread and which hop over.
     */
    class Camera2(private val context: Context, private val handler: Handler) : Camera {
        private val main = Handler(Looper.getMainLooper())
        private val manager = cameraManager(context)
        private var listener: Listener? = null
        private var texture: TextureView? = null
        private var device: CameraDevice? = null
        private var captureSession: CameraCaptureSession? = null
        private var reader: ImageReader? = null
        private var surfaceTexture: SurfaceTexture? = null
        private var previewSurface: Surface? = null
        private var previewSize: Pair<Int, Int> = 0 to 0
        private var sensorOrientation = 0
        private var hasTorch = false
        private var continuousFocus = false
        @Volatile private var torchOn = false
        @Volatile private var closed = false
        @Volatile private var announced = false

        // The permission was granted through Permissions.requestForApp before start is called.
        @SuppressLint("MissingPermission")
        override fun start(preview: TextureView, listener: Listener) {
            this.listener = listener
            texture = preview
            val id = backCameraId(manager) ?: throw IllegalStateException("no back camera")
            val characteristics = manager.getCameraCharacteristics(id)
            sensorOrientation = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION) ?: 0
            hasTorch = characteristics.get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true
            continuousFocus = characteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES)
                ?.contains(CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE) == true
            val map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP)
                ?: throw IllegalStateException("no stream configuration")
            val analysis = QrScanLogic.pickAnalysisSize(map.getOutputSizes(ImageFormat.YUV_420_888)?.map { it.width to it.height } ?: emptyList())
                ?: throw IllegalStateException("no YUV_420_888 size")
            val window = context.resources.displayMetrics.let { (PREVIEW_WINDOW_DP * it.density).toInt() }
            previewSize = QrScanLogic.pickPreviewSize(map.getOutputSizes(SurfaceTexture::class.java)?.map { it.width to it.height } ?: emptyList(), window)
                ?: analysis
            reader = ImageReader.newInstance(analysis.first, analysis.second, ImageFormat.YUV_420_888, 3).also {
                it.setOnImageAvailableListener({ r -> onImage(r) }, handler)
            }
            preview.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
                override fun onSurfaceTextureAvailable(surface: SurfaceTexture, width: Int, height: Int) {
                    handler.post { surfaceReady(surface) }
                    fitPreview()
                }

                override fun onSurfaceTextureSizeChanged(surface: SurfaceTexture, width: Int, height: Int) = fitPreview()

                override fun onSurfaceTextureDestroyed(surface: SurfaceTexture): Boolean = true

                override fun onSurfaceTextureUpdated(surface: SurfaceTexture) {}
            }
            if (preview.isAvailable) preview.surfaceTexture?.let { st -> handler.post { surfaceReady(st) } }
            manager.openCamera(id, deviceCallback, handler)
        }

        override fun setTorch(on: Boolean) {
            if (!hasTorch) return
            handler.post {
                if (closed || torchOn == on) return@post
                torchOn = on
                if (captureSession != null && repeat()) main.post { listener?.torch(on) }
            }
        }

        override fun close() {
            closed = true
            texture?.surfaceTextureListener = null
            texture = null
            handler.post {
                runCatching { captureSession?.close() }
                captureSession = null
                runCatching { device?.close() }
                device = null
                runCatching { reader?.close() }
                reader = null
                runCatching { previewSurface?.release() }
                previewSurface = null
                surfaceTexture = null
            }
        }

        // --- the camera thread ---------------------------------------------------------------------

        private val deviceCallback = object : CameraDevice.StateCallback() {
            override fun onOpened(camera: CameraDevice) {
                if (closed) {
                    camera.close()
                    return
                }
                device = camera
                createSession()
            }

            override fun onDisconnected(camera: CameraDevice) {
                camera.close()
                if (device === camera) device = null
                fail("disconnected")
            }

            override fun onError(camera: CameraDevice, error: Int) {
                camera.close()
                if (device === camera) device = null
                fail(QrScanLogic.errorName(error))
            }

            override fun onClosed(camera: CameraDevice) {
                if (device === camera) device = null
            }
        }

        private fun surfaceReady(surface: SurfaceTexture) {
            if (closed) return
            surfaceTexture = surface
            createSession()
        }

        /**
         * Both halves in hand – the device open, the preview's surface there – and no session yet.
         * The list-and-handler `createCaptureSession` is the one form minSdk 26 has (its
         * `SessionConfiguration` replacement is API 28).
         */
        @Suppress("DEPRECATION")
        private fun createSession() {
            val device = device ?: return
            val surface = surfaceTexture ?: return
            val reader = reader ?: return
            if (captureSession != null || closed) return
            surface.setDefaultBufferSize(previewSize.first, previewSize.second)
            val previewSurface = Surface(surface).also { this.previewSurface = it }
            main.post { fitPreview() }
            try {
                device.createCaptureSession(listOf(previewSurface, reader.surface), sessionCallback, handler)
            } catch (e: Exception) {
                Log.w(TAG, "no capture session: ${e.message}")
                fail("camera")
            }
        }

        private val sessionCallback = object : CameraCaptureSession.StateCallback() {
            override fun onConfigured(session: CameraCaptureSession) {
                if (closed) {
                    session.close()
                    return
                }
                captureSession = session
                if (!repeat()) fail("camera")
            }

            override fun onConfigureFailed(session: CameraCaptureSession) {
                session.close()
                fail("camera")
            }
        }

        /** The one repeating request: preview and reader, continuous focus, the torch as asked. */
        private fun repeat(): Boolean {
            val device = device ?: return false
            val session = captureSession ?: return false
            val previewSurface = previewSurface ?: return false
            val reader = reader ?: return false
            return try {
                val request = device.createCaptureRequest(CameraDevice.TEMPLATE_PREVIEW).apply {
                    addTarget(previewSurface)
                    addTarget(reader.surface)
                    if (continuousFocus) set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_PICTURE)
                    if (hasTorch) set(CaptureRequest.FLASH_MODE, if (torchOn) CaptureRequest.FLASH_MODE_TORCH else CaptureRequest.FLASH_MODE_OFF)
                }
                session.setRepeatingRequest(request.build(), null, handler)
                true
            } catch (e: Exception) {
                Log.w(TAG, "the repeating request failed: ${e.message}")
                false
            }
        }

        private fun onImage(reader: ImageReader) {
            val image = try {
                reader.acquireLatestImage()
            } catch (e: Exception) {
                null
            } ?: return
            try {
                if (closed) return
                if (!announced) {
                    announced = true
                    main.post { if (!closed) listener?.ready(hasTorch) }
                }
                val plane = image.planes[0]
                val source = QrScanLogic.luminanceSource(plane.buffer, image.width, image.height, plane.rowStride, plane.pixelStride)
                listener?.frame(source)
            } catch (e: Exception) {
                Log.w(TAG, "a frame was dropped: ${e.message}")
            } finally {
                image.close()
            }
        }

        private fun fail(kind: String) {
            if (closed) return
            closed = true
            main.post { listener?.error(kind) }
        }

        /** Main thread: the picture covers the view upright (see [QrScanLogic.previewFit]). */
        private fun fitPreview() {
            val view = texture ?: return
            val (bufferWidth, bufferHeight) = previewSize
            if (view.width <= 0 || view.height <= 0 || bufferWidth <= 0 || bufferHeight <= 0) return
            val fit = QrScanLogic.previewFit(view.width, view.height, bufferWidth, bufferHeight, sensorOrientation, displayRotationDegrees(context))
            val viewRect = RectF(0f, 0f, view.width.toFloat(), view.height.toFloat())
            val content = RectF(0f, 0f, fit.contentWidth.toFloat(), fit.contentHeight.toFloat())
            content.offset(viewRect.centerX() - content.centerX(), viewRect.centerY() - content.centerY())
            val matrix = Matrix()
            matrix.setRectToRect(viewRect, content, Matrix.ScaleToFit.FILL)
            matrix.postScale(fit.scale, fit.scale, viewRect.centerX(), viewRect.centerY())
            if (fit.rotation != 0) matrix.postRotate(fit.rotation.toFloat(), viewRect.centerX(), viewRect.centerY())
            view.setTransform(matrix)
        }
    }

    companion object {
        private const val TAG = "ZenQrScan"
        /** The framed target's side in CSS px (`.zen-qr-target` in the chrome), the least the preview's short side should cover. */
        private const val PREVIEW_WINDOW_DP = 264
        private const val STILL_INTERVAL_MS = 500L
        private const val STILL_SIDE_PX = 288
        private const val STILL_JPEG_QUALITY = 55

        /** Testing: builds the camera instead of the platform's (set before the activity starts). Written nowhere in `main`. */
        @Volatile
        internal var cameraFactory: ((Context) -> Camera)? = null

        /** Testing: what [available] answers instead of asking the platform. Written nowhere in `main`. */
        @Volatile
        internal var availabilityOverride: Boolean? = null

        fun cameraManager(context: Context): CameraManager = context.getSystemService(Context.CAMERA_SERVICE) as CameraManager

        /** The first camera facing away from the screen, or null when the device has none. */
        fun backCameraId(manager: CameraManager): String? = runCatching {
            manager.cameraIdList.firstOrNull { id ->
                manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK
            }
        }.getOrNull()

        /** The display's rotation from the device's natural orientation, in degrees. */
        fun displayRotationDegrees(context: Context): Int {
            val rotation = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                runCatching { context.display?.rotation }.getOrNull() ?: Surface.ROTATION_0
            } else {
                @Suppress("DEPRECATION")
                (context.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.rotation
            }
            return when (rotation) {
                Surface.ROTATION_90 -> 90
                Surface.ROTATION_180 -> 180
                Surface.ROTATION_270 -> 270
                else -> 0
            }
        }
    }
}
