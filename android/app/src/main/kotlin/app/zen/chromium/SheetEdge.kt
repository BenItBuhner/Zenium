package app.zen.chromium

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.Drawable
import android.view.View
import androidx.annotation.ColorInt
import androidx.core.view.WindowInsetsCompat

/**
 * The hairline round a v2 sheet (`.zen-sheet`'s `border: 1px solid var(--v2-border)` with
 * `border-bottom: 0`), over the panel fill the sheet style paints: one open path up the left
 * side, round the two top radii, down the right side – the top and the sides – and no run along
 * the bottom, where a bottom sheet meets the screen's edge. The stroke lies inside the bounds,
 * its outer edge on the sheet's radius, [PromptSheetSpec.hairlinePx] wide (one dp in whole
 * pixels, as the chrome's 1 CSS px). The one edge for every native sheet – the prompt sheet
 * ([NativePromptSheet]) and the extension surfaces' sheet (`ExtensionSheet`) – so the pin that
 * holds the prompt sheet to main.css holds the extension sheet too.
 *
 * The sides run through the host's bottom inset – the gesture bar, the three-button bar, the
 * keyboard over them – to the screen's bottom, as `.zen-sheet`'s border runs under the safe area
 * the chassis pads for inside it: the view carrying the edge gives it bounds that reach the
 * screen's bottom and takes the inset as its own bottom padding ([getPadding], kept current by
 * [inset]), so its content stops above the bar while the path ends at the bounds' bottom. The
 * sheet style pads nothing for the bar under these sheets (`Widget.Zen.Sheet`'s
 * `paddingBottomSystemWindowInsets`); were it to, the bounds would stop at the inset and the
 * sides would end a bar's height above the panel fill's edge.
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

    /**
     * The host's bottom inset in device pixels, as the window last reported it ([inset]); zero
     * until it does. The bottom padding of the view carrying the edge, never a shortening of the
     * path: the sides end at the bounds' bottom whatever the inset.
     */
    var inset: Int = 0
        private set

    /**
     * The padding the view carrying the edge takes from its background: none at the top or the
     * sides (content sits inside the hairline by its own margins, as inside a CSS border box), the
     * host's [inset] at the bottom, so the content stops above the bar and the bounds keep it.
     */
    override fun getPadding(padding: Rect): Boolean {
        padding.set(0, 0, 0, inset)
        return true
    }

    /**
     * The window's insets for [view], the view carrying this edge as its background: its bottom
     * padding follows the host's inset ([hostInset]) – a background's padding is read once, when
     * the background is set, so the view is padded here – and the view lays out again, its content
     * up by the inset and its bounds, with the edge's sides, at the screen's bottom.
     */
    fun inset(view: View, insets: WindowInsetsCompat) {
        val value = hostInset(insets)
        if (inset == value) return
        inset = value
        view.setPadding(view.paddingLeft, view.paddingTop, view.paddingRight, value)
        invalidateSelf()
    }

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

    /**
     * Where a sheet whose bounds reach the screen's bottom over a host [inset] ends: the edge at
     * the bounds' bottom itself ([edgeBottom], through the inset), the content the inset above it
     * ([contentBottom]), the inset the padding the view keeps ([padding]).
     */
    class Geometry(boundsBottom: Float, inset: Int) {
        val padding: Int = inset.coerceAtLeast(0)
        val edgeBottom: Float = boundsBottom
        val contentBottom: Float = boundsBottom - padding
    }

    companion object {
        /** The centre line of a [hairline]-wide stroke inside `[left, top, right, bottom]` at the sheet's [radius]. */
        fun outline(left: Float, top: Float, right: Float, bottom: Float, hairline: Int, radius: Int): Outline {
            val half = hairline / 2f
            return Outline(left + half, top + half, right - half, bottom, (radius - half).coerceAtLeast(0f))
        }

        /** The edge's end and the content's over a host [inset], for bounds reaching [boundsBottom] (the screen's). */
        fun geometry(boundsBottom: Float, inset: Int): Geometry = Geometry(boundsBottom, inset)

        /**
         * The host's bottom inset in the window's insets: the system-window inset, which is the
         * navigation bar (gesture or three-button) and, under `adjustResize` (the mode the Material
         * sheet theme sets), the keyboard over it – the quantity the Material sheet's behavior pads
         * its container by where its style asks it to, taken here by the sheet's own column instead.
         */
        @Suppress("DEPRECATION")
        fun hostInset(insets: WindowInsetsCompat): Int = insets.systemWindowInsetBottom.coerceAtLeast(0)
    }
}
