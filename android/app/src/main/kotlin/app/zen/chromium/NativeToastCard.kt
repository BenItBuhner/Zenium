package app.zen.chromium

import android.animation.AnimatorSet
import android.animation.ObjectAnimator
import android.animation.StateListAnimator
import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.core.widget.TextViewCompat
import kotlin.math.abs
import kotlin.math.sign

/**
 * The numbers of the v2 toast card (design language v2 §9.33), each after the constant or rule
 * it is taken from: `@shared/toastCard`'s `TOAST_CARD` – the one source the chrome's
 * `.zen-message` and the page-drawn fullscreen hint share – `.zen-message` /
 * `.zen-message-button` in main.css, and the swipe's `SWIPE_THRESHOLDS` (`lib/gestures/swipe.ts`)
 * and `lib/gestures/dismiss.ts`, the one release rule every swipe in the app shares.
 * `V2TokensPinTest` holds them equal to each source, so this twin cannot drift from the card the
 * chrome draws.
 */
object ToastCardSpec {
    /** `TOAST_CARD.insetPx`: the card stands this far inside the frame's edges, every side. */
    const val INSET_DP = 8
    /** `TOAST_CARD.maxWidthPx`: the most a card spans; a wider frame centres it. */
    const val MAX_WIDTH_DP = 560
    /** `TOAST_CARD.rowPx` (`--v2-row` on a phone): a card with nothing but its text is one row tall. */
    const val ROW_DP = 44
    /** `TOAST_CARD.radiusPx` (`--v2-radius-card`). */
    const val RADIUS_DP = 8
    /** `TOAST_CARD.gutterPx`: the padding on the text's side, inside the hairline. */
    const val GUTTER_DP = 14
    /** `TOAST_CARD.padPx`: above and below the row. */
    const val PAD_DP = 3
    /** `.zen-message`'s `padding-right`: the control's side. */
    const val CONTROL_SIDE_DP = 6
    /** `TOAST_CARD.gapPx`: the text to the control beside it. */
    const val GAP_DP = 8
    /** `.zen-message[data-action]`'s `min-height`: the control plus 8, the row's 4 above and below it. */
    const val ACTION_MIN_DP = PromptSheetSpec.CONTROL_DP + 8
    /** `.zen-message-text`'s vertical padding: `(--v2-row - --v2-line-body-box) / 2 - 4px`. */
    const val TEXT_INSET_DP = (ROW_DP - PromptSheetSpec.BODY_LINE_SP) / 2 - 4
    /** `.zen-message-button`'s `padding: 0 12px`. */
    const val BUTTON_PADDING_DP = 12
    /** `.zen-message-button:active`'s `transform: scale(0.98)`, on its 120 ms transition. */
    const val PRESS_SCALE = 0.98f
    /** `--v2-shadow-panel`, `0 2px 6px rgb(0 0 0 / 0.2)`: the card's elevation is the shadow's offset. */
    const val SHADOW_Y_DP = 2
    /** `TOAST_SHOW_MS`: a toast without an action (§9.33's 2.8 s). */
    const val SHOW_MS = 2800L
    /** `TOAST_ACTION_DURATION` (lib/ui.ts): one with an action. */
    const val ACTION_SHOW_MS = 5000L
    /** §9.33's longest clock, the 8 s an Undo waits for the second thought. */
    const val LONG_SHOW_MS = 8000L
    /** `REDUCED_FADE_MS`: under reduced motion an arrival or a departure is a fade in place (§11.3). */
    const val FADE_MS = 120L
    /** `SPRING_GENTLE` (`@shared/spring`): the arrival across the frame's edge. */
    const val IN_STIFFNESS = 300f
    const val IN_DAMPING = 31f
    /** `SPRING_SNAPPY`: the departure, the throw-off and the spring back from a drag. */
    const val OUT_STIFFNESS = 420f
    const val OUT_DAMPING = 40f
    /** `SWIPE_THRESHOLDS.flingVelocity` (swipe.ts): a release this fast (dp/s) or faster, a way the card may go, sends it off from anywhere. */
    const val FLING_VELOCITY = 450f
    /** `SWIPE_THRESHOLDS.commitFraction`: a slower release, projected ahead, sends the card off once it is this far along its reach. */
    const val COMMIT_FRACTION = 0.45f
    /** `SWIPE_THRESHOLDS.projectionSeconds`: how far ahead (s) a slow release is projected. */
    const val PROJECTION_SECONDS = 0.12f
    /** `DISMISS_SLOP` (dismiss.ts): the finger's travel before a touch is a drag rather than a tap. */
    const val SLOP_DP = 8
    /** `RESIST_EXTENT` (dismiss.ts): the most the card gives where it may not go – the rubber band's extent. */
    const val RESIST_DP = 40
    /** `rubberBand`'s coefficient (swipe.ts). */
    const val RUBBER_COEFFICIENT = 0.55f
}

