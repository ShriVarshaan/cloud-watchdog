import { describe, expect, it } from 'vitest'
import { supportsMica, titleBarOverlay, windowBackground } from './windowChrome'

describe('supportsMica', () => {
  it('is on for Windows 11 22H2 and later', () => {
    expect(supportsMica('win32', '10.0.22621')).toBe(true)
    expect(supportsMica('win32', '10.0.26300')).toBe(true)
  })

  it('is off for Windows 10 and the first Windows 11 release', () => {
    expect(supportsMica('win32', '10.0.19045')).toBe(false)
    expect(supportsMica('win32', '10.0.22000')).toBe(false)
  })

  it('is off on other platforms and for a release string it cannot read', () => {
    expect(supportsMica('darwin', '10.0.26300')).toBe(false)
    expect(supportsMica('win32', 'unknown')).toBe(false)
  })
})

describe('titleBarOverlay', () => {
  it('matches the page background and label colour in each theme', () => {
    expect(titleBarOverlay(false)).toEqual({ color: '#f5f5f7', symbolColor: '#1d1d1f', height: 48 })
    expect(titleBarOverlay(true)).toEqual({ color: '#1c1c1e', symbolColor: '#f5f5f7', height: 48 })
  })
})

describe('windowBackground', () => {
  it('is transparent under Mica so the material shows through', () => {
    expect(windowBackground(true, true)).toBe('#00000000')
  })

  it('is the content background otherwise', () => {
    expect(windowBackground(false, false)).toBe('#f5f5f7')
    expect(windowBackground(true, false)).toBe('#1c1c1e')
  })
})
