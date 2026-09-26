package app.zen.chromium

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.WriterException
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import kotlin.math.roundToInt

/**
 * The QR code sheet's model (SH-06), pure so the JVM tests reach it: what the share sheet's "QR
 * code" encodes for the chrome's sheet (`qr.code`: the code's modules as rows) and how Download
 * composes the picture it keeps – Chrome 152's `QrCodeShareMediator.addUrlToBitmap`: the link
 * written above the code on white, the code 200 dp on a side, 50 dp of white at either side, 70 dp
 * above the text and 25 dp between the text and the code, the same band under the code so it sits
 * centred; the file `chrome_qrcode_<millis>` there, `zenium_qrcode_<millis>.png` here. The
 * drawing itself (`Canvas`, `StaticLayout`) is `Share.composeQrPicture`.
 */
object QrCodeLogic {
    /** Chrome's `QrCodeShareMediator.MAX_URL_LENGTH`: a longer link gets the too-long message in the code's place. */
    const val MAX_URL_LENGTH = 2331

    /** `qr.code`'s `error` for a link longer than [MAX_URL_LENGTH]. */
    const val ERROR_TOO_LONG = "too-long"
    /** `qr.code`'s `error` when the encoder refused the link (a payload no QR version holds). */
    const val ERROR_FAILED = "failed"

    /** Chrome's `qr_code_filename_prefix` is `chrome_qrcode_`; the file is the prefix and the wall-clock millis. */
    const val FILE_PREFIX = "zenium_qrcode_"
    const val MIME = "image/png"

    // Chrome's dimens (`chrome/browser/share/android/java/res/values/dimens.xml`), in dp.
    const val CODE_DP = 200
    const val SIDE_PADDING_DP = 50
    const val URL_TOP_PADDING_DP = 70
    const val URL_BOTTOM_PADDING_DP = 25
    /** Chrome's `text_size_large`, the link's size, in sp. */
    const val URL_TEXT_SP = 16f
    /** The link is at most two lines, the second ellipsised (Chrome's `FixedLineCountLayout`). */
    const val URL_MAX_LINES = 2

    /** The saved picture's name: the prefix and `nowMs`, a PNG. */
    fun fileName(nowMs: Long): String = "$FILE_PREFIX$nowMs.png"

    /** What `qr.code` carries: the modules as rows, or the error in their place. */
    data class Code(val rows: List<String>, val error: String?) {
        val ok: Boolean get() = error == null
    }

    /**
     * The link as a code for the chrome to draw: rows of `1` (dark) and `0` (light), the two-module
     * quiet zone included, or no rows and why – too long past [MAX_URL_LENGTH] (Chrome checks the
     * length before encoding), or refused by the encoder.
     */
    fun codeFor(url: String): Code {
        if (url.length > MAX_URL_LENGTH) return Code(emptyList(), ERROR_TOO_LONG)
        val matrix = encode(url) ?: return Code(emptyList(), ERROR_FAILED)
        return Code(rows(matrix), null)
    }

    /**
     * The bare module matrix (error correction M, a two-module quiet zone) – a width and height of
     * 0 ask ZXing for the code's own size, one module per cell; null when the payload does not fit
     * any version.
     */
    fun encode(text: String): BitMatrix? {
        val hints = mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 2)
        return try {
            QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, 0, 0, hints)
        } catch (e: WriterException) {
            null
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    /** The matrix as rows of `1` and `0`, top to bottom. */
    fun rows(matrix: BitMatrix): List<String> = List(matrix.height) { y ->
        buildString(matrix.width) { for (x in 0 until matrix.width) append(if (matrix.get(x, y)) '1' else '0') }
    }

    /**
     * Where everything goes in the saved picture, in px: the canvas, the text's box (as wide as the
     * code, `textTop` down from the top edge) and the code's square under it, all from Chrome's
     * dp values at `density` and the measured `textHeightPx` of the link's lines.
     */
    data class Composition(
        val width: Int,
        val height: Int,
        val sidePadding: Int,
        val textTop: Int,
        val textWidth: Int,
        val codeSize: Int,
        val codeTop: Int
    ) {
        val codeLeft: Int get() = sidePadding
        val textLeft: Int get() = sidePadding
    }

    fun composition(density: Float, textHeightPx: Int): Composition {
        fun dp(value: Int): Int = (value * density).roundToInt()
        val codeSize = dp(CODE_DP)
        val side = dp(SIDE_PADDING_DP)
        val top = dp(URL_TOP_PADDING_DP)
        val bottom = dp(URL_BOTTOM_PADDING_DP)
        val band = top + textHeightPx + bottom
        return Composition(
            width = codeSize + side * 2,
            height = band * 2 + codeSize,
            sidePadding = side,
            textTop = top,
            textWidth = codeSize,
            codeSize = codeSize,
            codeTop = band
        )
    }
}
