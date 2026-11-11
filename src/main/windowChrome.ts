// How the main window's frame looks (M13, docs/DESIGN.md "Windows specifics").
// Pure functions so the choices can be tested without opening a window.

/** Height of the page's toolbar, which the native window buttons sit beside. Matches `--toolbar-height` in styles.css. */
export const TOOLBAR_HEIGHT = 48

/** Content background and label colours from the design tokens, for the parts the OS draws. */
const THEME = {
  light: { background: '#f5f5f7', symbol: '#1d1d1f' },
  dark: { background: '#1c1c1e', symbol: '#f5f5f7' }
} as const

/**
 * Mica, the Windows 11 window material, needs build 22621 (22H2) or later.
 * On anything else the page draws a solid sidebar instead.
 */
export function supportsMica(platform: string, release: string): boolean {
  if (platform !== 'win32') return false
  const build = Number(release.split('.')[2])
  return Number.isInteger(build) && build >= 22621
}

/** The minimise, maximise and close buttons, drawn by Windows over the page's toolbar. */
export function titleBarOverlay(dark: boolean): { color: string; symbolColor: string; height: number } {
  const theme = dark ? THEME.dark : THEME.light
  return { color: theme.background, symbolColor: theme.symbol, height: TOOLBAR_HEIGHT }
}

/** Painted before the page loads, so opening the window never flashes white in dark mode. Transparent under Mica. */
export function windowBackground(dark: boolean, mica: boolean): string {
  if (mica) return '#00000000'
  return dark ? THEME.dark.background : THEME.light.background
}
