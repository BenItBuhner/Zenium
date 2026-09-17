package app.zen.chromium

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Typeface
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.widget.ImageViewCompat

/**
 * The custom tab's toolbar, drawn natively in the caller's colour (or Zenium's window colour):
 * the close control, the page's title over its host (or the host alone) behind a lock glyph
 * when the connection is secure, the caller's one action button, the menu button, a 2 px
 * progress line along the bottom while the page loads, and a hairline under it all. Geometry
 * per the v2 draft: 56 px bar, 44 px icon buttons with 20 px glyphs at radius 8, 15/600 title
 * over 13/400 host at 69%, weights 400 and 600 only.
 */
class CustomTabToolbar(context: Context, private val config: CustomTabConfig, listener: Listener) : FrameLayout(context) {
    interface Listener {
        fun onClose()
        fun onMenu()
        fun onAction()
    }

    private val density = resources.displayMetrics.density
    private val scheme = config.scheme

    /** Ink on the toolbar: near-white on a dark toolbar, near-black on a light one. */
    val ink: Int = ContextCompat.getColor(context, if (scheme.lightToolbarForeground) R.color.v2_text_dark else R.color.v2_text_light)
    val inkFaint: Int = ColorUtils.setAlphaComponent(ink, (0.69f * 255).toInt())
    /** The hairline under the bar (and between menu groups): the v2 border for the bar's own tone. */
    val hairline: Int = ContextCompat.getColor(context, if (scheme.lightToolbarForeground) R.color.v2_border_dark else R.color.v2_border_light)

    private val row = LinearLayout(context)
    private val title = TextView(context)
    private val host = TextView(context)
    private val lock = ImageView(context)
    private val progress = View(context)
    private val hairlinePaint = Paint().apply { color = hairline }
    private var topInset = 0
    private var loading = false
    private val hideProgress = Runnable { progress.animate().alpha(0f).setDuration(180).start() }

    /** The bar's own height, without the status bar it paints under. */
    val barHeight: Int = dp(BAR_DP)

    init {
        setBackgroundColor(scheme.toolbar)
        row.orientation = LinearLayout.HORIZONTAL
        row.gravity = Gravity.CENTER_VERTICAL
        row.setPadding(dp(4), 0, dp(4), 0)
        addView(row, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, barHeight, Gravity.BOTTOM))

        val close = iconButton(context.getString(R.string.cct_close)) { listener.onClose() }
        val callerClose = config.closeIcon
        if (callerClose != null) {
            close.setImageDrawable(BitmapDrawable(resources, callerClose))
            close.scaleType = ImageView.ScaleType.FIT_CENTER
            close.setPadding(dp(10), dp(10), dp(10), dp(10))
        } else {
            close.setImageResource(R.drawable.ic_cct_close)
        }
        ImageViewCompat.setImageTintList(close, ColorStateList.valueOf(ink))
        if (!config.closeAtEnd) row.addView(close)

