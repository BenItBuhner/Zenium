package app.zen.chromium

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.ViewOutlineProvider
import android.view.animation.PathInterpolator
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.widget.TextViewCompat
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The tab hover card's numbers (design language v2 §9.20's panel at §9.31's numbers; the
 * chrome's `.zen-tab-hover-card` in main.css and `placeHoverCard` in lib/hoverCard.ts). The
 * desktop card's form, drawn here by the host: a 320 panel at the card radius on the chrome's
 * corner, the block padding inside the hairline, the page's picture in a 16:10 box at the
 * content width above the title (tabs-19), the title on two lines at most at the body size, the
 * host and the state lines at the small size de-emphasised. Each constant names the token or
 * rule it copies; `TabHoverCardSpecTest` pins them to the stylesheet.
 */
object TabHoverCardSpec {
    /** `POPOVER_WIDTH.list` (§9.20): the card's outer width. */
    const val WIDTH_DP = 320
    /** `--v2-radius-card`, the card's `border-radius: 8px` on `corner-shape: var(--zen-corner)` (the squircle). */
    const val RADIUS_DP = 8
    /** `.zen-tab-hover-card { padding: 16px }`, the block padding (`PromptSheetSpec.BLOCK_PADDING_DP`). */
    const val PADDING_DP = PromptSheetSpec.BLOCK_PADDING_DP
    /** `--v2-shadow-panel`, `0 2px 6px rgb(0 0 0 / 0.2)`: the card's elevation is the shadow's offset. */
    const val SHADOW_Y_DP = 2
    /** `.zen-tab-hover-card-preview`: the picture's box at the content width, 16:10, `margin-bottom: 12px`. */
    const val PREVIEW_ASPECT = 10f / 16f
    const val PREVIEW_GAP_DP = 12
    /** `--v2-radius-inner`: the picture's box at r6, a plain round corner (§2 keeps the squircle for 8 and up). */
    const val PREVIEW_RADIUS_DP = PromptSheetSpec.CONTROL_RADIUS_DP
    /** `.zen-tab-hover-card-title`: `-webkit-line-clamp: 2`. */
    const val TITLE_LINES = 2
    /** `.zen-tab-hover-card-meta { margin-top: 4px }`. */
    const val META_GAP_DP = 4
    /** `POPOVER_MARGIN`: how close the card may come to the window's edges. */
    const val MARGIN_DP = 8
    /** `POPOVER_HEIGHT_FLOOR`: the least height a card shrinks to before it flips above its row. */
    const val HEIGHT_FLOOR_DP = 160
    /** `zen-animate-pop`: `zen-pop 180ms var(--zen-ease)` from `scale(0.94)` at opacity 0. */
    const val POP_MS = 180L
    const val POP_SCALE = 0.94f
    /** The reduced-motion fade in place (§11.3): 120 ms of opacity alone. */
    const val FADE_MS = 120L

    /** `--zen-ease: cubic-bezier(0.2, 0.8, 0.2, 1)`. */
    val EASE = floatArrayOf(0.2f, 0.8f, 0.2f, 1f)
}

/**
 * `chrome.hoverCard`'s frame (from lib/hoverCard.ts, CSS px of the chrome's window) read into
 * device px: the row's box, its list's box – the sidebar, or the strip's band with the axis
 * turned – the window's size, and the card's text as the desktop card renders it. Null for
 * `{ visible: false }`, the card down.
 */
