import type { JSX } from 'react'
import {
  AppWindow,
  Bell,
  Bluetooth,
  Bookmark,
  Camera,
  Clipboard,
  Cookie,
  Download,
  Eye,
  Globe,
  HardDrive,
  History,
  Image,
  Keyboard,
  KeyRound,
  Lock,
  MapPin,
  Mic,
  Monitor,
  Network,
  Printer,
  Puzzle,
  Search,
  Shield,
  Terminal,
  TextCursorInput,
  Usb,
  User,
  type LucideIcon
} from 'lucide-react'
import { warningGlyph, type WarningGlyph } from '@renderer/lib/extensions/warningGlyph'

const GLYPHS: Record<WarningGlyph, LucideIcon> = {
  globe: Globe,
  history: History,
  download: Download,
  bell: Bell,
  clipboard: Clipboard,
  puzzle: Puzzle,
  'hard-drive': HardDrive,
  terminal: Terminal,
  shield: Shield,
  bookmark: Bookmark,
  'app-window': AppWindow,
  lock: Lock,
  cookie: Cookie,
  monitor: Monitor,
  usb: Usb,
  bluetooth: Bluetooth,
  mic: Mic,
  camera: Camera,
  'map-pin': MapPin,
  printer: Printer,
  keyboard: Keyboard,
  search: Search,
  image: Image,
  network: Network,
  user: User,
  'text-cursor-input': TextCursorInput,
  eye: Eye,
  'key-round': KeyRound
}

/** One of Chrome's permission warnings as a row: a 16 glyph for its kind, then the sentence. */
export function WarningRow({ warning }: { warning: string }): JSX.Element {
  const Glyph = GLYPHS[warningGlyph(warning)]
  return (
    <div className="zen-settings-row zen-ext-warning">
      <Glyph className="h-4 w-4 shrink-0 text-[var(--zen-muted)]" />
      <span className="zen-settings-text">
        <span className="zen-settings-label">{warning}</span>
      </span>
    </div>
  )
}
