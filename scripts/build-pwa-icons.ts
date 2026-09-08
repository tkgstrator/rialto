#!/usr/bin/env bun
/**
 * Generate the PWA icon set into `public/`.
 *
 * The icons are drawn here rather than committed as opaque binaries so
 * the mark stays editable: the bridge is three primitives in a normalised
 * box, and changing the palette or the proportions is a code edit plus a
 * re-run. Rasterising by hand also keeps the repo free of an image
 * toolchain — a PNG encoder over node:zlib is about forty lines, and
 * playwright's chromium (the only other renderer here) is optional and
 * frequently not installed.
 *
 *   bun run pwa:icons
 *
 * Re-run after editing GLYPH or the palette; the output is deterministic,
 * so an unchanged design produces byte-identical files.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

// The app's own neutral palette: `--background` in `.dark`
// (oklch(0.145 0 0)) and `--foreground` on top of it. A monochrome mark
// sits correctly on both the light and the dark shell, which a coloured
// one would not.
const INK = { r: 10, g: 10, b: 10 }
const PAPER = { r: 250, g: 250, b: 250 }

// Rialto is a bridge, so the mark is one: a deck, a single arch, and the
// ground it lands on. Coordinates are fractions of the glyph box, which
// is what lets the same geometry serve a 192px icon and a 512px maskable
// one without a second set of numbers.
const GLYPH = {
  deck: { top: 0.16, bottom: 0.25 },
  arch: { cx: 0.5, cy: 0.75, outerR: 0.5, innerR: 0.37 },
  ground: { top: 0.75, bottom: 0.84 }
}

interface Rgb {
  r: number
  g: number
  b: number
}

// Supersampling factor per axis. 3 is enough to keep the arch's edge
// clean at 192px without making the 512px render slow.
const SAMPLES = 3

const inRect = (x: number, y: number, left: number, top: number, right: number, bottom: number): boolean =>
  x >= left && x <= right && y >= top && y <= bottom

// Rounded square in absolute pixels, used for the shape of the icon
// itself rather than for the glyph.
function inRoundedSquare(x: number, y: number, size: number, radius: number): boolean {
  if (!inRect(x, y, 0, 0, size, size)) return false
  const dx = Math.max(radius - x, x - (size - radius), 0)
  const dy = Math.max(radius - y, y - (size - radius), 0)
  return dx * dx + dy * dy <= radius * radius
}

/**
 * Is this point inside the bridge?
 *
 * `gx` / `gy` are already normalised into the glyph box. The arch keeps
 * only its upper half: the lower half of the ring would draw the arch's
 * reflection below the ground line.
 */
function inGlyph(gx: number, gy: number): boolean {
  if (gx < 0 || gx > 1 || gy < 0 || gy > 1) return false
  if (inRect(gx, gy, 0, GLYPH.deck.top, 1, GLYPH.deck.bottom)) return true
  if (inRect(gx, gy, 0, GLYPH.ground.top, 1, GLYPH.ground.bottom)) return true
  const dx = gx - GLYPH.arch.cx
  const dy = gy - GLYPH.arch.cy
  if (dy > 0) return false
  const d = Math.sqrt(dx * dx + dy * dy)
  return d >= GLYPH.arch.innerR && d <= GLYPH.arch.outerR
}

interface IconSpec {
  size: number
  /** Fraction of the icon the glyph box spans. */
  glyphScale: number
  /** Corner radius as a fraction of the size; 0 renders a full-bleed square. */
  cornerRatio: number
}

/**
 * Render one icon to raw RGBA.
 *
 * Coverage is averaged over a SAMPLES × SAMPLES grid per pixel, which is
 * the whole of the antialiasing: the shapes are analytic, so there is
 * nothing to smooth afterwards.
 */
