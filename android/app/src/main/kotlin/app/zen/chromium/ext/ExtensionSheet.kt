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
import androidx.core.view.ViewCompat
import androidx.core.widget.ImageViewCompat
import app.zen.chromium.Host
import app.zen.chromium.PromptSheetSpec
import app.zen.chromium.R
import app.zen.chromium.SheetEdge
import app.zen.chromium.V2Ink
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * The phone sheet of the v2 draft (§6, §9.16, §9.25) hosting one extension surface: a popup, an
 * options page, a side panel document or the identity auth flow. Neutral panel colour with a
 * hairline edge and 12 dp top corners; a 20 dp grip strip with the 32×4 grabber 8 dp from the
 * top; a 48 dp header with the title at 17/600 centred and a 44 dp close control at 2 dp margins
 * on the trailing side, so the body starts at 68; the §9.7 hairline under the header appears
 * while the body has scrolled under it. The body is the caller's WebView, edge to edge (an
 * extension's own popup width is the WebView's, see [ExtensionPopup]); a drag on the strip or
 * header moves the sheet, a drag on the page scrolls it and pulls the sheet down only past the
 * page's top ([NestedScrollWebView]). The scrim (black .4 light / .55 dark) comes from the sheet
 * theme; a tap on it, the back gesture and the close control dismiss the sheet.
 *
 * The inks are the v2 token block's through [V2Ink] – the border, the text, the panel, the
 * grabber's and the press fill's fractions of the text – never a colour of the sheet's own, so
 * `V2TokensPinTest`, which holds the block to main.css, holds this sheet too. The hairline round
 * the top and the sides is the one edge every native sheet draws ([SheetEdge]: an open path at
 * [PromptSheetSpec.hairlinePx], one dp in whole pixels, with no run along the bottom, as
 * `.zen-sheet`'s `border: 1px` with `border-bottom: 0`; its sides run through the host's bar to
 * the screen's bottom, the column padding for the bar through the edge), and the §9.7 line under
 * the header is the same dp in the same ink. The anatomy stays the WebView host's: this is not the §9.23
 * prompt composition ([app.zen.chromium.NativePromptSheet]), whose title block and footer are a
 * prompt's.
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
    /** The token block of the theme in force: every ink the sheet draws. */
    private val ink = V2Ink(activity, dark)
    /** Every hairline's width on this screen: one dp in whole pixels. */
    private val hairline = PromptSheetSpec.hairlinePx(density)
    val dialog = BottomSheetDialog(activity, if (dark) R.style.ThemeOverlay_Zen_Sheet_Dark else R.style.ThemeOverlay_Zen_Sheet)
    private val titleView = TextView(activity)
    private val headerLine = View(activity)
    /** The body's frame: the WebView sits in it, centred, at its own width when narrower, on the panel. */
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
        val edge = edge()
        val column = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            background = edge
        }
        // The host's bar (or the keyboard over it): the column pads its bottom by it, through the
        // edge, and its bounds run to the screen's bottom with the hairline's sides, as the chrome
        // sheet's border runs under the safe area it pads for; the sheet style pads nothing for
        // the bar under this sheet (`Widget.Zen.Sheet`).
        ViewCompat.getRootWindowInsets(activity.window.decorView)?.let { edge.inset(column, it) }
        ViewCompat.setOnApplyWindowInsetsListener(column) { v, insets ->
            edge.inset(v, insets)
            insets
        }
        column.addView(grip(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(GRIP_DP)))
        column.addView(header(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(HEADER_DP)))
        headerLine.setBackgroundColor(ink.border)
        headerLine.visibility = View.INVISIBLE
        column.addView(headerLine, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, hairline))
        frame.setBackgroundColor(ink.panel)
        frame.addView(body)
        // The body sits inside the side hairlines, as content sits inside a CSS border box: the
        // edge-to-edge WebView is the sheet less one dp a side, and the sides' hairline shows down
        // the whole sheet instead of stopping where an opaque page begins.
        column.addView(frame, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            marginStart = hairline
            marginEnd = hairline
        })
        return column
    }

    /**
     * The hairline round the sheet, over the panel colour the sheet style paints: the shared open
     * path (top and sides, none along the bottom) at one dp, in the border ink.
     */
    private fun edge(): SheetEdge = SheetEdge(hairline, dp(PromptSheetSpec.SHEET_RADIUS_DP), ink.border)

    /** §9.9: 32×4 at radius 2, the text at 25 % ([V2Ink.grabber]), 8 dp from the top edge, inside the 20 dp strip. */
    private fun grip(): View {
        val strip = FrameLayout(activity)
        val bar = View(activity).apply {
            background = GradientDrawable().apply {
                shape = GradientDrawable.RECTANGLE
                cornerRadius = dp(PromptSheetSpec.GRABBER_RADIUS_DP).toFloat()
                setColor(ink.grabber)
            }
        }
        strip.addView(bar, FrameLayout.LayoutParams(dp(PromptSheetSpec.GRABBER_WIDTH_DP), dp(PromptSheetSpec.GRABBER_HEIGHT_DP)).apply {
            gravity = Gravity.CENTER_HORIZONTAL or Gravity.TOP
            topMargin = dp(PromptSheetSpec.GRABBER_TOP_DP)
        })
        return strip
    }

    /** §9.16: title 17/600 at line-height 22 centred in the text ink; a 44 dp control at 2 dp margins trailing. */
    private fun header(): View {
        val header = FrameLayout(activity)
        titleView.apply {
            setTextColor(ink.text)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, PromptSheetSpec.TITLE_SP.toFloat())
            typeface = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) Typeface.create(Typeface.DEFAULT, PromptSheetSpec.TITLE_WEIGHT, false) else Typeface.DEFAULT_BOLD
            gravity = Gravity.CENTER
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            includeFontPadding = false
            setLineSpacing(0f, 1f)
        }
        header.addView(titleView, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(PromptSheetSpec.TITLE_LINE_SP)).apply {
            gravity = Gravity.CENTER
            marginStart = dp(CONTROL_DP + 2)
            marginEnd = dp(CONTROL_DP + 2)
        })
        val close = ImageButton(activity).apply {
            setImageResource(R.drawable.ic_cct_close)
            ImageViewCompat.setImageTintList(this, ColorStateList.valueOf(ink.text))
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

    /** The close control's press: the token block's press fill (`--v2-fill-hover`, the text at 16 %) as a round ripple. */
    private fun ripple(): RippleDrawable {
        val mask = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.WHITE)
        }
        return RippleDrawable(ColorStateList.valueOf(ink.fillPressed), null, mask)
    }

    fun dp(value: Int): Int = (value * density + 0.5f).toInt()

    companion object {
        /** §9.16: the grip strip, the header and the header's trailing control. */
        const val GRIP_DP = PromptSheetSpec.GRIP_STRIP_DP
        const val HEADER_DP = 48
        const val CONTROL_DP = 44
    }
}
