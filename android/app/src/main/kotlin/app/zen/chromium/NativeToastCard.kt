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

/**
 * The numbers of the v2 toast card (design language v2 §9.33), each after the constant or rule
 * it is taken from: `@shared/toastCard`'s `TOAST_CARD` – the one source the chrome's
 * `.zen-message` and the page-drawn fullscreen hint share – and `.zen-message` /
 * `.zen-message-button` in main.css. `V2TokensPinTest` holds them equal to both, so this twin
 * cannot drift from the card the chrome draws.
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
    /** `SPRING_SNAPPY`: the departure. */
    const val OUT_STIFFNESS = 420f
    const val OUT_DAMPING = 40f
}

/**
 * The v2 toast card (§9.33) as a native Android view, for the windows without the chrome's
 * renderer to draw it – an installed web app's own window ([WebAppActivity]), whose one message
 * so far is the first launch's disclosure ([WebAppDisclosure]). §9.33 already names one twin
 * drawn outside the chrome (the fullscreen exit hint in the page's top layer); this is the
 * second, held to the same tokens and geometry: the panel fill with the 1 dp hairline at the
 * card radius and the panel shadow, 8 inside the host's edges over its bottom inset, capped at
 * 560 and centred, the text 15/400 in the ink at the row's inset, the one action a secondary
 * button – the control's height, radius 6, the text's 10 % for a fill, the label in the accent
 * at 500 – and the same clocks. A finger on the card pauses its clock; the action, the clock
 * or the caller take it away. In on `SPRING_GENTLE` from below the edge, out on `SPRING_SNAPPY`;
 * with the system's animations off a 120 ms fade in place. The text is a polite live region,
 * as the chrome's `role="status"` is.
 */
class NativeToastCard(
    private val context: Context,
    private val ink: V2Ink,
    text: CharSequence,
    action: CharSequence?,
    /** The clock: one of [ToastCardSpec]'s, the caller's choice. */
    private val showMs: Long,
    private val onAction: () -> Unit = {},
    /** The card has left the host (by the action, the clock or [dismiss]); [detach] does not call it. */
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
    private var remainingMs = showMs
    private var clockStartedAt = 0L
    private var clockRunning = false
    private val clock = Runnable { dismiss() }
    private val spring = Spring(ToastCardSpec.IN_STIFFNESS, ToastCardSpec.IN_DAMPING, { view.translationY = it }, { view.translationY = it })
    private val exit = Spring(ToastCardSpec.OUT_STIFFNESS, ToastCardSpec.OUT_DAMPING, { view.translationY = it }, { remove() })

    /** Whether the card is in a host and not on its way out. */
    val shown: Boolean get() = host != null && !leaving

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
        view.isClickable = true

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

    /** Away on the departure spring (or the fade), then [onGone]. */
    fun dismiss() {
        if (host == null || leaving) return
        leaving = true
        stopClock()
        spring.stop()
        if (reduced) {
            view.animate().alpha(0f).setDuration(ToastCardSpec.FADE_MS).withEndAction { remove() }.start()
        } else {
            exit.animate(view.translationY, 0f, offscreen())
        }
    }

    /** Out at once, nothing animated and nothing reported: the window is going away. */
    fun detach() {
        stopClock()
        spring.stop()
        exit.stop()
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
            spring.animate(view.translationY, 0f, 0f)
        }
        startClock()
    }

    /** Below the host's bottom edge: the card's height and the margins under it. */
    private fun offscreen(): Float = (view.height + inset + bottomInset).toFloat()

    private fun remove() {
        val h = host ?: return
        h.removeView(view)
        host = null
        onGone(this)
    }

    private fun startClock() {
        if (clockRunning || leaving) return
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

    /** The row: capped at the card's width, and a finger on it holds the clock. */
    inner class Card : LinearLayout(context) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            val cap = dp(ToastCardSpec.MAX_WIDTH_DP)
            val spec = if (MeasureSpec.getMode(widthMeasureSpec) != MeasureSpec.UNSPECIFIED && MeasureSpec.getSize(widthMeasureSpec) > cap)
                MeasureSpec.makeMeasureSpec(cap, MeasureSpec.getMode(widthMeasureSpec))
            else widthMeasureSpec
            super.onMeasure(spec, heightMeasureSpec)
        }

        override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
            when (ev.actionMasked) {
                MotionEvent.ACTION_DOWN -> stopClock()
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> startClock()
            }
            return super.dispatchTouchEvent(ev)
        }
    }
}