data class TabHoverCardFrame(
    val tabId: String,
    val title: String,
    /** The second line, the page's site as the URL pill shows it; "" for a blank tab. */
    val host: String,
    /** The state lines the row's tooltip carried (sleeping, muted, an agent's). */
    val lines: List<String>,
    /** Whether the card pictures the page: a background tab with a view; the host reads its own picture of it. */
    val preview: Boolean,
    /** The tab's document, the picture's stamp. */
    val url: String,
    val anchor: Box,
    val sidebar: Box,
    /** The row is on the strip along the caption band (§9.37): the card hangs under the band. */
    val axisX: Boolean,
    val viewportWidth: Float,
    val viewportHeight: Float,
    /** Raised by keyboard focus rather than the pointer. */
    val byFocus: Boolean
) {
    /** A box in device px (a plain value: `android.graphics.RectF` is a stub on the JVM). */
    data class Box(val x: Float, val y: Float, val width: Float, val height: Float)

    companion object {
        fun parse(args: JSONObject, density: Float): TabHoverCardFrame? {
            if (!args.optBoolean("visible", true)) return null
            val tabId = args.strOrNull("tabId") ?: return null
            val anchor = args.optJSONObject("anchor")?.let { box(it, density) } ?: return null
            val sidebar = args.optJSONObject("sidebar")?.let { box(it, density) } ?: return null
            val viewport = args.optJSONObject("viewport")
            val lines = ArrayList<String>()
            val raw = args.optJSONArray("lines")
            if (raw != null) for (i in 0 until raw.length()) raw.optString(i).takeIf { it.isNotEmpty() }?.let(lines::add)
            return TabHoverCardFrame(
                tabId,
                args.str("title"),
                args.str("host"),
                lines,
                args.optBoolean("preview", false),
                args.str("url"),
                anchor,
                sidebar,
                args.strOrNull("axis") == "x",
                (viewport?.num("width") ?: 0.0).toFloat() * density,
                (viewport?.num("height") ?: 0.0).toFloat() * density,
                args.strOrNull("by") == "focus"
            )
        }

        private fun box(o: JSONObject, density: Float) = Box(
            (o.num("x") * density).toFloat(),
            (o.num("y") * density).toFloat(),
            (o.num("width") * density).toFloat(),
            (o.num("height") * density).toFloat()
        )
    }
}

/**
 * Where the card goes, `placeHoverCard`'s rule (lib/hoverCard.ts) in device px: flush against
 * the sidebar's inner edge (gap 0), on whichever side the page is, start-aligned with its row –
 * top edges together – and clamped against the window as §9.20 clamps a popover, with the
 * margin and in the same order: a card that would cross the bottom margin flips above –
 * end-aligned, its bottom edge on the row's – when there is more room above than below (or the
 * room below is under the floor); otherwise it stays and shrinks to the room left. A card wider
 * than the window minus two margins shrinks to that. With the rows along the caption band
 * (`axisX`, §9.37) the same rule turned: flush under the band, left edges together with its
 * tab, slid back inside the window's margin, the room down to the bottom margin.
 *
 * Pure, so `TabHoverCardPlacementTest` walks the same cases as the chrome's `placeHoverCard`
 * tests at one px per dp.
 */
object TabHoverCardPlacement {
    enum class Side { BELOW, ABOVE }

    /**
     * The card's box: `top` for a card hanging below (its top edge), `bottom` for one flipped
     * above – the distance from the window's bottom edge to the row's bottom, as the chrome pins
     * a flipped popover by `bottom` so a card shorter than [maxHeight] still ends on the row.
     */
    data class Placement(
        val side: Side,
        val left: Float,
        val top: Float,
        val bottom: Float,
        val width: Float,
        val maxHeight: Float
    ) {
        /** The card's top edge for a card [height] tall (capped at [maxHeight]) in a window [viewportHeight] tall. */
        fun topFor(height: Float, viewportHeight: Float): Float =
            if (side == Side.BELOW) top else viewportHeight - bottom - min(height, maxHeight)
    }

