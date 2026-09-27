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
    /**
     * The caller's share state (`EXTRA_SHARE_STATE` with the deprecated flag folded in,
     * [CustomTabButtons.shareState]; the default when it sent none): with [actionButton] it
     * decides the toolbar's one action slot ([toolbarSlot], CCT-17).
     */
    val shareState: Int = CustomTabsIntent.SHARE_STATE_DEFAULT,
    /** The icon row's star, unless the caller sent `EXTRA_DISABLE_BOOKMARKS_BUTTON`. */
    val bookmarksButton: Boolean = true,
    /** The icon row's Download, unless the caller sent `EXTRA_DISABLE_DOWNLOAD_BUTTON`. */
    val downloadButton: Boolean = true,
    /** The caller's exit animations (`EXTRA_EXIT_ANIMATION_BUNDLE`), an `ActivityOptions` bundle. */
    val exitAnimation: Bundle?,
    /** The caller's own layout for the bottom toolbar (`EXTRA_REMOTEVIEWS`), when it sent one. */
    val remoteViews: RemoteViews?,
    /** The `EXTRA_TOOLBAR_ITEMS` buttons that belong to the bottom toolbar, in the caller's order. */
    val bottomButtons: List<ActionButton>,
    /** `EXTRA_SECONDARY_TOOLBAR_SWIPE_UP_GESTURE`: fired when the bottom toolbar is swiped up. */
    val swipeUpIntent: PendingIntent?,
    /**
     * The Auth Tab's redirect (CCT-13, `AuthTabIntent.EXTRA_LAUNCH_AUTH_TAB`): set, the tab hands
     * the caller its redirect as the activity's result instead of loading it ([AuthTabVerifier]),
     * and wears Chrome's Auth Tab chrome – the title row, no share, no star or Download, no
     * caller buttons, menu rows or bottom toolbar, the toolbar never hiding. Null on every
     * ordinary custom tab, whose one cost for the feature is this null.
     */
    val authTab: AuthTab.Redirect? = null,
    /** The Auth Tab's session (its `AuthTabCallback` binder under `EXTRA_SESSION`), in place of [session]. */
    val authSession: AuthTabSession? = null,
    /**
     * The origins a Trusted Web Activity's client claims (CCT-20; `EXTRA_LAUNCH_AS_TRUSTED_WEB_ACTIVITY`
     * sent with a session, the two Chrome's `CustomTabIntentDataProvider.java:651-656` requires
     * of a TWA): the launch URL's and `EXTRA_ADDITIONAL_TRUSTED_ORIGINS` ([TwaScope.trustedOrigins]).
     * Each is verified against its Digital Asset Links statement ([TwaVerifier]); the tab hides
     * its toolbar while the page is on one of them and shows it elsewhere. Null on every
     * ordinary custom tab, whose one cost for the feature is this null.
     */
    val trustedOrigins: Set<String>? = null
) {
    /** Whether this tab was launched as a Trusted Web Activity. */
    val trustedWebActivity: Boolean get() = trustedOrigins != null

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

    /**
     * The toolbar's one action slot: the caller's button, Zenium's Share when the caller sent
     * none and did not turn share off, or nothing ([CustomTabButtons.topSlot]).
     */
    val toolbarSlot: CustomTabButtons.Slot get() = CustomTabButtons.topSlot(actionButton != null, shareState)

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
            @Suppress("DEPRECATION")
            val shareState = CustomTabButtons.shareState(
                extras.getInt(CustomTabsIntent.EXTRA_SHARE_STATE, CustomTabsIntent.SHARE_STATE_DEFAULT),
                legacyShareItem = extras.getBoolean(CustomTabsIntent.EXTRA_DEFAULT_SHARE_MENU_ITEM, true)
            )
            val tint = extras.getBoolean(CustomTabsIntent.EXTRA_TINT_ACTION_BUTTON, false)
            val actionBundle = actionButton(extras.getBundle(CustomTabsIntent.EXTRA_ACTION_BUTTON_BUNDLE), tint)
            val items = toolbarItems(extras, tint)
            val placement = CustomTabButtons.place(actionBundle != null, items.map { it.id })
            val authTab = AuthTab.redirect(
                launch = extras.getBoolean(AuthTab.EXTRA_LAUNCH_AUTH_TAB, false),
                scheme = extras.getString(AuthTab.EXTRA_REDIRECT_SCHEME),
                host = extras.getString(AuthTab.EXTRA_HTTPS_REDIRECT_HOST),
                path = extras.getString(AuthTab.EXTRA_HTTPS_REDIRECT_PATH)
            )
            if (authTab != null) return authTabConfig(intent, extras, scheme, authTab)
            val url = intent.dataString ?: "about:blank"
            val session = CustomTabsSessionToken.getSessionTokenFromIntent(intent)
            return CustomTabConfig(
                url = url,
                session = session,
                callerPackage = intent.getStringExtra(CustomTabIntents.EXTRA_CALLER_PACKAGE),
                scheme = scheme,
                closeIcon = IntentCompat.getParcelableExtra(intent, CustomTabsIntent.EXTRA_CLOSE_BUTTON_ICON, Bitmap::class.java),
                closeAtEnd = extras.getInt(CustomTabsIntent.EXTRA_CLOSE_BUTTON_POSITION, CustomTabsIntent.CLOSE_BUTTON_POSITION_DEFAULT) ==
                    CustomTabsIntent.CLOSE_BUTTON_POSITION_END,
                showTitle = extras.getInt(CustomTabsIntent.EXTRA_TITLE_VISIBILITY_STATE, CustomTabsIntent.NO_TITLE) == CustomTabsIntent.SHOW_PAGE_TITLE,
                hideToolbarOnScroll = extras.getBoolean(CustomTabsIntent.EXTRA_ENABLE_URLBAR_HIDING, false),
                actionButton = actionBundle ?: placement.top?.let { items[it] },
                menuItems = menuItems(extras),
                share = shareState != CustomTabsIntent.SHARE_STATE_OFF,
                shareState = shareState,
                bookmarksButton = !extras.getBoolean(CustomTabsIntent.EXTRA_DISABLE_BOOKMARKS_BUTTON, false),
                downloadButton = !extras.getBoolean(CustomTabsIntent.EXTRA_DISABLE_DOWNLOAD_BUTTON, false),
                exitAnimation = extras.getBundle(CustomTabsIntent.EXTRA_EXIT_ANIMATION_BUNDLE),
                remoteViews = remoteViews(extras),
                bottomButtons = placement.bottom.map { items[it] },
                swipeUpIntent = CustomTabsIntent.getSecondaryToolbarSwipeUpGesture(intent),
                trustedOrigins = trustedOrigins(extras, session, url)
            )
        }

        /**
         * A Trusted Web Activity's claimed origins, null for anything else: the launch flag
         * counts only with a session, as Chrome's (a TWA without one is a plain custom tab).
         */
        private fun trustedOrigins(extras: Bundle, session: CustomTabsSessionToken?, url: String): Set<String>? {
            if (session == null || !extras.getBoolean(TwaScope.EXTRA_LAUNCH_AS_TRUSTED_WEB_ACTIVITY, false)) return null
            return TwaScope.trustedOrigins(url, extras.getStringArrayList(TwaScope.EXTRA_ADDITIONAL_TRUSTED_ORIGINS))
        }

        /**
         * An Auth Tab's config: Chrome's `AuthTabIntentDataProvider` reads the colour scheme, the
         * close icon and the exit animation off the intent and nothing else of the custom tab's
         * extras – no action or toolbar buttons, no menu rows, no bottom toolbar, share off, no
         * star or Download, the title shown, the toolbar never hiding – so neither does this. The
         * session is the auth kind ([AuthTabSession]), never a `CustomTabsSessionToken` over the
         * same binder.
         */
        private fun authTabConfig(intent: Intent, extras: Bundle, scheme: CustomTabScheme.Resolved, authTab: AuthTab.Redirect): CustomTabConfig =
            CustomTabConfig(
                url = intent.dataString ?: "about:blank",
                session = null,
                callerPackage = intent.getStringExtra(CustomTabIntents.EXTRA_CALLER_PACKAGE),
                scheme = scheme,
                closeIcon = IntentCompat.getParcelableExtra(intent, CustomTabsIntent.EXTRA_CLOSE_BUTTON_ICON, Bitmap::class.java),
                closeAtEnd = false,
                showTitle = true,
                hideToolbarOnScroll = false,
                actionButton = null,
                menuItems = emptyList(),
                share = false,
                shareState = CustomTabsIntent.SHARE_STATE_OFF,
                bookmarksButton = false,
                downloadButton = false,
                exitAnimation = extras.getBundle(CustomTabsIntent.EXTRA_EXIT_ANIMATION_BUNDLE),
                remoteViews = null,
                bottomButtons = emptyList(),
                swipeUpIntent = null,
                authTab = authTab,
                authSession = AuthTabSession.fromIntent(intent)
            )

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
