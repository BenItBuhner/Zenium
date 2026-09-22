/**
 * CSS colour strings as Chrome's extension APIs read them (`content::ParseCssColorString`, the
 * parser behind `action.setBadgeBackgroundColor` / `setBadgeTextColor` and their
 * `browserAction` names): `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()` / `rgba()`,
 * `hsl()` / `hsla()`, and the named colours of Skia's table (the CSS / SVG names, `white`,
 * `rebeccapurple`). Chrome's parser takes the comma forms; the space-separated forms of CSS
 * Color 4 (`rgb(1 2 3 / 50%)`) are read too, since an extension written against a browser's CSS
 * engine may hand them over. Anything else is "Invalid value for color." to the caller.
 */

/** `[r, g, b, a]`, each 0..255 (the API's `ColorArray`). */
export type CssRgba = [number, number, number, number]

// Skia's named colours (`SkParse::FindNamedColor`): the 147 CSS names, as `name hex` pairs.
const NAMED_COLORS =
  'aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc ' +
  'bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a ' +
  'burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 chocolate d2691e coral ff7f50 ' +
  'cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff darkblue 00008b ' +
  'darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgreen 006400 darkgrey a9a9a9 ' +
  'darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 ' +
  'darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f darkslateblue 483d8b ' +
  'darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 darkviolet 9400d3 ' +
  'deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff ' +
  'firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ' +
  'ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 greenyellow adff2f ' +
  'grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082 ivory fffff0 ' +
  'khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd ' +
  'lightblue add8e6 lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 ' +
  'lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 lightpink ffb6c1 lightsalmon ffa07a ' +
  'lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899 lightslategrey 778899 ' +
  'lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6 ' +
  'magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 ' +
  'mediumpurple 9370db mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a ' +
  'mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa ' +
  'mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 olive 808000 ' +
  'olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa ' +
  'palegreen 98fb98 paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 ' +
  'peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 purple 800080 ' +
  'rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 ' +
  'salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 ' +
  'skyblue 87ceeb slateblue 6a5acd slategray 708090 slategrey 708090 snow fffafa ' +
  'springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8 tomato ff6347 ' +
  'turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00 ' +
  'yellowgreen 9acd32'

let namedColors: Map<string, string> | null = null

function namedColor(name: string): CssRgba | null {
  if (!namedColors) {
    namedColors = new Map()
    const parts = NAMED_COLORS.split(' ')
    for (let i = 0; i + 1 < parts.length; i += 2) namedColors.set(parts[i], parts[i + 1])
  }
  const hex = namedColors.get(name.toLowerCase())
  return hex ? hexColor(hex) : null
}

function hexColor(digits: string): CssRgba | null {
  let hex = digits
  if (hex.length === 3 || hex.length === 4) hex = hex.replace(/./g, (c) => c + c)
  if (hex.length !== 6 && hex.length !== 8) return null
  const at = (i: number): number => parseInt(hex.slice(i, i + 2), 16)
  return [at(0), at(2), at(4), hex.length === 8 ? at(6) : 255]
}

const clampByte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)))

/** An alpha component: a number 0..1, or a percentage (`50%`), as 0..255. */
function alphaByte(text: string | undefined): number | null {
  if (text === undefined) return 255
  const value = text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text)
  if (!Number.isFinite(value)) return null
  return clampByte(Math.max(0, Math.min(1, value)) * 255)
}

/** A colour channel: a number 0..255, or a percentage of it. */
function channelByte(text: string): number | null {
  const value = text.endsWith('%') ? (Number(text.slice(0, -1)) * 255) / 100 : Number(text)
  return Number.isFinite(value) ? clampByte(value) : null
}

/** The components inside `fn(...)`: comma-separated, or space-separated with `/ alpha`. */
function components(inner: string): string[] | null {
  const text = inner.trim()
  if (text.length === 0) return null
  if (text.includes(',')) {
    const parts = text.split(',').map((p) => p.trim())
    return parts.every((p) => p.length > 0) ? parts : null
  }
  const [main, alpha, ...rest] = text.split('/').map((p) => p.trim())
  if (rest.length > 0 || main === undefined) return null
  const parts = main.split(/\s+/)
  if (alpha !== undefined) {
    if (alpha.length === 0) return null
    parts.push(alpha)
  }
  return parts
}

function rgbColor(inner: string): CssRgba | null {
  const parts = components(inner)
  if (!parts || parts.length < 3 || parts.length > 4) return null
  const r = channelByte(parts[0])
  const g = channelByte(parts[1])
  const b = channelByte(parts[2])
  const a = alphaByte(parts[3])
  if (r === null || g === null || b === null || a === null) return null
  return [r, g, b, a]
}

/** `hsl()` as Chrome converts it (`color_utils::HSLToSkColor`): hue truncated and wrapped. */
function hslColor(inner: string): CssRgba | null {
  const parts = components(inner)
  if (!parts || parts.length < 3 || parts.length > 4) return null
  const hue = Number(parts[0].replace(/deg$/i, ''))
  const saturation = Number(parts[1].replace(/%$/, ''))
  const lightness = Number(parts[2].replace(/%$/, ''))
  const a = alphaByte(parts[3])
  if (![hue, saturation, lightness].every(Number.isFinite) || a === null) return null
  const h = (((Math.trunc(hue) % 360) + 360) % 360) / 360
  const s = Math.max(0, Math.min(100, saturation)) / 100
  const l = Math.max(0, Math.min(100, lightness)) / 100
  const channel = (t: number): number => {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    let x = t
    if (x < 0) x += 1
    if (x > 1) x -= 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  if (s === 0) {
    const grey = clampByte(l * 255)
    return [grey, grey, grey, a]
  }
  return [
    clampByte(channel(h + 1 / 3) * 255),
    clampByte(channel(h) * 255),
    clampByte(channel(h - 1 / 3) * 255),
    a
  ]
}

/** A CSS colour string as `[r, g, b, a]`, or null when Chrome would refuse it. */
export function parseCssColor(raw: string): CssRgba | null {
  const text = raw.trim()
  if (text.length === 0) return null
  if (text.startsWith('#')) return /^#[0-9a-f]+$/i.test(text) ? hexColor(text.slice(1)) : null
  const fn = /^(rgba?|hsla?)\((.*)\)$/is.exec(text)
  if (fn) return fn[1].toLowerCase().startsWith('rgb') ? rgbColor(fn[2]) : hslColor(fn[2])
  return namedColor(text)
}
