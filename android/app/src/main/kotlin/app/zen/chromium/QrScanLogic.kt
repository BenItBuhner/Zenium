package app.zen.chromium

import com.google.zxing.BinaryBitmap
import com.google.zxing.DecodeHintType
import com.google.zxing.LuminanceSource
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.ReaderException
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import java.nio.ByteBuffer

/**
 * The scanner's pure half (OMN-22, NTP-04): what `QrScan.kt` decides without a camera in hand,
 * kept apart so the JVM tests can hold it – the luminance-plane adapter between camera2's
 * YUV_420_888 frames and ZXing, the decode itself and its cadence ([Decoder], [FrameGate]), the
 * frame sizes picked from what a camera offers, the preview's fit on its window and the names
 * the chrome knows the grant and the camera's errors by.
 */
object QrScanLogic {
    /** The chrome's `QrStartOutcome` for a grant: the camera opens on a grant, a refusal is named. */
    fun outcome(grant: RuntimeGrant): String = when (grant) {
        RuntimeGrant.GRANTED -> "scanning"
        RuntimeGrant.DENIED -> "denied"
        RuntimeGrant.DENIED_PERMANENTLY -> "denied-permanently"
    }

    /**
     * A YUV_420_888 frame's luminance plane as ZXing reads it. The Y plane is one byte per pixel
     * with rows `rowStride` bytes apart (the stride runs past the width on most devices, and the
     * buffer's last row stops at the width rather than at the stride), so the source is told the
     * stride as its data width and the frame as the crop inside it, and the copy is padded to a
     * whole last row so the source's bounds hold. A plane whose pixels are not adjacent
     * (`pixelStride` above 1: no device reports it for the Y plane, but the format allows it) is
     * repacked tight. The buffer is read from its start whatever its position, and left as it was.
     */
    fun luminanceSource(plane: ByteBuffer, width: Int, height: Int, rowStride: Int, pixelStride: Int): PlanarYUVLuminanceSource {
        require(width > 0 && height > 0) { "an empty frame ($width x $height)" }
        require(pixelStride >= 1 && rowStride >= width * pixelStride) { "stride $rowStride/$pixelStride under a width of $width" }
        val source = plane.duplicate()
        source.rewind()
        if (pixelStride == 1) {
            val data = ByteArray(rowStride * height)
            source.get(data, 0, minOf(source.remaining(), data.size))
            return PlanarYUVLuminanceSource(data, rowStride, height, 0, 0, width, height, false)
        }
        val data = ByteArray(width * height)
        val limit = source.limit()
        for (y in 0 until height) {
            val row = y * rowStride
            val out = y * width
            for (x in 0 until width) {
                val i = row + x * pixelStride
                if (i < limit) data[out + x] = source.get(i)
            }
        }
        return PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false)
    }

    /**
     * The QR code in a frame as text, or null when the frame holds none, read both ways (as it
     * is, then inverted). One frame on its own – the tests' form; a session's stream goes through
     * a [Decoder], which spaces the inverted reads out.
     */
    fun decode(source: LuminanceSource): String? = Decoder().decode(source, inverted = true)

    /**
     * The reader over a session's frames, one per camera thread. QR codes only (the parity
     * target is a code that opens its URL or searches its text; 1D product codes would only ever
     * be a number to search, and read wrong more often than they read right on a live frame),
     * through the adaptive binarizer, which holds up under the uneven light a camera sees. A
     * frame is read as it is; every [INVERTED_EVERY]th frame is read inverted too – a light code
     * on a dark screen is the rare case, and the second read doubles what a frame with no code in
     * it costs, the common case while the sheet is up. One [QRCodeReader] serves every read (it
     * keeps its detector's state; a new one per frame was allocation for nothing). A decode that
     * carries no text counts as none.
     */
    class Decoder {
        private val reader = QRCodeReader()
        private var reads = 0

        /** The next frame of the stream. */
        fun next(source: LuminanceSource): String? = decode(source, inverted = ++reads % INVERTED_EVERY == 0)

        /** One frame, read as it is and – when `inverted` – inverted too. */
        fun decode(source: LuminanceSource, inverted: Boolean): String? =
            read(source) ?: if (inverted) read(source.invert()) else null

        private fun read(source: LuminanceSource): String? = try {
            reader.decode(BinaryBitmap(HybridBinarizer(source)), HINTS).text?.takeIf { it.isNotEmpty() }
        } catch (e: ReaderException) {
            null
        } finally {
            reader.reset()
        }
    }

    /**
     * Whether a frame that arrived is read at all. Frames are read only while the window shows
     * the live picture ([shown], what the chrome's `qr.layout visible` last said: a hidden window
     * is the sheet's rise, a finger on the sheet, a sheet stacked above it or the sheet on its way
     * out, and a code held to the camera through any of those is not the user asking for it), at
     * most one every [DECODE_INTERVAL_MS] (the camera streams at 30 fps and more; a read every
     * other frame finds a code as fast as a hand can hold one still, at half the CPU), and none
     * for [DECODE_COOL_DOWN_MS] after a code was found (the chrome ends the session on a payload
     * it can act on; one it lets run goes on scanning once the pause is over rather than firing
     * the same code every frame). Written on the main thread and read on the camera's.
     */
    class FrameGate {
        @Volatile var shown = false
        @Volatile private var nextReadAt = 0L

        /** Whether the frame at `now` (uptime ms) is read; the next read is booked when it is. */
        fun admits(now: Long): Boolean {
            if (!shown || now < nextReadAt) return false
            nextReadAt = now + DECODE_INTERVAL_MS
            return true
        }

        /** A code was found at `now`: nothing is read for the cool-down. */
        fun decoded(now: Long) {
            nextReadAt = now + DECODE_COOL_DOWN_MS
        }
    }

    /**
     * The frame size the decoder reads, from the sizes a camera offers for YUV_420_888: the
     * smallest whose shorter side reaches [ANALYSIS_MIN_SHORT] (a code a fifth of the frame wide
     * then keeps modules of a few pixels) within [ANALYSIS_MAX_LONG] on the longer side (the decode
     * has to keep pace with the stream), else the largest under that cap, else the smallest of all.
     */
    fun pickAnalysisSize(sizes: List<Pair<Int, Int>>): Pair<Int, Int>? = pick(sizes, ANALYSIS_MIN_SHORT, ANALYSIS_MAX_LONG)

    /**
     * The preview's buffer size, from the sizes a camera offers a surface texture: the smallest
     * whose shorter side covers the window's longer side in pixels (the picture is cropped to a
     * square, so its shorter side is what has to fill the window), within [PREVIEW_MAX_LONG].
     */
    fun pickPreviewSize(sizes: List<Pair<Int, Int>>, windowPx: Int): Pair<Int, Int>? = pick(sizes, windowPx, PREVIEW_MAX_LONG)

    private fun pick(sizes: List<Pair<Int, Int>>, minShort: Int, maxLong: Int): Pair<Int, Int>? {
        if (sizes.isEmpty()) return null
        val capped = sizes.filter { (w, h) -> maxOf(w, h) <= maxLong }
        capped.filter { (w, h) -> minOf(w, h) >= minShort }.minByOrNull { (w, h) -> w * h }?.let { return it }
        capped.maxByOrNull { (w, h) -> w * h }?.let { return it }
        return sizes.minByOrNull { (w, h) -> w * h }
    }

    /**
     * How the preview's buffer is laid on its window: the buffer's sides as the display shows
     * them in the device's natural orientation ([contentWidth] x [contentHeight]: swapped when the
     * sensor is mounted across it), the turn that keeps the picture upright once the device is
     * rotated ([rotation], degrees clockwise), and the one [scale] about the window's centre that
     * covers the window with the picture cropped rather than squeezed.
     */
    class Fit(val contentWidth: Int, val contentHeight: Int, val scale: Float, val rotation: Int)

    fun previewFit(
        viewWidth: Int,
        viewHeight: Int,
        bufferWidth: Int,
        bufferHeight: Int,
        sensorOrientation: Int,
        displayRotationDegrees: Int
    ): Fit {
        val swapped = sensorOrientation % 180 != 0
        val contentWidth = if (swapped) bufferHeight else bufferWidth
        val contentHeight = if (swapped) bufferWidth else bufferHeight
        val rotation = ((360 - displayRotationDegrees) % 360 + 360) % 360
        val turned = rotation % 180 != 0
        val shownWidth = if (turned) contentHeight else contentWidth
        val shownHeight = if (turned) contentWidth else contentHeight
        val scale = if (viewWidth <= 0 || viewHeight <= 0 || shownWidth <= 0 || shownHeight <= 0) 1f
            else maxOf(viewWidth.toFloat() / shownWidth, viewHeight.toFloat() / shownHeight)
        return Fit(contentWidth, contentHeight, scale, rotation)
    }

    /** The name the chrome knows a camera2 device error by (`QrError` in `src/shared/qrScan.ts`). */
    fun errorName(cameraDeviceError: Int): String = when (cameraDeviceError) {
        ERROR_CAMERA_IN_USE, ERROR_MAX_CAMERAS_IN_USE -> "busy"
        else -> "camera"
    }

    /**
     * The name the chrome knows a `CameraAccessException` thrown by `openCamera` itself by, from
     * its `reason`: the camera held by another app (thrown before any callback on some devices)
     * is `busy`; disabled by policy, in error or gone is `camera` – it did not start, whatever the
     * cause, and that is what the toast should say rather than "not available on this device".
     */
    fun accessErrorName(reason: Int): String = when (reason) {
        ACCESS_CAMERA_IN_USE, ACCESS_MAX_CAMERAS_IN_USE -> "busy"
        else -> "camera"
    }

    /** `CameraDevice.StateCallback.ERROR_CAMERA_IN_USE` and `ERROR_MAX_CAMERAS_IN_USE`, spelled out for the JVM tests. */
    const val ERROR_CAMERA_IN_USE = 1
    const val ERROR_MAX_CAMERAS_IN_USE = 2
    /** `CameraAccessException.CAMERA_IN_USE` and `MAX_CAMERAS_IN_USE` (`CAMERA_DISABLED` 1, `CAMERA_DISCONNECTED` 2, `CAMERA_ERROR` 3), spelled out for the JVM tests. */
    const val ACCESS_CAMERA_IN_USE = 4
    const val ACCESS_MAX_CAMERAS_IN_USE = 5

    const val ANALYSIS_MIN_SHORT = 480
    const val ANALYSIS_MAX_LONG = 1280
    const val PREVIEW_MAX_LONG = 1920
    /** The least between two reads of the stream: every other frame of a 30 fps camera. */
    const val DECODE_INTERVAL_MS = 66L
    /** The pause after a code was found. */
    const val DECODE_COOL_DOWN_MS = 1_500L
    /** Every so many reads is tried inverted too. */
    const val INVERTED_EVERY = 3

    /** No hints: the reader guesses a byte segment's charset (UTF-8, Shift-JIS, Latin-1) or takes the code's ECI. */
    private val HINTS: Map<DecodeHintType, Any> = emptyMap()
}
