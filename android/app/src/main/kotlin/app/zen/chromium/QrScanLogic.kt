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
 * The scanner's pure half (OMN-22, NTP-03): what `QrScan.kt` decides without a camera in hand,
 * kept apart so the JVM tests can hold it – the luminance-plane adapter between camera2's
 * YUV_420_888 frames and ZXing, the decode itself, the frame sizes picked from what a camera
 * offers, the preview's fit on its window and the grant's name for the chrome.
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
     * The QR code in a frame as text, or null when the frame holds none. QR codes only (the
     * parity target is a code that opens its URL or searches its text; 1D product codes would
     * only ever be a number to search, and read wrong more often than they read right on a live
     * frame). The frame is read as it is and then inverted – a light code on a dark screen – with
     * the adaptive binarizer, which holds up under the uneven light a camera sees. A decode that
     * carries no text counts as none.
     */
    fun decode(source: LuminanceSource): String? = decodeOnce(source) ?: decodeOnce(source.invert())

    private fun decodeOnce(source: LuminanceSource): String? = try {
        QRCodeReader().decode(BinaryBitmap(HybridBinarizer(source)), HINTS).text?.takeIf { it.isNotEmpty() }
    } catch (e: ReaderException) {
        null
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

    /** `CameraDevice.StateCallback.ERROR_CAMERA_IN_USE` and `ERROR_MAX_CAMERAS_IN_USE`, spelled out for the JVM tests. */
    const val ERROR_CAMERA_IN_USE = 1
    const val ERROR_MAX_CAMERAS_IN_USE = 2

    const val ANALYSIS_MIN_SHORT = 480
    const val ANALYSIS_MAX_LONG = 1280
    const val PREVIEW_MAX_LONG = 1920

    /** No hints: the reader guesses a byte segment's charset (UTF-8, Shift-JIS, Latin-1) or takes the code's ECI. */
    private val HINTS: Map<DecodeHintType, Any> = emptyMap()
}
