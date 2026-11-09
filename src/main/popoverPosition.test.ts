import { describe, expect, it } from 'vitest'
import { POPOVER_MARGIN, popoverPosition } from './popoverPosition'

// A 1920x1080 screen. Each test moves the taskbar (and so the work area).
const size = { width: 360, height: 480 }
const m = POPOVER_MARGIN

describe('popoverPosition', () => {
  it('sits above a bottom taskbar, centred on the tray icon', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 }
    const tray = { x: 1500, y: 1048, width: 24, height: 24 }
    expect(popoverPosition(tray, workArea, size)).toEqual({ x: 1512 - 180, y: 1040 - 480 - m })
  })

  it('stays inside the work area when the icon is near the right edge', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 }
    const tray = { x: 1880, y: 1048, width: 24, height: 24 }
    expect(popoverPosition(tray, workArea, size).x).toBe(1920 - 360 - m)
  })

  it('sits below a top taskbar', () => {
    const workArea = { x: 0, y: 40, width: 1920, height: 1040 }
    const tray = { x: 1500, y: 8, width: 24, height: 24 }
    expect(popoverPosition(tray, workArea, size).y).toBe(40 + m)
  })

  it('sits beside a left taskbar, vertically centred on the icon', () => {
    const workArea = { x: 60, y: 0, width: 1860, height: 1080 }
    const tray = { x: 18, y: 900, width: 24, height: 24 }
    expect(popoverPosition(tray, workArea, size)).toEqual({ x: 60 + m, y: 1080 - 480 - m })
  })

  it('sits beside a right taskbar', () => {
    const workArea = { x: 0, y: 0, width: 1860, height: 1080 }
    const tray = { x: 1878, y: 300, width: 24, height: 24 }
    expect(popoverPosition(tray, workArea, size)).toEqual({ x: 1860 - 360 - m, y: 312 - 240 })
  })

  it('falls back to the bottom-right corner when tray bounds are unknown', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 }
    const tray = { x: 0, y: 0, width: 0, height: 0 }
    expect(popoverPosition(tray, workArea, size)).toEqual({ x: 1920 - 360 - m, y: 1040 - 480 - m })
  })

  it('returns whole pixels', () => {
    const workArea = { x: 0, y: 0, width: 1920, height: 1040 }
    const tray = { x: 1500, y: 1048, width: 25, height: 24 }
    const { x, y } = popoverPosition(tray, workArea, size)
    expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true)
  })
})
