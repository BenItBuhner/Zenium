package app.zen.chromium

import android.animation.ValueAnimator
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.view.Gravity
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.View
import android.view.ViewConfiguration
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.widget.ImageViewCompat

/**
 * The caller's bottom toolbar of a custom tab (CCT-07), as Chrome's `CustomTabBottomBarDelegate`
 * draws it: the caller's own `RemoteViews` (`EXTRA_REMOTEVIEWS`) inflated into a slot above the
 * system's bottom inset, its clickable ids reported through the caller's `PendingIntent`, and
 * under or instead of them the caller's custom buttons (`EXTRA_TOOLBAR_ITEMS` with an id other
 * than the top bar's) as equally weighted 44 boxes in a 56 row, each firing its own intent. The
 * bar is painted in the secondary toolbar colour with a hairline along its top; the activity
 * shrinks the page's viewport by [barHeight] and slides the bar away with the top toolbar.
 *
 * With `EXTRA_SECONDARY_TOOLBAR_SWIPE_UP_GESTURE` set the bar answers an upward drag: it rides
 * the finger (a rubber band past a point), the caller's intent fires once the travel passes the
 * threshold, and on release the bar settles back on §11's snappy spring. The caller then
 * typically answers with `setSecondaryToolbarViews`, which arrives through [setRemoteViews].
 */