    fun place(
        anchor: TabHoverCardFrame.Box,
        sidebar: TabHoverCardFrame.Box,
        viewportWidth: Float,
        viewportHeight: Float,
        cardWidth: Float,
        cardHeight: Float,
        axisX: Boolean,
        margin: Float,
        floor: Float
    ): Placement {
        val width = max(0f, min(cardWidth, viewportWidth - 2 * margin))
        if (axisX) {
            val top = max(margin, sidebar.y + sidebar.height)
            val left = min(max(margin, anchor.x), max(margin, viewportWidth - width - margin))
            val room = max(0f, viewportHeight - margin - top)
            return Placement(Side.BELOW, left, top, 0f, width, min(cardHeight, room))
        }
        val onRight = sidebar.x + sidebar.width / 2 > viewportWidth / 2
        val flush = if (onRight) sidebar.x - width else sidebar.x + sidebar.width
        val left = min(max(margin, flush), max(margin, viewportWidth - width - margin))

        val edge = max(0f, viewportHeight - 2 * margin)
        val wanted = max(0f, min(cardHeight, edge))
        val top = max(margin, anchor.y)
        val bottom = max(margin, viewportHeight - (anchor.y + anchor.height))
        val below = max(0f, viewportHeight - margin - top)
        val above = max(0f, viewportHeight - margin - bottom)
        val side = if (wanted <= below) Side.BELOW else if (above > below || below < floor) Side.ABOVE else Side.BELOW
        val maxHeight = min(wanted, if (side == Side.BELOW) below else above)
        return if (side == Side.BELOW) Placement(side, left, top, 0f, width, maxHeight)
        else Placement(side, left, 0f, bottom, width, maxHeight)
    }
}

/**
 * The layer the host draws the tab hover card in, laid over the whole window above the pages
 * and under the fullscreen layer ([Host]): the desktop card's form, where the chrome says
 * (TABLET-05; Chrome's tablet strip hover card, `TabHoverCardView.java`: title, domain and the
 * page's thumbnail – no memory line on this chassis). Made on the first frame and never before
 * (the cold-start rule), gone while the card is down so an idle window pays nothing for it;
 * it takes no touch, no hover and no focus – what is under it is the page's – and the pointer
 * that raised it rests on a row, never on the card. The chrome keeps the card's machine
 * (lib/hoverCard.ts) and its dismissals (`TabletHoverCardHost`): this draws.
 *
 * A frame for a card that is down pops it in as `zen-animate-pop` (180 ms from scale 0.94 at
 * opacity 0 on the chrome's ease; a 120 ms fade under reduced motion, §11.3); a frame while it
 * is up moves it there at once, as the DOM card re-renders in place; null takes it down at
 * once, as the DOM card unmounts.
 */
class TabHoverCardLayer(context: Context, private var ink: V2Ink) : FrameLayout(context) {
    private val density = context.resources.displayMetrics.density
    private val hairline = PromptSheetSpec.hairlinePx(density)
    private val reduced = !ValueAnimator.areAnimatorsEnabled()
    private val ease = PathInterpolator(TabHoverCardSpec.EASE[0], TabHoverCardSpec.EASE[1], TabHoverCardSpec.EASE[2], TabHoverCardSpec.EASE[3])

    val card = LinearLayout(context)
    private val previewBox = FrameLayout(context)
    private val previewImage = ImageView(context)
    private val titleView = TextView(context)
    private val meta = LinearLayout(context)
    private val hostView = TextView(context)
    private val lineViews = ArrayList<TextView>()

    /** The tab whose card is up; null while the card is down. */
    var shownTabId: String? = null
        private set
    val shown: Boolean get() = shownTabId != null
    /** Where the card was last placed, for the run's probes. */
    var placement: TabHoverCardPlacement.Placement? = null
        private set
    /** What the card shows, for the run's probes: the picture's box up, the title, the host line. */
    val previewShown: Boolean get() = previewBox.visibility == VISIBLE
    val titleText: String get() = titleView.text.toString()
    val hostText: String get() = hostView.text.toString()

