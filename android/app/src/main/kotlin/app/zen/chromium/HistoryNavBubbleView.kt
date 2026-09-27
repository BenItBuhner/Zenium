package app.zen.chromium

import android.content.Context
import android.graphics.Canvas
import android.graphics.Outline
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.util.Log
import android.util.TypedValue
import android.view.HapticFeedbackConstants
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
    /** Motion is reduced: the leave fades over 120 ms and nothing else animates; the box still follows the finger (v2 §11.3, §11.9). */
    val reduced: Boolean,
    /**
     * The page frame's box: the disc is drawn only inside it, as the DOM disc under the frame's
     * `overflow: hidden` – it comes out from beyond the frame's side, not over the gutter between
     * the frame and the window's edge. Null when the chrome sent none: unclipped.
     */
    val clip: Clip?,
    /**
     * How far the caption's pill is out of the disc, 0 (a disc) to 1 (the whole caption): Chrome's
     * 'Close tab' / 'Close Chrome' indicator at the history's first page, shown while the drag is
     * armed (`SideSlideLayout.showCaption` while `mWillNavigate`). 0 whenever [captionText] is null.
     */
    val caption: Float = 0f,
    /** The caption's text as the chrome words it; null: the drag has none (a page turn, a forward drag). */
    val captionText: String? = null
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
            // A caption is a text: an extent without one, or a blank, is a disc.
            val captionText = args.strOrNull("captionText")?.takeIf { it.isNotBlank() }
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
                },
                if (captionText == null) 0f else args.num("caption", 0.0).toFloat().coerceIn(0f, 1f),
                captionText
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
 *
 * The threshold's tap is the layer's too: Chrome's `SideSlideLayout.pull()` performs
 * `HapticFeedbackConstants.KEYBOARD_TAP` on its own view as `willNavigate()` turns true
 * (152.0.7977.89, l.345–351), and this layer performs the same constant on the frame whose
 * `armed` comes on ([BubbleThresholdTap]) – the disc's full frame and the tap are one message
 * from the chrome, as they are one `pull()` in Chrome. The chrome's own `haptic` tick stands
 * only where no host draws the disc (`lib/historyNav.ts`).
 */
class HistoryNavBubbleLayer(context: Context) : FrameLayout(context) {
    /** The disc itself; the layer moves nothing – the disc rides its own translation, scale and alpha. */
    val disc = HistoryNavBubbleView(context)
    /** The clip as last set, so a frame carrying the same box (every frame of a drag) sets nothing. */
    private var clip: HistoryNavBubbleFrame.Clip? = null
    private val tap = BubbleThresholdTap()

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
        if (tap.take(frame?.armed)) {
            Log.d(TAG, "history threshold: KEYBOARD_TAP (${frame?.edge})")
            performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP)
        }
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

    companion object {
        /** `TabWebView`'s tag for the gesture's own lines (`history start / release on …`), so one filter reads the drag whole. */
        private const val TAG = "ZenPull"
    }
}

/**
 * When the threshold taps the finger, on the frames the chrome sends: Chrome performs
 * `KEYBOARD_TAP` each time `willNavigate()` turns true (`SideSlideLayout.pull()`, l.345–351) –
 * once per rising crossing, not on every frame past the threshold, and again if the finger eases
 * back under it and crosses once more; nothing on the way back and nothing at the release. The
 * crossing is the frame whose `armed` is on after one whose was off; a null frame (the bubble
 * down) leaves the next drag to start unarmed. A plain class, so the JVM holds it without the view.
 */
class BubbleThresholdTap {
    private var armed = false

