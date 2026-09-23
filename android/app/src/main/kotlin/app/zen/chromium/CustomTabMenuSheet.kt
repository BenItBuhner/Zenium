package app.zen.chromium

import android.app.Activity
import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.widget.ImageViewCompat
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * The custom tab's menu: the phone sheet of the v2 draft (§6) drawn natively, since a custom
 * tab has no chrome. Neutral panel surface with the native chassis's hairline edge ([SheetEdge]:
 * top and sides, one dp, the sides running through the host's bar to the screen's bottom with the
 * bar as the column's own padding, as the prompt sheet's and the extension sheet's do) and 12 dp
 * top corners, a 32×4 grabber, rows 44 dp tall at 15/400 with
 * a 20 dp glyph (the caller's own items keep the glyph slot so every label lines up), one-dp
 * hairlines with 4 dp margins between [CustomTabMenu.groups], and a footer naming the browser
 * the page is running in, as Chrome's and Firefox's custom tabs do.
 */
class CustomTabMenuSheet(
    private val context: Context,
    private val dark: Boolean,
    private val groups: List<List<CustomTabMenu.Item>>,
    private val onPick: (CustomTabMenu.Item) -> Unit
) {
    private val density = context.resources.displayMetrics.density
    private val ink = ContextCompat.getColor(context, if (dark) R.color.v2_text_dark else R.color.v2_text_light)
    private val inkFaint = ColorUtils.setAlphaComponent(ink, (0.69f * 255).toInt())
    private val border = ContextCompat.getColor(context, if (dark) R.color.v2_border_dark else R.color.v2_border_light)
    /** One dp in device pixels, never under one – the sheet's edge and the separators between its groups. */
    private val hairline = PromptSheetSpec.hairlinePx(density)

    fun show() {
        val dialog = BottomSheetDialog(context, if (dark) R.style.ThemeOverlay_Zen_CustomTabSheet_Dark else R.style.ThemeOverlay_Zen_CustomTabSheet)
        dialog.setContentView(content(dialog))
        dialog.behavior.skipCollapsed = true
        dialog.behavior.state = BottomSheetBehavior.STATE_EXPANDED
        dialog.show()
    }

    private fun content(dialog: BottomSheetDialog): View {
        // The chassis's edge: top and sides at one dp, no run along the bottom, over the panel colour the sheet style paints.
        val edge = SheetEdge(hairline, dp(PromptSheetSpec.SHEET_RADIUS_DP), border)
        val column = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            background = edge
            setPadding(0, dp(8), 0, 0)
        }
        // The host's bar: the column pads its bottom by it through the edge, so its bounds and the
        // hairline's sides run through the bar to the screen's bottom (the sheet style pads nothing
        // for the bar, `Widget.Zen.Sheet`); the menu's own 8 under the footer is the footer's margin.
        (context as? Activity)?.window?.decorView?.let { ViewCompat.getRootWindowInsets(it) }?.let { edge.inset(column, it) }
        ViewCompat.setOnApplyWindowInsetsListener(column) { v, insets ->
            edge.inset(v, insets)
            insets
        }
        column.addView(grabber(), LinearLayout.LayoutParams(dp(32), dp(4)).apply {
            gravity = Gravity.CENTER_HORIZONTAL
            bottomMargin = dp(8)
        })
        groups.forEachIndexed { index, group ->
            if (index > 0) column.addView(separator())
            for (item in group) column.addView(row(item) {
                dialog.dismiss()
                onPick(item)
            })
        }
        column.addView(separator())
        column.addView(footer(), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
            bottomMargin = dp(8)
        })
        return column
    }

    private fun grabber(): View = View(context).apply {
        contentDescription = context.getString(R.string.cct_menu)
        background = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(2).toFloat()
            setColor(ColorUtils.setAlphaComponent(ink, (0.3f * 255).toInt()))
        }
    }

    private fun separator(): View = View(context).apply {
        setBackgroundColor(border)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, hairline).apply {
            topMargin = dp(4)
            bottomMargin = dp(4)
        }
    }

    private fun row(item: CustomTabMenu.Item, onClick: () -> Unit): View {
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(ROW_DP)
            setPadding(dp(16), 0, dp(16), 0)
            background = ripple()
            isClickable = true
            isFocusable = true
            setOnClickListener { onClick() }
        }
        val glyph = ImageView(context)
        val icon = iconOf(item)
        if (icon != 0) {
            glyph.setImageResource(icon)
            ImageViewCompat.setImageTintList(glyph, ColorStateList.valueOf(ink))
        }
        row.addView(glyph, LinearLayout.LayoutParams(dp(20), dp(20)).apply { marginEnd = dp(12) })
        val label = TextView(context).apply {
            text = labelOf(item)
            setTextColor(ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        row.addView(label, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.contentDescription = label.text
        return row
    }

    private fun footer(): View = TextView(context).apply {
        text = context.getString(R.string.cct_powered_by)
        setTextColor(inkFaint)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        gravity = Gravity.CENTER_VERTICAL
        minimumHeight = dp(36)
        setPadding(dp(48), 0, dp(16), 0)
    }

    private fun ripple(): RippleDrawable {
        val mask = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            setColor(Color.WHITE)
        }
        return RippleDrawable(ColorStateList.valueOf(ColorUtils.setAlphaComponent(ink, (0.12f * 255).toInt())), null, mask)
    }

    private fun labelOf(item: CustomTabMenu.Item): String = when (item) {
        is CustomTabMenu.Item.Caller -> item.title
        CustomTabMenu.Item.Share -> context.getString(R.string.cct_share)
        CustomTabMenu.Item.CopyLink -> context.getString(R.string.cct_copy_link)
        CustomTabMenu.Item.Reload -> context.getString(R.string.cct_reload)
        CustomTabMenu.Item.FindInPage -> context.getString(R.string.cct_find_in_page)
        CustomTabMenu.Item.OpenInZenium -> context.getString(R.string.cct_open_in_zenium)
    }

    private fun iconOf(item: CustomTabMenu.Item): Int = when (item) {
        is CustomTabMenu.Item.Caller -> 0
        CustomTabMenu.Item.Share -> R.drawable.ic_cct_share
        CustomTabMenu.Item.CopyLink -> R.drawable.ic_cct_copy
        CustomTabMenu.Item.Reload -> R.drawable.ic_cct_reload
        CustomTabMenu.Item.FindInPage -> R.drawable.ic_cct_find
        CustomTabMenu.Item.OpenInZenium -> R.drawable.ic_cct_open_in
    }

    private fun dp(value: Int): Int = (value * density + 0.5f).toInt()

    companion object {
        /** v2 §5: a phone menu row is 44 dp. */
        const val ROW_DP = 44
    }
}
