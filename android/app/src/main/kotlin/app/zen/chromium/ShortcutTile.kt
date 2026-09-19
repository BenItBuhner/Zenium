package app.zen.chromium

import kotlin.math.max
import kotlin.math.roundToInt

/** A square placed on the tile canvas, in canvas pixels. */
data class Square(val left: Float, val top: Float, val size: Float) {
    val right: Float get() = left + size
    val bottom: Float get() = top + size
}

/**
 * The geometry of a Home-screen tile ("Add to Home screen"): where a web app's icon lands on the
 * adaptive icon canvas and what fills the rest of it. An adaptive icon layer is a 108 dp square of
 * which the launcher's mask shows the central 72 dp, and only the central 66 dp are guaranteed to
 * stay visible under every mask; a maskable web icon (W3C) keeps its own content inside the central
 * 80 % circle. Everything here is arithmetic on those numbers so it can be unit-tested on the JVM;
 * the drawing lives in `Shortcuts`.
 */
object ShortcutTile {
    const val CANVAS_DP = 108
    const val VISIBLE_DP = 72
    const val SAFE_DP = 66
    /** The share of a maskable icon its author keeps important content in. */
    const val MASKABLE_SAFE_SHARE = 0.8f
    /** An `any` icon sits inside the safe zone with a little air around it. */
    const val ANY_SHARE = 0.56f
    /** A monochrome glyph is smaller still: it is a symbol on a colour, not a picture. */
    const val MONOCHROME_SHARE = 0.44f
    /** The letter of a letter tile, as a share of the canvas (its text size). */
    const val LETTER_SHARE = 0.42f
    /** Edge pixels this opaque, on this share of the border, make the icon's own edge its background. */
    const val OPAQUE_ALPHA = 0xF0
    const val OPAQUE_EDGE_SHARE = 0.9f

    /** How much of the canvas a maskable icon covers so that its 80 % safe zone fills the 66 dp safe zone exactly. */
    fun maskableShare(): Float = (SAFE_DP.toFloat() / CANVAS_DP) / MASKABLE_SAFE_SHARE

    /** A centred square covering `share` of a `canvas` px canvas. */
    fun centred(canvas: Int, share: Float): Square {
        val size = canvas * share
        val offset = (canvas - size) / 2f
        return Square(offset, offset, size)
    }

    /** Where a maskable icon of `width` × `height` px is drawn: covering the maskable square (its shorter side fits). */
    fun maskableRect(canvas: Int, width: Int, height: Int): FloatRect =
        cover(centred(canvas, maskableShare()), width, height)

    /** Where an `any` icon is drawn: contained in its square, centred, at its own aspect ratio. */
    fun anyRect(canvas: Int, width: Int, height: Int): FloatRect =
        contain(centred(canvas, ANY_SHARE), width, height)

    fun monochromeRect(canvas: Int, width: Int, height: Int): FloatRect =
        contain(centred(canvas, MONOCHROME_SHARE), width, height)

    /** Scale `width` × `height` so it fills `square` (the longer side spills over, centred). */
    fun cover(square: Square, width: Int, height: Int): FloatRect {
        if (width <= 0 || height <= 0) return FloatRect(square.left, square.top, square.right, square.bottom)
        val scale = max(square.size / width, square.size / height)
        return placed(square, width * scale, height * scale)
    }

    /** Scale `width` × `height` so it fits inside `square` (the shorter side leaves air, centred). */
    fun contain(square: Square, width: Int, height: Int): FloatRect {
        if (width <= 0 || height <= 0) return FloatRect(square.left, square.top, square.right, square.bottom)
        val scale = minOf(square.size / width, square.size / height)
        return placed(square, width * scale, height * scale)
    }

    private fun placed(square: Square, w: Float, h: Float): FloatRect {
        val left = square.left + (square.size - w) / 2f
        val top = square.top + (square.size - h) / 2f
        return FloatRect(left, top, left + w, top + h)
    }