/**
 * The chrome's rule for swiping a message card away (`lib/gestures/dismiss.ts` on `swipe.ts`'s
 * `SWIPE_THRESHOLDS`, §9.33), pure and in the chrome's units (dp, dp/s), so the native card
 * decides as the chrome's does and a JVM test can hold it to the chrome's cases. A toast may
 * leave sideways either way or down ([TOAST_WAYS], the chrome's `TOAST_DIRS`); dragged where it
 * may not go it gives a short rubber band; a fling in an open way sends it off from anywhere, a
 * slower release once the card – projected ahead – is `commitFraction` of its reach out; its
 * presence (the opacity) thins with the travel out.
 */
object ToastSwipe {
    enum class Axis { X, Y }

    /** The ways a card may leave: the signs along each axis (−1 up or left, 1 down or right). */
    class Ways(val x: Set<Int>, val y: Set<Int>) {
        fun along(axis: Axis): Set<Int> = if (axis == Axis.X) x else y
    }

    /** `TOAST_DIRS`: sideways both ways, and down. */
    val TOAST_WAYS = Ways(setOf(-1, 1), setOf(1))

    /** The axis a drag has settled on once the finger is out of the slop circle; null while it is not. */
    fun dragAxis(dx: Float, dy: Float, slop: Float = ToastCardSpec.SLOP_DP.toFloat()): Axis? {
        if (dx * dx + dy * dy < slop * slop) return null
        return if (abs(dx) >= abs(dy)) Axis.X else Axis.Y
    }

    /** Whether the card may leave along [axis] the way [delta] points. */
    fun allowedAlong(delta: Float, axis: Axis, ways: Ways = TOAST_WAYS): Boolean =
        delta != 0f && ways.along(axis).contains(if (delta > 0f) 1 else -1)

    /** `rubberBand`: past an edge the card follows the finger with diminishing returns, never further than [extent]. */
    fun rubberBand(overshoot: Float, extent: Float, coefficient: Float = ToastCardSpec.RUBBER_COEFFICIENT): Float {
        if (overshoot == 0f || extent <= 0f) return 0f
        val d = abs(overshoot)
        return sign(overshoot) * (1f - 1f / ((d * coefficient) / extent + 1f)) * extent
    }

    /** Where a finger [delta] along [axis] puts the card: with it where it may leave, held by the rubber band where it may not. */
    fun dragOffset(delta: Float, axis: Axis, ways: Ways = TOAST_WAYS, resist: Float = ToastCardSpec.RESIST_DP.toFloat()): Float =
        if (allowedAlong(delta, axis, ways)) delta else rubberBand(delta, resist)

