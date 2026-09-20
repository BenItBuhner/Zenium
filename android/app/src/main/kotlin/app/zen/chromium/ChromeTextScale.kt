package app.zen.chromium

import android.content.res.Configuration
import android.content.res.Resources
import android.os.Build
import android.util.TypedValue
import kotlin.math.roundToInt

/**
 * The chrome's text follows the system font size and the bold-text setting (A11Y-05).
 *
 * The chrome is designed in CSS px (v2 §4: 13 / 15 / 17 / 22 on fixed line boxes). The WebView's
 * `textZoom` grows the text alone – no length, glyph or control box moves with it – and the chrome
 * grows its line boxes (and the rows built on them) by the same factor through `--zen-text-zoom`
 * (`lib/textScale.ts`), which the host reports as `environment.textZoom` next to `fontScale`.
 *
 * Android 14 scales text non-linearly (`FontScaleConverter`: small text grows more than large,
 * 30 sp hardly at all). One zoom applies to the whole chrome, so the factor is what the system
 * does to the chrome's body size, 15 sp, read through `TypedValue.applyDimension`, which routes
 * through the converter on API 34+ and is `fontScale` itself below (linear).
 */
object ChromeTextScale {
    /** The chrome's body text size (`--v2-font-body`), the size the zoom is exact for. */
    const val BODY_SP = 15f

    /** What `WebSettings.textZoom` is allowed to take from here: half size to three times. */
    const val MIN_PERCENT = 50
    const val MAX_PERCENT = 300

    /** The bold-text setting's weight adjustment (Android 12+): 0 when off or unknown, 300 when on. */
    fun fontWeightAdjustment(config: Configuration): Int {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return 0
        val adjustment = config.fontWeightAdjustment
        return if (adjustment == Configuration.FONT_WEIGHT_ADJUSTMENT_UNDEFINED) 0 else adjustment
    }

    /** `WebSettings.textZoom` for the configuration behind `resources`: 100 at the default size. */
    fun textZoomPercent(resources: Resources): Int {
        val metrics = resources.displayMetrics
        val bodyPx = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, BODY_SP, metrics)
        return textZoomPercent(bodyPx / metrics.density)
    }

    /** The zoom percent that renders [BODY_SP] at `bodyDp` (the body size as the system scales it). */
    fun textZoomPercent(bodyDp: Float): Int =
        (bodyDp / BODY_SP * 100).roundToInt().coerceIn(MIN_PERCENT, MAX_PERCENT)

    /** The factor the chrome hears (`environment.textZoom`): the percent it is drawn at, over 100. */
    fun zoomFactor(percent: Int): Double = percent / 100.0
}
