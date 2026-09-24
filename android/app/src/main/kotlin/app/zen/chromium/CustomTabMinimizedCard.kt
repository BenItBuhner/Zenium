package app.zen.chromium

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.TextUtils
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils

/**
 * The face of a minimized custom tab (CCT-11): what the floating picture-in-picture window shows
 * while the page waits, as Chrome's minimized card does. The page's favicon (20, a blank glyph
 * tile without one) beside its title in 15/600 on one line, its host in 13/400 at 69% under them,
 * the 16 gutter all round, on the v2 panel tone in the tab's own scheme with a 1 px card border
 * inside the window's rounded edge. Nothing here takes a touch: inside picture-in-picture the
 * platform owns the window's taps (its expand control restores the tab).
 */
class CustomTabMinimizedCard(context: Context, dark: Boolean) : FrameLayout(context) {
    private val density = resources.displayMetrics.density
    private val ink = ContextCompat.getColor(context, if (dark) R.color.v2_text_dark else R.color.v2_text_light)
    private val inkFaint = ColorUtils.setAlphaComponent(ink, (0.69f * 255).toInt())
    private val favicon = ImageView(context)
    private val title = TextView(context)
    private val host = TextView(context)

    init {
        background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            setColor(ContextCompat.getColor(context, if (dark) R.color.v2_panel_dark else R.color.v2_panel_light))
            setStroke(1, ContextCompat.getColor(context, if (dark) R.color.v2_card_border_dark else R.color.v2_card_border_light))
        }
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES

        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
        }
        favicon.scaleType = ImageView.ScaleType.FIT_CENTER
        favicon.background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(4).toFloat()
            setColor(ColorUtils.setAlphaComponent(ink, (0.08f * 255).toInt()))
        }
        favicon.importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        row.addView(favicon, LinearLayout.LayoutParams(dp(20), dp(20)).apply { marginEnd = dp(8) })

        title.setTextColor(ink)
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        title.typeface = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(Typeface.DEFAULT, 600, false) else Typeface.DEFAULT_BOLD
        title.maxLines = 1
        title.ellipsize = TextUtils.TruncateAt.END
        row.addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        column.addView(row, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        host.setTextColor(inkFaint)
        host.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        host.maxLines = 1
        host.ellipsize = TextUtils.TruncateAt.END
        column.addView(host, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(4) })
        addView(column, LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER_VERTICAL))
    }

    /** The page as it is at the moment of minimizing. */
    fun show(card: CustomTabMinimize.Card, icon: Bitmap?) {
        title.text = card.title
        host.text = card.host
        host.visibility = if (card.host == card.title) View.GONE else View.VISIBLE
        favicon.setImageBitmap(icon)
        contentDescription = context.getString(R.string.cct_minimized_card, card.title)
    }

    private fun dp(value: Int): Int = (value * density + 0.5f).toInt()
}