    /**
     * Which way a released card goes: 1 or −1 off along [axis], 0 back to its slot. A release at
     * [fling] or faster in an open way commits from anywhere; a slower one, projected
     * [projection] seconds ahead, commits once it is [fraction] of the card's [reach] out.
     */
    fun dismissSign(
        offset: Float,
        velocity: Float,
        reach: Float,
        axis: Axis,
        ways: Ways = TOAST_WAYS,
        fling: Float = ToastCardSpec.FLING_VELOCITY,
        fraction: Float = ToastCardSpec.COMMIT_FRACTION,
        projection: Float = ToastCardSpec.PROJECTION_SECONDS
    ): Int {
        if (abs(velocity) >= fling && allowedAlong(velocity, axis, ways)) return if (velocity > 0f) 1 else -1
        val projected = offset + velocity * projection
        if (!allowedAlong(projected, axis, ways)) return 0
        if (abs(projected) < fraction * maxOf(1f, reach)) return 0
        return if (projected > 0f) 1 else -1
    }

    /** How present the card is: 1 in its slot, 0 once [reach] out along its way – its opacity as it goes. */
    fun presence(offset: Float, reach: Float): Float {
        if (reach <= 0f) return 1f
        return (1f - abs(offset) / reach).coerceIn(0f, 1f)
    }
}

/**
 * The v2 toast card (§9.33) as a native Android view, for the windows without the chrome's
 * renderer to draw it – an installed web app's own window ([WebAppActivity]), whose one message
 * so far is the first launch's disclosure ([WebAppDisclosure]). §9.33 names two twins drawn
 * outside the chrome, the fullscreen exit hint in the page's top layer and this one, held to the
 * same tokens and geometry: the panel fill with the 1 dp hairline at the card radius and the
 * panel shadow, 8 inside the host's edges over its bottom inset, capped at 560 and centred, the
 * text 15/400 in the ink at the row's inset, an action (when a message carries one) a secondary
 * button – the control's height, radius 6, the text's 10 % for a fill, the label in the accent
 * at 500 – and the same clocks. A finger on the card pauses its clock; a swipe takes it away
 * early on the chrome's rule ([ToastSwipe]: sideways either way or down, the rubber band
 * upward, the shared thresholds), the card following the finger and thinning as it goes; the
 * action, the clock or the caller take it away otherwise. In on `SPRING_GENTLE` from below the
 * edge, out and back on `SPRING_SNAPPY`; with the system's animations off a 120 ms fade in place,
 * a drag still 1:1 and a release at its outcome at once (§11.3). The card swallows the touches
 * on it without a click of its own – it is the chrome's `role="status"` – and the text is a
 * polite live region.
 */