class CustomTabBottomBar(
    context: Context,
    private val scheme: CustomTabScheme.Resolved,
    private val listener: Listener
) : FrameLayout(context) {
    interface Listener {
        /** A tap on one of the caller's clickable RemoteViews ids. */
        fun onRemoteViewClick(id: Int)
        /** A tap on one of the caller's bottom buttons. */
        fun onBottomButton(button: CustomTabConfig.ActionButton)
        /** The bar was swiped up (once per gesture). */
        fun onSwipeUp()
        /** The bar's own height changed (new views from the caller); the page's viewport follows. */
        fun onBarHeightChanged()
    }

    private val density = resources.displayMetrics.density

    /** Ink on the bar, by the same contrast rule as the top toolbar's. */
    val ink: Int = ContextCompat.getColor(context, if (scheme.lightSecondaryForeground) R.color.v2_text_dark else R.color.v2_text_light)
    private val hairline: Int = ContextCompat.getColor(context, if (scheme.lightSecondaryForeground) R.color.v2_border_dark else R.color.v2_border_light)
    private val hairlinePaint = Paint().apply { color = hairline }

    /** The remote views slot over the buttons row; the bar's height is theirs. */
    private val content = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
    private val remoteSlot = FrameLayout(context)
    private val buttonsRow = LinearLayout(context).apply {
        orientation = LinearLayout.HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(4), 0, dp(4), 0)
        visibility = View.GONE
    }

    private var bottomInset = 0
    /** The bar's own height as last laid out, without the inset it pads under. */
    var barHeight = 0
        private set

    /** Whether an upward drag is the caller's swipe-up gesture. */
    var swipeUpEnabled = false

    private val slop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
    private val swipeThreshold = dp(CustomTabBottomBarRules.SWIPE_UP_DP).toFloat()
    private var downX = 0f
    private var downY = 0f
    private var dragging = false
    private var fired = false
    private var velocity: VelocityTracker? = null
    /** The settle after a drag: `x` is the bar's upward offset, so `translationY = -x`. */
    private val spring = Spring(SPRING_STIFFNESS, SPRING_DAMPING, onFrame = { translationY = -it }, onRest = { translationY = 0f })

    init {
        setBackgroundColor(scheme.secondaryToolbar)
        isClickable = true
        content.addView(remoteSlot, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        content.addView(buttonsRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(CustomTabBottomBarRules.BUTTON_ROW_DP)))
        addView(content, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP))
        setWillNotDraw(false)
    }

    // --- the caller's pieces -------------------------------------------------------------------------

    /**
     * The caller's `RemoteViews`, applied fresh (an update replaces the previous views), each
     * clickable id wired to [Listener.onRemoteViewClick]. Null clears the slot. Views that fail
     * to inflate (a layout from a package the system will not load) leave the slot empty. With
     * views in the slot the caller's buttons stand down, as in Chrome (the views are the bar);
     * cleared, the buttons come back.
     */
    fun setRemoteViews(remote: CustomTabConfig.RemoteViews?) {
        remoteSlot.removeAllViews()
        val view = remote?.let {
            try {
                it.views.apply(context, remoteSlot)
            } catch (e: RuntimeException) {
                null
            }
        }
        if (view != null && remote != null) {
            for (id in remote.clickableIds) {
                view.findViewById<View>(id)?.setOnClickListener { listener.onRemoteViewClick(id) }
            }
            remoteSlot.addView(view, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        }
        buttonsRow.visibility = if (remoteSlot.childCount > 0 || buttonsRow.childCount == 0) View.GONE else View.VISIBLE
    }

    /** The caller's bottom buttons in its order, equally weighted across the row; empty hides the row. */
    fun setButtons(buttons: List<CustomTabConfig.ActionButton>) {
        buttonsRow.removeAllViews()
        buttonsRow.visibility = if (buttons.isEmpty() || remoteSlot.childCount > 0) View.GONE else View.VISIBLE
        for (button in buttons) {
            val cell = FrameLayout(context)
            val image = iconButton(button.description) { listener.onBottomButton(button) }
            image.setImageDrawable(BitmapDrawable(resources, scaledIcon(button.icon)))
            image.tag = button.id
            if (button.tint) ImageViewCompat.setImageTintList(image, ColorStateList.valueOf(ink))
            cell.addView(image, LayoutParams(dp(BUTTON_DP), dp(BUTTON_DP), Gravity.CENTER))
            buttonsRow.addView(cell, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
        }
    }

    /** A later icon for one of the buttons (`CustomTabsSession.setToolbarItem`); false when no button has the id. */
    fun updateButton(id: Int, icon: Bitmap, description: String): Boolean {
        for (i in 0 until buttonsRow.childCount) {
            val image = (buttonsRow.getChildAt(i) as FrameLayout).getChildAt(0) as ImageButton
            if (image.tag != id) continue
            image.setImageDrawable(BitmapDrawable(resources, scaledIcon(icon)))
            image.contentDescription = description
            return true
        }
        return false
    }

    /** The navigation bar the toolbar pads under; the bar's own row sits above it. */
    fun setBottomInset(px: Int) {
        if (bottomInset == px) return
        bottomInset = px
        setPadding(0, 0, 0, px)
        requestLayout()
    }

    /** The bar's height for a given width before it is laid out: what the page should leave for it. */
    fun measureBarHeight(widthPx: Int): Int {
        content.measure(MeasureSpec.makeMeasureSpec(widthPx, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED))
        return content.measuredHeight
    }

    /** True when the caller gave the bar anything to show. */
    val hasContent: Boolean get() = remoteSlot.childCount > 0 || buttonsRow.childCount > 0

    /** The caller's views are what the bar shows (its buttons stand down behind them). */
    val showsRemoteViews: Boolean get() = remoteSlot.childCount > 0

    // --- the swipe up ----------------------------------------------------------------------------

    override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
        if (!swipeUpEnabled) return false
        when (ev.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = ev.x
                downY = ev.y
                dragging = false
                fired = false
                spring.stop()
                velocity?.recycle()
                velocity = VelocityTracker.obtain().also { it.addMovement(ev) }
            }
            MotionEvent.ACTION_MOVE -> {
                velocity?.addMovement(ev)
                if (!dragging && CustomTabBottomBarRules.claimsDrag(ev.x - downX, ev.y - downY, slop)) {
                    dragging = true
                    return true
                }
            }
        }
        return false
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (!swipeUpEnabled) return super.onTouchEvent(event)
        velocity?.addMovement(event)
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x
                downY = event.y
                dragging = false
                fired = false
                spring.stop()
                velocity?.recycle()
                velocity = VelocityTracker.obtain().also { it.addMovement(event) }
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                if (!dragging && CustomTabBottomBarRules.claimsDrag(event.x - downX, event.y - downY, slop)) dragging = true
                if (dragging) {
                    val travelUp = downY - event.y
                    translationY = -CustomTabBottomBarRules.dragOffset(travelUp, barHeight.toFloat())
                    if (!fired && CustomTabBottomBarRules.swipeFires(travelUp, swipeThreshold)) {
                        fired = true
                        listener.onSwipeUp()
                    }
                }
                return true
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                settle()
                return true
            }
        }
        return super.onTouchEvent(event)
    }

    /** The bar returns to its place on the spring, carrying the finger's velocity; snaps with animators off. */
    private fun settle() {
        val tracker = velocity
        var upward = 0f
        if (tracker != null) {
            tracker.computeCurrentVelocity(1000)
            upward = -tracker.yVelocity
            tracker.recycle()
            velocity = null
        }
        dragging = false
        val offset = -translationY
        if (offset == 0f) return
        if (!ValueAnimator.areAnimatorsEnabled()) {
            translationY = 0f
            return
        }
        spring.animate(offset, upward, 0f)
    }

    /** A hide or show from the activity cancels a settle in flight. */
    fun stopSettling() {
        spring.stop()
    }

    // --- drawing and measure -------------------------------------------------------------------------

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        canvas.drawRect(0f, 0f, width.toFloat(), 1f, hairlinePaint)
    }

    override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {
        super.onLayout(changed, left, top, right, bottom)
        val h = content.height
        if (h != barHeight) {
            barHeight = h
            post { listener.onBarHeightChanged() }
        }
    }

    private fun iconButton(description: String, onClick: () -> Unit): ImageButton {
        val button = ImageButton(context)
        button.background = ripple()
        button.scaleType = ImageView.ScaleType.FIT_CENTER
        // A 24 px icon in a 44 px box, as the top bar's action button.
        button.setPadding(dp(10), dp(10), dp(10), dp(10))
        button.contentDescription = description
        button.setOnClickListener { onClick() }
        return button
    }

    private fun ripple(): RippleDrawable {
        val mask = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(8).toFloat()
            setColor(Color.WHITE)
        }
        return RippleDrawable(ColorStateList.valueOf(ColorUtils.setAlphaComponent(ink, (0.14f * 255).toInt())), null, mask)
    }

    private fun scaledIcon(icon: Bitmap): Bitmap {
        val size = dp(24)
        if (icon.width == size && icon.height == size) return icon
        val scale = size.toFloat() / maxOf(icon.width, icon.height)
        return Bitmap.createScaledBitmap(icon, (icon.width * scale).toInt().coerceAtLeast(1), (icon.height * scale).toInt().coerceAtLeast(1), true)
    }

    private fun dp(value: Int): Int = (value * density + 0.5f).toInt()

    companion object {
        const val BUTTON_DP = 44
        /** §11 SPRING_SNAPPY. */
        private const val SPRING_STIFFNESS = 420f
        private const val SPRING_DAMPING = 40f
    }
}
