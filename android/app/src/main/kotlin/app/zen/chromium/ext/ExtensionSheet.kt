package app.zen.chromium.ext

import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.widget.ImageViewCompat
import app.zen.chromium.Host
import app.zen.chromium.R
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * The phone sheet of the v2 draft (§6, §9.16, §9.25) hosting one extension surface: a popup, an
 * options page or the identity auth flow. Neutral panel colour with a hairline edge and 12 dp top
 * corners; a 20 dp grip strip with the 32×4 grabber 8 dp from the top; a 48 dp header with the
 * title at 17/600 centred and a 44 dp close control at 2 dp margins on the trailing side, so the
 * body starts at 68; the §9.7 hairline under the header appears while the body has scrolled
 * under it. The body is the caller's WebView, edge to edge (an extension's own popup width is the
 * WebView's, see [ExtensionPopup]); a drag on the strip or header moves the sheet, a drag on the
 * page scrolls it and pulls the sheet down only past the page's top ([NestedScrollWebView]). The
 * scrim (black .4 light / .55 dark) comes from the sheet theme; a tap on it, the back gesture and
 * the close control dismiss the sheet. Styling polish waits for the design hold; the geometry is
 * the draft's.
 */
class ExtensionSheet(
    private val host: Host,
    title: String,
    private val body: View,
    private val onDismissed: () -> Unit
) {
    private val activity = host.activity
    private val density = activity.resources.displayMetrics.density
    private val dark = host.themeDark
    private val ink = ContextCompat.getColor(activity, if (dark) R.color.v2_text_dark else R.color.v2_text_light)
    private val hairline = ContextCompat.getColor(activity, if (dark) R.color.v2_border_dark else R.color.v2_border_light)
    val dialog = BottomSheetDialog(activity, if (dark) R.style.ThemeOverlay_Zen_Sheet_Dark else R.style.ThemeOverlay_Zen_Sheet)
    private val titleView = TextView(activity)
    private val headerLine = View(activity)
    /** The body's frame: the WebView sits in it, centred, at its own width when narrower. */
    val frame = FrameLayout(activity)
    private var dismissed = false

    init {
        titleView.text = title
        dialog.setContentView(content())
        dialog.behavior.skipCollapsed = true
        dialog.behavior.isFitToContents = true
        dialog.setOnDismissListener {
            if (dismissed) return@setOnDismissListener
            dismissed = true
            onDismissed()
        }
    }

    fun show() {
        dialog.show()
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
    }

    fun dismiss() {
        if (dismissed) return
        dialog.dismiss()
    }

    fun setTitle(title: String) {
        titleView.text = title
    }

    /** §9.7: the hairline under a header shows only while content has scrolled under it. */
    fun setScrolled(scrolled: Boolean) {
        headerLine.visibility = if (scrolled) View.VISIBLE else View.INVISIBLE
    }

    /** The tallest the body may be: the screen minus the grip strip, header and a margin above the sheet. */
    fun maxBodyHeight(): Int {
        val screen = activity.resources.displayMetrics.heightPixels
        return (screen * 0.85f).toInt() - dp(GRIP_DP + HEADER_DP)
    }

    private fun content(): View {
        val column = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            background = edge()
        }
        column.addView(grip(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(GRIP_DP)))
        column.addView(header(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(HEADER_DP)))
        headerLine.setBackgroundColor(hairline)
        headerLine.visibility = View.INVISIBLE
        column.addView(headerLine, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1))
        frame.addView(body)
        column.addView(frame, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        return column
    }

    /** The 1 px border of the sheet, over the panel colour the sheet style paints. */
    private fun edge(): GradientDrawable = GradientDrawable().apply {
        shape = GradientDrawable.RECTANGLE
        val r = dp(12).toFloat()
        cornerRadii = floatArrayOf(r, r, r, r, 0f, 0f, 0f, 0f)
        setColor(Color.TRANSPARENT)
        setStroke(1, hairline)
    }

    /** §9.9: 32×4 at radius 2, ink at 25%, 8 dp from the top edge, inside the 20 dp strip. */
    private fun grip(): View {
        val strip = FrameLayout(activity)
        val bar = View(activity).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(2).toFloat()
                setColor(ColorUtils.setAlphaComponent(ink, (0.25f * 255).toInt()))
            }
        }
        strip.addView(bar, FrameLayout.LayoutParams(dp(32), dp(4)).apply {
            gravity = Gravity.CENTER_HORIZONTAL or Gravity.TOP
            topMargin = dp(8)
        })
        return strip
    }

    /** §9.16: title 17/600 at line-height 22 centred; a 44 dp control at 2 dp margins trailing. */
    private fun header(): View {
        val header = FrameLayout(activity)
        titleView.apply {
            setTextColor(ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
            typeface = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(Typeface.DEFAULT, 600, false) else Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            includeFontPadding = false
            setLineSpacing(0f, 1f)
        }
        header.addView(titleView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(22)).apply {
            gravity = Gravity.CENTER
            marginStart = dp(CONTROL_DP + 2)
            marginEnd = dp(CONTROL_DP + 2)
        })
        val close = ImageButton(activity).apply {
            setImageResource(R.drawable.ic_cct_close)
            ImageViewCompat.setImageTintList(this, ColorStateList.valueOf(ink))
            background = ripple()
            contentDescription = activity.getString(R.string.cct_close)
            scaleType = android.widget.ImageView.ScaleType.CENTER
            setOnClickListener { dismiss() }
        }
        header.addView(close, FrameLayout.LayoutParams(dp(CONTROL_DP), dp(CONTROL_DP)).apply {
            gravity = Gravity.END or Gravity.CENTER_VERTICAL
            marginEnd = dp(2)
        })
        return header
    }

    private fun ripple(): RippleDrawable {
        val mask = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.WHITE)
        }
        return RippleDrawable(ColorStateList.valueOf(ColorUtils.setAlphaComponent(ink, (0.12f * 255).toInt())), null, mask)
    }

    fun dp(value: Int): Int = (value * density + 0.5f).toInt()

    companion object {
        /** §9.16: the grip strip, the header and the header's trailing control. */
        const val GRIP_DP = 20
        const val HEADER_DP = 48
        const val CONTROL_DP = 44
    }
}
