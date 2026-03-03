#!/usr/bin/env node
/**
 * generate-icons.js — creates Electron icon assets using only Node.js built-ins.
 * Outputs: electron/icon/icon.png (512×512), icon.ico (256×256), tray.png (32×32), tray.ico (16×16)
 * Run: node scripts/generate-icons.js
 */
'use strict'

const { deflateSync } = require('zlib')
const { writeFileSync, mkdirSync } = require('fs')
const { join } = require('path')

// ── CRC32 ──────────────────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let crc = 0xFFFFFFFF
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

// ── PNG builder ────────────────────────────────────────────────────────────
function pngChunk(type, data) {
  const lenBuf = Buffer.alloc(4)
  lenBuf.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([lenBuf, body, crcBuf])
}

function createPNG(width, height, drawFn) {
  const pixels = new Uint8Array(width * height * 4) // RGBA
  drawFn(pixels, width, height)

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type: RGBA

  const raw = Buffer.alloc((1 + width * 4) * height)
  let off = 0
  for (let y = 0; y < height; y++) {
    raw[off++] = 0 // filter: None
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4
      raw[off++] = pixels[p]
      raw[off++] = pixels[p + 1]
      raw[off++] = pixels[p + 2]
      raw[off++] = pixels[p + 3]
    }
  }

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

// ── ICO builder (embeds PNG directly, Vista+) ──────────────────────────────
function createICO(pngBufs) {
  const count = pngBufs.length
  const headerSize = 6
  const entrySize = 16
  const dataOffset = headerSize + entrySize * count

  const header = Buffer.alloc(headerSize)
  header.writeUInt16LE(0, 0)     // reserved
  header.writeUInt16LE(1, 2)     // type: ICO
  header.writeUInt16LE(count, 4) // image count

  const entries = []
  let currentOffset = dataOffset
  for (const png of pngBufs) {
    const entry = Buffer.alloc(entrySize)
    entry[0] = 0   // width: 0 = 256 (convention for 256+)
    entry[1] = 0   // height: 0 = 256
    entry[2] = 0   // color count (0 = no palette)
    entry[3] = 0   // reserved
    entry.writeUInt16LE(1, 4)            // planes
    entry.writeUInt16LE(32, 6)           // bits per pixel
    entry.writeUInt32LE(png.length, 8)   // data size
    entry.writeUInt32LE(currentOffset, 12) // data offset
    entries.push(entry)
    currentOffset += png.length
  }

  return Buffer.concat([header, ...entries, ...pngBufs])
}

function createSmallICO(pngBuf, w) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)

  const entry = Buffer.alloc(16)
  entry[0] = w   // actual width
  entry[1] = w   // actual height
  entry[2] = 0
  entry[3] = 0
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(pngBuf.length, 8)
  entry.writeUInt32LE(22, 12)

  return Buffer.concat([header, entry, pngBuf])
}

// ── Drawing primitives ─────────────────────────────────────────────────────
function blend(pixels, w, x, y, r, g, b, alpha) {
  const h = pixels.length / 4 / w
  if (x < 0 || x >= w || y < 0 || y >= h) return
  const p = (y * w + x) * 4
  const bg = pixels[p + 3] / 255
  const oa = alpha + bg * (1 - alpha)
  if (oa > 0) {
    pixels[p]     = Math.round((r * alpha + pixels[p]     * bg * (1 - alpha)) / oa)
    pixels[p + 1] = Math.round((g * alpha + pixels[p + 1] * bg * (1 - alpha)) / oa)
    pixels[p + 2] = Math.round((b * alpha + pixels[p + 2] * bg * (1 - alpha)) / oa)
    pixels[p + 3] = Math.round(oa * 255)
  }
}

function fillAll(pixels, r, g, b) {
  for (let i = 0; i < pixels.length; i += 4) {
    pixels[i] = r; pixels[i + 1] = g; pixels[i + 2] = b; pixels[i + 3] = 255
  }
}

function fillRect(pixels, w, x1, y1, x2, y2, r, g, b) {
  const h = pixels.length / 4 / w
  for (let y = Math.max(0, y1); y < Math.min(h, y2); y++) {
    for (let x = Math.max(0, x1); x < Math.min(w, x2); x++) {
      blend(pixels, w, x, y, r, g, b, 1.0)
    }
  }
}

/** Anti-aliased circle — filled or stroked */
function circle(pixels, w, cx, cy, rad, r, g, b, filled, strokeW = 1.5) {
  const outer = filled ? rad + 1 : rad + strokeW / 2 + 1
  for (let y = Math.floor(cy - outer); y <= Math.ceil(cy + outer); y++) {
    for (let x = Math.floor(cx - outer); x <= Math.ceil(cx + outer); x++) {
      const d = Math.sqrt((x - cx) ** 2 + (y - cy) ** 2)
      let alpha
      if (filled) {
        alpha = Math.max(0, Math.min(1, rad - d + 0.5))
      } else {
        const inner = rad - strokeW / 2
        alpha = Math.max(0, Math.min(1, Math.min(d - inner, rad + strokeW / 2 - d) + 0.5))
      }
      if (alpha > 0) blend(pixels, w, x, y, r, g, b, alpha)
    }
  }
}

