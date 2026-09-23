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
 * The hairline round a native phone sheet, over the panel fill the sheet style paints: one open
 * path up the left side, round the two top radii, down the right side – the top and the sides,
 * as `.zen-sheet`'s `border: 1px` with `border-bottom: 0` – and no run along the bottom, where a
 * bottom sheet meets the screen's edge. The stroke lies inside the bounds, its outer edge on the
 * sheet's radius, [hairline] px wide – [PromptSheetSpec.hairlinePx], one dp, never the one
 * physical pixel a `setStroke(1, …)` would draw on all four sides. The one edge for the app's
 * native sheets: the prompt chassis ([NativePromptSheet]) and the custom tab's menu
 * ([CustomTabMenuSheet]) draw it.
 *
 * The edge lifted out of [NativePromptSheet] (where it was that sheet's private inner drawable) so
 * the custom tab's menu can draw the same one. The sides end at the bounds' bottom: how far the
 * bounds reach under a host's bottom inset – the gesture bar, the three-button bar – is the view's
 * to settle, and the extension program's round 10 settles it (the edge running through the inset
 * with the inset as the carrying view's padding); this file is that class's forward-compatible
 * stand-in at its path, the same name and constructor, and yields to it when that lands.
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
        val half = hairline / 2f
        // The stroke's centre line: half a stroke in from the edge, its radius the sheet's less that half.
        val r = (radius - half).coerceAtLeast(0f)
        val left = bounds.left + half
        val right = bounds.right - half
        val top = bounds.top + half
        val bottom = bounds.bottom.toFloat()
        path.reset()
        path.moveTo(left, bottom)
        path.lineTo(left, top + r)
        path.arcTo(left, top, left + 2 * r, top + 2 * r, 180f, 90f, false)
        path.lineTo(right - r, top)
        path.arcTo(right - 2 * r, top, right, top + 2 * r, 270f, 90f, false)
        path.lineTo(right, bottom)
    }

    override fun draw(canvas: Canvas) = canvas.drawPath(path, paint)
    override fun setAlpha(alpha: Int) { paint.alpha = alpha }
    override fun setColorFilter(colorFilter: ColorFilter?) { paint.colorFilter = colorFilter }
    @Deprecated("Deprecated in Java") override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
