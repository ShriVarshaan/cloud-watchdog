// Every text colour in styles.css against every surface it can sit on, in
// light and dark mode, at the WCAG level it needs (docs/DESIGN.md, Tokens).
// The values are read from the stylesheet itself, so changing a token to one
// that fails breaks this test.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = readFileSync(join(import.meta.dirname, '../../src/renderer/styles.css'), 'utf8')

/** The custom properties declared directly in a block of CSS text. */
function tokens(block: string): Record<string, string> {
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]))
}

function blockAfter(marker: string): string {
  const start = css.indexOf('{', css.indexOf(marker))
  let depth = 0
  for (let i = start; i < css.length; i++) {
    if (css[i] === '{') depth++
    if (css[i] === '}' && --depth === 0) return css.slice(start, i)
  }
  throw new Error(`No block after ${marker}`)
}

const light = tokens(blockAfter(':root {'))
const dark = { ...light, ...tokens(blockAfter('@media (prefers-color-scheme: dark)')) }

type Rgb = [number, number, number]
const rgb = (hex: string): Rgb => {
  expect(hex, `a hex colour, got ${hex}`).toMatch(/^#[0-9a-f]{6}$/i)
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb
}
const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const luminance = ([r, g, b]: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
const ratio = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}
const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb => fg.map((f, i) => f * alpha + bg[i]! * (1 - alpha)) as Rgb

/** `--x-tint: color-mix(in srgb, var(--x) 10%, transparent)` gives the colour and its strength. */
function tint(theme: Record<string, string>, name: string): { colour: string; alpha: number } {
  const match = /var\(--([\w-]+)\)\s+(\d+)%/.exec(theme[`${name}-tint`] ?? '')
  if (!match) throw new Error(`--${name}-tint is not a color-mix of a token`)
  return { colour: theme[match[1]!]!, alpha: Number(match[2]) / 100 }
}

const SURFACES = ['bg', 'surface', 'surface-alt', 'selection']
const TEXT = ['label', 'secondary', 'accent-text', 'green', 'orange', 'red']
const PILLS = ['accent', 'green', 'orange', 'red']

describe.each([
  ['light', light],
  ['dark', dark]
])('contrast in %s mode', (_name, theme) => {
  const colour = (token: string) => rgb(theme[token]!)

  it.each(SURFACES.flatMap((surface) => TEXT.map((text) => [text, surface])))('%s text on %s reaches 4.5:1', (text, surface) => {
    expect(ratio(colour(text), colour(surface))).toBeGreaterThanOrEqual(4.5)
  })

  it.each(SURFACES.flatMap((surface) => PILLS.map((pill) => [pill, surface])))(
    'a %s pill over %s reaches 4.5:1, and so does a banner',
    (pill, surface) => {
      const { colour: text, alpha } = tint(theme, pill)
      const background = over(rgb(text), colour(surface), alpha)
      expect(ratio(rgb(text), background)).toBeGreaterThanOrEqual(4.5)
      expect(ratio(colour('label'), background)).toBeGreaterThanOrEqual(4.5)
    }
  )

  it('white on the filled accent button reaches 4.5:1', () => {
    expect(ratio([1, 1, 1], colour('accent'))).toBeGreaterThanOrEqual(4.5)
  })

  it('the focus ring and an on switch reach 3:1 against every surface', () => {
    for (const surface of SURFACES) {
      expect(ratio(colour('accent-text'), colour(surface))).toBeGreaterThanOrEqual(3)
      const on = theme['switch-on'] === 'var(--accent)' ? colour('accent') : colour('switch-on')
      expect(ratio(on, colour(surface))).toBeGreaterThanOrEqual(3)
    }
  })
})
