import qrcodegen from 'nayuki-qr-code-generator'

/** The quiet zone the QR specification wants around the symbol, in modules. */
export const QR_QUIET_ZONE = 4

export interface QrSymbol {
  /** Modules per side, quiet zone included: the SVG's `viewBox` is `0 0 size size`. */
  size: number
  /** One `M x y h1 v1 h-1 z` per dark module, offset by the quiet zone. */
  path: string
}

/**
 * A QR symbol for `text` (a share's link; Chrome's "Create QR code" bubble) as an SVG path on a
 * quiet zone, from Nayuki's encoder (`nayuki-qr-code-generator`, MIT, no dependencies): medium
 * error correction, the smallest version that holds the text, its mask chosen automatically.
 * Null when the text does not fit a QR code at all (past the 2953 bytes of version 40) or is
 * empty – the caller shows no code then.
 */
export function qrSymbol(text: string): QrSymbol | null {
  if (!text) return null
  let code: qrcodegen.QrCode
  try {
    code = qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM)
  } catch {
    return null
  }
  const parts: string[] = []
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (code.getModule(x, y)) parts.push(`M${x + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h1v1h-1z`)
    }
  }
  return { size: code.size + 2 * QR_QUIET_ZONE, path: parts.join('') }
}

/**
 * Where a symbol of `size` modules sits in a tile `inner` px square so that every module is one
 * whole number of pixels wide – `crispEdges` rounds each module's edges on its own otherwise, and
 * a module lands 4 px wide beside one of 5: `scale` px per module is the largest whole number
 * that fits, and the tile's own white absorbs the remainder as padding around the quiet zone,
 * the symbol centred at a whole `offset` (a spare pixel goes to the far side, never to a half).
 * A symbol denser than a pixel per module (past version 37 in a 158 tile) fills the tile
 * fractionally instead: whole beats clipped, and it is not scannable at that size either way.
 */
export function qrLayout(size: number, inner: number): { scale: number; offset: number } {
  if (size > inner) return { scale: inner / size, offset: 0 }
  const scale = Math.floor(inner / size)
  return { scale, offset: Math.floor((inner - scale * size) / 2) }
}