/** Anti-aliased thick line */
function line(pixels, w, x1, y1, x2, y2, r, g, b, thick = 1) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) * 2 + 1
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const px = x1 + t * (x2 - x1)
    const py = y1 + t * (y2 - y1)
    const hw = thick / 2
    for (let dy = Math.floor(-hw); dy <= Math.ceil(hw); dy++) {
      for (let dx = Math.floor(-hw); dx <= Math.ceil(hw); dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy)
        const alpha = Math.max(0, Math.min(1, hw - dist + 0.5))
        if (alpha > 0) blend(pixels, w, Math.round(px + dx), Math.round(py + dy), r, g, b, alpha)
      }
    }
  }
}

/** Rounded rectangle (filled) */
function roundRect(pixels, w, x, y, rw, rh, rx, r, g, b) {
  // Horizontal band (full width, minus corner arcs)
  fillRect(pixels, w, x, y + rx, x + rw, y + rh - rx, r, g, b)
  // Vertical band (full height, minus corner arcs, clipped by horizontal)
  fillRect(pixels, w, x + rx, y, x + rw - rx, y + rh, r, g, b)
  // Four rounded corners
  for (const [cx, cy] of [[x + rx, y + rx], [x + rw - rx, y + rx], [x + rx, y + rh - rx], [x + rw - rx, y + rh - rx]]) {
    circle(pixels, w, cx, cy, rx, r, g, b, true)
  }
}

// ── Robot icon drawing ─────────────────────────────────────────────────────
const BG    = [0x0a, 0x0a, 0x1a]   // #0a0a1a
const CARD  = [0x0e, 0x0e, 0x28]   // slightly lighter bg
const CYAN  = [0x00, 0xe5, 0xff]   // #00e5ff
const ORANGE= [0xff, 0x91, 0x00]   // #ff9100
const WHITE = [0xff, 0xff, 0xff]

function drawRobot(pixels, w, h, colors) {
  const [fg, accent] = colors
  const s = w / 32   // scale: 1 at 32px, 16 at 512px

  // Head circle
  circle(pixels, w, 16*s, 12*s, 7*s, ...fg, false, 1.5*s)
  // Eyes
  circle(pixels, w, 13.5*s, 11*s, 1.5*s, ...fg, true)
  circle(pixels, w, 18.5*s, 11*s, 1.5*s, ...fg, true)
  // Smile arc (sinusoidal approx)
  for (let i = 0; i <= 30; i++) {
    const t = i / 30
    const sx = (13 + 6*t) * s
    const sy = 15*s + Math.sin(t * Math.PI) * 2.5*s
    blend(pixels, w, Math.round(sx), Math.round(sy), ...fg, 1.0)
    if (s > 1) {
      blend(pixels, w, Math.round(sx), Math.round(sy) + 1, ...fg, 0.5)
      blend(pixels, w, Math.round(sx), Math.round(sy) - 1, ...fg, 0.5)
    }
  }
  // Antenna ball
  circle(pixels, w, 16*s, 3.5*s, 1.5*s, ...fg, true)
  // Antenna stem
  line(pixels, w, 16*s, 5*s, 16*s, 6*s, ...fg, 1.5*s)
  // Neck
  fillRect(pixels, w, Math.round(14.5*s), Math.round(19*s), Math.round(17.5*s), Math.round(21*s), ...fg)
  // Terminal box outline
  roundRect(pixels, w, Math.round(9*s), Math.round(21*s), Math.round(14*s), Math.round(6*s), Math.round(1.5*s), ...accent)
  // Terminal interior
  fillRect(pixels, w, Math.round(10*s), Math.round(22*s), Math.round(22*s), Math.round(26*s), ...CARD)
  // Key lines
  for (const kx of [12, 16, 20]) {
    line(pixels, w, kx*s, 23*s, kx*s, 25.5*s, ...accent, Math.max(1, Math.round(0.8*s)))
  }
}

function drawAppIcon(pixels, w, h) {
  fillAll(pixels, ...BG)
  // Background card
  roundRect(pixels, w, Math.round(w*0.04), Math.round(h*0.04), Math.round(w*0.92), Math.round(h*0.92), Math.round(w*0.1), ...CARD)
  // Subtle glow behind robot head
  for (let r = 12; r >= 0; r--) {
    circle(pixels, w, w/2, h*0.38, r * w/32, 0, 0x60, 0x80, false, 1)
  }
  drawRobot(pixels, w, h, [CYAN, ORANGE])
}

function drawTrayIcon(pixels, w, h) {
  // Transparent background, white robot (macOS template style)
  drawRobot(pixels, w, h, [WHITE, WHITE])
}

function drawTrayIconColor(pixels, w, h) {
  fillAll(pixels, ...BG)
  drawRobot(pixels, w, h, [CYAN, ORANGE])
}

// ── Generate & save ────────────────────────────────────────────────────────
const iconDir = join(__dirname, '..', 'electron', 'icon')
mkdirSync(iconDir, { recursive: true })

const icon512 = createPNG(512, 512, drawAppIcon)
writeFileSync(join(iconDir, 'icon.png'), icon512)
console.log('✓ icon.png  (512×512)')

const icon256 = createPNG(256, 256, drawAppIcon)
const icoFile = createICO([icon256])
writeFileSync(join(iconDir, 'icon.ico'), icoFile)
console.log('✓ icon.ico  (256×256 embedded PNG)')

const tray32 = createPNG(32, 32, drawTrayIcon)
writeFileSync(join(iconDir, 'tray.png'), tray32)
console.log('✓ tray.png  (32×32 template)')

const tray16 = createPNG(16, 16, drawTrayIconColor)
const trayIco = createSmallICO(tray16, 16)
writeFileSync(join(iconDir, 'tray.ico'), trayIco)
console.log('✓ tray.ico  (16×16)')

console.log('\nAll icons generated → electron/icon/')
