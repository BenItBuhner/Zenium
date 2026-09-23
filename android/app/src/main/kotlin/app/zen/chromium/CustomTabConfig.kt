package app.zen.chromium

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Bitmap
import android.os.Bundle
import androidx.browser.customtabs.CustomTabsIntent
import androidx.browser.customtabs.CustomTabsSessionToken
import androidx.core.content.ContextCompat
import androidx.core.content.IntentCompat
import androidx.core.os.BundleCompat

/**
 * What another app asked of its custom tab, read once from the `CustomTabsIntent` it sent (see
 * `androidx.browser.customtabs.CustomTabsIntent` for the extras). Everything the activity and
 * its toolbar need is here, so the intent is not consulted again.
 */
class CustomTabConfig(
    val url: String,
    /** The caller's session, when it made one through the service; its callback hears about navigations. */
    val session: CustomTabsSessionToken?,
    val callerPackage: String?,
    val scheme: CustomTabScheme.Resolved,
    /** The caller's own close glyph, else Zenium's X. */
    val closeIcon: Bitmap?,
    /** `CLOSE_BUTTON_POSITION_END`: the close control sits after the menu, not before the title. */
    val closeAtEnd: Boolean,
    /** `SHOW_PAGE_TITLE`: the page's title above its host, rather than the host alone. */
    val showTitle: Boolean,
    /** `EXTRA_ENABLE_URLBAR_HIDING`: the toolbar slides away as the page scrolls down. */
    val hideToolbarOnScroll: Boolean,
    val actionButton: ActionButton?,
    /** Up to [MAX_MENU_ITEMS] of the caller's menu entries, in its order. */
    val menuItems: List<MenuItem>,
    /** Whether the menu offers the system share sheet (`EXTRA_SHARE_STATE`). */
    val share: Boolean,
    /** The caller's exit animations (`EXTRA_EXIT_ANIMATION_BUNDLE`), an `ActivityOptions` bundle. */
    val exitAnimation: Bundle?,
    /** The caller's own layout for the bottom toolbar (`EXTRA_REMOTEVIEWS`), when it sent one. */
    val remoteViews: RemoteViews?,
    /** The `EXTRA_TOOLBAR_ITEMS` buttons that belong to the bottom toolbar, in the caller's order. */
    val bottomButtons: List<ActionButton>,
    /** `EXTRA_SECONDARY_TOOLBAR_SWIPE_UP_GESTURE`: fired when the bottom toolbar is swiped up. */
    val swipeUpIntent: PendingIntent?
) {
    class ActionButton(val icon: Bitmap, val description: String, val intent: PendingIntent, val tint: Boolean, val id: Int = CustomTabButtons.TOP_BAR_ID)
    class MenuItem(val title: String, val intent: PendingIntent)

    /**
     * The caller's `RemoteViews` for the bottom toolbar, with the ids it wants clicks from
     * (`EXTRA_REMOTEVIEWS_VIEW_IDS`) and the `PendingIntent` that hears them
     * (`EXTRA_REMOTEVIEWS_PENDINGINTENT`, sent with `EXTRA_REMOTEVIEWS_CLICKED_ID`).
     */
    class RemoteViews(val views: android.widget.RemoteViews, val clickableIds: List<Int>, val clickIntent: PendingIntent?)

    /** Whether there is a bottom toolbar at all: the caller's views or its buttons. */
    val hasBottomBar: Boolean get() = remoteViews != null || bottomButtons.isNotEmpty()

    /** The caller's animation for the tab closing, as resource ids in the caller's package. */
    class ExitAnimation(val packageName: String, val enterRes: Int, val exitRes: Int)

    fun exitAnimation(): ExitAnimation? {
        val bundle = exitAnimation ?: return null
        val packageName = bundle.getString(KEY_ANIMATION_PACKAGE) ?: callerPackage ?: return null
        return ExitAnimation(packageName, bundle.getInt(KEY_ANIMATION_ENTER, 0), bundle.getInt(KEY_ANIMATION_EXIT, 0))
    }

    companion object {
        /** Chrome's cap on the caller's menu entries. */
        const val MAX_MENU_ITEMS = 5

        /** `ActivityOptions`' own keys, as `CustomTabsIntent.Builder.setExitAnimations` stores them. */
        private const val KEY_ANIMATION_PACKAGE = "android:activity.packageName"
        private const val KEY_ANIMATION_ENTER = "android:activity.animEnterRes"
        private const val KEY_ANIMATION_EXIT = "android:activity.animExitRes"

        fun from(context: Context, intent: Intent): CustomTabConfig {
            val extras = intent.extras ?: Bundle()
            val systemDark = context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
            val colorScheme = extras.getInt(CustomTabsIntent.EXTRA_COLOR_SCHEME, CustomTabsIntent.COLOR_SCHEME_SYSTEM)
            val dark = CustomTabScheme.isDark(colorScheme, systemDark)
            val callerParams = CustomTabsIntent.getColorSchemeParams(
                intent, if (dark) CustomTabsIntent.COLOR_SCHEME_DARK else CustomTabsIntent.COLOR_SCHEME_LIGHT
            )
            val scheme = CustomTabScheme.resolve(
                colorScheme, systemDark,
                CustomTabScheme.Params(
                    toolbar = callerParams.toolbarColor,
                    secondaryToolbar = callerParams.secondaryToolbarColor,
                    navigationBar = callerParams.navigationBarColor,
                    navigationBarDivider = callerParams.navigationBarDividerColor
                ),
                light = CustomTabScheme.Defaults(color(context, R.color.v2_window_light), color(context, R.color.v2_page_light)),
                dark = CustomTabScheme.Defaults(color(context, R.color.v2_window_dark), color(context, R.color.v2_page_dark))
            )
            val shareState = extras.getInt(CustomTabsIntent.EXTRA_SHARE_STATE, CustomTabsIntent.SHARE_STATE_DEFAULT)
            @Suppress("DEPRECATION")
            val legacyShare = extras.getBoolean(CustomTabsIntent.EXTRA_DEFAULT_SHARE_MENU_ITEM, true)
            val tint = extras.getBoolean(CustomTabsIntent.EXTRA_TINT_ACTION_BUTTON, false)
            val actionBundle = actionButton(extras.getBundle(CustomTabsIntent.EXTRA_ACTION_BUTTON_BUNDLE), tint)
            val items = toolbarItems(extras, tint)
            val placement = CustomTabButtons.place(actionBundle != null, items.map { it.id })
            return CustomTabConfig(
                url = intent.dataString ?: "about:blank",
                session = CustomTabsSessionToken.getSessionTokenFromIntent(intent),
                callerPackage = intent.getStringExtra(CustomTabIntents.EXTRA_CALLER_PACKAGE),
                scheme = scheme,
                closeIcon = IntentCompat.getParcelableExtra(intent, CustomTabsIntent.EXTRA_CLOSE_BUTTON_ICON, Bitmap::class.java),
                closeAtEnd = extras.getInt(CustomTabsIntent.EXTRA_CLOSE_BUTTON_POSITION, CustomTabsIntent.CLOSE_BUTTON_POSITION_DEFAULT) ==
                    CustomTabsIntent.CLOSE_BUTTON_POSITION_END,
                showTitle = extras.getInt(CustomTabsIntent.EXTRA_TITLE_VISIBILITY_STATE, CustomTabsIntent.NO_TITLE) == CustomTabsIntent.SHOW_PAGE_TITLE,
                hideToolbarOnScroll = extras.getBoolean(CustomTabsIntent.EXTRA_ENABLE_URLBAR_HIDING, false),
                actionButton = actionBundle ?: placement.top?.let { items[it] },
                menuItems = menuItems(extras),
                share = shareState != CustomTabsIntent.SHARE_STATE_OFF && (shareState == CustomTabsIntent.SHARE_STATE_ON || legacyShare),
                exitAnimation = extras.getBundle(CustomTabsIntent.EXTRA_EXIT_ANIMATION_BUNDLE),
                remoteViews = remoteViews(extras),
                bottomButtons = placement.bottom.map { items[it] },
                swipeUpIntent = CustomTabsIntent.getSecondaryToolbarSwipeUpGesture(intent)
            )
        }

        /** One custom button bundle (`KEY_ICON`, `KEY_DESCRIPTION`, `KEY_PENDING_INTENT`, `KEY_ID`); null when unusable. */
        fun actionButton(bundle: Bundle?, tint: Boolean): ActionButton? {
            if (bundle == null) return null
            val icon = BundleCompat.getParcelable(bundle, CustomTabsIntent.KEY_ICON, Bitmap::class.java) ?: return null
            val intent = BundleCompat.getParcelable(bundle, CustomTabsIntent.KEY_PENDING_INTENT, PendingIntent::class.java) ?: return null
            return ActionButton(
                icon = icon,
                description = bundle.getString(CustomTabsIntent.KEY_DESCRIPTION) ?: "",
                intent = intent,
                tint = tint,
                id = bundle.getInt(CustomTabsIntent.KEY_ID, CustomTabButtons.TOP_BAR_ID)
            )
        }

        private fun toolbarItems(extras: Bundle, tint: Boolean): List<ActionButton> {
            val bundles = BundleCompat.getParcelableArrayList(extras, CustomTabsIntent.EXTRA_TOOLBAR_ITEMS, Bundle::class.java) ?: return emptyList()
            return bundles.mapNotNull { actionButton(it, tint) }
        }

        /** The bottom toolbar's `RemoteViews` with its clickable ids and their intent; null without views. */
        fun remoteViews(extras: Bundle): RemoteViews? {
            val views = BundleCompat.getParcelable(extras, CustomTabsIntent.EXTRA_REMOTEVIEWS, android.widget.RemoteViews::class.java) ?: return null
            return RemoteViews(
                views = views,
                clickableIds = CustomTabButtons.clickTargets(extras.getIntArray(CustomTabsIntent.EXTRA_REMOTEVIEWS_VIEW_IDS)),
                clickIntent = BundleCompat.getParcelable(extras, CustomTabsIntent.EXTRA_REMOTEVIEWS_PENDINGINTENT, PendingIntent::class.java)
            )
        }

        private fun menuItems(extras: Bundle): List<MenuItem> {
            val bundles = BundleCompat.getParcelableArrayList(extras, CustomTabsIntent.EXTRA_MENU_ITEMS, Bundle::class.java) ?: return emptyList()
            val items = ArrayList<MenuItem>()
            for (bundle in bundles) {
                val title = bundle.getString(CustomTabsIntent.KEY_MENU_ITEM_TITLE)?.trim()?.ifEmpty { null } ?: continue
                val intent = BundleCompat.getParcelable(bundle, CustomTabsIntent.KEY_PENDING_INTENT, PendingIntent::class.java) ?: continue
                items.add(MenuItem(title, intent))
                if (items.size == MAX_MENU_ITEMS) break
            }
            return items
        }

        private fun color(context: Context, id: Int): Int = ContextCompat.getColor(context, id)
    }
}
