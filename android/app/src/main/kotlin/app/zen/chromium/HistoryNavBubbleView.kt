package app.zen.chromium

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.view.MotionEvent
import android.view.View
import android.view.ViewOutlineProvider
import android.view.animation.PathInterpolator
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * One frame of the history navigation bubble as the chrome laid it (`chrome.historyNavBubble`,
 * from `HistoryNavBubble.tsx` off `lib/historyNav.ts`'s machine), in device px of the window:
 * the disc's box at scale 1, its scale about its centre, its opacity, and whether letting go
 * would navigate. Null means the bubble is down.
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
    /** The arrow takes the accent (Chrome's `NavigationBubble.setImageTint`). */
    val armed: Boolean,
    /** Motion is reduced: an opacity change fades over 120 ms; the box still follows the finger (v2 §11.3). */
    val reduced: Boolean
) {
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
                args.optBoolean("reduced", false)
            )
        }
    }
}

/**
 * The history navigation bubble (GN-04) as a view above the pages. The page WebViews are layered
 * above the chrome's ([TabHost.create] appends them to the root the chrome sits at the bottom
 * of; `ContentCover.kt`), so the disc the chrome lays out at a page's side could never show
 * through a page – as Chrome's own bubble is a view above the content (`HistoryNavigationLayout`
 * added to the content's parent, `SideSlideLayout` holding the `NavigationBubble`), this one is
 * added above the root, and draws what the chrome's disc draws: a 44 dp disc of the panel token
 * with the hairline and the panel's shadow, round a 32 dp arrow (lucide's `arrow-left` /
 * `arrow-right` at stroke 1.75, as `.zen-histnav-glyph svg` sets it) in the deemphasised ink,
 * with the accent copy coming up over it in 250 ms once letting go would navigate (Chrome's
 * `NavigationBubble` tint, `COLOR_TRANSITION_DURATION_MS`). The chrome's machine drives it per
 * frame ([apply]) on translation, scale and alpha alone; the accent's fade is the landmark's, not
 * a frame's. Touches pass through it, and it is nothing to accessibility, as the DOM disc is
 * (`pointer-events: none`, `aria-hidden`).
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
    private val ink = glyphPaint()
    private val accent = glyphPaint()
    private var accentColor = 0
    private val glyph = Path()
    private var edge = HistoryNavClassifier.Edge.LEFT
    private var sizePx = 0
    private var armed = false
    /** The accent copy's opacity, 0 … 1, on its own 250 ms fade. */
    private var accentAlpha = 0f
    private var accentFade: ValueAnimator? = null
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

    /** The theme in force: the panel, the hairline, the deemphasised ink and the accent (the chrome's live pair). */
    fun retint(tokens: V2Ink) {
        fill.color = tokens.panel
        border.color = tokens.border
        ink.color = tokens.textDeemphasized
        accentColor = tokens.accent
        accent.color = accentColor
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
        setArmed(frame.armed)
    }

    private fun hide() {
        animate().cancel()
        fading = false
        accentFade?.cancel()
        accentFade = null
        accentAlpha = 0f
        armed = false
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

    /** Crossing the threshold either way: the accent copy comes up, or goes, over 250 ms from where it is. */
    private fun setArmed(next: Boolean) {
        if (next == armed) return
        armed = next
        accentFade?.cancel()
        accentFade = ValueAnimator.ofFloat(accentAlpha, if (next) 1f else 0f).apply {
            duration = ACCENT_FADE_MS
            interpolator = EASE
            addUpdateListener {
                accentAlpha = it.animatedValue as Float
                invalidate()
            }
            start()
        }
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
        val stroke = GLYPH_STROKE * unit
        ink.strokeWidth = stroke
        accent.strokeWidth = stroke
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
        if (accentAlpha > 0f) {
            accent.alpha = (accentAlpha * Color.alpha(accentColor)).roundToInt()
            canvas.drawPath(glyph, accent)
        }
    }

    /** The disc takes no touch: the finger under it is the page's drag (`pointer-events: none`). */
    override fun onTouchEvent(event: MotionEvent): Boolean = false

    private fun glyphPaint(): Paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        // lucide's defaults: round caps and joins.
        strokeCap = Paint.Cap.ROUND
        strokeJoin = Paint.Join.ROUND
    }

    companion object {
        /** `.zen-histnav-disc`'s `border: 1px`. */
        private const val BORDER_DP = 1f
        /** `.zen-histnav-glyph svg`: 32 px, `stroke-width: 1.75`, on lucide's 24-unit viewBox. */
        private const val GLYPH_DP = 32f
        private const val GLYPH_GRID = 24f
        private const val GLYPH_STROKE = 1.75f
        /** `.zen-histnav-accent`'s `transition: opacity 250ms` (Chrome's `COLOR_TRANSITION_DURATION_MS`). */
        private const val ACCENT_FADE_MS = 250L
        /** `.zen-histnav[data-reduced] .zen-histnav-disc`'s `transition: opacity 120ms` (`REDUCED_FADE_MS`). */
        private const val REDUCED_FADE_MS = 120L
        /** The elevation standing in for `--v2-shadow-panel`'s `0 2px 6px rgb(0 0 0 / 0.2)`. */
        private const val SHADOW_ELEVATION_DP = 3f
        /** `--zen-ease`: `cubic-bezier(0.2, 0.8, 0.2, 1)`. */
        private val EASE = PathInterpolator(0.2f, 0.8f, 0.2f, 1f)
    }
}