class NativeToastCard(
    private val context: Context,
    private val ink: V2Ink,
    text: CharSequence,
    action: CharSequence?,
    /** The clock: one of [ToastCardSpec]'s, the caller's choice. */
    private val showMs: Long,
    private val onAction: () -> Unit = {},
    /** The card has left the host – by the clock, a swipe, the action or [dismiss]; [detach] does not call it. */
    private val onGone: (NativeToastCard) -> Unit = {}
) {
    private val density = context.resources.displayMetrics.density
    private val hairline = PromptSheetSpec.hairlinePx(density)
    private val main = Handler(Looper.getMainLooper())
    private val reduced = !ValueAnimator.areAnimatorsEnabled()

    /** The card itself: the row with its text and its action. */
    val view: Card = Card()
    val textView: TextView
    val actionView: TextView?

    private var host: FrameLayout? = null
    private var bottomInset = 0
    private var inset = 0
    private var leaving = false
    private var dismissOnRelease = false
    private var remainingMs = showMs
    private var clockStartedAt = 0L
    private var clockRunning = false
    private val clock = Runnable { dismiss() }

    /** The axis of the card's excursion out of its slot – a drag, the spring back from one, or the way out – while one is on. */
    private var travelAxis: ToastSwipe.Axis? = null
    private var exitAxis: ToastSwipe.Axis? = null
    private val arrival = Spring(ToastCardSpec.IN_STIFFNESS, ToastCardSpec.IN_DAMPING, { view.translationY = it }, { view.translationY = it })
    private val snapX = Spring(ToastCardSpec.OUT_STIFFNESS, ToastCardSpec.OUT_DAMPING, { view.translationX = it; paint() }, { view.translationX = it; paint(); rested(ToastSwipe.Axis.X) })
    private val snapY = Spring(ToastCardSpec.OUT_STIFFNESS, ToastCardSpec.OUT_DAMPING, { view.translationY = it; paint() }, { view.translationY = it; paint(); rested(ToastSwipe.Axis.Y) })

    // The finger on the card: where it landed, its speed (in the screen's frame, so the card's
    // own travel under it does not read as stillness), and the axis its drag settled on.
    private var downTime = -1L
    private var startX = 0f
    private var startY = 0f
    private var tracker: VelocityTracker? = null
    private var dragAxis: ToastSwipe.Axis? = null

    /** Whether the card is in a host and not on its way out. */
    val shown: Boolean get() = host != null && !leaving

    /** Whether a finger has the card out of its slot. */
    val dragging: Boolean get() = dragAxis != null

    init {
        val hasAction = action != null
        view.orientation = LinearLayout.HORIZONTAL
        view.gravity = Gravity.CENTER_VERTICAL
        view.minimumHeight = dp(if (hasAction) ToastCardSpec.ACTION_MIN_DP else ToastCardSpec.ROW_DP)
        view.setPadding(
            dp(ToastCardSpec.GUTTER_DP) + hairline,
            dp(ToastCardSpec.PAD_DP) + hairline,
            dp(if (hasAction) ToastCardSpec.CONTROL_SIDE_DP else ToastCardSpec.GUTTER_DP) + hairline,
            dp(ToastCardSpec.PAD_DP) + hairline
        )
        view.background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(ToastCardSpec.RADIUS_DP).toFloat()
            setColor(ink.panel)
            setStroke(hairline, ink.border)
        }
        view.elevation = dp(ToastCardSpec.SHADOW_Y_DP).toFloat()

        textView = TextView(context).apply {
            this.text = text
            setTextColor(ink.text)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, PromptSheetSpec.BODY_SP.toFloat())
            typeface = weight(PromptSheetSpec.BODY_WEIGHT)
            TextViewCompat.setLineHeight(this, sp(PromptSheetSpec.BODY_LINE_SP))
            setPadding(0, dp(ToastCardSpec.TEXT_INSET_DP), 0, dp(ToastCardSpec.TEXT_INSET_DP))
            ViewCompat.setAccessibilityLiveRegion(this, ViewCompat.ACCESSIBILITY_LIVE_REGION_POLITE)
        }
        view.addView(textView, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        actionView = action?.let { label ->
            button(label).also {
                view.addView(it, LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(PromptSheetSpec.CONTROL_DP)).apply {
                    marginStart = dp(ToastCardSpec.GAP_DP)
                })
            }
        }
    }

    /**
     * Into [host] at [index] (under a layer that must stay on top, such as a fullscreen video's),
     * 8 inside its bottom edge over [bottomInset] – the navigation bar's height, or the
     * keyboard's while it is up – and arriving from below the edge.
     */
    fun show(host: FrameLayout, bottomInset: Int, index: Int = -1) {
        if (this.host != null) return
        this.host = host
        this.bottomInset = bottomInset
        inset = dp(ToastCardSpec.INSET_DP)
        val lp = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL)
        lp.setMargins(inset, 0, inset, inset + bottomInset)
        // Laid out first (the arrival needs the card's height), shown from below the edge after.
        view.visibility = View.INVISIBLE
        host.addView(view, index, lp)
        view.addOnLayoutChangeListener(object : View.OnLayoutChangeListener {
            override fun onLayoutChange(v: View, l: Int, t: Int, r: Int, b: Int, ol: Int, ot: Int, or: Int, ob: Int) {
                v.removeOnLayoutChangeListener(this)
                arrive()
            }
        })
    }

    /** The host's bottom inset changed (the keyboard came or went): the card keeps its 8 above it. */
    fun setBottomInset(px: Int) {
        if (px == bottomInset) return
        bottomInset = px
        val lp = view.layoutParams as? FrameLayout.LayoutParams ?: return
        lp.bottomMargin = inset + px
        view.layoutParams = lp
    }

    /** Away by its home edge on the departure spring (or the fade), then [onGone]; under a finger, once it lets go. */
    fun dismiss() {
        if (host == null || leaving) return
        if (dragging) {
            dismissOnRelease = true
            return
        }
        leave(ToastSwipe.Axis.Y, 1, 0f)
    }

    /** Out at once, nothing animated and nothing reported: the window is going away. */
    fun detach() {
        stopClock()
        arrival.stop()
        snapX.stop()
        snapY.stop()
        tracker?.recycle()
        tracker = null
        dragAxis = null
        view.animate().cancel()
        host?.removeView(view)
        host = null
    }

    private fun arrive() {
        if (host == null || leaving) return
        if (reduced) {
            view.alpha = 0f
            view.visibility = View.VISIBLE
            view.animate().alpha(1f).setDuration(ToastCardSpec.FADE_MS).start()
        } else {
            view.translationY = offscreen()
            view.visibility = View.VISIBLE
            arrival.animate(view.translationY, 0f, 0f)
        }
        startClock()
    }

    /** Below the host's bottom edge: the card's height and the margins under it. */
    private fun offscreen(): Float = (view.height + inset + bottomInset).toFloat()

    /** The distance along [axis] at which the card is out of sight: its width sideways, below the edge downward (the chrome's `reach`). */
    private fun reach(axis: ToastSwipe.Axis): Float =
        if (axis == ToastSwipe.Axis.X) maxOf(1f, view.width.toFloat()) else maxOf(1f, offscreen())

    /**
     * Off along [axis] towards [sign] from where it is, at [velocity] px/s, on the departure
     * spring; with motion reduced a release's outcome ([jump]) is gone at once, anything else
     * fades in place from the opacity it has.
     */
    private fun leave(axis: ToastSwipe.Axis, sign: Int, velocity: Float, jump: Boolean = false) {
        if (host == null || leaving) return
        leaving = true
        stopClock()
        arrival.stop()
        snapX.stop()
        snapY.stop()
        exitAxis = axis
        if (reduced) {
            view.animate().cancel()
            if (jump) remove()
            else view.animate().alpha(0f).setDuration(ToastCardSpec.FADE_MS).withEndAction { remove() }.start()
            return
        }
        travelAxis = axis
        if (axis == ToastSwipe.Axis.X) snapX.animate(view.translationX, velocity, sign * reach(axis))
        else snapY.animate(view.translationY, velocity, sign * reach(axis))
    }

    private fun remove() {
        val h = host ?: return
        h.removeView(view)
        host = null
        onGone(this)
    }

    // --- the finger ---------------------------------------------------------------------------------

    /** Every touch on the card, from either of the row's hooks; the same DOWN seen by both counts once. */
    private fun track(ev: MotionEvent) {
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                if (ev.downTime == downTime) return
                downTime = ev.downTime
                startX = ev.rawX
                startY = ev.rawY
                dragAxis = null
                tracker?.recycle()
                tracker = VelocityTracker.obtain().also { it.addRaw(ev) }
                stopClock()
            }
            MotionEvent.ACTION_MOVE -> {
                if (ev.downTime != downTime) return
                tracker?.addRaw(ev)
                val dx = ev.rawX - startX
                val dy = ev.rawY - startY
                val axis = dragAxis ?: run {
                    if (leaving) return
                    val settled = ToastSwipe.dragAxis(dx, dy, dp(ToastCardSpec.SLOP_DP).toFloat()) ?: return
                    dragAxis = settled
                    dragStarted(settled)
                    settled
                }
                drag(axis, if (axis == ToastSwipe.Axis.X) dx else dy)
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                if (ev.downTime != downTime) return
                downTime = -1L
                val axis = dragAxis
                dragAxis = null
                val t = tracker
                tracker = null
                if (axis == null) {
                    t?.recycle()
                    startClock()
                    return
                }
                // The system taking the touch away (a palm, the shade) is a release at no speed: where the card is decides.
                var velocity = 0f
                if (ev.actionMasked == MotionEvent.ACTION_UP && t != null) {
                    t.addRaw(ev)
                    t.computeCurrentVelocity(1000)
                    velocity = if (axis == ToastSwipe.Axis.X) t.xVelocity else t.yVelocity
                }
                t?.recycle()
                release(axis, velocity)
            }
        }
    }

    /** The finger has left the slop circle: the card is its, whatever motion was on. */
    private fun dragStarted(axis: ToastSwipe.Axis) {
        arrival.stop()
        snapX.stop()
        snapY.stop()
        view.animate().cancel()
        travelAxis = axis
    }

    /** The finger [delta] px along [axis]: the card with it where it may leave, on the rubber band where it may not, thinning as it goes out. */
    private fun drag(axis: ToastSwipe.Axis, delta: Float) {
        val offset = ToastSwipe.dragOffset(delta / density, axis) * density
        if (axis == ToastSwipe.Axis.X) view.translationX = offset else view.translationY = offset
        paint()
    }

    /** The finger let go at [velocity] px/s: off along [axis] when the chrome's rule says so, back to the slot otherwise, the clock running again. */
    private fun release(axis: ToastSwipe.Axis, velocity: Float) {
        val offset = if (axis == ToastSwipe.Axis.X) view.translationX else view.translationY
        val sign = ToastSwipe.dismissSign(offset / density, velocity / density, reach(axis) / density, axis)
        if (sign != 0) {
            leave(axis, sign, velocity, jump = true)
            return
        }
        if (dismissOnRelease) {
            // Dismissed while held: it goes now, by its own edge.
            dismissOnRelease = false
            leave(ToastSwipe.Axis.Y, 1, 0f)
            return
        }
        if (reduced) {
            // §11.3: a release jumps to its outcome.
            view.translationX = 0f
            view.translationY = 0f
            travelAxis = null
            view.alpha = 1f
        } else {
            // Back along the way it came, the presence with it, on the same spring as the way out.
            snapX.animate(view.translationX, if (axis == ToastSwipe.Axis.X) velocity else 0f, 0f)
            snapY.animate(view.translationY, if (axis == ToastSwipe.Axis.Y) velocity else 0f, 0f)
        }
        startClock()
    }

    /** The presence along the travel: the card thins as it goes an open way; a rubber-banded pull is not on its way (the chrome's `paint`). */
    private fun paint() {
        val axis = travelAxis ?: return
        val d = if (axis == ToastSwipe.Axis.X) view.translationX else view.translationY
        view.alpha = if (ToastSwipe.allowedAlong(d, axis)) ToastSwipe.presence(d, reach(axis)) else 1f
    }

    /** A spring along [axis] came to rest: gone if it was the way out, settled once the other is still too. */
    private fun rested(axis: ToastSwipe.Axis) {
        if (leaving) {
            if (axis == exitAxis) remove()
            return
        }
        if (dragging) return
        val other = if (axis == ToastSwipe.Axis.X) snapY else snapX
        if (!other.running) {
            travelAxis = null
            view.alpha = 1f
        }
    }

    /** The event's point in the screen's frame, not the card's – the card moves under the finger. */
    private fun VelocityTracker.addRaw(ev: MotionEvent) {
        val raw = MotionEvent.obtain(ev)
        raw.setLocation(ev.rawX, ev.rawY)
        addMovement(raw)
        raw.recycle()
    }

    // --- the clock ----------------------------------------------------------------------------------

    private fun startClock() {
        if (clockRunning || leaving || host == null) return
        clockRunning = true
        clockStartedAt = SystemClock.uptimeMillis()
        main.postDelayed(clock, remainingMs)
    }

    private fun stopClock() {
        if (!clockRunning) return
        clockRunning = false
        main.removeCallbacks(clock)
        remainingMs = (remainingMs - (SystemClock.uptimeMillis() - clockStartedAt)).coerceAtLeast(0L)
    }

    /** `.zen-message-button`: the control's height, radius 6, the fill at the text's 10 %, the label 15/500 in the accent, the press scale. */
    private fun button(label: CharSequence): TextView {
        val button = TextView(context)
        button.text = label
        button.gravity = Gravity.CENTER
        button.setTextColor(ink.accent)
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, PromptSheetSpec.BODY_SP.toFloat())
        button.typeface = weight(PromptSheetSpec.BUTTON_WEIGHT)
        button.maxLines = 1
        button.setPadding(dp(ToastCardSpec.BUTTON_PADDING_DP), 0, dp(ToastCardSpec.BUTTON_PADDING_DP), 0)
        button.background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(PromptSheetSpec.CONTROL_RADIUS_DP).toFloat()
            setColor(ink.fill)
        }
        button.stateListAnimator = StateListAnimator().apply {
            addState(intArrayOf(android.R.attr.state_pressed), scaleTo(button, ToastCardSpec.PRESS_SCALE))
            addState(intArrayOf(), scaleTo(button, 1f))
        }
        button.isClickable = true
        button.isFocusable = true
        ViewCompat.setAccessibilityDelegate(button, object : AccessibilityDelegateCompat() {
            override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {
                super.onInitializeAccessibilityNodeInfo(host, info)
                info.className = Button::class.java.name
            }
        })
        button.setOnClickListener {
            if (leaving) return@setOnClickListener
            onAction()
            dismiss()
        }
        return button
    }

    private fun scaleTo(target: View, scale: Float): AnimatorSet = AnimatorSet().apply {
        playTogether(ObjectAnimator.ofFloat(target, View.SCALE_X, scale), ObjectAnimator.ofFloat(target, View.SCALE_Y, scale))
        duration = if (reduced) 0L else PromptSheetSpec.PRESS_FADE_MS.toLong()
    }

    /** The scale's weights on the system font; before API 28 the nearest named face (as the sheet chassis does). */
    private fun weight(w: Int): Typeface =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(Typeface.DEFAULT, w, false)
        else if (w >= 600) Typeface.DEFAULT_BOLD
        else if (w >= 500) Typeface.create("sans-serif-medium", Typeface.NORMAL)
        else Typeface.DEFAULT

    private fun dp(value: Int): Int = (value * density + 0.5f).toInt()
    private fun sp(value: Int): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, value.toFloat(), context.resources.displayMetrics).toInt()

    /**
     * The row: capped at the card's width, and the finger's. It takes every touch on it (nothing
     * reaches the page under the card) with no click of its own – no ACTION_CLICK on its node –
     * and, once a drag has its axis, takes the touch from its action too, so the button's tap
     * stays a tap and a drag that ends over it does not click it.
     */
    inner class Card : LinearLayout(context) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val cap = dp(ToastCardSpec.MAX_WIDTH_DP)
            val spec = if (MeasureSpec.getMode(widthMeasureSpec) != MeasureSpec.UNSPECIFIED && MeasureSpec.getSize(widthMeasureSpec) > cap)
                MeasureSpec.makeMeasureSpec(cap, MeasureSpec.getMode(widthMeasureSpec))
            else widthMeasureSpec
            super.onMeasure(spec, heightMeasureSpec)
        }

        override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
            track(ev)
            return dragging
        }

        override fun onTouchEvent(ev: MotionEvent): Boolean {
            track(ev)
            return true
        }
    }
}
