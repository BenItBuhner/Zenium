import {
  Book,
  Briefcase,
  Code2,
  Coffee,
  Compass,
  Gamepad2,
  GraduationCap,
  Heart,
  Home,
  Lightbulb,
  Music,
  Newspaper,
  Palette,
  Plane,
  ShoppingBag,
  Star,
  Wrench,
  Zap
} from 'lucide-react'

/** Zen's space icon picker offers emoji and a set of monochrome symbols; symbols are stored as `sym:<name>`. */
export const SPACE_SYMBOLS: Record<string, typeof Home> = {
  home: Home,
  briefcase: Briefcase,
  book: Book,
  code: Code2,
  coffee: Coffee,
  compass: Compass,
  gamepad: Gamepad2,
  graduation: GraduationCap,
  heart: Heart,
  lightbulb: Lightbulb,
  music: Music,
  newspaper: Newspaper,
  palette: Palette,
  plane: Plane,
  shopping: ShoppingBag,
  star: Star,
  wrench: Wrench,
  zap: Zap
}

export const SYMBOL_PREFIX = 'sym:'

export function isSymbolIcon(icon: string): boolean {
  return icon.startsWith(SYMBOL_PREFIX) && Boolean(SPACE_SYMBOLS[icon.slice(SYMBOL_PREFIX.length)])
}
