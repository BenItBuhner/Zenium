package app.zen.chromium

import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.Rect
import android.graphics.drawable.Drawable
import android.os.Build
import androidx.annotation.ColorInt
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.pow
import kotlin.math.sin

/**
 * The chrome's corner, drawn natively. `main.css` declares `--zen-corner: squircle` once and a
 * card of radius 8 and up carries it as `corner-shape: var(--zen-corner)` beside its radius token
 * (#575: the `.zen-message` cards among them); CSS Borders 4 defines `squircle` as
 * `superellipse(2)` – the curve |x|^n + |y|^n = 1 in the corner's box with n = 2^2 = 4 (`round` is
 * `superellipse(1)`, n = 2, the circular arc). The geometry here is pure numbers, so
 * `V2TokensPinTest` holds it to the stylesheet's keyword and to the curve on the JVM;
 * [SquircleRectDrawable] draws it. A control of radius 6 stays a circle: the squircle goes on
 * radius 8 and up, as the stylesheet has it.
 */
object Squircle {
    /** `corner-shape`'s keywords as the exponent n of |x|^n + |y|^n = 1: `superellipse(K)` is n = 2^K. */
    fun exponent(cornerShape: String): Double = when (cornerShape.trim()) {
        "round" -> 2.0
        "squircle" -> 4.0
        else -> error("corner-shape $cornerShape is not a shape the native card draws")
    }

    /** `--zen-corner`'s `squircle`: n = 4. */
    const val EXPONENT = 4.0

    /**
     * Line segments per corner. At 16 the polyline stays within 0.11 % of the radius of the curve
     * – 0.024 px on the card's 8 dp at a Pixel 6's 2.625 density (0.016 px at the demo display's
     * 1.75), a fortieth of a pixel.
     */
    const val SEGMENTS = 16

    /**
     * A point of the corner's curve in its r × r box, measured from the box's inner corner (the
     * centre of curvature): the superellipse's parametrisation x = r·cos^(2/n) θ, y = r·sin^(2/n) θ,
     * θ from 0 (on the horizontal edge, (r, 0)) to π/2 (on the vertical edge, (0, r)), on the curve
     * exactly at every θ. At 45° x = y = r / 2^(1/n): 0.841 r for the squircle, where the circular
     * arc has 0.707 r.
     */
    fun point(radius: Float, theta: Double, exponent: Double = EXPONENT): Pair<Float, Float> {
        val e = 2.0 / exponent
        val x = radius * abs(cos(theta)).pow(e)
        val y = radius * abs(sin(theta)).pow(e)
        return x.toFloat() to y.toFloat()
    }

    /** The corner's polyline: [segments] + 1 points from (r, 0) to (0, r), evenly spaced in θ. */
    fun corner(radius: Float, exponent: Double = EXPONENT, segments: Int = SEGMENTS): List<Pair<Float, Float>> =
        (0..segments).map { point(radius, Math.PI / 2 * it / segments, exponent) }

    /**
     * The rectangle [left], [top], [right], [bottom] with four squircle corners of [radius] (capped
     * at half the shorter side) into [path], replacing what it held: clockwise from the top edge's
     * start, each corner the same samples turned into its quadrant.
     */
    fun roundRect(path: Path, left: Float, top: Float, right: Float, bottom: Float, radius: Float, exponent: Double = EXPONENT) {
        path.rewind()
        val r = radius.coerceIn(0f, minOf(right - left, bottom - top) / 2f)
        if (r <= 0f) {
            path.addRect(left, top, right, bottom, Path.Direction.CW)
            return
        }
        // The samples run from the horizontal edge (r, 0) to the vertical edge (0, r).
        val c = corner(r, exponent)
        path.moveTo(left + r, top)
        path.lineTo(right - r, top)
        // Top right: from the top edge down to the right edge – the samples reversed, mirrored up.
        for (i in c.indices.reversed()) path.lineTo(right - r + c[i].first, top + r - c[i].second)
        path.lineTo(right, bottom - r)
        // Bottom right: from the right edge to the bottom edge.
        for ((x, y) in c) path.lineTo(right - r + x, bottom - r + y)
        path.lineTo(left + r, bottom)
        // Bottom left: from the bottom edge up to the left edge.
        for (i in c.indices.reversed()) path.lineTo(left + r - c[i].first, bottom - r + c[i].second)
        path.lineTo(left, top + r)
        // Top left: from the left edge to the top edge.
        for ((x, y) in c) path.lineTo(left + r - x, top + r - y)
        path.close()
    }
}

/**
 * A card on the squircle corner: the fill on the outer path, the hairline stroked INSIDE it –
 * its centre half a hairline in, its width the hairline, so it occupies the band the chrome's
 * `1px solid` border does over the fill (`background-clip: border-box`; the `GradientDrawable`
 * this replaces drew its fill inset by half the stroke, the stroke's outer half over the page) –
 * and the outline the outer path, so a view's elevation shadow follows the corner. (A
 * `GradientDrawable` reports a zero-alpha outline when its stroke's alpha differs from its fill's,
 * as the hairline's does – the ink at 15 % over an opaque panel – so a card on one cast no shadow
 * at all; this one carries the fill's alpha, and the 2 dp shadow shows.) The corner geometry is
 * [Squircle]'s.
 */
class SquircleRectDrawable(
    /** The corner's radius in px; capped at half the shorter side. */
    private val radius: Float,
    /** The hairline's width in px ([PromptSheetSpec.hairlinePx]); 0 draws none. */
    private val hairline: Int,
    @ColorInt fill: Int,
    @ColorInt border: Int
) : Drawable() {
    private val outer = Path()
    private val edge = Path()
    private val fillPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
        color = fill
    }
    private val edgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = hairline.toFloat()
        color = border
    }
    private val fillAlpha = fillPaint.alpha
    private val edgeAlpha = edgePaint.alpha

    override fun onBoundsChange(bounds: Rect) {
        super.onBoundsChange(bounds)
        Squircle.roundRect(outer, bounds.left.toFloat(), bounds.top.toFloat(), bounds.right.toFloat(), bounds.bottom.toFloat(), radius)
        val half = hairline / 2f
        Squircle.roundRect(edge, bounds.left + half, bounds.top + half, bounds.right - half, bounds.bottom - half, maxOf(0f, radius - half))
    }

    override fun draw(canvas: Canvas) {
        canvas.drawPath(outer, fillPaint)
        if (hairline > 0) canvas.drawPath(edge, edgePaint)
    }

    /** The outer squircle, at the fill's opacity: what the elevation shadow is cast from. */
    override fun getOutline(outline: Outline) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) outline.setPath(outer)
        else @Suppress("DEPRECATION") outline.setConvexPath(outer)
        outline.alpha = fillPaint.alpha / 255f
    }

    override fun setAlpha(alpha: Int) {
        fillPaint.alpha = fillAlpha * alpha / 255
        edgePaint.alpha = edgeAlpha * alpha / 255
        invalidateSelf()
    }

    override fun getAlpha(): Int = if (fillAlpha == 0) 0 else fillPaint.alpha * 255 / fillAlpha

    override fun setColorFilter(colorFilter: ColorFilter?) {
        fillPaint.colorFilter = colorFilter
        edgePaint.colorFilter = colorFilter
        invalidateSelf()
    }

    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = PixelFormat.TRANSLUCENT
}