    init {
        visibility = GONE
        isClickable = false
        isFocusable = false
        clipChildren = false
        clipToPadding = false
        importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS

        card.orientation = LinearLayout.VERTICAL
        card.setPadding(
            dp(TabHoverCardSpec.PADDING_DP) + hairline,
            dp(TabHoverCardSpec.PADDING_DP) + hairline,
            dp(TabHoverCardSpec.PADDING_DP) + hairline,
            dp(TabHoverCardSpec.PADDING_DP) + hairline
        )
        // The panel fill with the hairline inside its edge on the chrome's corner – the squircle,
        // not a circular arc – and the elevation shadow cast from the same outline.
        card.background = SquircleRectDrawable(dp(TabHoverCardSpec.RADIUS_DP).toFloat(), hairline, ink.panel, ink.border)
        card.outlineProvider = ViewOutlineProvider.BACKGROUND
        card.elevation = dp(TabHoverCardSpec.SHADOW_Y_DP).toFloat()
        card.isClickable = false
        card.isFocusable = false

        previewBox.clipToOutline = true
        previewBox.outlineProvider = ViewOutlineProvider.BACKGROUND
        previewBox.background = previewBackground()
        previewImage.scaleType = ImageView.ScaleType.MATRIX
        previewImage.adjustViewBounds = false
        previewBox.addView(previewImage, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        previewBox.visibility = GONE
        card.addView(previewBox, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0).apply {
            bottomMargin = dp(TabHoverCardSpec.PREVIEW_GAP_DP)
        })

        titleView.apply {
            setTextColor(ink.text)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, PromptSheetSpec.BODY_SP.toFloat())
            typeface = weight(PromptSheetSpec.BODY_WEIGHT)
            TextViewCompat.setLineHeight(this, sp(PromptSheetSpec.BODY_LINE_SP))
            maxLines = TabHoverCardSpec.TITLE_LINES
            ellipsize = TextUtils.TruncateAt.END
            includeFontPadding = false
        }
        card.addView(titleView, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        meta.orientation = LinearLayout.VERTICAL
        meta.addView(smallLine(hostView), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        card.addView(meta, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(TabHoverCardSpec.META_GAP_DP)
        })

        addView(card, LayoutParams(dp(TabHoverCardSpec.WIDTH_DP), ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.LEFT))
    }

    /**
     * One frame from the chrome with the tab's picture when it has one (decoded off the main
     * thread by the host; null shows no box); null takes the card down.
     */
    fun apply(frame: TabHoverCardFrame?, picture: Bitmap?) {
        if (frame == null) {
            if (shownTabId == null) return
            shownTabId = null
            placement = null
            card.animate().cancel()
            previewImage.setImageDrawable(null)
            visibility = GONE
            return
        }
        val wasUp = shownTabId != null
        shownTabId = frame.tabId

        titleView.text = frame.title
        hostView.text = frame.host
        hostView.visibility = if (frame.host.isEmpty()) GONE else VISIBLE
        setLines(frame.lines)
        meta.visibility = if (frame.host.isEmpty() && frame.lines.isEmpty()) GONE else VISIBLE

        val width = dp(TabHoverCardSpec.WIDTH_DP)
        val contentWidth = width - 2 * (dp(TabHoverCardSpec.PADDING_DP) + hairline)
        if (picture != null && frame.preview) {
            val boxHeight = (contentWidth * TabHoverCardSpec.PREVIEW_ASPECT).roundToInt()
            (previewBox.layoutParams as LinearLayout.LayoutParams).height = boxHeight
            previewImage.setImageBitmap(picture)
            previewImage.imageMatrix = coverTop(picture, contentWidth - 2 * hairline, boxHeight - 2 * hairline)
            previewBox.setPadding(hairline, hairline, hairline, hairline)
            previewBox.visibility = VISIBLE
        } else {
            previewImage.setImageDrawable(null)
            previewBox.visibility = GONE
        }

        // The card's own size decides where it fits, at the height its content wants.
        card.measure(
            MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
            MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED)
        )
        val height = card.measuredHeight.toFloat()
        val margin = dp(TabHoverCardSpec.MARGIN_DP).toFloat()
        val floor = dp(TabHoverCardSpec.HEIGHT_FLOOR_DP).toFloat()
        val viewportWidth = if (frame.viewportWidth > 0f) frame.viewportWidth else this.width.toFloat()
        val viewportHeight = if (frame.viewportHeight > 0f) frame.viewportHeight else this.height.toFloat()
        val box = TabHoverCardPlacement.place(
            frame.anchor, frame.sidebar, viewportWidth, viewportHeight, width.toFloat(), height, frame.axisX, margin, floor
        )
        placement = box
        val lp = card.layoutParams as LayoutParams
        lp.width = box.width.roundToInt()
        lp.height = min(height, box.maxHeight).roundToInt()
        lp.leftMargin = box.left.roundToInt()
        lp.topMargin = box.topFor(height, viewportHeight).roundToInt()
        card.layoutParams = lp

