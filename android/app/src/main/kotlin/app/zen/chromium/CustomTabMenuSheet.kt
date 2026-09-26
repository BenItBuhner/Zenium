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
import android.view.accessibility.AccessibilityManager
import android.widget.CheckBox
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.core.graphics.ColorUtils
import androidx.core.view.AccessibilityDelegateCompat
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.core.widget.ImageViewCompat
import com.google.android.material.bottomsheet.BottomSheetBehavior
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * The custom tab's menu: the phone sheet of the v2 draft (§6) drawn natively, since a custom
 * tab has no chrome. Neutral panel surface with the native chassis's hairline edge ([SheetEdge]:
 * top and sides, one dp, the sides running through the host's bar to the screen's bottom with the
 * bar as the column's own padding, as the prompt sheet's and the extension sheet's do) and 12 dp
 * top corners, a 32×4 grabber, then – a custom tab's, not a web app's – Chrome's icon row (§9.13:
 * 44 × 44 buttons with 20 dp glyphs spread evenly inside the 16 gutter, a hairline 8 below; the
 * star its one stateful glyph; Reload read as Stop once, at open), rows 44 dp tall at 15/400 with
 * a 20 dp glyph (the caller's own items keep the glyph slot so every label lines up), one-dp
 * hairlines with 4 dp margins between [CustomTabMenu.groups], and a footer naming the browser
 * the page is running in, as Chrome's and Firefox's custom tabs do. Under touch exploration or
 * a font scale of 1.3 and up the icon row is a list of the same actions (A11Y-04).
 */
class CustomTabMenuSheet(
    private val context: Context,
    private val dark: Boolean,
    private val groups: List<List<CustomTabMenu.Item>>,
    private val onPick: (CustomTabMenu.Item) -> Unit,
    private val iconRow: List<CustomTabMenu.IconButton> = emptyList(),
    private val onIcon: (CustomTabMenu.Icon) -> Unit = {}
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
        if (iconRow.isNotEmpty()) {
            if (iconRowAsList()) {
                for (button in iconRow) column.addView(iconListRow(button) {
                    dialog.dismiss()
                    onIcon(button.icon)
                })
            } else {
                column.addView(iconRow(dialog), LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(ROW_DP)).apply {
                    bottomMargin = dp(4)
                })
            }
            column.addView(separator())
        }
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

    /** A11Y-04: with touch exploration on, or text at 1.3 and up, the icon row's actions are rows. */
    private fun iconRowAsList(): Boolean {
        val manager = context.getSystemService(Context.ACCESSIBILITY_SERVICE) as? AccessibilityManager
        return manager?.isTouchExplorationEnabled == true || context.resources.configuration.fontScale >= LARGE_TEXT_FONT_SCALE
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

    /**
     * The icon row: each button a 44 dp box round a 20 dp glyph, the boxes at the gutter's edges
     * and the space between them shared out evenly (the phone row's `space-between`).
     */
    private fun iconRow(dialog: BottomSheetDialog): View {
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(16), 0, dp(16), 0)
        }
        iconRow.forEachIndexed { index, button ->
            if (index > 0) row.addView(View(context), LinearLayout.LayoutParams(0, 1, 1f))
            row.addView(iconButton(button) {
                dialog.dismiss()
                onIcon(button.icon)
            }, LinearLayout.LayoutParams(dp(ROW_DP), dp(ROW_DP)))
        }
        return row
    }

    private fun iconButton(button: CustomTabMenu.IconButton, onClick: () -> Unit): View = ImageView(context).apply {
        setImageResource(glyphOf(button))
        ImageViewCompat.setImageTintList(this, ColorStateList.valueOf(ink))
        setPadding(dp(12), dp(12), dp(12), dp(12))
        background = ripple(round = true)
        contentDescription = nameOf(button)
        isClickable = true
        isFocusable = true
        isEnabled = button.enabled
        // §9.30: a disabled control stands at .4 of its ink.
        if (!button.enabled) alpha = DISABLED_ALPHA
        setOnClickListener { onClick() }
    }

    /** The icon row's action as a text row (A11Y-04), the glyph in the row's slot. */
    private fun iconListRow(button: CustomTabMenu.IconButton, onClick: () -> Unit): View =
        row(glyphOf(button), nameOf(button), checked = null, enabled = button.enabled, onClick = onClick)

    private fun row(item: CustomTabMenu.Item, onClick: () -> Unit): View =
        row(iconOf(item), labelOf(item), checked = (item as? CustomTabMenu.Item.DesktopSite)?.checked, enabled = true, onClick = onClick)

    private fun row(icon: Int, label: String, checked: Boolean?, enabled: Boolean, onClick: () -> Unit): View {
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = dp(ROW_DP)
            setPadding(dp(16), 0, dp(16), 0)
            background = ripple(round = false)
            isClickable = true
            isFocusable = true
            isEnabled = enabled
            if (!enabled) alpha = DISABLED_ALPHA
            setOnClickListener { onClick() }
        }
        val glyph = ImageView(context)
        if (icon != 0) {
            glyph.setImageResource(icon)
            ImageViewCompat.setImageTintList(glyph, ColorStateList.valueOf(ink))
        }
        row.addView(glyph, LinearLayout.LayoutParams(dp(20), dp(20)).apply { marginEnd = dp(12) })
        val text = TextView(context).apply {
            text = label
            setTextColor(ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        row.addView(text, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        row.contentDescription = label
        if (checked != null) {
            // Chrome's check row: the mark in the trailing slot while on; the row reads as a checkbox.
            val mark = ImageView(context).apply {
                setImageResource(R.drawable.ic_check)
                ImageViewCompat.setImageTintList(this, ColorStateList.valueOf(ink))
                visibility = if (checked) View.VISIBLE else View.INVISIBLE
                importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
            }
            row.addView(mark, LinearLayout.LayoutParams(dp(20), dp(20)).apply { marginStart = dp(12) })
            ViewCompat.setAccessibilityDelegate(row, object : AccessibilityDelegateCompat() {
                override fun onInitializeAccessibilityNodeInfo(host: View, info: AccessibilityNodeInfoCompat) {
                    super.onInitializeAccessibilityNodeInfo(host, info)
                    info.className = CheckBox::class.java.name
                    info.isCheckable = true
                    info.isChecked = checked
                }
            })
        }
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

    private fun ripple(round: Boolean): RippleDrawable {
        val mask = GradientDrawable().apply {
            shape = if (round) GradientDrawable.OVAL else GradientDrawable.RECTANGLE
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
        CustomTabMenu.Item.AddToHomeScreen -> context.getString(R.string.cct_add_to_home_screen)
        is CustomTabMenu.Item.DesktopSite -> context.getString(R.string.cct_desktop_site)
        CustomTabMenu.Item.OpenInZenium -> context.getString(R.string.cct_open_in_zenium)
    }

    private fun iconOf(item: CustomTabMenu.Item): Int = when (item) {
        is CustomTabMenu.Item.Caller -> 0
        CustomTabMenu.Item.Share -> R.drawable.ic_cct_share
        CustomTabMenu.Item.CopyLink -> R.drawable.ic_cct_copy
        CustomTabMenu.Item.Reload -> R.drawable.ic_cct_reload
        CustomTabMenu.Item.FindInPage -> R.drawable.ic_cct_find
        CustomTabMenu.Item.AddToHomeScreen -> R.drawable.ic_cct_add_home
        is CustomTabMenu.Item.DesktopSite -> R.drawable.ic_cct_desktop
        CustomTabMenu.Item.OpenInZenium -> R.drawable.ic_cct_open_in
    }

    /** The icon row's names, the phone row's (TB-08): the star's by its state, Reload's by the page's, read once. */
    private fun nameOf(button: CustomTabMenu.IconButton): String = when (button.icon) {
        CustomTabMenu.Icon.Forward -> context.getString(R.string.cct_forward)
        CustomTabMenu.Icon.Bookmark -> context.getString(if (button.filled) R.string.cct_edit_bookmark else R.string.cct_bookmark)
        CustomTabMenu.Icon.Download -> context.getString(R.string.cct_download_page)
        CustomTabMenu.Icon.Info -> context.getString(R.string.cct_page_info)
        CustomTabMenu.Icon.Reload -> context.getString(if (button.stop) R.string.cct_stop else R.string.cct_reload)
    }

    private fun glyphOf(button: CustomTabMenu.IconButton): Int = when (button.icon) {
        CustomTabMenu.Icon.Forward -> R.drawable.ic_cct_forward
        CustomTabMenu.Icon.Bookmark -> if (button.filled) R.drawable.ic_cct_star_filled else R.drawable.ic_cct_star
        CustomTabMenu.Icon.Download -> R.drawable.ic_cct_download
        CustomTabMenu.Icon.Info -> R.drawable.ic_cct_info
        CustomTabMenu.Icon.Reload -> if (button.stop) R.drawable.ic_cct_stop else R.drawable.ic_cct_reload
    }

    private fun dp(value: Int): Int = (value * density + 0.5f).toInt()

    companion object {
        /** v2 §5: a phone menu row is 44 dp; the icon row's buttons are 44 dp boxes. */
        const val ROW_DP = 44
        /** §9.30: a disabled control at .4. */
        const val DISABLED_ALPHA = 0.4f
        /** A11Y-04: from this font scale the icon row is a list. */
        const val LARGE_TEXT_FONT_SCALE = 1.3f
    }
}
