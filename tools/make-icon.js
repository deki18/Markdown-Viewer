/**
 * 生成应用图标（build/icon.ico / icon.png），零依赖手写 PNG + ICO 编码。
 * 运行：node tools/make-icon.js
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[n] = c
    }
  }
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePNG(size, rgba) {
  const stride = size * 4 + 1
  const raw = Buffer.alloc(stride * size)
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0
    rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function encodeICO(pngBuffer, size) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry[0] = size >= 256 ? 0 : size
  entry[1] = size >= 256 ? 0 : size
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(pngBuffer.length, 8)
  entry.writeUInt32LE(22, 12)
  return Buffer.concat([header, entry, pngBuffer])
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

const SHAPES = [
  [0.26, 0.30, 0.26, 0.72],
  [0.74, 0.30, 0.74, 0.72],
  [0.26, 0.30, 0.50, 0.56],
  [0.74, 0.30, 0.50, 0.56],
  [0.26, 0.84, 0.74, 0.84]
]

function render(size) {
  const ss = 4
  const out = Buffer.alloc(size * size * 4)
  const bg = [47, 111, 235]
  const fg = [255, 255, 255]
  const radius = 0.2
  const stroke = 0.045

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const nx = (x + (sx + 0.5) / ss) / size
          const ny = (y + (sy + 0.5) / ss) / size
          let dx = 0
          let dy = 0
          if (nx < radius) dx = radius - nx
          else if (nx > 1 - radius) dx = nx - (1 - radius)
          if (ny < radius) dy = radius - ny
          else if (ny > 1 - radius) dy = ny - (1 - radius)
          const inBg = dx * dx + dy * dy <= radius * radius
          if (!inBg) continue
          let inFg = false
          for (const s of SHAPES) {
            if (distToSegment(nx, ny, s[0], s[1], s[2], s[3]) <= stroke) { inFg = true; break }
          }
          r += inFg ? fg[0] : bg[0]
          g += inFg ? fg[1] : bg[1]
          b += inFg ? fg[2] : bg[2]
          a += 255
        }
      }
      const n = ss * ss
      const i = (y * size + x) * 4
      const alpha = a / n
      out[i] = a ? Math.round(r / n) : 0
      out[i + 1] = a ? Math.round(g / n) : 0
      out[i + 2] = a ? Math.round(b / n) : 0
      out[i + 3] = Math.round(alpha)
    }
  }
  return out
}

const size = Number(process.argv[2]) || 256
const dir = path.join(__dirname, '..', 'build')
fs.mkdirSync(dir, { recursive: true })
const png = encodePNG(size, render(size))
const pngPath = path.join(dir, 'icon.png')
const icoPath = path.join(dir, 'icon.ico')

function writeOrSkip(p, buf) {
  try {
    fs.writeFileSync(p, buf)
    return true
  } catch (e) {
    if (fs.existsSync(p)) {
      console.log(`跳过 ${p}（文件被占用或锁定）`)
      return true
    }
    throw e
  }
}

writeOrSkip(pngPath, png)
writeOrSkip(icoPath, encodeICO(png, size))
console.log(`已生成 build/icon.png 与 build/icon.ico (${size}x${size})`)
