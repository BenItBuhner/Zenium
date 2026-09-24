package app.zen.chromium

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.Bitmap
import android.graphics.drawable.AdaptiveIconDrawable
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.ColorDrawable
import android.util.Log
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.core.splashscreen.SplashScreenViewProvider
import kotlin.math.roundToInt

/**
 * An installed web app's cold launch splash (PWA-06): the app's tile on its manifest
 * `background_color`, held until the page's first frame, through the same `SplashScreen`
 * mechanism as the browser's ([StartupSplash]) – as Chrome's `SplashController` holds a web app's
 * splash (`WebappSplashDelegate`: the icon on the background colour) to the page's first paint.
 *
 * WHAT THE PLATFORM ALLOWS. The starting window is the system's: `ActivityRecord.showStartingWindow`
 * has WM Shell's `SplashscreenContentDrawer` draw it from the activity's THEME – the
 * `windowSplashScreenBackground` colour and the `windowSplashScreenAnimatedIcon` drawable are
 * resolved from the APK's resources before any code of the app runs – and `SplashScreen.
 * setSplashScreenTheme` picks a resource theme per package, nothing per launch. A colour the
 * manifest chose and a tile the install drew cannot be on that window. So the theme
 * (`Theme.Zen.WebApp.Splash`) gives it a fixed ground – the web app window's default page colour,
 * light or night – and a transparent icon (no false Zenium mark on the app's splash), and at the
 * platform's hand-over of its `SplashScreenView` to the window (the exit listener, at the window's
 * first frame) this class dresses that very view: its background to the app's colour (a short
 * blend from the fixed ground; nothing to blend for an app with no `background_color`, whose page
 * colour the ground already is), the app's tile at the platform's icon size in its centre, the
 * bars' icons in the tone the ground wants. THE LIMIT: from the tap to the window's first frame
 * the splash is the fixed ground with no icon; the app's colour and icon are on screen from then
 * to the page's first frame (the longer part of a launch that has a network on it).
 *
 * The tile is the install's adaptive layer ([WebAppStore.tileFile], `Shortcuts.drawTile`),
 * drawn as the launcher draws it: an [AdaptiveIconDrawable] of the layer under the device's mask,
 * so the splash's icon is the home screen's. It is decoded off the main thread
 * (`WebAppActivity.describeTask`) and lands here when ready, before or after the hand-over.
 */
class WebAppSplash(
    private val context: Context,
    /** The app's ground from the hand-over on: the manifest's `background_color`, else the window's page colour. */
    val color: Int,
    private val animatorsEnabled: () -> Boolean = { ValueAnimator.areAnimatorsEnabled() }
) {
    private var iconView: ImageView? = null
    private var icon: Bitmap? = null

    /** The bars' icon tone over [color]: dark icons on a light ground, by the custom tab's 3:1 rule. */
    val lightBars: Boolean get() = lightBarsOver(color)

    /** The tile, decoded: onto the splash when it is up, kept for the hand-over otherwise. */
    fun setIcon(bitmap: Bitmap) {
        icon = bitmap
        iconView?.let { show(it, bitmap) }
    }

    /** [StartupSplash]'s skin: the platform's view, at the hand-over, dressed as the app's. */
    fun skin(provider: SplashScreenViewProvider): SplashSkin {
        val view = provider.view
        val from = (view.background as? ColorDrawable)?.color
        val platformIcon = runCatching { provider.iconView }.getOrNull()
        val size = iconSizePx(platformIcon?.width ?: 0, context.resources.displayMetrics.density)
        // The platform's icon view drew the theme's transparent icon: out of the way, the tile
        // in its place at its size (the view is the platform's; a version without a group or an
        // icon view still gets the colour).
        platformIcon?.visibility = View.GONE
        val image = ImageView(context).apply { alpha = 0f }
        (view as? ViewGroup)?.addView(image, FrameLayout.LayoutParams(size, size, Gravity.CENTER))
        iconView = image
        icon?.let { show(image, it) }
        val motion = animatorsEnabled() && from != null && from != color
        if (!motion) {
            view.setBackgroundColor(color)
            image.alpha = 1f
        } else {
            ValueAnimator.ofArgb(from!!, color).apply {
                duration = DRESS_MS
                addUpdateListener { view.setBackgroundColor(it.animatedValue as Int) }
            }.start()
            image.animate().alpha(1f).setDuration(DRESS_MS).start()
        }
        Log.i(StartupSplash.TAG, "web app splash: dressed at the hand-over, ground #${Integer.toHexString(color)}, icon ${if (icon != null) "on" else "pending"}, ${size}px")
        return SplashSkin(image, lightBars)
    }

    private fun show(image: ImageView, bitmap: Bitmap) {
        image.setImageDrawable(AdaptiveIconDrawable(null, BitmapDrawable(context.resources, bitmap)))
    }

    companion object {
        /** The platform's splash icon without an icon background: 192 dp (WM Shell's `starting_surface_icon_size` at its no-background scale). */
        const val ICON_DP = 192
        /** The blend from the theme's fixed ground to the app's colour at the hand-over. */
        const val DRESS_MS = 150L

        /** The app's ground: the manifest's colour, else the window's page colour for the scheme. */
        fun ground(backgroundColor: Int?, pageColor: Int): Int = backgroundColor ?: pageColor

        /** The icon's side in px: the platform's icon view's when it laid one out, else [ICON_DP] at `density`. */
        fun iconSizePx(platformIconPx: Int, density: Float): Int =
            if (platformIconPx > 0) platformIconPx else (ICON_DP * density).roundToInt()

        /** Dark icons (light bars) over a ground white does not contrast with 3:1. */
        fun lightBarsOver(color: Int): Boolean = !CustomTabScheme.needsLightForeground(color)
    }
}
