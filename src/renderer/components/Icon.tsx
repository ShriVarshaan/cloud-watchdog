// Icons from Lucide (ISC licence), drawn at the weight closest to SF Symbols'
// regular. Every icon sits next to a word, so all are hidden from screen readers.

import type { LucideIcon } from 'lucide-react'

export function Icon({ icon: Glyph, size = 16 }: { icon: LucideIcon; size?: number }) {
  return <Glyph className="icon" size={size} strokeWidth={1.75} aria-hidden="true" focusable="false" />
}
