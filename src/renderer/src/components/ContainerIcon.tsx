import type { JSX } from 'react'
import {
  Apple,
  Briefcase,
  Circle,
  Coffee,
  DollarSign,
  Fence,
  Fingerprint,
  Gift,
  PawPrint,
  Plane,
  ShoppingCart,
  TreePine,
  Utensils
} from 'lucide-react'
import type { Container } from '@shared/types'
import { CONTAINER_COLORS } from '@shared/defaults'

const ICONS: Record<Container['icon'], typeof Circle> = {
  fingerprint: Fingerprint,
  briefcase: Briefcase,
  dollar: DollarSign,
  cart: ShoppingCart,
  circle: Circle,
  gift: Gift,
  vacation: Plane,
  food: Utensils,
  fruit: Apple,
  pet: PawPrint,
  tree: TreePine,
  chill: Coffee,
  fence: Fence
}

/** Firefox's container glyph in the container's colour (Zen 1.21.9 "improved container UI"). */
export function ContainerIcon({
  container,
  size = 16,
  className
}: {
  container: Pick<Container, 'icon' | 'color'>
  size?: number
  className?: string
}): JSX.Element {
  const Icon = ICONS[container.icon] ?? Circle
  return (
    <Icon
      className={className}
      style={{ width: size, height: size, color: CONTAINER_COLORS[container.color] }}
      aria-hidden
    />
  )
}