        row.addView(titles(), LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))

        val action = config.actionButton
        if (action != null) {
            val button = iconButton(action.description) { listener.onAction() }
            button.setImageDrawable(BitmapDrawable(resources, scaledIcon(action.icon)))
            button.scaleType = ImageView.ScaleType.FIT_CENTER
            button.setPadding(dp(10), dp(10), dp(10), dp(10))
            if (action.tint) ImageViewCompat.setImageTintList(button, ColorStateList.valueOf(ink))
            row.addView(button)
        }

        val menu = iconButton(context.getString(R.string.cct_menu)) { listener.onMenu() }
        menu.setImageResource(R.drawable.ic_cct_more)
        ImageViewCompat.setImageTintList(menu, ColorStateList.valueOf(ink))
        row.addView(menu)
        if (config.closeAtEnd) row.addView(close)

        progress.setBackgroundColor(ink)
        progress.pivotX = 0f
        progress.scaleX = 0f
        progress.alpha = 0f
        addView(progress, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(2), Gravity.BOTTOM))
        setWillNotDraw(false)
    }

    private fun titles(): View {
        val block = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(8), 0, dp(8), 0)
        }
        title.setTextColor(ink)
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        title.typeface = semibold()
        title.maxLines = 1
        title.ellipsize = TextUtils.TruncateAt.END
        title.visibility = if (config.showTitle) View.VISIBLE else View.GONE
        block.addView(title, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        val hostRow = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        lock.setImageResource(R.drawable.ic_cct_lock)
        lock.contentDescription = context.getString(R.string.cct_secure)
        lock.visibility = View.GONE
        val lockSize = dp(if (config.showTitle) 14 else 16)
        hostRow.addView(lock, LinearLayout.LayoutParams(lockSize, lockSize).apply { marginEnd = dp(4) })
        host.setTextSize(TypedValue.COMPLEX_UNIT_SP, if (config.showTitle) 13f else 15f)
        host.setTextColor(if (config.showTitle) inkFaint else ink)
        ImageViewCompat.setImageTintList(lock, ColorStateList.valueOf(if (config.showTitle) inkFaint else ink))
        host.maxLines = 1
        host.ellipsize = TextUtils.TruncateAt.END
        hostRow.addView(host, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        block.addView(hostRow, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return block
    }

    private fun iconButton(description: String, onClick: () -> Unit): ImageButton {
        val button = ImageButton(context)
        button.layoutParams = LinearLayout.LayoutParams(dp(BUTTON_DP), dp(BUTTON_DP))
        button.background = ripple()
        button.scaleType = ImageView.ScaleType.FIT_CENTER
        // A 20 px glyph in a 44 px box.
        button.setPadding(dp(12), dp(12), dp(12), dp(12))
        button.contentDescription = description
        button.setOnClickListener { onClick() }
        return button
    }

    /** The press fill of an icon button: ink at 14% within the button's radius-8 box. */
    private fun ripple(): RippleDrawable {
        val mask = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(8).toFloat()
            setColor(Color.WHITE)
        }
        return RippleDrawable(ColorStateList.valueOf(ColorUtils.setAlphaComponent(ink, (0.14f * 255).toInt())), null, mask)
    }

    /** A caller's action icon at 24 px, whatever size it came in. */
    private fun scaledIcon(icon: Bitmap): Bitmap {
        val size = dp(24)
        if (icon.width == size && icon.height == size) return icon
        val scale = size.toFloat() / maxOf(icon.width, icon.height)
        return Bitmap.createScaledBitmap(icon, (icon.width * scale).toInt().coerceAtLeast(1), (icon.height * scale).toInt().coerceAtLeast(1), true)
    }

    private fun semibold(): Typeface =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(Typeface.DEFAULT, 600, false) else Typeface.DEFAULT_BOLD

    // --- state -----------------------------------------------------------------------------------

    /** The status bar the toolbar paints under; the bar itself sits below it. */
    fun setTopInset(px: Int) {
        if (topInset == px) return
        topInset = px
        setPadding(0, px, 0, 0)
        requestLayout()
    }

    fun setTitle(text: String?) {
        title.text = text?.takeIf { it.isNotBlank() } ?: host.text
    }

    /** The page's address: its host (without a leading `www.`) and whether it is secure. */
    fun setUrl(url: String?) {
        val uri = runCatching { Uri.parse(url ?: "") }.getOrNull()
        val name = uri?.host?.removePrefix("www.")?.ifEmpty { null } ?: url ?: ""
        host.text = name
        lock.visibility = if (uri?.scheme.equals("https", ignoreCase = true)) View.VISIBLE else View.GONE
        if (title.text.isNullOrEmpty()) title.text = name
    }

    /** Load progress 0…100: the line grows along the bottom edge and fades once the page is in. */
    fun setProgress(percent: Int) {
        removeCallbacks(hideProgress)
        val fraction = percent.coerceIn(0, 100) / 100f
        if (percent >= 100) {
            progress.scaleX = 1f
            loading = false
            postDelayed(hideProgress, 200)
            return
        }
        if (!loading) {
            loading = true
            progress.animate().cancel()
            progress.alpha = 1f
        }
        progress.scaleX = maxOf(fraction, 0.05f)
    }

    override fun onDraw(canvas: Canvas) {
        super.onDraw(canvas)
        val h = height.toFloat()
        canvas.drawRect(0f, h - 1f, width.toFloat(), h, hairlinePaint)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val height = barHeight + topInset
        super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY))
    }

    private fun dp(value: Int): Int = (value * density + 0.5f).toInt()

    companion object {
        const val BAR_DP = 56
        const val BUTTON_DP = 44
    }
}
