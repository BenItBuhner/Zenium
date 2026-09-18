/**
 * The glyph beside a Chrome permission warning in the install dialog and the Permissions group.
 * Keys name Lucide icons; the component maps them (one stroke weight per surface, §6).
 */
export type WarningGlyph =
  | 'globe'
  | 'history'
  | 'download'
  | 'bell'
  | 'clipboard'
  | 'puzzle'
  | 'hard-drive'
  | 'terminal'
  | 'shield'
  | 'bookmark'
  | 'app-window'
  | 'lock'
  | 'cookie'
  | 'monitor'
  | 'usb'
  | 'bluetooth'
  | 'mic'
  | 'camera'
  | 'map-pin'
  | 'printer'
  | 'keyboard'
  | 'search'
  | 'image'
  | 'network'
  | 'user'
  | 'text-cursor-input'
  | 'eye'
  | 'key-round'

const RULES: Array<[RegExp, WarningGlyph]> = [
  [/\bbookmarks?\b/i, 'bookmark'],
  [/\bbrowsing history\b|\bmost frequently visited\b|\bhistory\b/i, 'history'],
  [/\bdownloads?\b/i, 'download'],
  [/\bnotifications?\b/i, 'bell'],
  [/\bcopy and paste\b/i, 'clipboard'],
  [/\bapps, extensions, and themes\b|\bextensions?\b/i, 'puzzle'],
  [/\bstorage devices?\b|\bphotos, music\b|\bfiles?\b|\bfolders?\b|\bmedia\b/i, 'hard-drive'],
  [/\bnative applications?\b|\bdebugger\b/i, 'terminal'],
  [/\bblock (content|parts)\b/i, 'shield'],
  [/\btabs\b|\bbrowsing activity\b|\bwindows?\b/i, 'app-window'],
  [/\bprivacy\b|\bpasswords?\b|\bsecurity\b/i, 'lock'],
  [/\bcookies?\b/i, 'cookie'],
  [/\bscreen\b|\bdisplay\b|\bwallpaper\b/i, 'monitor'],
  [/\busb\b/i, 'usb'],
  [/\bbluetooth\b|\bserial\b/i, 'bluetooth'],
  [/\bmicrophone\b|\bspeech\b|\bspoken\b/i, 'mic'],
  [/\bcamera\b|\bcapture\b/i, 'camera'],
  [/\blocation\b/i, 'map-pin'],
  [/\bprinters?\b|\bprinting\b|\bscanners?\b/i, 'printer'],
  [/\banything you type\b|\bkeyboard\b|\binput\b/i, 'keyboard'],
  [/\bsearch settings\b|\baddress bar\b/i, 'search'],
  [/\bicons of the websites\b/i, 'image'],
  [/\bnetwork\b|\bproxy\b|\bdevices? (in|on) the\b|\bexchange data\b/i, 'network'],
  [/\bemail address\b|\baccount\b|\busers?\b/i, 'user'],
  [/\bautofill\b|\bform\b/i, 'text-cursor-input'],
  [/\baccessibility\b|\bread all\b/i, 'eye'],
  [/\bwebsites?\b|\bpage\b|\bweb\b|\bdata on\b/i, 'globe']
]

/** Picks the glyph for a warning string ("Read and change all your data on all websites" → globe). */
export function warningGlyph(warning: string): WarningGlyph {
  for (const [pattern, glyph] of RULES) if (pattern.test(warning)) return glyph
  return 'key-round'
}
