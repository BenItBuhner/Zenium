package app.zen.chromium

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.graphics.ColorUtils
import androidx.core.widget.ImageViewCompat
import androidx.core.widget.doAfterTextChanged

/**
 * Find in page for a custom tab: a row that takes the toolbar's place while it is up – the
 * field, the `active/total` count at 69 percent, previous and next, and a close – in the
 * toolbar's own colours. The page does the searching (`TabWebView.find`); [setCount] shows what
 * it found.
 */
class CustomTabFindBar(context: Context, ink: Int, height: Int, private val listener: Listener) : LinearLayout(context) {
    interface Listener {
        fun onFind(text: String, forward: Boolean, newSession: Boolean)
        fun onFindClosed()
    }

    private val density = resources.displayMetrics.density
    private val inkFaint = ColorUtils.setAlphaComponent(ink, (0.69f * 255).toInt())
    private val field = EditText(context)
    private val count = TextView(context)

    init {
        orientation = HORIZONTAL
        gravity = Gravity.CENTER_VERTICAL
        setPadding(dp(4), 0, dp(4), 0)
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, height)
        isClickable = true

        field.apply {
            background = null
            hint = context.getString(R.string.cct_find_hint)
            setHintTextColor(inkFaint)
            setTextColor(ink)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
            imeOptions = EditorInfo.IME_ACTION_SEARCH or EditorInfo.IME_FLAG_NO_EXTRACT_UI
            isSingleLine = true
            setPadding(dp(12), 0, dp(8), 0)
            doAfterTextChanged { text ->
                val query = text?.toString() ?: ""
                if (query.isEmpty()) count.text = ""
                // An empty query clears the page's matches (see the activity).
                listener.onFind(query, true, true)
            }
            setOnEditorActionListener { _, actionId, event ->
                val enter = event?.keyCode == KeyEvent.KEYCODE_ENTER && event.action == KeyEvent.ACTION_DOWN
                if (actionId == EditorInfo.IME_ACTION_SEARCH || enter) {
                    next(true)
                    true
                } else false
            }
        }
        addView(field, LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))

        count.apply {
            setTextColor(inkFaint)
            setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
            setPadding(dp(4), 0, dp(4), 0)
        }
        addView(count, LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        addView(button(R.drawable.ic_cct_chevron_up, R.string.cct_find_previous, ink) { next(false) })
        addView(button(R.drawable.ic_cct_chevron_down, R.string.cct_find_next, ink) { next(true) })
        addView(button(R.drawable.ic_cct_close, R.string.cct_find_close, ink) { listener.onFindClosed() })
    }

    /** What the page reported (`found`): `active` is 1-based, 0 with no matches. */
    fun setCount(active: Int, matches: Int) {
        count.text = if (field.text.isNullOrEmpty()) "" else context.getString(R.string.cct_find_count, active, matches)
    }

    fun focusField() {
        field.requestFocus()
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.showSoftInput(field, InputMethodManager.SHOW_IMPLICIT)
    }

    fun hideKeyboard() {
        val imm = context.getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager
        imm.hideSoftInputFromWindow(field.windowToken, 0)
    }

    fun clear() {
        field.setText("")
        count.text = ""
    }

    private fun next(forward: Boolean) {
        val query = field.text?.toString() ?: return
        if (query.isNotEmpty()) listener.onFind(query, forward, false)
    }

    private fun button(icon: Int, description: Int, ink: Int, onClick: () -> Unit): ImageButton {
        val button = ImageButton(context)
        button.layoutParams = LayoutParams(dp(CustomTabToolbar.BUTTON_DP), dp(CustomTabToolbar.BUTTON_DP))
        val mask = GradientDrawable().apply {
            shape = GradientDrawable.RECTANGLE
            cornerRadius = dp(8).toFloat()
            setColor(Color.WHITE)
        }
        button.background = RippleDrawable(ColorStateList.valueOf(ColorUtils.setAlphaComponent(ink, (0.14f * 255).toInt())), null, mask)
        button.scaleType = ImageView.ScaleType.FIT_CENTER
        button.setPadding(dp(12), dp(12), dp(12), dp(12))
        button.setImageResource(icon)
        ImageViewCompat.setImageTintList(button, ColorStateList.valueOf(ink))
        button.contentDescription = context.getString(description)
        button.setOnClickListener { onClick() }
        return button
    }

    private fun dp(value: Int): Int = (value * density + 0.5f).toInt()

    override fun onVisibilityChanged(changedView: View, visibility: Int) {
        super.onVisibilityChanged(changedView, visibility)
        if (changedView === this && visibility != VISIBLE) hideKeyboard()
    }
}
