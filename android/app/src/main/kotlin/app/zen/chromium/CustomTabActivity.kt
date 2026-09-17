package app.zen.chromium

import android.app.PendingIntent
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.browser.customtabs.CustomTabColorSchemeParams
import androidx.browser.customtabs.CustomTabsIntent
import androidx.core.view.WindowInsetsControllerCompat
import com.google.android.material.bottomsheet.BottomSheetDialog

/**
 * A dedicated provider activity: it never boots Zenium's React chrome or creates a core tab.
 * It still uses [TabWebView] and [Host], so page permissions, downloads, uploads and fullscreen
 * behave exactly as they do for a normal Zenium tab.
 */
class CustomTabActivity : MainActivity() {
    private lateinit var pageRoot: FrameLayout
    private lateinit var toolbar: LinearLayout
    private lateinit var title: TextView
    private lateinit var tab: TabWebView
    private var latestUrl: String = ""
    private var toolbarHidden = false
    private var lastScrollY = 0
    private lateinit var colors: CustomTabColors

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        colors = resolveColors(intent)
        applySystemBars(colors)

        pageRoot = FrameLayout(this).apply { setBackgroundColor(if (colors.dark) CustomTabColorSchemeResolver.DARK_PAGE else CustomTabColorSchemeResolver.LIGHT_PAGE) }
        val fullscreenLayer = FrameLayout(this).apply {
            setBackgroundColor(Color.BLACK)
            visibility = View.GONE
        }
        host = Host(this, pageRoot, fullscreenLayer)
        tab = host.tabs.create(CUSTOM_TAB_ID, Profiles.CUSTOM_TAB_CONTAINER)
        tab.layoutParams = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT).apply {
            topMargin = dp(TOOLBAR_HEIGHT_DP)
        }
        tab.visibility = View.VISIBLE

        toolbar = buildToolbar()
        pageRoot.addView(toolbar, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(TOOLBAR_HEIGHT_DP), Gravity.TOP))
        val shell = FrameLayout(this)
        shell.addView(pageRoot, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        shell.addView(fullscreenLayer, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(shell)

        tab.onTitleChanged = { pageTitle -> updateTitle(pageTitle) }
        tab.onUrlChanged = { url ->
            latestUrl = url
            updateTitle(tab.title.orEmpty())
        }
        if (intent.getBooleanExtra(CustomTabsIntent.EXTRA_ENABLE_URLBAR_HIDING, false)) {
            tab.setOnScrollChangeListener { _, _, scrollY, _, oldScrollY ->
                if (scrollY > oldScrollY + dp(8)) hideToolbar()
                else if (scrollY < oldScrollY || scrollY <= dp(8)) showToolbar()
                lastScrollY = scrollY
            }
        }
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (tab.canGoBack()) tab.goBack() else finishCustomTab()
            }
        })

        latestUrl = intent.dataString.orEmpty()
        updateTitle("")
        if (latestUrl.startsWith("http://") || latestUrl.startsWith("https://")) tab.loadUrl(latestUrl)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        intent.dataString?.takeIf { it.startsWith("http://") || it.startsWith("https://") }?.let {
            latestUrl = it
            tab.loadUrl(it)
        }
    }

    private fun buildToolbar(): LinearLayout {
        val bar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(6), 0, dp(6), 0)
            background = GradientDrawable().apply {
                setColor(this@CustomTabActivity.colors.toolbar)
                setStroke(dp(1), hairline(this@CustomTabActivity.colors.dark))
            }
            elevation = dp(2).toFloat()
        }
        val close = closeButton().apply {
            setOnClickListener { finishCustomTab() }
        }
        val secure = ImageView(this).apply {
            contentDescription = "Secure"
            setImageResource(android.R.drawable.ic_lock_lock)
            imageTintList = android.content.res.ColorStateList.valueOf(foreground(colors.dark, 0.72f))
        }
        title = TextView(this).apply {
            setTextColor(foreground(colors.dark, 1f))
            textSize = 14f
            maxLines = 2
            ellipsize = android.text.TextUtils.TruncateAt.END
        }
        val overflow = iconButton("More options").apply {
            setImageResource(android.R.drawable.ic_menu_more)
            setOnClickListener { showMenu() }
        }
        val middle = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(secure, LinearLayout.LayoutParams(dp(20), dp(20)).apply { marginEnd = dp(8) })
            addView(title, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
        val action = actionButton()
        if (intent.getIntExtra(
                CustomTabsIntent.EXTRA_CLOSE_BUTTON_POSITION,
                CustomTabsIntent.CLOSE_BUTTON_POSITION_DEFAULT
            ) == CustomTabsIntent.CLOSE_BUTTON_POSITION_END
        ) {
            bar.addView(middle, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
            action?.let { bar.addView(it) }
            bar.addView(overflow)
            bar.addView(close)
        } else {
            bar.addView(close)
            bar.addView(middle, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1f))
            action?.let { bar.addView(it) }
            bar.addView(overflow)
        }
        return bar
    }

    private fun actionButton(): ImageButton? {
        val bundle = intent.getBundleExtra(CustomTabsIntent.EXTRA_ACTION_BUTTON_BUNDLE) ?: return null
        val icon = parcelable<Bitmap>(bundle, CustomTabsIntent.KEY_ICON) ?: return null
        val pending = parcelable<PendingIntent>(bundle, CustomTabsIntent.KEY_PENDING_INTENT) ?: return null
        return iconButton(bundle.getString(CustomTabsIntent.KEY_DESCRIPTION) ?: "Custom action").apply {
            setImageBitmap(icon)
            setOnClickListener { sendPendingIntent(pending) }
        }
    }

    private fun updateTitle(pageTitle: String) {
        val showTitle = intent.getIntExtra(
            CustomTabsIntent.EXTRA_TITLE_VISIBILITY_STATE,
            CustomTabsIntent.NO_TITLE
        ) == CustomTabsIntent.SHOW_PAGE_TITLE
        title.text = if (showTitle && pageTitle.isNotBlank()) pageTitle else hostOf(latestUrl)
    }

    private fun hideToolbar() {
        if (toolbarHidden) return
        toolbarHidden = true
        toolbar.animate().translationY(-toolbar.height.toFloat()).setDuration(120).start()
    }

    private fun showToolbar() {
        if (!toolbarHidden) return
        toolbarHidden = false
        toolbar.animate().translationY(0f).setDuration(120).start()
    }

    private fun showMenu() {
        val dialog = BottomSheetDialog(this)
        val menu = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(8), dp(12), dp(8), dp(12))
            background = GradientDrawable().apply {
                setColor(if (this@CustomTabActivity.colors.dark) MENU_DARK else MENU_LIGHT)
                setStroke(dp(1), if (this@CustomTabActivity.colors.dark) 0x1fffffff else 0x26000000)
                cornerRadius = dp(12).toFloat()
            }
        }
        fun item(label: String, run: () -> Unit) {
            menu.addView(TextView(this).apply {
                text = label
                textSize = 15f
                gravity = Gravity.CENTER_VERTICAL
                setPadding(dp(16), 0, dp(16), 0)
                setTextColor(if (colors.dark) 0xfffbfbfe.toInt() else 0xff15141a.toInt())
                isClickable = true
                isFocusable = true
                background = selectableBackground()
                setOnClickListener {
                    dialog.dismiss()
                    run()
                }
            }, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(44)))
        }
        item("Share") { shareCurrentPage() }
        item("Open in Zenium") { openInZenium() }
        item("Reload") { tab.reload() }
        callerMenuItems().forEach { (label, pending) -> item(label) { sendPendingIntent(pending) } }
        dialog.setContentView(menu)
        dialog.setOnShowListener {
            dialog.findViewById<FrameLayout>(com.google.android.material.R.id.design_bottom_sheet)?.apply {
                setBackgroundColor(Color.TRANSPARENT)
            }
        }
        dialog.show()
    }

    private fun callerMenuItems(): List<Pair<String, PendingIntent>> {
        val items = intent.getParcelableArrayListExtra<Bundle>(CustomTabsIntent.EXTRA_MENU_ITEMS) ?: return emptyList()
        return items.take(MAX_CALLER_MENU_ITEMS).mapNotNull { item ->
            val title = item.getString(CustomTabsIntent.KEY_MENU_ITEM_TITLE)?.takeIf(String::isNotBlank) ?: return@mapNotNull null
            val pending = parcelable<PendingIntent>(item, CustomTabsIntent.KEY_PENDING_INTENT) ?: return@mapNotNull null
            title to pending
        }
    }

    private fun shareCurrentPage() {
        host.share.share(
            json(
                "title" to tab.title?.toString()?.takeIf(String::isNotBlank),
                "url" to latestUrl,
                "tabId" to CUSTOM_TAB_ID
            )
        ) {}
    }

    private fun openInZenium() {
        startActivity(Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = Uri.parse(latestUrl)
            putExtra(CustomTabsLaunch.EXTRA_REPLAY_FROM_CUSTOM_TAB, true)
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)
        })
        finishCustomTab()
    }

    private fun sendPendingIntent(pending: PendingIntent) {
        runCatching { pending.send(this, 0, Intent().setData(Uri.parse(latestUrl))) }
    }

    private fun finishCustomTab() {
        applyExitAnimation()
        finish()
    }

    private fun applySystemBars(colors: CustomTabColors) {
        window.statusBarColor = colors.toolbar
        window.navigationBarColor = colors.navigationBar
        WindowInsetsControllerCompat(window, window.decorView).apply {
            isAppearanceLightStatusBars = !colors.dark
            isAppearanceLightNavigationBars = !colors.dark
        }
    }

    private fun resolveColors(intent: Intent): CustomTabColors {
        val requested = intent.getIntExtra(CustomTabsIntent.EXTRA_COLOR_SCHEME, CustomTabsIntent.COLOR_SCHEME_SYSTEM)
        val systemDark = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
        val selected = when (requested) {
            CustomTabsIntent.COLOR_SCHEME_DARK -> CustomTabsIntent.COLOR_SCHEME_DARK
            CustomTabsIntent.COLOR_SCHEME_LIGHT -> CustomTabsIntent.COLOR_SCHEME_LIGHT
            else -> if (systemDark) CustomTabsIntent.COLOR_SCHEME_DARK else CustomTabsIntent.COLOR_SCHEME_LIGHT
        }
        val params: CustomTabColorSchemeParams = CustomTabsIntent.getColorSchemeParams(intent, selected)
        return CustomTabColorSchemeResolver.resolve(params.toolbarColor, requested, systemDark)
    }

    private fun iconButton(description: String): ImageButton = ImageButton(this).apply {
        contentDescription = description
        background = selectableBackground()
        imageTintList = android.content.res.ColorStateList.valueOf(foreground(colors.dark, 1f))
        scaleType = ImageView.ScaleType.CENTER_INSIDE
        adjustViewBounds = true
        layoutParams = LinearLayout.LayoutParams(dp(44), dp(44))
    }

    private fun closeButton(): ImageButton {
        val supplied = parcelable<Bitmap>(intent.extras ?: Bundle.EMPTY, CustomTabsIntent.EXTRA_CLOSE_BUTTON_ICON)
        return iconButton("Close custom tab").apply {
            imageTintList = null
            setImageBitmap(supplied ?: defaultCloseIcon())
        }
    }

    private fun defaultCloseIcon(): Bitmap {
        val size = dp(20)
        val inset = dp(4).toFloat()
        return Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888).also { bitmap ->
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = foreground(colors.dark, 1f)
                strokeWidth = 1.75f * resources.displayMetrics.density
                strokeCap = Paint.Cap.ROUND
                style = Paint.Style.STROKE
            }
            val canvas = Canvas(bitmap)
            if (intent.getIntExtra(
                    CustomTabsIntent.EXTRA_CLOSE_BUTTON_POSITION,
                    CustomTabsIntent.CLOSE_BUTTON_POSITION_DEFAULT
                ) == CustomTabsIntent.CLOSE_BUTTON_POSITION_END
            ) {
                canvas.drawLine(inset, inset, size - inset, size - inset, paint)
                canvas.drawLine(size - inset, inset, inset, size - inset, paint)
            } else {
                canvas.drawLine(size - inset, inset, inset, size / 2f, paint)
                canvas.drawLine(inset, size / 2f, size - inset, size - inset, paint)
            }
        }
    }

    private fun selectableBackground(): android.graphics.drawable.Drawable {
        val outValue = android.util.TypedValue()
        theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, outValue, true)
        return getDrawable(outValue.resourceId) ?: GradientDrawable()
    }

    private fun applyExitAnimation() {
        val options = intent.getBundleExtra(CustomTabsIntent.EXTRA_EXIT_ANIMATION_BUNDLE) ?: return
        val enter = options.getInt("android:activity.animEnterRes", 0)
        val exit = options.getInt("android:activity.animExitRes", 0)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            overrideActivityTransition(OVERRIDE_TRANSITION_CLOSE, enter, exit)
        } else {
            @Suppress("DEPRECATION")
            overridePendingTransition(enter, exit)
        }
    }

    @Suppress("DEPRECATION")
    private inline fun <reified T> parcelable(bundle: Bundle, key: String): T? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) bundle.getParcelable(key, T::class.java)
        else bundle.getParcelable(key) as? T

    private fun foreground(dark: Boolean, opacity: Float): Int {
        val base = if (dark) Color.WHITE else Color.BLACK
        return Color.argb((opacity * 255).toInt(), Color.red(base), Color.green(base), Color.blue(base))
    }

    private fun hairline(dark: Boolean): Int =
        if (dark) 0x1fffffff else 0x26000000

    private fun hostOf(url: String): String =
        runCatching { Uri.parse(url).host?.removePrefix("www.") }.getOrNull().orEmpty().ifEmpty { url }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    companion object {
        private const val CUSTOM_TAB_ID = "custom_tab"
        private const val TOOLBAR_HEIGHT_DP = 56
        private const val MAX_CALLER_MENU_ITEMS = 5
        private const val MENU_LIGHT = 0xfff4f4f4.toInt()
        private const val MENU_DARK = 0xff1f1f1f.toInt()
    }
}