        if (visibility != VISIBLE) visibility = VISIBLE
        if (!wasUp) pop()
    }

    fun retint(tokens: V2Ink) {
        ink = tokens
        card.background = SquircleRectDrawable(dp(TabHoverCardSpec.RADIUS_DP).toFloat(), hairline, ink.panel, ink.border)
        previewBox.background = previewBackground()
        titleView.setTextColor(ink.text)
        hostView.setTextColor(ink.textDeemphasized)
        for (v in lineViews) v.setTextColor(ink.textDeemphasized)
    }

    /** The layer takes no touch and no hover: what is under it is the page's. */
    override fun onTouchEvent(event: MotionEvent): Boolean = false
    override fun onHoverEvent(event: MotionEvent): Boolean = false

    private fun pop() {
        card.animate().cancel()
        if (reduced) {
            card.scaleX = 1f
            card.scaleY = 1f
            card.alpha = 0f
            card.animate().alpha(1f).setDuration(TabHoverCardSpec.FADE_MS).setInterpolator(ease).start()
            return
        }
        card.scaleX = TabHoverCardSpec.POP_SCALE
        card.scaleY = TabHoverCardSpec.POP_SCALE
        card.alpha = 0f
        card.animate().scaleX(1f).scaleY(1f).alpha(1f).setDuration(TabHoverCardSpec.POP_MS).setInterpolator(ease).start()
    }

    private fun setLines(lines: List<String>) {
        while (lineViews.size < lines.size) {
            val v = smallLine(TextView(context))
            lineViews.add(v)
            meta.addView(v, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        for ((i, v) in lineViews.withIndex()) {
            if (i < lines.size) {
                v.text = lines[i]
                v.visibility = VISIBLE
            } else {
                v.visibility = GONE
            }
        }
    }

    /** `.zen-tab-hover-card-host`: 13 on a 20 line, de-emphasised, one line ending in an ellipsis. */
    private fun smallLine(view: TextView): TextView = view.apply {
        setTextColor(ink.textDeemphasized)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, PromptSheetSpec.SMALL_SP.toFloat())
        typeface = weight(PromptSheetSpec.BODY_WEIGHT)
        TextViewCompat.setLineHeight(this, sp(PromptSheetSpec.SMALL_LINE_SP))
        maxLines = 1
        ellipsize = TextUtils.TruncateAt.END
        includeFontPadding = false
    }

    /** `.zen-tab-hover-card-preview`: the page fill under the hairline at r6, a plain round corner. */
    private fun previewBackground(): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        cornerRadius = dp(TabHoverCardSpec.PREVIEW_RADIUS_DP).toFloat()
        setColor(ink.page)
        setStroke(hairline, ink.border)
    }

    /** `object-fit: cover; object-position: top`: scaled to cover the box, centred across, the page's top kept. */
    private fun coverTop(bitmap: Bitmap, boxWidth: Int, boxHeight: Int): Matrix {
        val m = Matrix()
        if (bitmap.width <= 0 || bitmap.height <= 0 || boxWidth <= 0 || boxHeight <= 0) return m
        val scale = max(boxWidth.toFloat() / bitmap.width, boxHeight.toFloat() / bitmap.height)
        m.setScale(scale, scale)
        m.postTranslate((boxWidth - bitmap.width * scale) / 2f, 0f)
        return m
    }

    /** The scale's weights on the system font; before API 28 the nearest named face (as the sheet chassis does). */
    private fun weight(w: Int): Typeface =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(Typeface.DEFAULT, w, false)
        else if (w >= 600) Typeface.DEFAULT_BOLD
        else if (w >= 500) Typeface.create("sans-serif-medium", Typeface.NORMAL)
        else Typeface.DEFAULT

    private fun dp(value: Int): Int = (value * density + 0.5f).toInt()
    private fun sp(value: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value.toFloat(), context.resources.displayMetrics).toInt()
}
