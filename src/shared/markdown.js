/**
 * Markdown 渲染管线（纯逻辑，Node 与渲染进程共用）
 * 输出：html / toc / images / codes / mermaid / stats
 */
const path = require('path')
const MarkdownIt = require('markdown-it')
const hljs = require('highlight.js')
const footnote = require('markdown-it-footnote')
const taskLists = require('markdown-it-task-lists')

let katex = null
try { katex = require('katex') } catch (e) { katex = null }

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESCAPE_MAP[c])
}

function slugify(text, used) {
  let s = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[`*_~[\]()#!]/g, '')
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
  if (!s) s = 'section'
  let base = s
  let i = 1
  while (used.has(s)) s = base + '-' + i++
  used.add(s)
  return s
}

function collectText(children) {
  let out = ''
  for (const c of children || []) {
    if (c.type === 'text') out += c.content
    else if (c.type === 'code_inline') out += c.content
    else if (c.children) out += collectText(c.children)
  }
  return out
}

/** 兜底清洗：本地文件也防一手内联事件与脚本注入 */
function sanitize(html) {
  return html
    .replace(/<\s*(script|iframe|object|embed)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|iframe|object|embed)\b[^>]*\/?>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
}

function isExternal(href) {
  return /^https?:\/\//i.test(href || '')
}

function safeDecode(value) {
  try { return decodeURIComponent(value) } catch (e) { return value }
}

function createMarkdown() {
  const md = new MarkdownIt({
    // 阅读器默认处理不可信本地文档；原生 HTML 会扩大到 Electron 文件桥的攻击面。
    html: false,
    linkify: true,
    breaks: false,
    typographer: false,
    highlight(code, lang) {
      let body
      try {
        if (lang && hljs.getLanguage(lang)) {
          body = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
        } else {
          body = hljs.highlightAuto(code).value
        }
      } catch (e) {
        return ''
      }
      return `<pre class="hljs"><code>${body}</code></pre>`
    }
  })

  md.use(footnote)
  md.use(taskLists, { enabled: true, label: true })

  md.validateLink = (url) => {
    const u = String(url || '').trim()
    if (/^(https?:\/\/|mailto:|tel:|#|\/|\.{1,2}\/)/i.test(u)) return true
    if (/^data:image\/(png|gif|jpeg|webp);base64,/i.test(u)) return true
    return !/^[a-z][a-z0-9+.-]*:/i.test(u)
  }

  let usedSlugs = new Set()

  function blockSourceAttrs(token) {
    if (!token || !token.map) return ''
    return ` data-source-start="${token.map[0]}" data-source-end="${token.map[1]}"`
  }

  function inlineSourceAttrs(token) {
    const meta = token && token.meta
    if (!meta || !Number.isInteger(meta.sourceStart)) return ''
    return ` data-source-offset="${meta.sourceStart}" data-source-end-offset="${meta.sourceEnd}"`
  }

  // 数学公式：块级 $$...$$
  md.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
    const start = state.bMarks[startLine] + state.tShift[startLine]
    const max = state.eMarks[startLine]
    if (start + 2 > max) return false
    if (state.src.slice(start, start + 2) !== '$$') return false
    let firstLine = state.src.slice(start + 2, max)
    if (silent) return true
    let found = false
    let nextLine = startLine
    if (firstLine.trim().endsWith('$$')) {
      firstLine = firstLine.trim().slice(0, -2)
      found = true
    }
    let content = firstLine
    let lastLine = ''
    while (!found) {
      nextLine++
      if (nextLine >= endLine) break
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine]
      const lineEnd = state.eMarks[nextLine]
      if (lineStart < lineEnd && state.tShift[nextLine] < state.blkIndent) break
      const line = state.src.slice(lineStart, lineEnd)
      if (line.trim().endsWith('$$')) {
        lastLine = line.trim().slice(0, -2)
        found = true
      } else {
        content += '\n' + line
      }
    }
    state.line = nextLine + 1
    const token = state.push('math_block', 'div', 0)
    token.markup = '$$'
    token.content = content + (lastLine ? '\n' + lastLine : '')
    token.map = [startLine, state.line]
    return true
  }, { alt: ['paragraph', 'reference', 'blockquote', 'list'] })

  md.renderer.rules.math_block = (tokens, idx) => {
    const token = tokens[idx]
    const tex = token.content
    const attrs = blockSourceAttrs(token)
    if (!katex) return `<pre class="math-fallback"${attrs}>${escapeHtml(tex)}</pre>`
    try {
      return `<div class="math-block"${attrs}>${katex.renderToString(tex, { displayMode: true, throwOnError: false })}</div>`
    } catch (e) {
      return `<pre class="math-fallback"${attrs}>${escapeHtml(tex)}</pre>`
    }
  }

  // 数学公式：行内 $...$
  md.inline.ruler.before('escape', 'math_inline', (state, silent) => {
    const start = state.pos
    if (state.src[start] !== '$') return false
    if (state.src[start + 1] === '$') return false
    let pos = start + 1
    let found = false
    while (pos < state.posMax) {
      if (state.src[pos] === '\\') { pos += 2; continue }
      if (state.src[pos] === '\n') return false
      if (state.src[pos] === '$') { found = true; break }
      pos++
    }
    if (!found || pos === start + 1) return false
    const tex = state.src.slice(start + 1, pos)
    if (!silent) {
      const token = state.push('math_inline', 'span', 0)
      token.content = tex
    }
    state.pos = pos + 1
    return true
  })

  md.renderer.rules.math_inline = (tokens, idx) => {
    const token = tokens[idx]
    const tex = token.content
    const attrs = inlineSourceAttrs(token)
    if (!katex) return `<code${attrs}>${escapeHtml(tex)}</code>`
    try {
      return `<span class="md-source-math"${attrs}>${katex.renderToString(tex, { displayMode: false, throwOnError: false })}</span>`
    } catch (e) {
      return `<code${attrs}>${escapeHtml(tex)}</code>`
    }
  }

  // 为预览文本建立源字符偏移。Markdown 标记会被跳过，普通文本、行内代码与公式可精确回到源文件。
  md.core.ruler.after('inline', 'source_positions', (state) => {
    const src = state.src
    const lineOffsets = [0]
    for (let i = 0; i < src.length; i++) if (src[i] === '\n') lineOffsets.push(i + 1)
    lineOffsets.push(src.length)

    for (const token of state.tokens) {
      if (token.type === 'fence' && token.map && token.content) {
        const blockStart = lineOffsets[token.map[0]] == null ? 0 : lineOffsets[token.map[0]]
        const blockEnd = lineOffsets[token.map[1]] == null ? src.length : lineOffsets[token.map[1]]
        const found = src.indexOf(token.content, blockStart)
        if (found >= blockStart && found < blockEnd) {
          token.meta = Object.assign({}, token.meta, {
            sourceStart: found,
            sourceEnd: Math.min(blockEnd, found + token.content.length)
          })
        }
      }
      if (token.map && token.nesting === 1) {
        token.attrSet('data-source-start', String(token.map[0]))
        token.attrSet('data-source-end', String(token.map[1]))
      } else if (token.map && token.nesting === 0 && !['inline', 'fence', 'code_block', 'math_block'].includes(token.type)) {
        token.attrSet('data-source-start', String(token.map[0]))
        token.attrSet('data-source-end', String(token.map[1]))
      }

      if (token.type !== 'inline' || !token.map || !token.children) continue
      const segmentStart = lineOffsets[token.map[0]] == null ? 0 : lineOffsets[token.map[0]]
      const segmentEnd = lineOffsets[token.map[1]] == null ? src.length : lineOffsets[token.map[1]]
      let cursor = segmentStart
      for (const child of token.children) {
        if (child.type === 'softbreak' || child.type === 'hardbreak') {
          const newline = src.indexOf('\n', cursor)
          if (newline >= 0 && newline < segmentEnd) cursor = newline + 1
          continue
        }
        if (!['text', 'code_inline', 'math_inline'].includes(child.type) || !child.content) continue
        const found = src.indexOf(child.content, cursor)
        if (found < 0 || found >= segmentEnd) continue
        child.meta = Object.assign({}, child.meta, {
          sourceStart: found,
          sourceEnd: Math.min(segmentEnd, found + child.content.length)
        })
        cursor = found + child.content.length
      }
    }
  })

  md.renderer.rules.text = (tokens, idx) => {
    const token = tokens[idx]
    const attrs = inlineSourceAttrs(token)
    const text = escapeHtml(token.content)
    return attrs ? `<span class="md-source-text"${attrs}>${text}</span>` : text
  }

  md.renderer.rules.code_inline = (tokens, idx) => {
    const token = tokens[idx]
    return `<code${inlineSourceAttrs(token)}>${escapeHtml(token.content)}</code>`
  }

  // 标题锚点 + 目录收集
  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const inline = tokens[idx + 1]
    const text = collectText(inline && inline.children)
    const id = slugify(text, usedSlugs)
    tokens[idx].attrSet('id', id)
    if (env && env.toc) env.toc.push({ id, text, level: Number(tokens[idx].tag.slice(1)) })
    return self.renderToken(tokens, idx, options)
  }

  // 图片：包 figure，登记索引
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const srcIdx = token.attrIndex('src')
    const src = srcIdx >= 0 ? token.attrs[srcIdx][1] : ''
    const alt = collectText(token.children)
    const id = env && env.images ? env.images.length : 0
    if (env && env.images) env.images.push({ src, alt })
    const cls = isExternal(src) ? 'md-image is-external' : 'md-image'
    return `<figure class="md-figure"><img class="${cls}" loading="lazy" data-img-id="${id}" src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" decoding="async">${alt ? `<figcaption>${escapeHtml(alt)}</figcaption>` : ''}</figure>`
  }

  // 表格：横向滚动容器（table_open 无默认规则，用 renderToken 兜底）
  md.renderer.rules.table_open = (tokens, idx, options, env, self) => {
    return '<div class="table-wrap">' + self.renderToken(tokens, idx, options)
  }
  md.renderer.rules.table_close = (tokens, idx, options, env, self) => {
    return self.renderToken(tokens, idx, options) + '</div>'
  }

  // 链接：拦截危险协议、外链新窗口、锚点内部跳转
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    let hrefIdx = token.attrIndex('href')
    let href = hrefIdx >= 0 ? token.attrs[hrefIdx][1] : ''
    if (href && options.validateLink && !options.validateLink(href)) {
      token.attrs.splice(hrefIdx, 1)
      href = ''
    }
    if (isExternal(href)) {
      token.attrSet('target', '_blank')
      token.attrSet('rel', 'noopener noreferrer')
    } else if (href.startsWith('#')) {
      token.attrSet('class', 'anchor-link')
      token.attrSet('data-anchor', href.slice(1))
    }
    return self.renderToken(tokens, idx, options)
  }

  // 代码块：语言标签 + 复制按钮 + 行号；mermaid 单独处理
  const defaultFence = md.renderer.rules.fence
  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    const sourceAttrs = blockSourceAttrs(token)
    const info = token.info ? token.info.trim() : ''
    if (info === 'mermaid') {
      const id = env && env.mermaid ? env.mermaid.length : 0
      if (env && env.mermaid) env.mermaid.push(token.content)
      return `<div class="mermaid-block" data-mermaid-id="${id}"${sourceAttrs}>${escapeHtml(token.content)}</div>`
    }
    const body = defaultFence(tokens, idx, options, env, self)
    const mappedBody = inlineSourceAttrs(token) ? body.replace('<pre', `<pre${inlineSourceAttrs(token)}`) : body
    const lang = (info.split(/\s+/)[0] || 'text')
    const codeId = env && env.codes ? env.codes.length : 0
    const raw = token.content.replace(/\n$/, '')
    if (env && env.codes) env.codes.push(raw)
    const lineCount = raw.split('\n').length
    return `<div class="code-block"${sourceAttrs}><div class="code-head"><span class="code-lang">${escapeHtml(lang)}</span><span class="code-lines">${lineCount} 行</span><button type="button" class="code-copy" data-code-id="${codeId}">复制</button></div>${mappedBody}</div>`
  }

  function render(src, options) {
    const opts = options || {}
    usedSlugs = new Set()
    const env = { toc: [], images: [], codes: [], mermaid: [] }
    const baseDir = opts.baseDir || ''
    let html = md.render(String(src == null ? '' : src), env)
    html = sanitize(html)
    const images = env.images.map((img, i) => ({
      index: i,
      src: img.src,
      alt: img.alt,
      external: isExternal(img.src),
      resolved: isExternal(img.src) ? img.src : (baseDir ? path.resolve(baseDir, safeDecode(img.src.split('?')[0])) : '')
    }))
    const plain = String(src || '').replace(/```[\s\S]*?```/g, '').replace(/[#>*`_\-!\[\]()]/g, ' ')
    const cjk = (plain.match(/[\u4e00-\u9fa5]/g) || []).length
    const words = (plain.match(/[A-Za-z0-9]+/g) || []).length
    return {
      html,
      toc: env.toc,
      images,
      codes: env.codes,
      mermaid: env.mermaid,
      stats: {
        chars: String(src || '').length,
        cjk,
        words,
        images: images.length,
        lines: String(src || '').split('\n').length,
        readMinutes: Math.max(1, Math.round((cjk + words) / 400))
      }
    }
  }

  return { render, md }
}

const instance = createMarkdown()
module.exports = {
  createMarkdown,
  renderMarkdown: instance.render,
  escapeHtml,
  slugify
}
