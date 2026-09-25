/**
 * RFC 3492 Punycode, the decoding half: the URL parser hands hostnames over in their ASCII form
 * (`xn--pple-43d.com`), and both the lookalike check's skeleton test (`core/protection/lookalikes`)
 * and the question page it raises (`zenPages`) need the characters the user saw (`аpple.com`).
 * Nothing is encoded here: the address bar keeps the punycode form.
 */

/**
 * One label: `xn--pple-43d` → `аpple`. A label that is not an IDN label, or a malformed one,
 * comes back as it was.
 */
export function decodePunycodeLabel(label: string): string {
  if (!label.startsWith('xn--')) return label
  const input = label.slice(4)
  if (!input) return label
  const base = 36
  const tMin = 1
  const tMax = 26
  const skew = 38
  const damp = 700
  let n = 128
  let i = 0
  let bias = 72
  const basic = input.lastIndexOf('-')
  const output: number[] = []
  for (let j = 0; j < Math.max(basic, 0); j++) {
    const c = input.charCodeAt(j)
    if (c >= 0x80) return label
    output.push(c)
  }
  const digit = (c: number): number =>
    c - 48 < 10 ? c - 22 : c - 65 < 26 ? c - 65 : c - 97 < 26 ? c - 97 : base
  const adapt = (delta: number, numPoints: number, first: boolean): number => {
    let d = first ? Math.floor(delta / damp) : delta >> 1
    d += Math.floor(d / numPoints)
    let k = 0
    while (d > ((base - tMin) * tMax) >> 1) {
      d = Math.floor(d / (base - tMin))
      k += base
    }
    return k + Math.floor(((base - tMin + 1) * d) / (d + skew))
  }
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length;) {
    const oldI = i
    let w = 1
    for (let k = base; ; k += base) {
      if (index >= input.length) return label
      const d = digit(input.charCodeAt(index++))
      if (d >= base) return label
      i += d * w
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias
      if (d < t) break
      w *= base - t
    }
    const len = output.length + 1
    bias = adapt(i - oldI, len, oldI === 0)
    n += Math.floor(i / len)
    i %= len
    if (n > 0x10ffff) return label
    output.splice(i++, 0, n)
  }
  return String.fromCodePoint(...output)
}

/** A hostname with its IDN labels decoded to the characters they show (`xn--…` → Unicode); an ASCII host as it was. */
export function unicodeHost(host: string): string {
  return host.includes('xn--') ? host.split('.').map(decodePunycodeLabel).join('.') : host
}
