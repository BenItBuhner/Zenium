package app.zen.chromium.ext

import android.graphics.Bitmap
import android.util.Base64
import java.io.ByteArrayOutputStream

/**
 * `setIcon` pixels to the slot the chrome draws ([ActionCalls.ICON_SLOT]): an ARGB bitmap, scaled
 * down with filtering when larger than the slot (a smaller icon stays its size; upscaling would
 * only blur it), encoded as PNG into a data URL. Runs on the main thread at the guard's rate of
 * one per frame ([BridgeForward.Limits.iconsPerFrame]); a 96 px icon is a few milliseconds.
 */
object IconScaling : ActionCalls.IconScaler {
    override fun scale(width: Int, height: Int, argb: IntArray): ActionCalls.Scaled? {
        if (width <= 0 || height <= 0 || argb.size < width * height) return null
        return runCatching {
            val source = Bitmap.createBitmap(argb, width, height, Bitmap.Config.ARGB_8888)
            val longest = maxOf(width, height)
            val bitmap = if (longest <= ActionCalls.ICON_SLOT) {
                source
            } else {
                val factor = ActionCalls.ICON_SLOT.toFloat() / longest
                Bitmap.createScaledBitmap(source, maxOf(1, Math.round(width * factor)), maxOf(1, Math.round(height * factor)), true)
            }
            val out = ByteArrayOutputStream(4096)
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out)
            ActionCalls.Scaled(
                maxOf(bitmap.width, bitmap.height),
                "data:image/png;base64," + Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
            )
        }.getOrNull()
    }
}
