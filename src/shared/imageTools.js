/**
 * 图片工具：内容哈希查重、尺寸探测（零依赖，解析文件头）
 */
const fs = require('fs')
const crypto = require('crypto')
const path = require('path')

function md5File(filePath) {
  const buf = fs.readFileSync(filePath)
  return { hash: crypto.createHash('md5').update(buf).digest('hex'), size: buf.length }
}

function probeSize(buf) {
  try {
    if (buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let offset = 2
      while (offset < buf.length - 9) {
        if (buf[offset] !== 0xff) { offset++; continue }
        const marker = buf[offset + 1]
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) }
        }
        const len = buf.readUInt16BE(offset + 2)
        offset += 2 + len
      }
      return { width: 0, height: 0 }
    }
    if (buf.toString('ascii', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    }
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buf.toString('ascii', 12, 16)
      if (fmt === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
      if (fmt === 'VP8L') {
        const bits = buf.readUInt32LE(21)
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
      }
      if (fmt === 'VP8X') return { width: (buf.readUIntLE(24, 3) & 0xffffff) + 1, height: (buf.readUIntLE(27, 3) & 0xffffff) + 1 }
    }
    if (buf.toString('ascii', 0, 2) === 'BM') {
      return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) }
    }
    const head = buf.toString('utf8', 0, Math.min(buf.length, 2048))
    if (head.includes('<svg')) {
      const vb = head.match(/viewBox\s*=\s*["']\s*[\d.\-]+\s+[\d.\-]+\s+([\d.]+)\s+([\d.]+)/)
      if (vb) return { width: Math.round(parseFloat(vb[1])), height: Math.round(parseFloat(vb[2])) }
      const w = head.match(/\bwidth\s*=\s*["']([\d.]+)/)
      const h = head.match(/\bheight\s*=\s*["']([\d.]+)/)
      if (w && h) return { width: Math.round(parseFloat(w[1])), height: Math.round(parseFloat(h[1])) }
    }
  } catch (e) { /* 探测失败返回 0 */ }
  return { width: 0, height: 0 }
}

function formatSize(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let n = bytes
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`
}

/** 分析文档内图片：存在性、体积、尺寸、哈希，并标出重复组 */
function analyzeImages(images, opts) {
  const options = opts || {}
  const results = []
  const hashMap = new Map()
  const text = String(options.markdown || '')

  for (const img of images) {
    const item = {
      index: img.index,
      src: img.src,
      alt: img.alt,
      external: img.external,
      exists: false,
      path: '',
      size: 0,
      sizeText: '0 B',
      width: 0,
      height: 0,
      hash: '',
      occurrences: 1
    }
    if (img.external) {
      item.status = 'external'
      results.push(item)
      continue
    }
    let resolved = img.resolved
    if (!resolved || !fs.existsSync(resolved)) {
      // 回退到用户配置的图片根目录，按文件名查找
      if (options.imageRoots && options.imageRoots.length) {
        let decoded = img.src.split(/[?#]/)[0]
        try { decoded = decodeURIComponent(decoded) } catch (e) { /* 保留原路径文本 */ }
        const base = path.basename(decoded)
        for (const root of options.imageRoots) {
          if (!root) continue
          const candidate = path.join(root, base)
          if (fs.existsSync(candidate)) { resolved = candidate; break }
        }
      }
    }
    if (resolved && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      item.path = resolved
      item.exists = true
      try {
        const { hash, size } = md5File(resolved)
        const buf = fs.readFileSync(resolved)
        const dim = probeSize(buf)
        item.hash = hash
        item.size = size
        item.sizeText = formatSize(size)
        item.width = dim.width
        item.height = dim.height
      } catch (e) {
        item.status = 'error'
      }
      if (item.hash) {
        if (hashMap.has(item.hash)) hashMap.get(item.hash).push(item)
        else hashMap.set(item.hash, [item])
      }
    } else {
      item.status = 'missing'
    }
    // 统计同一 src 在文档中出现的次数
    const escaped = img.src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    item.occurrences = (text.match(new RegExp(escaped, 'g')) || []).length
    results.push(item)
  }

  const duplicates = []
  for (const [hash, group] of hashMap.entries()) {
    if (group.length > 1) {
      duplicates.push({
        hash,
        size: group[0].size,
        sizeText: group[0].sizeText,
        files: group.map((g) => ({ index: g.index, src: g.src, path: g.path }))
      })
    }
  }

  const missing = results.filter((r) => r.status === 'missing')
  const totalSize = results.reduce((sum, r) => sum + (r.size || 0), 0)

  return {
    items: results,
    duplicates,
    missing,
    summary: {
      total: results.length,
      external: results.filter((r) => r.external).length,
      missing: missing.length,
      duplicateGroups: duplicates.length,
      duplicateWaste: duplicates.reduce((s, d) => s + d.size * (d.files.length - 1), 0),
      totalSize,
      totalSizeText: formatSize(totalSize)
    }
  }
}

function inspectFileAsync(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5')
    const headParts = []
    let headSize = 0
    let size = 0
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk) => {
      hash.update(chunk)
      size += chunk.length
      if (headSize < 65536) {
        const take = chunk.subarray(0, Math.min(chunk.length, 65536 - headSize))
        headParts.push(take)
        headSize += take.length
      }
    })
    stream.on('error', reject)
    stream.on('end', () => resolve({ hash: hash.digest('hex'), size, head: Buffer.concat(headParts) }))
  })
}

/** 与 analyzeImages 输出一致，但使用流式异步读取，避免图片扫描阻塞 Electron 主线程。 */
async function analyzeImagesAsync(images, opts) {
  const options = opts || {}
  const results = []
  const hashMap = new Map()
  const text = String(options.markdown || '')

  for (const img of images || []) {
    const item = {
      index: img.index,
      src: img.src,
      alt: img.alt,
      external: img.external,
      exists: false,
      path: '',
      size: 0,
      sizeText: '0 B',
      width: 0,
      height: 0,
      hash: '',
      occurrences: 1
    }
    if (img.external) {
      item.status = 'external'
      results.push(item)
      continue
    }
    let resolved = img.resolved
    if (!resolved || !fs.existsSync(resolved)) {
      let decoded = String(img.src || '').split(/[?#]/)[0]
      try { decoded = decodeURIComponent(decoded) } catch (e) { /* 保留原路径文本 */ }
      const base = path.basename(decoded)
      for (const root of options.imageRoots || []) {
        const candidate = path.join(root, base)
        try {
          if (fs.statSync(candidate).isFile()) { resolved = candidate; break }
        } catch (e) { /* 继续尝试下一个根目录 */ }
      }
    }
    try {
      if (resolved && (await fs.promises.stat(resolved)).isFile()) {
        item.path = resolved
        item.exists = true
        const inspected = await inspectFileAsync(resolved)
        const dim = probeSize(inspected.head)
        item.hash = inspected.hash
        item.size = inspected.size
        item.sizeText = formatSize(inspected.size)
        item.width = dim.width
        item.height = dim.height
        if (hashMap.has(item.hash)) hashMap.get(item.hash).push(item)
        else hashMap.set(item.hash, [item])
      } else {
        item.status = 'missing'
      }
    } catch (e) {
      item.status = resolved ? 'error' : 'missing'
    }
    const escaped = String(img.src || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    item.occurrences = escaped ? (text.match(new RegExp(escaped, 'g')) || []).length : 0
    results.push(item)
  }

  const duplicates = []
  for (const [hash, group] of hashMap.entries()) {
    if (group.length > 1) duplicates.push({
      hash,
      size: group[0].size,
      sizeText: group[0].sizeText,
      files: group.map((g) => ({ index: g.index, src: g.src, path: g.path }))
    })
  }
  const missing = results.filter((item) => item.status === 'missing')
  const totalSize = results.reduce((sum, item) => sum + (item.size || 0), 0)
  return {
    items: results,
    duplicates,
    missing,
    summary: {
      total: results.length,
      external: results.filter((item) => item.external).length,
      missing: missing.length,
      duplicateGroups: duplicates.length,
      duplicateWaste: duplicates.reduce((sum, item) => sum + item.size * (item.files.length - 1), 0),
      totalSize,
      totalSizeText: formatSize(totalSize)
    }
  }
}

module.exports = { analyzeImages, analyzeImagesAsync, probeSize, md5File, formatSize }
