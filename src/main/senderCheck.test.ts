import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createSenderCheck } from './senderCheck'

const RENDERER_FILE = 'C:\\Program Files\\Cloud Watchdog\\resources\\app\\out\\renderer\\index.html'
const RENDERER_URL = pathToFileURL(RENDERER_FILE).href

const frame = (url: string, parent: unknown = null) => ({ url, parent })

describe('createSenderCheck (packaged app)', () => {
  const isTrusted = createSenderCheck({ rendererFile: RENDERER_FILE })

  it('accepts the app page, whichever view it shows', () => {
    expect(isTrusted(frame(`${RENDERER_URL}?view=main`))).toBe(true)
    expect(isTrusted(frame(`${RENDERER_URL}?view=popover#x`))).toBe(true)
  })

  it('accepts the same file when the drive letter case differs', () => {
    expect(isTrusted(frame(RENDERER_URL.replace('file:///C:', 'file:///c:')))).toBe(true)
  })

  it('rejects a missing frame (destroyed or navigating)', () => {
    expect(isTrusted(null)).toBe(false)
    expect(isTrusted(undefined)).toBe(false)
  })

  it('rejects a frame nested inside another frame', () => {
    expect(isTrusted(frame(RENDERER_URL, frame(RENDERER_URL)))).toBe(false)
  })

  it.each([
    'https://example.com/',
    'https://example.com/out/renderer/index.html',
    'file:///C:/Users/someone/Downloads/index.html',
    `${RENDERER_URL}/../evil.html`,
    'data:text/html,<script>1</script>',
    'about:blank',
    'http://localhost:5173/',
    'not a url',
    ''
  ])('rejects %s', (url) => {
    expect(isTrusted(frame(url))).toBe(false)
  })
})

describe('createSenderCheck (development)', () => {
  const isTrusted = createSenderCheck({ rendererFile: RENDERER_FILE, devServerUrl: 'http://localhost:5173' })

  it('also accepts the dev server origin', () => {
    expect(isTrusted(frame('http://localhost:5173/?view=main'))).toBe(true)
    expect(isTrusted(frame(`${RENDERER_URL}?view=main`))).toBe(true)
  })

  it('rejects another port or host', () => {
    expect(isTrusted(frame('http://localhost:9999/?view=main'))).toBe(false)
    expect(isTrusted(frame('http://localhost.evil.example:5173/'))).toBe(false)
  })
})