    /** The frame's armed flag in (null: the bubble is down); whether this frame taps. */
    fun take(frameArmed: Boolean?): Boolean {
        val now = frameArmed ?: false
        val fires = now && !armed
        armed = now
        return fires
    }
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
 *
 * At the history's first page the armed disc widens into a pill with Chrome's caption – 'Close
 * tab' / 'Close Zenium', as the chrome words it (`NavigationBubble.showCaption`; the
 * `TextView` after the arrow in `navigation_bubble.xml`) – by the frame's caption extent: the
 * pill's far end runs out from the disc on the chrome's spring, the arrow staying where it is,
 * the text revealed inside as the pill opens over it ([captionGeometry]). The scale stays about
 * the disc's centre. The text is the badge's type (v2 §9.19: 13/600) in the text ink, a
 * hair-gap from the arrow and the pill's end padding beyond it (`CAPTION_*`).
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
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, CAPTION_SP, resources.displayMetrics)
        typeface = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(Typeface.DEFAULT, CAPTION_WEIGHT, false)
            else Typeface.DEFAULT_BOLD
    }
    private val glyph = Path()
    private val pill = RectF()
    private var edge = HistoryNavClassifier.Edge.LEFT
    private var sizePx = 0
    /** The caption as last drawn: its text, its measured advance beyond the disc, and how far out it is. */
    private var captionText: String? = null
    private var captionAdvance = 0f
    private var caption = 0f
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
                // The pill as far as it is out: a disc at rest, so the shadow follows the shape.
                val radius = view.height / 2f
                outline.setRoundRect(0, 0, pillWidth().roundToInt().coerceAtLeast(view.height), view.height, radius)
            }
        }
        retint(V2Ink(context, dark = false))
    }

    /** The theme in force: the panel, the hairline and the text ink (the chrome's live pair). */
    fun retint(tokens: V2Ink) {
        fill.color = tokens.panel
        border.color = tokens.border
        ink.color = tokens.text
        text.color = tokens.text
        invalidate()
    }

    /** One frame from the chrome; null takes the bubble down at once. */
    fun apply(frame: HistoryNavBubbleFrame?) {
        if (frame == null) {
            hide()
            return
        }
        var relayout = false
        if (frame.sizePx != sizePx || frame.edge != edge) {
            sizePx = frame.sizePx
            edge = frame.edge
            // The scale is about the disc's centre whatever the pill's width.
            pivotX = sizePx / 2f
            pivotY = sizePx / 2f
            buildGlyph()
            relayout = true
        }
        if (frame.captionText != captionText || relayout) {
            captionText = frame.captionText
            captionAdvance = captionText?.let {
                captionGeometry(sizePx, text.measureText(it), density).advance
            } ?: 0f
            relayout = true
        }
        if (relayout) {
            requestLayout()
            invalidateOutline()
            invalidate()
        }
        if (frame.caption != caption) {
            caption = frame.caption
            // The pill's far end moved: the one redraw a drag asks for, on the caption's frames alone.
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

    /** The pill's width right now: the disc, plus the caption's advance as far as it is out. */
    private fun pillWidth(): Float = sizePx + caption * captionAdvance

    /** The caption as drawn, for the harness (`GesturesDemo`): its text, how far out it is, and the pill's width in px. */
    val shownCaption: ShownCaption get() = ShownCaption(captionText, caption, pillWidth())

    class ShownCaption(val text: String?, val extent: Float, val pillWidthPx: Float) {
        override fun toString(): String = "caption=${text?.let { "'$it'" } ?: "none"} extent=${"%.2f".format(extent)} pill=${"%.0f".format(pillWidthPx)}px"
    }

    private fun hide() {
        animate().cancel()
        fading = false
        alpha = 0f
        scaleX = 1f
        scaleY = 1f
        visibility = GONE
    }

    /** The frame's opacity: set outright, save reduced motion's leave, the one 120 ms fade ([bubbleAlphaStep]). */
    private fun setShown(target: Float, reduced: Boolean) {
        when (bubbleAlphaStep(reduced, target, alpha, fading)) {
            BubbleAlphaStep.KEEP -> Unit
            BubbleAlphaStep.FADE -> {
                fading = true
                animate().alpha(0f).setDuration(REDUCED_FADE_MS).setInterpolator(EASE).start()
            }
            BubbleAlphaStep.SET -> {
                if (fading) {
                    animate().cancel()
                    fading = false
                }
                alpha = target
            }
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
        ink.strokeWidth = GLYPH_STROKE * unit
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // The view is as wide as the pill would be whole; what is drawn is as far as it is out.
        setMeasuredDimension((sizePx + captionAdvance).roundToInt(), sizePx)
    }

    override fun onDraw(canvas: Canvas) {
        val radius = height / 2f
        val pillWidth = pillWidth()
        pill.set(0f, 0f, pillWidth, height.toFloat())
        canvas.drawRoundRect(pill, radius, radius, fill)
        // The hairline sits inside the pill's box, as a `border` inside a `border-box` does.
        val inset = border.strokeWidth / 2f
        pill.inset(inset, inset)
        canvas.drawRoundRect(pill, radius - inset, radius - inset, border)
        canvas.drawPath(glyph, ink)
        val caption = captionText
        if (caption != null && this.caption > 0f) {
            val geometry = captionGeometry(sizePx, text.measureText(caption), density)
            // Revealed as the pill opens over it: nothing of it past the pill's end padding.
            canvas.save()
            canvas.clipRect(0f, 0f, pillWidth - CAPTION_END_DP * density, height.toFloat())
            val baseline = height / 2f - (text.ascent() + text.descent()) / 2f
            canvas.drawText(caption, geometry.textX, baseline, text)
            canvas.restore()
        }
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
        /** The caption's type: the badge's 13/600 (v2 §9.19; `.zen-histnav-caption`). */
        private const val CAPTION_SP = 13f
        private const val CAPTION_WEIGHT = 600
        /** The pill's end padding beyond the text (`.zen-histnav-caption`'s `padding-inline: 0 12px`). */
        const val CAPTION_END_DP = 12f
        /** The gap from the arrow's box to the text's start. */
        const val CAPTION_GAP_DP = 6f
    }
}

/**
 * Where the caption sits in the pill (device px): the text starts [textX] in – past the disc's
 * centre, the arrow's half-box and the gap – and the pill runs [advance] beyond the disc when the
 * caption is whole: the text and the end padding past its start.
 */
data class CaptionGeometry(val textX: Float, val advance: Float)

/** The caption's geometry for a disc of `sizePx` and a text `textWidthPx` wide, at `density`. A top-level function the JVM holds without the view. */
fun captionGeometry(sizePx: Int, textWidthPx: Float, density: Float): CaptionGeometry {
    val textX = sizePx / 2f + (GLYPH_BOX_DP / 2f + HistoryNavBubbleView.CAPTION_GAP_DP) * density
    val advance = textX + textWidthPx + HistoryNavBubbleView.CAPTION_END_DP * density - sizePx
    return CaptionGeometry(textX, advance.coerceAtLeast(0f))
}

/** The arrow's box: v2 §11.9's 20 (`GLYPH_DP`), the caption measured from its far side. */
private const val GLYPH_BOX_DP = 20f

/** What a frame's opacity does to the disc ([bubbleAlphaStep]). */
enum class BubbleAlphaStep {
    /** Set outright, a fade that runs cancelled first. */
    SET,
    /** Start the one 120 ms fade to nothing: reduced motion's leave. */
    FADE,
    /** The fade to nothing already runs; a further frame at nothing restarts nothing. */
    KEEP
}

/**
 * The disc's opacity per frame. With motion on every frame is set outright – the chrome's
 * spring is the animation. Under reduced motion the box still follows the finger and the
 * opacity is set outright too, the fade-in over the first 16 px of the drag included; the one
 * thing animated is the LEAVE – the frame that takes a showing disc to nothing, which the
 * chrome's machine sends whole in a single frame – as the 120 ms fade v2 §11.9 gives reduced
 * motion for its leave (the DOM disc's `transition: opacity 120ms`). One fade per leave: a
 * frame at nothing while it runs is kept, a frame that shows the disc again cuts it and sets.
 * A top-level function, so the JVM can hold it without the view (its interpolator is a stub).
 */
fun bubbleAlphaStep(reduced: Boolean, target: Float, alpha: Float, fading: Boolean): BubbleAlphaStep = when {
    !reduced -> BubbleAlphaStep.SET
    target > 0f -> BubbleAlphaStep.SET
    fading -> BubbleAlphaStep.KEEP
    alpha > 0f -> BubbleAlphaStep.FADE
    else -> BubbleAlphaStep.SET
}
