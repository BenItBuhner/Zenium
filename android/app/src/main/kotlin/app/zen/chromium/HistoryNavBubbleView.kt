package app.zen.chromium

import android.content.Context
import android.graphics.Canvas
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * One frame of the history navigation bubble as the chrome laid it (`chrome.historyNavBubble`,
 * from `HistoryNavBubble.tsx` off `lib/historyNav.ts`'s machine), in device px of the window:
 * the disc's box at scale 1, its scale about its centre, its opacity, whether letting go would
 * navigate, and the page frame's box it is clipped to. Null means the bubble is down.
 */
class HistoryNavBubbleFrame(
    val edge: HistoryNavClassifier.Edge,
    /** The disc's left side and top, at scale 1. */
    val leftPx: Float,
    val topPx: Float,
    /** The disc's diameter at scale 1 (the chrome's 44 dp, Chrome's `navigation_bubble_size`). */
    val sizePx: Int,
    val scale: Float,
    val alpha: Float,
    /**
     * Letting go would navigate – the drag's state as the chrome sends it. The disc draws no mark
     * of its own for it (v2 §11.9: the threshold shows as the full disc and the haptic).
     */
    val armed: Boolean,
    /** Motion is reduced: an opacity change fades over 120 ms; the box still follows the finger (v2 §11.3). */
    val reduced: Boolean,
    /**
     * The page frame's box: the disc is drawn only inside it, as the DOM disc under the frame's
     * `overflow: hidden` – it comes out from beyond the frame's side, not over the gutter between
     * the frame and the window's edge. Null when the chrome sent none: unclipped.
     */
    val clip: Clip?
) {
    /** A box in device px (a plain value: `android.graphics.Rect` is a stub on the JVM, the layer makes one of it). */
    data class Clip(val left: Int, val top: Int, val right: Int, val bottom: Int) {
        fun toRect(): Rect = Rect(left, top, right, bottom)
    }

    companion object {
        /** `chrome.historyNavBubble`'s arguments (CSS px) → device px; null for `{ visible: false }`. */
        fun parse(args: JSONObject, density: Float): HistoryNavBubbleFrame? {
            if (!args.optBoolean("visible", true)) return null
            val size = (args.num("size") * density).roundToInt()
            if (size <= 0) return null
            return HistoryNavBubbleFrame(
                if (args.str("edge", "left") == "right") HistoryNavClassifier.Edge.RIGHT else HistoryNavClassifier.Edge.LEFT,
                (args.num("left") * density).toFloat(),
                (args.num("top") * density).toFloat(),
                size,
                args.num("scale", 1.0).toFloat().coerceAtLeast(0f),
                args.num("opacity", 1.0).toFloat().coerceIn(0f, 1f),
                args.optBoolean("armed", false),
                args.optBoolean("reduced", false),
                args.optJSONObject("clip")?.let { clip ->
                    val left = (clip.num("left") * density).roundToInt()
                    val top = (clip.num("top") * density).roundToInt()
                    val right = (clip.num("right") * density).roundToInt()
                    val bottom = (clip.num("bottom") * density).roundToInt()
                    // An empty box is no clip.
                    if (right > left && bottom > top) Clip(left, top, right, bottom) else null
                }
            )
        }
    }
}

/**
 * The layer the bubble's disc rides in, laid over the whole window above the pages
 * ([MainActivity]): it clips the disc to the page frame's box the chrome sends with each frame,
 * as the frame's `overflow: hidden` clips the DOM disc, so the disc comes out from beyond the
 * frame's side and nothing of it shows over the gutter to the window's edge or a sidebar. Gone
 * while the bubble is down, so an idle window pays nothing for it; touches pass through it as
 * through the disc.
 */
class HistoryNavBubbleLayer(context: Context) : FrameLayout(context) {
    /** The disc itself; the layer moves nothing – the disc rides its own translation, scale and alpha. */
    val disc = HistoryNavBubbleView(context)
    /** The clip as last set, so a frame carrying the same box (every frame of a drag) sets nothing. */
    private var clip: HistoryNavBubbleFrame.Clip? = null

    init {
        visibility = GONE
        isClickable = false
        isFocusable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
        addView(disc, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    }

    /** One frame from the chrome; null takes the bubble down. */
    fun apply(frame: HistoryNavBubbleFrame?) {
        disc.apply(frame)
        if (frame == null) {
            visibility = GONE
            clip = null
            clipBounds = null
            return
        }
        // A property of the render node, no redraw: set when the box differs (once per drag).
        if (frame.clip != clip) {
            clip = frame.clip
            clipBounds = frame.clip?.toRect()
        }
        if (visibility != VISIBLE) visibility = VISIBLE
    }

    fun retint(tokens: V2Ink) = disc.retint(tokens)

    /** The layer takes no touch: what is under it is the page's. */
    override fun onTouchEvent(event: MotionEvent): Boolean = false
}

/**
 * The history navigation bubble (GN-04) as a view above the pages. The page WebViews are layered
 * above the chrome's ([TabHost.create] appends them to the root the chrome sits at the bottom
 * of; `ContentCover.kt`), so the disc the chrome lays out at a page's side could never show
 * through a page – as Chrome's own bubble is a view above the content (`HistoryNavigationLayout`
 * added to the content's parent, `SideSlideLayout` holding the `NavigationBubble`), this one is
 * added above the root, and draws what the chrome's disc draws (v2 §11.9): a 44 dp disc of the
 * panel token with the hairline and the panel's shadow, round a 20 dp arrow (lucide's
 * `arrow-left` / `arrow-right` at stroke 1.75, as `.zen-histnav-glyph svg` sets it) in the text
 * ink. The chrome's machine drives it per frame ([apply]) on translation, scale and alpha alone
 * – the disc grows from .6 to full on the chrome's spring as the drag approaches the threshold,
 * and the threshold itself shows as the full disc and the haptic, no tint. Touches pass through
 * it, and it is nothing to accessibility, as the DOM disc is (`pointer-events: none`,
 * `aria-hidden`).
 *
 * The colours are the v2 tokens through [V2Ink] (`V2TokensPinTest` holds them to the CSS); the
 * shadow is the view's elevation over the disc's outline, the platform's approximation of
 * `--v2-shadow-panel` (`0 2px 6px rgb(0 0 0 / 0.2)`).
 */
class HistoryNavBubbleView(context: Context) : View(context) {
    private val density = resources.displayMetrics.density
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.FILL }
    private val border = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = BORDER_DP * density
    }
    private val ink = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        // lucide's defaults: round caps and joins.
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }
    private val glyph = Path()
    private var edge = HistoryNavClassifier.Edge.LEFT
    private var sizePx = 0
    /** An opacity fade under reduced motion is running on the view's animator. */
    private var fading = false

    init {
        visibility = GONE
        isClickable = false
        isFocusable = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO
        elevation = SHADOW_ELEVATION_DP * density
        outlineProvider = object : ViewOutlineProvider() {
            override fun getOutline(view: View, outline: Outline) {
                outline.setOval(0, 0, view.width, view.height)
            }
        }
        retint(V2Ink(context, dark = false))
    }

    /** The theme in force: the panel, the hairline and the text ink (the chrome's live pair). */
    fun retint(tokens: V2Ink) {
        fill.color = tokens.panel
        border.color = tokens.border
        ink.color = tokens.text
        invalidate()
    }

    /** One frame from the chrome; null takes the bubble down at once. */
    fun apply(frame: HistoryNavBubbleFrame?) {
        if (frame == null) {
            hide()
            return
        }
        if (frame.sizePx != sizePx || frame.edge != edge) {
            sizePx = frame.sizePx
            edge = frame.edge
            buildGlyph()
            requestLayout()
            invalidateOutline()
            invalidate()
        }
        translationX = frame.leftPx
        translationY = frame.topPx
        scaleX = frame.scale
        scaleY = frame.scale
        setShown(frame.alpha, frame.reduced)
        if (visibility != VISIBLE) visibility = VISIBLE
    }

    private fun hide() {
        animate().cancel()
        fading = false
        alpha = 0f
        scaleX = 1f
        scaleY = 1f
        visibility = GONE
    }

    /** The frame's opacity: set outright, or under reduced motion faded to over 120 ms as the DOM disc's transition. */
    private fun setShown(target: Float, reduced: Boolean) {
        if (reduced) {
            fading = true
            animate().alpha(target).setDuration(REDUCED_FADE_MS).setInterpolator(EASE).start()
            return
        }
        if (fading) {
            animate().cancel()
            fading = false
        }
        alpha = target
    }

    /** Lucide's arrow in the glyph box centred on the disc: two strokes, the shaft and the head, in the icon's 24-unit grid. */
    private fun buildGlyph() {
        glyph.reset()
        val unit = GLYPH_DP * density / GLYPH_GRID
        val origin = (sizePx - GLYPH_DP * density) / 2f
        fun at(x: Float, y: Float): Pair<Float, Float> = origin + x * unit to origin + y * unit
        fun move(x: Float, y: Float) = at(x, y).let { (px, py) -> glyph.moveTo(px, py) }
        fun line(x: Float, y: Float) = at(x, y).let { (px, py) -> glyph.lineTo(px, py) }
        when (edge) {
            // lucide `arrow-left`: `M19 12H5` and `m12 19-7-7 7-7`.
            HistoryNavClassifier.Edge.LEFT -> {
                move(19f, 12f); line(5f, 12f)
                move(12f, 19f); line(5f, 12f); line(12f, 5f)
            }
            // lucide `arrow-right`: `M5 12h14` and `m12 5 7 7-7 7`.
            HistoryNavClassifier.Edge.RIGHT -> {
                move(5f, 12f); line(19f, 12f)
                move(12f, 5f); line(19f, 12f); line(12f, 19f)
            }
        }
        ink.strokeWidth = GLYPH_STROKE * unit
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        setMeasuredDimension(sizePx, sizePx)
    }

    override fun onDraw(canvas: Canvas) {
        val radius = width / 2f
        canvas.drawCircle(radius, radius, radius, fill)
        // The hairline sits inside the disc's box, as a `border` inside a `border-box` does.
        canvas.drawCircle(radius, radius, radius - border.strokeWidth / 2f, border)
        canvas.drawPath(glyph, ink)
    }

    /** The disc takes no touch: the finger under it is the page's drag (`pointer-events: none`). */
    override fun onTouchEvent(event: MotionEvent): Boolean = false

    companion object {
        /** `.zen-histnav-disc`'s `border: 1px`. */
        private const val BORDER_DP = 1f
        /** `.zen-histnav-glyph svg`: v2 §11.9's 20 px, `stroke-width: 1.75`, on lucide's 24-unit viewBox. */
        private const val GLYPH_DP = 20f
        private const val GLYPH_GRID = 24f
        private const val GLYPH_STROKE = 1.75f
        /** `.zen-histnav[data-reduced] .zen-histnav-disc`'s `transition: opacity 120ms` (`REDUCED_FADE_MS`). */
        private const val REDUCED_FADE_MS = 120L
        /** The elevation standing in for `--v2-shadow-panel`'s `0 2px 6px rgb(0 0 0 / 0.2)`. */
        private const val SHADOW_ELEVATION_DP = 3f
        /** `--zen-ease`: `cubic-bezier(0.2, 0.8, 0.2, 1)`. */
        private val EASE = PathInterpolator(0.2f, 0.8f, 0.2f, 1f)
    }
}
