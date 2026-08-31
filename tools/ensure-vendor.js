/**
 * 打包前把第三方库复制到 src/renderer/vendor，确保离线 file:// 协议可加载。
 * 运行：node tools/ensure-vendor.js
 */
const fs = require('fs')
const path = require('path')

const vendorDir = path.join(__dirname, '..', 'src', 'renderer', 'vendor')
const root = path.join(__dirname, '..', 'node_modules')

function copy(src, dst) {
  if (!fs.existsSync(src)) throw new Error('vendor 源文件不存在：' + src)
  fs.mkdirSync(path.dirname(dst), { recursive: true })
  try {
    fs.copyFileSync(src, dst)
  } catch (e) {
    if (fs.existsSync(dst) && fs.statSync(dst).size > 0) {
      console.log(`跳过 ${path.basename(dst)}（目标已存在且被占用）`)
      return
    }
    throw e
  }
}

fs.mkdirSync(vendorDir, { recursive: true })

// Mermaid 10 通过 file:// 动态加载 chunk，需要复制整个 dist 目录并保持相对路径
const mermaidFrom = path.join(root, 'mermaid', 'dist')
const mermaidTo = path.join(vendorDir, 'mermaid')
if (!fs.existsSync(path.join(mermaidTo, 'mermaid.min.js'))) {
  fs.cpSync(mermaidFrom, mermaidTo, { recursive: true, force: true })
}

copy(path.join(root, 'highlight.js', 'styles', 'github.css'), path.join(vendorDir, 'hljs-light.css'))
copy(path.join(root, 'highlight.js', 'styles', 'github-dark.css'), path.join(vendorDir, 'hljs-dark.css'))

const katexFrom = path.join(root, 'katex', 'dist')
const katexTo = path.join(vendorDir, 'katex')
if (!fs.existsSync(path.join(katexTo, 'katex.min.css'))) {
  fs.cpSync(katexFrom, katexTo, { recursive: true, force: true })
}

console.log('vendor 文件已就绪')