function render(spec: IconSpec): Uint8Array {
  const { size, glyphScale, cornerRatio } = spec
  const pixels = new Uint8Array(size * size * 4)
  const radius = cornerRatio * size
  const glyphSize = size * glyphScale
  const glyphOrigin = (size - glyphSize) / 2
  const step = 1 / SAMPLES
  const total = SAMPLES * SAMPLES

  for (const y of Array.from({ length: size }, (_, i) => i)) {
    for (const x of Array.from({ length: size }, (_, i) => i)) {
      const coverage = { background: 0, ink: 0 }
      for (const sy of Array.from({ length: SAMPLES }, (_, i) => i)) {
        for (const sx of Array.from({ length: SAMPLES }, (_, i) => i)) {
          const px = x + (sx + 0.5) * step
          const py = y + (sy + 0.5) * step
          const inside = cornerRatio === 0 ? inRect(px, py, 0, 0, size, size) : inRoundedSquare(px, py, size, radius)
          if (!inside) continue
          coverage.background += 1
          if (inGlyph((px - glyphOrigin) / glyphSize, (py - glyphOrigin) / glyphSize)) coverage.ink += 1
        }
      }
      const alpha = coverage.background / total
      // The glyph's share of the covered area, so an edge pixel blends
      // paper into ink at the same rate it blends ink into transparency.
      const inkShare = coverage.background === 0 ? 0 : coverage.ink / coverage.background
      const blend = (channel: keyof Rgb): number => Math.round(INK[channel] + (PAPER[channel] - INK[channel]) * inkShare)
      const offset = (y * size + x) * 4
      pixels[offset] = blend('r')
      pixels[offset + 1] = blend('g')
      pixels[offset + 2] = blend('b')
      pixels[offset + 3] = Math.round(alpha * 255)
    }
  }
  return pixels
}

// --- PNG container ----------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) =>
  Array.from({ length: 8 }, () => 0).reduce((c) => (c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1), n)
)

const crc32 = (buf: Uint8Array): number =>
  (buf.reduce((c, byte) => CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'ascii')
  const body = Buffer.concat([head.subarray(4), data])
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([head, data, tail])
}

function encodePng(pixels: Uint8Array, size: number): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  // 8 bits per channel, colour type 6 (RGBA), no interlace.
  ihdr[8] = 8
  ihdr[9] = 6
  // Each scanline is prefixed with filter type 0 (None): the shapes are
  // flat colour, so a smarter filter buys almost nothing here.
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (const y of Array.from({ length: size }, (_, i) => i)) {
    raw[y * (stride + 1)] = 0
    Buffer.from(pixels.subarray(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// --- Output -----------------------------------------------------------------

interface Output extends IconSpec {
  file: string
  note: string
}

const OUTPUTS: Output[] = [
  { file: 'public/icon-192.png', size: 192, glyphScale: 0.6, cornerRatio: 0.22, note: 'install prompt / task switcher' },
  { file: 'public/icon-512.png', size: 512, glyphScale: 0.6, cornerRatio: 0.22, note: 'splash screen' },
  // Maskable icons are cropped to a platform-chosen shape, and only the
  // central 80% is guaranteed to survive — hence full bleed and a smaller
  // glyph rather than the rounded square above.
  { file: 'public/icon-maskable-512.png', size: 512, glyphScale: 0.46, cornerRatio: 0, note: 'adaptive / maskable' },
  // iOS applies its own corner mask and composites over black, so a
  // rounded PNG would show dark wedges in the corners.
  { file: 'public/apple-touch-icon.png', size: 180, glyphScale: 0.6, cornerRatio: 0, note: 'iOS home screen' }
]

for (const output of OUTPUTS) {
  const png = encodePng(render(output), output.size)
  const path = resolve(import.meta.dirname, '..', output.file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, png)
  const digest = createHash('sha256').update(png).digest('hex').slice(0, 8)
  console.error(`${output.file.padEnd(34)} ${String(png.length).padStart(6)}B  ${digest}  ${output.note}`)
}
