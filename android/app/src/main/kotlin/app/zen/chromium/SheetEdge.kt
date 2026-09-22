package app.zen.chromium

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.Drawable
import androidx.annotation.ColorInt

/**
 * The hairline round a v2 sheet (`.zen-sheet`'s `border: 1px solid var(--v2-border)` with
 * `border-bottom: 0`), over the panel fill the sheet style paints: one open path up the left
 * side, round the two top radii, down the right side – the top and the sides – and no run along
 * the bottom, where a bottom sheet meets the screen's edge. The stroke lies inside the bounds,
 * its outer edge on the sheet's radius, [PromptSheetSpec.hairlinePx] wide (one dp in whole
 * pixels, as the chrome's 1 CSS px). The one edge for every native sheet – the prompt sheet
 * ([NativePromptSheet]) and the extension surfaces' sheet (`ExtensionSheet`) – so the pin that
 * holds the prompt sheet to main.css holds the extension sheet too.
 */
class SheetEdge(
    /** The stroke in device pixels ([PromptSheetSpec.hairlinePx] at the screen's density). */
    private val hairline: Int,
    /** The sheet's top radius in device pixels ([PromptSheetSpec.SHEET_RADIUS_DP] at the density). */
    private val radius: Int,
    /** The border ink ([V2Ink.border]). */
    @ColorInt color: Int
) : Drawable() {
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = hairline.toFloat()
        this.color = color
    }
    private val path = Path()

    override fun onBoundsChange(bounds: Rect) {
        val o = outline(bounds.left.toFloat(), bounds.top.toFloat(), bounds.right.toFloat(), bounds.bottom.toFloat(), hairline, radius)
        path.reset()
        path.moveTo(o.left, o.bottom)
        path.lineTo(o.left, o.top + o.radius)
        path.arcTo(o.left, o.top, o.left + 2 * o.radius, o.top + 2 * o.radius, 180f, 90f, false)
        path.lineTo(o.right - o.radius, o.top)
        path.arcTo(o.right - 2 * o.radius, o.top, o.right, o.top + 2 * o.radius, 270f, 90f, false)
        path.lineTo(o.right, o.bottom)
    }

    override fun draw(canvas: Canvas) = canvas.drawPath(path, paint)
    override fun setAlpha(alpha: Int) { paint.alpha = alpha }
    override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter }
    @Deprecated("Deprecated in Java") override fun getOpacity(): Int = PixelFormat.TRANSLUCENT

    /**
     * The stroke's centre line: [left] and [right] half a stroke in from the bounds' sides, [top]
     * half a stroke under the bounds' top, [bottom] the bounds' bottom itself (the sides run to
     * the edge and stop: no bottom run), and the arcs' [radius] the sheet's less that half, so the
     * stroke's outer edge sits on the sheet's own radius.
     */
    class Outline(val left: Float, val top: Float, val right: Float, val bottom: Float, val radius: Float) {
        /** The open path's corners in drawing order, bottom-left up and round to bottom-right. */
        fun corners(): List<Pair<Float, Float>> = listOf(
            left to bottom,
            left to top + radius,
            left + radius to top,
            right - radius to top,
            right to top + radius,
            right to bottom
        )
    }

    companion object {
        /** The centre line of a [hairline]-wide stroke inside `[left, top, right, bottom]` at the sheet's [radius]. */
        fun outline(left: Float, top: Float, right: Float, bottom: Float, hairline: Int, radius: Int): Outline {
            val half = hairline / 2f
            return Outline(left + half, top + half, right - half, bottom, (radius - half).coerceAtLeast(0f))
        }
    }
}