    /**
     * The colour the icon's own edge is – the average of its one-pixel border – when that border is
     * essentially opaque, so a tile can extend the icon's background under the launcher's mask
     * instead of showing a seam. Null for an icon with a transparent (cut-out) edge.
     */
    fun edgeColor(pixels: IntArray, width: Int, height: Int): Int? {
        if (width <= 0 || height <= 0 || pixels.size < width * height) return null
        var count = 0
        var opaque = 0
        var r = 0L
        var g = 0L
        var b = 0L
        fun sample(x: Int, y: Int) {
            val c = pixels[y * width + x]
            count++
            if (alpha(c) < OPAQUE_ALPHA) return
            opaque++
            r += red(c)
            g += green(c)
            b += blue(c)
        }
        for (x in 0 until width) {
            sample(x, 0)
            if (height > 1) sample(x, height - 1)
        }
        for (y in 1 until height - 1) {
            sample(0, y)
            if (width > 1) sample(width - 1, y)
        }
        if (count == 0 || opaque < count * OPAQUE_EDGE_SHARE) return null
        return argb(0xFF, (r / opaque).toInt(), (g / opaque).toInt(), (b / opaque).toInt())
    }

    /**
     * White on a dark tile, near-black (the chrome's v2 text colour) on a light one, by WCAG relative
     * luminance at the chrome's `isDarkColor` threshold – the same rule as `tileInk` in `src/shared/webApp.ts`,
     * so the sheet's preview tile and the pinned tile agree.
     */
    fun onColor(background: Int): Int {
        fun channel(v: Int): Double {
            val c = v / 255.0
            return if (c <= 0.03928) c / 12.92 else Math.pow((c + 0.055) / 1.055, 2.4)
        }
        val luminance = 0.2126 * channel(red(background)) + 0.7152 * channel(green(background)) + 0.0722 * channel(blue(background))
        return if (luminance < 0.45) argb(0xFF, 0xFF, 0xFF, 0xFF) else argb(0xFF, 0x15, 0x14, 0x1A)
    }

    /**
     * The letter a letter tile shows: the title's first letter or digit (one code point, so a symbol is not split),
     * upper-cased; a symbol-only title keeps its first symbol, an empty one shows "?" – `tileLetter` in `src/shared/webApp.ts`.
     */
    fun letterFor(title: String): String {
        val trimmed = title.trim()
        var i = 0
        while (i < trimmed.length) {
            val cp = trimmed.codePointAt(i)
            if (Character.isLetterOrDigit(cp)) return String(Character.toChars(cp)).uppercase()
            i += Character.charCount(cp)
        }
        return if (trimmed.isEmpty()) "?" else String(Character.toChars(trimmed.codePointAt(0)))
    }

    /** `#rgb`, `#rrggbb` or `#rrggbbaa` (as the core writes colours) to opaque ARGB; null when it is none of those. */
    fun parseHex(css: String?): Int? {
        val s = css?.trim()?.removePrefix("#") ?: return null
        val hex = when (s.length) {
            3 -> s.map { "$it$it" }.joinToString("")
            6, 8 -> s.substring(0, 6)
            else -> return null
        }
        val rgb = hex.toIntOrNull(16) ?: return null
        return (0xFF shl 24) or rgb
    }

    /** The bitmap side used for a tile: 108 dp at `density`, never below what a launcher can show sharply. */
    fun canvasPx(density: Float): Int = max(216, (CANVAS_DP * density).roundToInt())

    fun alpha(c: Int): Int = (c ushr 24) and 0xFF
    fun red(c: Int): Int = (c shr 16) and 0xFF
    fun green(c: Int): Int = (c shr 8) and 0xFF
    fun blue(c: Int): Int = c and 0xFF
    fun argb(a: Int, r: Int, g: Int, b: Int): Int = (a shl 24) or (r shl 16) or (g shl 8) or b
}

/** A rectangle in canvas pixels (left, top, right, bottom), free of Android classes for the tests. */
data class FloatRect(val left: Float, val top: Float, val right: Float, val bottom: Float) {
    val width: Float get() = right - left
    val height: Float get() = bottom - top
}
