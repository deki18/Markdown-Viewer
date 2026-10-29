(function () {
  'use strict'

  const mdv = window.mdv
  const $ = (id) => document.getElementById(id)
  const on = (el, event, cb) => { if (el) el.addEventListener(event, cb) }
  const el = {
    tabbar: $('tabbar'), sidebar: $('sidebar'), splitter: $('splitter'), tree: $('tree'), treeRoot: $('treeRoot'),
    outline: $('outline'), outlineCount: $('outlineCount'), imageList: $('imageList'), imageSummary: $('imageSummary'),
    searchInput: $('globalSearchInput'), searchResults: $('searchResults'), recentList: $('recentList'),
    preview: $('preview'), editor: $('editor'), content: $('content'), docWrap: $('docWrap'), emptyState: $('emptyState'),
    findInput: $('findInput'), findCount: $('findCount'),
    statPath: $('statPath'), statImages: $('statImages'), statWords: $('statWords'), statRead: $('statRead'), statZoom: $('statZoom'), statMsg: $('statMsg'),
    lightbox: $('lightbox'), lbImg: $('lbImg'), lbMeta: $('lbMeta'),
    settings: $('settingsModal'), toast: $('toast')
  }

  const state = {
    tabs: [],
    activeId: null,
    rootDir: '',
    prefs: { view: { theme: 'ink', fontSize: 16, lineWidth: 900, focusMode: false }, sidebar: { visible: true, width: 320, activeTab: 'files' }, recentFiles: [], imageRoots: [] },
    panel: 'files',
    editMode: false,
    gallery: [],
    galleryIndex: 0,
    findMarks: [],
    findIndex: -1,
    pendingFind: '',
    treeCache: [],
    expandedDirs: new Set(),
    seq: 0
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }
  function baseName(p) {
    return String(p || '').split(/[\\/]/).pop() || ''
  }
  function dirName(p) {
    const s = String(p || '').replace(/\\/g, '/')
    const i = s.lastIndexOf('/')
    return i < 0 ? '' : s.slice(0, i)
  }
  function isAbsolute(p) {
    return /^[A-Za-z]:[\\/]/.test(p || '') || String(p || '').startsWith('/')
  }
  function joinPath(a, b) {
    if (!a) return b
    if (isAbsolute(b)) return b
    return a.replace(/[\\/]+$/, '') + '/' + b
  }
  function toFileUrl(p) {
    if (/^(https?:|data:|file:)/i.test(p)) return p
    let s = String(p || '').replace(/\\/g, '/')
    if (!s.startsWith('/')) s = '/' + s
    return 'file://' + encodeURI(s)
  }
  function extOf(p) {
    const n = baseName(p)
    const i = n.lastIndexOf('.')
    return i < 0 ? '' : n.slice(i).toLowerCase()
  }
  let toastTimer = null
  function toast(msg) {
    el.toast.textContent = msg
    el.toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { el.toast.hidden = true }, 2200)
  }

  function activeTab() {
    return state.tabs.find((t) => t.id === state.activeId) || null
  }

  /* ---------------- 标签与文档 ---------------- */

  function renderTabs() {
    el.tabbar.innerHTML = state.tabs.map((t) => `
      <button class="tab ${t.id === state.activeId ? 'is-active' : ''}" data-id="${t.id}" title="${escapeHtml(t.path)}">
        <span class="tab-name">${escapeHtml(t.name)}</span>
        ${t.dirty ? '<span class="tab-dirty">●</span>' : ''}
        <span class="tab-close" data-close="${t.id}">×</span>
      </button>`).join('')
    el.tabbar.querySelectorAll('.tab').forEach((btn) => {
      on(btn, 'click', (e) => {
        const closeId = e.target.getAttribute('data-close')
        if (closeId) { e.stopPropagation(); closeTab(Number(closeId)) } else setActiveTab(Number(btn.getAttribute('data-id')))
      })
    })
  }

  function setActiveTab(id) {
    const prev = activeTab()
    if (prev && prev.id !== id) prev.scrollTop = el.docWrap.scrollTop
    const isSwitch = state.activeId !== id
    state.activeId = id
    renderTabs()
    const tab = activeTab()
    el.emptyState.hidden = !!tab
    el.docWrap.hidden = !tab
    if (!tab) $('findbar').hidden = true
    if (!tab) {
      el.preview.innerHTML = ''
      el.editor.value = ''
      updateStatus(null)
      $('documentTitle').textContent = 'Markdown 查看器'
      return
    }
    $('documentTitle').textContent = tab.name
    el.editor.value = tab.content
    el.statPath.textContent = tab.path
    // 首次显示或从未渲染过才完整渲染，切换标签时保留已渲染内容
    if (isSwitch || !tab.render) paintDoc(tab)
    if (!$('findbar').hidden && el.findInput.value.trim()) runFind(el.findInput.value)
    el.docWrap.scrollTop = tab.scrollTop || 0
  }

  function closeTab(id) {
    const idx = state.tabs.findIndex((t) => t.id === id)
    if (idx < 0) return
    const tab = state.tabs[idx]
    if (tab.dirty && !confirm(`「${tab.name}」有未保存的修改，确定关闭？`)) return
    state.tabs.splice(idx, 1)
    if (!state.tabs.length) {
      state.activeId = null
      renderTabs()
      el.emptyState.hidden = false
      el.docWrap.hidden = true
      clearFindInput({ focus: false })
      $('findbar').hidden = true
      el.preview.innerHTML = ''
      updateStatus(null)
      return
    }
    setActiveTab(state.tabs[Math.min(idx, state.tabs.length - 1)].id)
  }

  async function openFiles(paths, opts) {
    const options = opts || {}
    let lastId = null
    for (const p of paths) {
      if (!p) continue
      if (!options.force && !/\.(md|markdown|mdown|mkd|txt)$/i.test(p)) { toast('仅支持 Markdown 文件：' + baseName(p)); continue }
      const existing = state.tabs.find((t) => t.path === p)
      if (existing) { lastId = existing.id; continue }
      const res = await mdv.readFile(p)
      if (!res.ok) { toast('读取失败：' + (res.message || res.error || '未知错误')); continue }
      const tab = {
        id: ++state.seq,
        path: p,
        name: baseName(p),
        content: res.content,
        original: res.content,
        dirty: false,
        scrollTop: 0,
        render: null,
        imageReport: null,
        mtime: res.mtime
      }
      state.tabs.push(tab)
      lastId = tab.id
      mdv.addRecent(p)
      if (!state.rootDir) openFolder(dirName(p), { silent: true }).catch(() => {})
    }
    if (lastId != null) {
      state.activeId = lastId
      renderTabs()
    el.emptyState.hidden = true
    el.docWrap.hidden = false
      setActiveTab(lastId)
      loadPrefs().then(renderRecent)
    } else {
      renderTabs()
    }
  }

  async function openFolder(dir, opts) {
    const options = opts || {}
    if (!dir) return
    state.rootDir = dir
    const res = await mdv.readTree(dir)
    el.treeRoot.textContent = dir
    el.treeRoot.title = dir
    state.treeCache = res.tree || []
    paintTree()
    if (!options.silent) {
      switchPanel('files')
      toast('已载入文件夹：' + dir)
    }
    mdv.setPrefs({ lastFolder: dir })
  }

  function paintTree() {
    el.tree.innerHTML = renderTree(state.treeCache || [], 0)
  }

  function renderTree(nodes, depth) {
    const d = depth || 0
    let html = ''
    for (const node of nodes) {
      const pad = 6 + d * 12
      if (node.type === 'dir') {
        const expanded = state.expandedDirs.has(node.path)
        html += `<div class="tree-branch${expanded ? ' is-expanded' : ''}"><div class="tree-node is-dir" data-dir="${escapeHtml(node.path)}" style="padding-left:${pad}px"><span class="tw fluent-icon" aria-hidden="true">&#xE76C;</span><span class="tn">${escapeHtml(node.name)}</span></div>`
        if (expanded && node.children && node.children.length) html += `<div class="tree-children">${renderTree(node.children, d + 1)}</div>`
        html += '</div>'
      } else if (node.markdown) {
        const tab = activeTab()
        const active = tab && tab.path === node.path ? ' is-active' : ''
        html += `<div class="tree-node${active}" data-file="${escapeHtml(node.path)}" style="padding-left:${pad + 14}px"><span class="tn">${escapeHtml(node.name)}</span></div>`
      }
    }
    return html
  }

  /* ---------------- 文档渲染 ---------------- */

  function paintDoc(tab) {
    const result = mdv.render(tab.content, { baseDir: dirName(tab.path) })
    tab.render = result
    el.preview.innerHTML = result.html
    renderOutline(tab)
    renderMermaid(tab)
    updateStatus(tab)
    resolveImages(tab)
    if (state.pendingFind) {
      runFind(state.pendingFind)
      state.pendingFind = ''
    }
  }

  async function resolveImages(tab) {
    const imgs = el.preview.querySelectorAll('img.md-image')
    if (!imgs.length) { updateStatus(tab); return }
    const report = await mdv.analyzeImages(tab.render.images, tab.content, tab.path)
    if (!report.ok || !activeTab() || activeTab().id !== tab.id) return
    tab.imageReport = report
    for (const img of imgs) {
      const idx = Number(img.getAttribute('data-img-id'))
      const item = report.items[idx]
      if (!item) continue
      if (item.path) {
        img.src = toFileUrl(item.path)
        img.setAttribute('data-path', item.path)
        img.setAttribute('data-w', item.width)
        img.setAttribute('data-h', item.height)
        img.title = `${baseName(item.src)} · ${item.width}×${item.height} · ${item.sizeText}`
      } else if (!item.external) {
        img.classList.add('is-broken')
        img.alt = '[图片缺失] ' + (item.alt || baseName(item.src))
      }
      img.onerror = () => { img.classList.add('is-broken'); img.alt = '[无法加载] ' + (item.alt || baseName(item.src)) }
    }
    buildGallery()
    if (state.panel === 'images') renderImagePanel(tab)
    updateStatus(tab)
  }

  function buildGallery() {
    state.gallery = Array.from(el.preview.querySelectorAll('img.md-image'))
      .filter((img) => img.getAttribute('data-path'))
      .map((img) => ({ src: img.src, path: img.getAttribute('data-path'), meta: img.title }))
  }

  async function renderMermaid(tab) {
    const nodes = el.preview.querySelectorAll('.mermaid-block')
    if (!nodes.length) return
    if (!window.mermaid) {
      nodes.forEach((n) => { n.innerHTML = '<pre class="mermaid-error">Mermaid 库未加载</pre>' })
      return
    }
    try {
      window.mermaid.initialize({
        startOnLoad: false,
        theme: resolvedTheme() === 'night' ? 'dark' : 'default',
        securityLevel: 'strict',
        fontFamily: 'inherit'
      })
    } catch (e) { /* 初始化失败沿用默认配置 */ }
    for (const node of nodes) {
      const src = node.textContent.trim()
      if (!src) { node.innerHTML = ''; continue }
      node.innerHTML = '<div class="mermaid-error">渲染中…</div>'
      const id = 'mmd' + Math.random().toString(36).slice(2, 9)
      try {
        // 当前随应用分发 Mermaid 10；第三参数在新版是容器而不是旧版回调，
        // 不能再通过 Function.length 猜测 API，否则会把回调当 DOM 容器。
        const out = await window.mermaid.render(id, src)
        node.innerHTML = (out && out.svg) || ''
        if (out && typeof out.bindFunctions === 'function') out.bindFunctions(node)
      } catch (e) {
        node.innerHTML = '<pre class="mermaid-error">Mermaid 语法错误：\n' + escapeHtml(e && e.message ? e.message : String(e)) + '</pre>'
      }
    }
  }

  function renderOutline(tab) {
    const toc = (tab.render && tab.render.toc) || []
    el.outline.innerHTML = toc.length
      ? toc.map((h) => `<button class="outline-item lv${h.level}" data-id="${escapeHtml(h.id)}" title="${escapeHtml(h.text)}">${escapeHtml(h.text || '(无标题)')}</button>`).join('')
      : '<div class="panel-empty"><strong>本文暂无标题</strong><span>使用 #、##、### 添加标题后，会在这里生成可点击目录。</span></div>'
    el.outlineCount.textContent = toc.length ? toc.length + ' 个标题' : ''
    el.outline.querySelectorAll('.outline-item').forEach((btn) => {
      on(btn, 'click', () => {
        const target = el.preview.querySelector('#' + CSS.escape(btn.getAttribute('data-id')))
        if (target) target.scrollIntoView({ block: 'start' })
      })
    })
    syncOutline()
  }

  function syncOutline() {
    const tab = activeTab()
    if (!tab || !tab.render) return
    const headings = el.preview.querySelectorAll('h1[id],h2[id],h3[id],h4[id],h5[id],h6[id]')
    if (!headings.length) return
    const scroller = state.editMode ? el.preview : el.docWrap
    const top = scroller.scrollTop + 80
    let currentId = headings[0].id
    for (const h of headings) {
      if (h.offsetTop <= top) currentId = h.id
      else break
    }
    el.outline.querySelectorAll('.outline-item').forEach((b) => {
      b.classList.toggle('is-active', b.getAttribute('data-id') === currentId)
    })
  }

  function updateStatus(tab) {
    if (!tab || !tab.render) {
      el.statPath.textContent = ''
      el.statImages.textContent = ''
      el.statWords.textContent = ''
      el.statRead.textContent = ''
      return
    }
    const s = tab.render.stats
    const rep = tab.imageReport
    el.statPath.textContent = tab.path
    el.statPath.title = tab.path
    el.statWords.textContent = `${s.cjk + s.words} 字`
    el.statRead.textContent = `约 ${s.readMinutes} 分钟`
    if (rep && rep.summary) {
      const parts = [`图片 ${rep.summary.total}`]
      if (rep.summary.missing) parts.push(`缺失 ${rep.summary.missing}`)
      if (rep.summary.duplicateGroups) parts.push(`重复 ${rep.summary.duplicateGroups} 组`)
      parts.push(rep.summary.totalSizeText)
      el.statImages.textContent = parts.join(' · ')
      el.statImages.style.color = rep.summary.missing ? 'var(--danger)' : ''
    } else {
      el.statImages.textContent = `图片 ${s.images}`
      el.statImages.style.color = ''
    }
    el.statZoom.textContent = `${state.prefs.view.fontSize}px`
  }

  /* ---------------- 图片面板与查看器 ---------------- */

  function renderImagePanel(tab) {
    const rep = tab.imageReport
    if (!rep) {
      el.imageSummary.textContent = '点击「分析」扫描文档中的图片'
      el.imageList.innerHTML = ''
      return
    }
    const sum = rep.summary
    el.imageSummary.innerHTML = `<div class="stat-line">
      <span>共 ${sum.total}</span>
      <span>${sum.totalSizeText}</span>
      <span class="${sum.missing ? 'warn-text' : 'ok-text'}">缺失 ${sum.missing}</span>
      <span class="${sum.duplicateGroups ? 'warn-text' : 'ok-text'}">重复 ${sum.duplicateGroups} 组</span>
      <span>外链 ${sum.external}</span>
    </div>`
    if (sum.duplicateGroups) {
      el.imageSummary.innerHTML += `<div class="warn-text" style="margin-top:6px">重复图片浪费约 ${(sum.duplicateWaste / 1024).toFixed(0)} KB</div>`
    }
    el.imageList.innerHTML = rep.items.map((item) => {
      const dup = rep.duplicates.find((d) => d.files.some((f) => f.index === item.index))
      const badge = item.external ? '<span class="badge ext">外链</span>'
        : item.status === 'missing' ? '<span class="badge miss">缺失</span>'
        : dup ? '<span class="badge dup">重复</span>' : ''
      const url = item.path ? toFileUrl(item.path) : item.src
      const thumb = item.path || item.external ? `style="background-image:url('${encodeURI(url).replace(/'/g, '%27')}')"` : ''
      return `<div class="img-row" data-index="${item.index}" data-path="${escapeHtml(item.path)}">
        <div class="img-thumb" ${thumb}></div>
        <div class="img-info">
          <div class="img-name">${escapeHtml(baseName(item.src) || '(无名称)')}${badge}</div>
          <div class="img-meta">${item.path ? `${item.width}×${item.height} · ${item.sizeText}` : escapeHtml(item.src)}${item.occurrences > 1 ? ` · 引用 ${item.occurrences} 次` : ''}</div>
        </div>
      </div>`
    }).join('')
    el.imageList.querySelectorAll('.img-row').forEach((row) => {
      on(row, 'click', () => {
        const path = row.getAttribute('data-path')
        const idx = state.gallery.findIndex((g) => g.path === path)
        if (idx >= 0) openLightbox(idx)
        else {
          const img = el.preview.querySelector(`img[data-img-id="${row.getAttribute('data-index')}"]`)
          if (img) img.scrollIntoView({ block: 'center' })
        }
      })
    })
  }

  function openLightbox(index) {
    if (!state.gallery.length) return
    state.galleryIndex = Math.max(0, Math.min(index, state.gallery.length - 1))
    const item = state.gallery[state.galleryIndex]
    el.lbImg.src = item.src
    el.lbMeta.textContent = `${state.galleryIndex + 1} / ${state.gallery.length} · ${item.meta || ''}`
    el.lightbox.hidden = false
  }
  function closeLightbox() { el.lightbox.hidden = true }
  function stepLightbox(delta) { openLightbox(state.galleryIndex + delta) }

  /* ---------------- 查找 ---------------- */

  function clearFind() {
    for (const mark of state.findMarks) {
      const parent = mark.parentNode
      if (!parent) continue
      parent.replaceChild(document.createTextNode(mark.textContent), mark)
      parent.normalize()
    }
    state.findMarks = []
    state.findIndex = -1
    el.findCount.textContent = ''
  }

  function runFind(query) {
    clearFind()
    const q = String(query || '').trim()
    if (!q || !el.preview.innerHTML) {
      el.findCount.textContent = ''
      $('btnFindPrev').disabled = true
      $('btnFindNext').disabled = true
      return
    }
    const lower = q.toLowerCase()
    const walker = document.createTreeWalker(el.preview, NodeFilter.SHOW_TEXT)
    const targets = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.parentElement && node.parentElement.closest('pre,code,.math-block,.katex')) continue
      if (node.nodeValue.toLowerCase().includes(lower)) targets.push(node)
    }
    for (const node of targets) {
      const text = node.nodeValue
      const frag = document.createDocumentFragment()
      let pos = 0
      let hit = text.toLowerCase().indexOf(lower)
      while (hit >= 0) {
        if (hit > pos) frag.appendChild(document.createTextNode(text.slice(pos, hit)))
        const mark = document.createElement('mark')
        mark.textContent = text.slice(hit, hit + q.length)
        frag.appendChild(mark)
        state.findMarks.push(mark)
        pos = hit + q.length
        hit = text.toLowerCase().indexOf(lower, pos)
      }
      if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)))
      node.parentNode.replaceChild(frag, node)
    }
    if (state.findMarks.length) {
      state.findIndex = 0
      highlightCurrent()
    }
    el.findCount.textContent = state.findMarks.length ? `1 / ${state.findMarks.length}` : '无匹配'
    $('btnFindPrev').disabled = !state.findMarks.length
    $('btnFindNext').disabled = !state.findMarks.length
  }

  function highlightCurrent() {
    state.findMarks.forEach((m, i) => m.classList.toggle('is-current', i === state.findIndex))
    const cur = state.findMarks[state.findIndex]
    if (cur) {
      cur.scrollIntoView({ block: 'center' })
      el.findCount.textContent = `${state.findIndex + 1} / ${state.findMarks.length}`
    }
  }

  function stepFind(delta) {
    if (!state.findMarks.length) {
      runFind(el.findInput.value)
      if (!state.findMarks.length) return
    }
    state.findIndex = (state.findIndex + delta + state.findMarks.length) % state.findMarks.length
    highlightCurrent()
  }

  function clearFindInput(options) {
    const opts = options || {}
    el.findInput.value = ''
    clearFind()
    $('btnFindPrev').disabled = true
    $('btnFindNext').disabled = true
    if (opts.focus !== false) el.findInput.focus()
  }

  function openFind() {
    if (!activeTab()) return
    $('findbar').hidden = false
    requestAnimationFrame(() => {
      el.findInput.focus()
      el.findInput.select()
    })
  }

  function closeFind() {
    clearFindInput({ focus: false })
    $('findbar').hidden = true
    el.docWrap.focus({ preventScroll: true })
  }

  /* ---------------- 全局搜索 ---------------- */

  async function runGlobalSearch() {
    const q = el.searchInput.value.trim()
    if (!q) return
    if (!state.rootDir) { toast('请先打开文件夹'); return }
    el.searchResults.innerHTML = '<div class="search-hit">搜索中…</div>'
    const res = await mdv.searchFolder(state.rootDir, q)
    if (!res.ok) { el.searchResults.innerHTML = `<div class="search-hit">${escapeHtml(res.error || '搜索失败')}</div>`; return }
    if (!res.results.length) { el.searchResults.innerHTML = '<div class="search-hit">没有匹配结果</div>'; return }
    const re = new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi')
    el.searchResults.innerHTML = res.results.map((r) => `
      <div class="search-file" data-path="${escapeHtml(r.path)}">
        <div class="search-file-name">${escapeHtml(r.name)}<span class="muted"> · ${r.hits.length} 处</span></div>
        ${r.hits.map((h) => `<div class="search-hit" data-line="${h.line}">${h.line}: ${escapeHtml(h.text).replace(re, '<b>$1</b>')}</div>`).join('')}
      </div>`).join('')
    el.searchResults.querySelectorAll('.search-file').forEach((node) => {
      on(node, 'click', () => {
        state.pendingFind = q
        openFiles([node.getAttribute('data-path')])
      })
    })
  }

  /* ---------------- 编辑与保存 ---------------- */

  let editTimer = null
  let sourceSyncTimer = null
  let linkedScrollFrame = null
  let linkedScrollLock = ''
  let linkedScrollUnlockTimer = null

  function sourceOffsetForLine(content, line) {
    let offset = 0
    for (let i = 0; i < line; i++) {
      const next = content.indexOf('\n', offset)
      if (next < 0) return content.length
      offset = next + 1
    }
    return offset
  }

  function sourceLineForOffset(content, offset) {
    const safeOffset = Math.max(0, Math.min(String(content || '').length, Number(offset) || 0))
    return (String(content || '').slice(0, safeOffset).match(/\n/g) || []).length
  }

  function sourceRangeForPreviewNode(node, tab) {
    if (!node || !tab) return null
    const exactStartAttr = node.getAttribute('data-source-offset')
    const exactEndAttr = node.getAttribute('data-source-end-offset')
    const exactStart = exactStartAttr == null ? NaN : Number(exactStartAttr)
    const exactEnd = exactEndAttr == null ? NaN : Number(exactEndAttr)
    if (Number.isFinite(exactStart)) {
      return {
        startLine: sourceLineForOffset(tab.content, exactStart),
        endLine: sourceLineForOffset(tab.content, Number.isFinite(exactEnd) ? Math.max(exactStart, exactEnd - 1) : exactStart),
        exact: true
      }
    }
    const startLine = Number(node.getAttribute('data-source-start'))
    const endLine = Number(node.getAttribute('data-source-end'))
    if (!Number.isFinite(startLine)) return null
    return {
      startLine,
      endLine: Number.isFinite(endLine) ? Math.max(startLine, endLine - 1) : startLine,
      exact: false
    }
  }

  function previewSourceAtCenter(tab, viewport) {
    if (!tab || !viewport) return null
    const centerX = Math.round(viewport.left + viewport.width * 0.45)
    const centerY = Math.round(viewport.top + viewport.height / 2)
    let mapped = null
    const stack = document.elementsFromPoint(centerX, centerY)
    for (const node of stack) {
      if (!el.preview.contains(node)) continue
      mapped = node.closest('[data-source-offset],[data-source-start]')
      if (mapped) break
    }
    if (!mapped) {
      let distance = Infinity
      el.preview.querySelectorAll('[data-source-offset],[data-source-start]').forEach((node) => {
        const rect = node.getBoundingClientRect()
        const delta = centerY < rect.top ? rect.top - centerY : centerY > rect.bottom ? centerY - rect.bottom : 0
        if (delta < distance) { distance = delta; mapped = node }
      })
    }
    if (!mapped) return null
    const range = sourceRangeForPreviewNode(mapped, tab)
    if (!range) return null
    const rect = mapped.getBoundingClientRect()
    const ratio = rect.height > 1 ? Math.max(0, Math.min(1, (centerY - rect.top) / rect.height)) : 0.5
    return {
      line: Math.round(range.startLine + (range.endLine - range.startLine) * ratio),
      node: mapped
    }
  }

  function previewAnchorForSourceLine(line, tab) {
    let best = null
    el.preview.querySelectorAll('[data-source-offset],[data-source-start]').forEach((node) => {
      const range = sourceRangeForPreviewNode(node, tab)
      if (!range) return
      const contains = line >= range.startLine && line <= range.endLine
      const distance = contains ? 0 : Math.min(Math.abs(line - range.startLine), Math.abs(line - range.endLine))
      const span = Math.max(0, range.endLine - range.startLine)
      const score = distance * 10000 + (contains && range.exact ? 0 : 1000) + span
      if (!best || score < best.score) best = { node, range, score }
    })
    if (!best) return null
    const rect = best.node.getBoundingClientRect()
    const span = Math.max(1, best.range.endLine - best.range.startLine + 1)
    const ratio = Math.max(0, Math.min(1, (line - best.range.startLine + 0.5) / span))
    return { node: best.node, y: rect.top + rect.height * ratio }
  }

  /* 编辑器像素测量：textarea 存在软换行，一个源码行可能占多个视觉行，
     不能用「行号 × 行高」换算滚动位置。改用与编辑器排版完全一致的镜像 div，
     通过 Range API 直接测量任意字符偏移的真实像素坐标。 */
  let editorMirror = null

  function syncEditorMirror() {
    if (!editorMirror) {
      editorMirror = document.createElement('div')
      editorMirror.setAttribute('aria-hidden', 'true')
      editorMirror.style.cssText = 'position:absolute;left:-99999px;top:0;visibility:hidden;white-space:pre-wrap;overflow-wrap:break-word;box-sizing:border-box;'
      document.body.appendChild(editorMirror)
    }
    const style = getComputedStyle(el.editor)
    const m = editorMirror.style
    m.fontFamily = style.fontFamily
    m.fontSize = style.fontSize
    m.fontWeight = style.fontWeight
    m.lineHeight = style.lineHeight
    m.letterSpacing = style.letterSpacing
    m.tabSize = style.tabSize
    m.padding = style.padding
    m.width = el.editor.clientWidth + 'px'
    const text = String(el.editor.value)
    if (editorMirror.textContent !== text) editorMirror.textContent = text
    return editorMirror
  }

  function editorPixelYForOffset(offset) {
    const mirror = syncEditorMirror()
    const node = mirror.firstChild
    if (!node || !node.length) return 0
    const mirrorTop = mirror.getBoundingClientRect().top
    const len = node.length
    const o = Math.max(0, Math.min(len, Math.round(offset)))
    const range = document.createRange()
    let rect = null
    const probe = (a, b) => {
      try {
        range.setStart(node, a)
        range.setEnd(node, b)
        const r = range.getBoundingClientRect()
        if (r && r.height > 0) rect = r
      } catch (e) { /* 忽略非法区间 */ }
    }
    probe(o, Math.min(o + 1, len))
    if (!rect && o > 0) probe(o - 1, o)
    if (!rect) return mirror.getBoundingClientRect().height - mirrorTop
    return rect.top - mirrorTop + rect.height / 2
  }

  function editorOffsetForPixelY(y) {
    const mirror = syncEditorMirror()
    const node = mirror.firstChild
    if (!node || !node.length) return 0
    let lo = 0
    let hi = node.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (editorPixelYForOffset(mid) < y) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  function centerEditorAtOffset(offset) {
    const y = editorPixelYForOffset(offset)
    const target = y - el.editor.clientHeight / 2
    const max = Math.max(0, el.editor.scrollHeight - el.editor.clientHeight)
    el.editor.scrollTop = Math.max(0, Math.min(max, target))
  }

  function centerEditorAtSourceLine(line, tab) {
    if (!tab) return
    centerEditorAtOffset(sourceOffsetForLine(tab.content, line))
  }

  function centerRenderedAtSourceLine(line, tab, scroller) {
    const anchor = previewAnchorForSourceLine(line, tab)
    if (!anchor || !scroller) return
    const viewport = scroller.getBoundingClientRect()
    const target = scroller.scrollTop + anchor.y - (viewport.top + viewport.height / 2)
    const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight)
    scroller.scrollTop = Math.max(0, Math.min(max, target))
  }

  function syncEditorScrollFromPreview() {
    const tab = activeTab()
    const anchor = previewSourceAtCenter(tab, el.preview.getBoundingClientRect())
    if (anchor) centerEditorAtSourceLine(anchor.line, tab)
  }

  function syncPreviewScrollFromEditor() {
    const tab = activeTab()
    if (!tab) return
    const centerY = el.editor.scrollTop + el.editor.clientHeight / 2
    const offset = editorOffsetForPixelY(centerY)
    const line = sourceLineForOffset(tab.content, offset)
    centerRenderedAtSourceLine(line, tab, el.preview)
  }

  function scheduleLinkedScroll(source) {
    if (!state.editMode || el.editor.hidden) return
    if (linkedScrollLock && linkedScrollLock !== source) return
    if (linkedScrollFrame) cancelAnimationFrame(linkedScrollFrame)
    linkedScrollFrame = requestAnimationFrame(() => {
      linkedScrollFrame = null
      linkedScrollLock = source
      if (source === 'preview') syncEditorScrollFromPreview()
      else syncPreviewScrollFromEditor()
      clearTimeout(linkedScrollUnlockTimer)
      linkedScrollUnlockTimer = setTimeout(() => {
        if (linkedScrollLock === source) linkedScrollLock = ''
      }, 48)
    })
  }

  function sourceOffsetFromDomPoint(node, offset, tab) {
    if (!node || !tab) return null
    const parent = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement
    if (!parent || !el.preview.contains(parent)) return null
    const exact = parent.closest('[data-source-offset]')
    if (exact) {
      const start = Number(exact.getAttribute('data-source-offset'))
      const end = Number(exact.getAttribute('data-source-end-offset'))
      if (Number.isFinite(start)) {
        try {
          const probe = document.createRange()
          probe.selectNodeContents(exact)
          probe.setEnd(node, offset)
          const visibleOffset = probe.toString().length
          return Math.max(start, Math.min(Number.isFinite(end) ? end : tab.content.length, start + visibleOffset))
        } catch (e) {
          return start
        }
      }
    }
    const block = parent.closest('[data-source-start]')
    if (!block) return null
    const line = Number(block.getAttribute('data-source-start'))
    return Number.isFinite(line) ? sourceOffsetForLine(tab.content, line) : null
  }

  function caretPointFromMouse(event) {
    if (document.caretPositionFromPoint) {
      const point = document.caretPositionFromPoint(event.clientX, event.clientY)
      if (point) return { node: point.offsetNode, offset: point.offset }
    }
    if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(event.clientX, event.clientY)
      if (range) return { node: range.startContainer, offset: range.startOffset }
    }
    return null
  }

  function fallbackSelectionOffsets(selection, target, tab) {
    const parent = target && (target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement)
    const block = parent && parent.closest ? parent.closest('[data-source-start]') : null
    if (!block) return null
    const startLine = Number(block.getAttribute('data-source-start'))
    const endLine = Number(block.getAttribute('data-source-end'))
    const blockStart = sourceOffsetForLine(tab.content, Number.isFinite(startLine) ? startLine : 0)
    const blockEnd = sourceOffsetForLine(tab.content, Number.isFinite(endLine) ? endLine : startLine + 1)
    const selected = String(selection && selection.toString ? selection.toString() : '').trim()
    if (selected) {
      const found = tab.content.slice(blockStart, blockEnd).indexOf(selected)
      if (found >= 0) return { start: blockStart + found, end: blockStart + found + selected.length, block }
    }
    return { start: blockStart, end: blockStart, block }
  }

  function scrollEditorToSource(offset) {
    centerEditorAtOffset(offset)
  }

  function flashSourceTarget(block) {
    el.preview.querySelectorAll('.is-source-target').forEach((node) => node.classList.remove('is-source-target'))
    if (block) block.classList.add('is-source-target')
    el.editor.classList.add('is-source-target')
    clearTimeout(sourceSyncTimer)
    sourceSyncTimer = setTimeout(() => {
      if (block) block.classList.remove('is-source-target')
      el.editor.classList.remove('is-source-target')
    }, 900)
  }

  function syncEditorFromPreview(event) {
    const tab = activeTab()
    if (!state.editMode || !tab || el.editor.hidden) return
    if (event.target.closest('button,a,img,input,label')) return

    const selection = window.getSelection()
    let start = null
    let end = null
    let block = event.target.closest('[data-source-start]')
    if (selection && selection.rangeCount && !selection.isCollapsed && el.preview.contains(selection.anchorNode) && el.preview.contains(selection.focusNode)) {
      const range = selection.getRangeAt(0)
      start = sourceOffsetFromDomPoint(range.startContainer, range.startOffset, tab)
      end = sourceOffsetFromDomPoint(range.endContainer, range.endOffset, tab)
      if (start == null || end == null || (start === end && selection.toString())) {
        const fallback = fallbackSelectionOffsets(selection, event.target, tab)
        if (fallback) { start = fallback.start; end = fallback.end; block = fallback.block }
      }
    } else {
      const point = caretPointFromMouse(event)
      if (point) start = end = sourceOffsetFromDomPoint(point.node, point.offset, tab)
      if (start == null) {
        const fallback = fallbackSelectionOffsets(null, event.target, tab)
        if (fallback) { start = fallback.start; end = fallback.end; block = fallback.block }
      }
    }
    if (start == null) return
    if (end == null) end = start
    if (end < start) [start, end] = [end, start]
    start = Math.max(0, Math.min(tab.content.length, start))
    end = Math.max(start, Math.min(tab.content.length, end))

    el.editor.focus({ preventScroll: true })
    el.editor.setSelectionRange(start, end)
    scrollEditorToSource(start)
    flashSourceTarget(block)
  }

  function toggleEdit(force) {
    const tab = activeTab()
    if (!tab) { toast('请先打开一个文档'); return }
    const wasEditing = state.editMode
    const currentScroller = wasEditing ? el.preview : el.docWrap
    const currentAnchor = previewSourceAtCenter(tab, currentScroller.getBoundingClientRect())
    state.editMode = force == null ? !state.editMode : !!force
    el.content.classList.toggle('is-edit', state.editMode)
    el.editor.hidden = !state.editMode
    $('btnEdit').classList.toggle('is-active', state.editMode)
    if (state.editMode) {
      el.editor.value = tab.content
      el.editor.focus()
    } else if (tab.dirty) {
      paintDoc(tab)
    }
    requestAnimationFrame(() => {
      if (!currentAnchor) return
      if (state.editMode) {
        centerRenderedAtSourceLine(currentAnchor.line, tab, el.preview)
        centerEditorAtSourceLine(currentAnchor.line, tab)
      } else {
        centerRenderedAtSourceLine(currentAnchor.line, tab, el.docWrap)
      }
    })
  }

  async function saveCurrent() {
    const tab = activeTab()
    if (!tab) return
    if (state.editMode) tab.content = el.editor.value
    const res = await mdv.saveFile(tab.path, tab.content, tab.mtime)
    if (res.conflict) {
      toast('文件已在其他程序中修改，请重新打开后再保存')
      return
    }
    if (!res.ok) { toast('保存失败：' + res.error); return }
    tab.dirty = false
    tab.original = tab.content
    tab.mtime = res.mtime
    renderTabs()
    paintDoc(tab)
    toast('已保存 ' + tab.name)
  }

  /* ---------------- 视图与偏好 ---------------- */

  function resolvedTheme() {
    const selected = state.prefs.view.theme || 'ink'
    if (selected !== 'system') return selected
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'ink'
  }

  function applyView() {
    const v = state.prefs.view
    document.documentElement.setAttribute('data-theme', resolvedTheme())
    document.documentElement.setAttribute('data-theme-choice', v.theme || 'ink')
    document.documentElement.style.setProperty('--font-size', v.fontSize + 'px')
    document.documentElement.style.setProperty('--line-width', v.lineWidth + 'px')
    setSidebarWidth(state.prefs.sidebar.width, false)
    const hl = $('hljs-theme')
    if (hl) hl.href = resolvedTheme() === 'night' ? 'vendor/hljs-dark.css' : 'vendor/hljs-light.css'
    el.sidebar.classList.toggle('is-hidden', !state.prefs.sidebar.visible)
    $('btnOutline').classList.toggle('is-active', state.prefs.sidebar.visible && state.panel === 'outline')
    document.body.classList.toggle('focus-mode', !!v.focusMode)
    $('fontSizeRange').value = v.fontSize
    $('fontSizeLabel').textContent = v.fontSize
    $('lineWidthRange').value = v.lineWidth
    $('lineWidthLabel').textContent = v.lineWidth
    document.querySelectorAll('.theme-option').forEach((btn) => {
      const selected = btn.getAttribute('data-theme') === (v.theme || 'ink')
      btn.classList.toggle('is-selected', selected)
      btn.setAttribute('aria-checked', selected ? 'true' : 'false')
    })
    if (activeTab()) updateStatus(activeTab())
  }

  async function loadPrefs() {
    state.prefs = await mdv.getPrefs()
    state.prefs.view = Object.assign({ theme: 'ink', fontSize: 16, lineWidth: 900, focusMode: false }, state.prefs.view)
    if (state.prefs.view.theme === 'light') state.prefs.view.theme = 'ink'
    if (state.prefs.view.theme === 'dark') state.prefs.view.theme = 'night'
    state.prefs.sidebar = Object.assign({ visible: true, width: 320, activeTab: 'files' }, state.prefs.sidebar)
    return state.prefs
  }

  function saveView() {
    mdv.setPrefs({ view: state.prefs.view, sidebar: state.prefs.sidebar })
  }

  function setSidebarVisible(visible) {
    state.prefs.sidebar.visible = !!visible
    applyView()
    saveView()
  }

  const SIDEBAR_MIN = 220
  const SIDEBAR_MAX = 520
  const SIDEBAR_DEFAULT = 320

  function sidebarWidthLimits() {
    const left = el.sidebar ? el.sidebar.getBoundingClientRect().left : 0
    const min = window.innerWidth < 980 ? 200 : SIDEBAR_MIN
    const maxForWindow = Math.max(min, window.innerWidth - left - 420)
    return { min, max: Math.min(SIDEBAR_MAX, maxForWindow) }
  }

  function setSidebarWidth(width, persist) {
    const limits = sidebarWidthLimits()
    const numeric = Number.isFinite(Number(width)) ? Number(width) : SIDEBAR_DEFAULT
    const next = Math.round(Math.max(limits.min, Math.min(limits.max, numeric)))
    state.prefs.sidebar.width = next
    document.documentElement.style.setProperty('--sidebar-width', next + 'px')
    if (el.splitter) {
      el.splitter.setAttribute('aria-valuemin', String(limits.min))
      el.splitter.setAttribute('aria-valuemax', String(limits.max))
      el.splitter.setAttribute('aria-valuenow', String(next))
      el.splitter.setAttribute('aria-valuetext', next + ' 像素')
    }
    if (persist) saveView()
    return next
  }

  function bindSidebarResize() {
    if (!el.splitter) return
    let activePointer = null

    const resizeFromPointer = (clientX) => {
      const left = el.sidebar.getBoundingClientRect().left
      setSidebarWidth(clientX - left, false)
    }
    const finishResize = (event) => {
      if (activePointer == null || (event.pointerId != null && event.pointerId !== activePointer)) return
      if (el.splitter.hasPointerCapture && el.splitter.hasPointerCapture(activePointer)) el.splitter.releasePointerCapture(activePointer)
      activePointer = null
      document.body.classList.remove('sidebar-resizing')
      saveView()
    }

    on(el.splitter, 'pointerdown', (event) => {
      if (event.button !== 0) return
      activePointer = event.pointerId
      try { el.splitter.setPointerCapture(activePointer) } catch (e) { /* 合成事件或旧环境不支持捕获时仍可调整 */ }
      document.body.classList.add('sidebar-resizing')
      resizeFromPointer(event.clientX)
      event.preventDefault()
    })
    on(el.splitter, 'pointermove', (event) => {
      if (activePointer !== event.pointerId) return
      resizeFromPointer(event.clientX)
    })
    on(el.splitter, 'pointerup', finishResize)
    on(el.splitter, 'pointercancel', finishResize)
    on(el.splitter, 'dblclick', () => {
      setSidebarWidth(SIDEBAR_DEFAULT, true)
      toast('侧栏宽度已恢复默认')
    })
    on(el.splitter, 'keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return
      event.preventDefault()
      const step = event.shiftKey ? 32 : 16
      const next = event.key === 'Home'
        ? SIDEBAR_DEFAULT
        : state.prefs.sidebar.width + (event.key === 'ArrowRight' ? step : -step)
      setSidebarWidth(next, true)
    })
  }

  function showSettings() {
    $('imageRootsInput').value = (state.prefs.imageRoots || []).join('\n')
    el.settings.hidden = false
  }

  function toggleThemePopover(force) {
    const popover = $('themePopover')
    const shouldOpen = force == null ? popover.hidden : !!force
    popover.hidden = !shouldOpen
    $('btnTheme').classList.toggle('is-active', shouldOpen)
  }

  function chooseTheme(theme) {
    if (!['ink', 'paper', 'night', 'system'].includes(theme)) return
    state.prefs.view.theme = theme
    saveView()
    applyView()
    const tab = activeTab()
    if (tab) paintDoc(tab)
    toggleThemePopover(false)
  }

  function renderRecent() {
    const list = state.prefs.recentFiles || []
    el.recentList.innerHTML = list.length
      ? list.map((p) => `<div class="tree-node" data-file="${escapeHtml(p)}" title="${escapeHtml(p)}"><span class="tn">${escapeHtml(baseName(p))}</span></div>`).join('')
      : '<div class="search-hit">暂无记录</div>'
    el.recentList.querySelectorAll('[data-file]').forEach((n) => {
      on(n, 'click', () => openFiles([n.getAttribute('data-file')]))
    })
  }

  function switchPanel(name, options) {
    if (!['files', 'outline', 'images', 'search'].includes(name)) return
    const opts = options || {}
    state.panel = name
    state.prefs.sidebar.activeTab = name
    if (!opts.preserveVisibility) state.prefs.sidebar.visible = true
    document.querySelectorAll('.side-tab').forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-panel') === name))
    document.querySelectorAll('.side-panel').forEach((p) => p.classList.toggle('is-active', p.getAttribute('data-panel') === name))
    const tab = activeTab()
    if (name === 'outline') renderOutline(tab || { render: { toc: [] } })
    if (name === 'files') paintTree()
    if (name === 'images' && tab) renderImagePanel(tab)
    applyView()
    saveView()
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    bindSidebarResize()
    document.querySelectorAll('.side-tab').forEach((btn) => {
      on(btn, 'click', () => switchPanel(btn.getAttribute('data-panel')))
    })
    on($('btnToggleSidebar'), 'click', () => setSidebarVisible(!state.prefs.sidebar.visible))
    on($('btnActivitySettings'), 'click', showSettings)
    on($('btnOpenFile'), 'click', async () => {
      const files = await mdv.openFileDialog()
      if (files && files.length) openFiles(files)
    })
    on($('btnOpenFolder'), 'click', async () => {
      const dir = await mdv.openFolderDialog()
      if (dir) openFolder(dir)
    })
    on($('btnTreeRefresh'), 'click', () => state.rootDir && openFolder(state.rootDir, { silent: true }))
    on($('btnEdit'), 'click', () => toggleEdit())
    on($('btnTheme'), 'click', () => toggleThemePopover())
    on($('btnThemeClose'), 'click', () => toggleThemePopover(false))
    document.querySelectorAll('.theme-option').forEach((btn) => on(btn, 'click', () => chooseTheme(btn.getAttribute('data-theme'))))
    on($('btnOutline'), 'click', () => {
      if (state.prefs.sidebar.visible && state.panel === 'outline') setSidebarVisible(false)
      else switchPanel('outline')
    })
    on($('btnSettings'), 'click', showSettings)
    on($('btnSettingsClose'), 'click', () => { el.settings.hidden = true })
    on($('btnImageAnalyze'), 'click', async () => {
      const tab = activeTab()
      if (!tab) { toast('请先打开文档'); return }
      await resolveImages(tab)
      renderImagePanel(tab)
      toast('图片分析完成')
    })
    on($('btnGlobalSearch'), 'click', runGlobalSearch)
    on(el.searchInput, 'keydown', (e) => { if (e.key === 'Enter') runGlobalSearch() })

    on(el.tree, 'click', (e) => {
      const node = e.target.closest('.tree-node')
      if (!node) return
      if (node.getAttribute('data-file')) openFiles([node.getAttribute('data-file')])
      else if (node.getAttribute('data-dir')) {
        const dir = node.getAttribute('data-dir')
        if (state.expandedDirs.has(dir)) state.expandedDirs.delete(dir)
        else state.expandedDirs.add(dir)
        paintTree()
      }
    })

    on(el.tabbar, 'dblclick', (e) => { if (e.target.classList.contains('tabbar')) $('btnOpenFile').click() })

    on(el.findInput, 'input', () => runFind(el.findInput.value))
    on(el.findInput, 'keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1) }
      if (e.key === 'Escape') { e.preventDefault(); closeFind() }
    })
    on($('btnFindPrev'), 'click', () => stepFind(-1))
    on($('btnFindNext'), 'click', () => stepFind(1))
    on($('btnFindClear'), 'click', closeFind)

    on(el.editor, 'input', () => {
      const tab = activeTab()
      if (!tab) return
      tab.content = el.editor.value
      tab.dirty = tab.content !== tab.original
      renderTabs()
      clearTimeout(editTimer)
      editTimer = setTimeout(() => {
        tab.render = mdv.render(tab.content, { baseDir: dirName(tab.path) })
        el.preview.innerHTML = tab.render.html
        renderOutline(tab)
        renderMermaid(tab)
        updateStatus(tab)
      }, 280)
    })
    on(el.editor, 'keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault()
        const s = el.editor.selectionStart
        el.editor.value = el.editor.value.slice(0, s) + '  ' + el.editor.value.slice(el.editor.selectionEnd)
        el.editor.selectionStart = el.editor.selectionEnd = s + 2
        el.editor.dispatchEvent(new Event('input'))
      }
    })

    on(el.preview, 'click', (e) => {
      const copyBtn = e.target.closest('.code-copy')
      if (copyBtn) {
        const tab = activeTab()
        const code = tab && tab.render && tab.render.codes[Number(copyBtn.getAttribute('data-code-id'))]
        if (code != null && navigator.clipboard) {
          navigator.clipboard.writeText(code).then(() => {
            copyBtn.textContent = '已复制'
            setTimeout(() => { copyBtn.textContent = '复制' }, 1200)
          }).catch(() => toast('复制失败'))
        }
        return
      }
      const img = e.target.closest('img.md-image')
      if (img && img.getAttribute('data-path')) {
        const idx = state.gallery.findIndex((g) => g.path === img.getAttribute('data-path'))
        openLightbox(idx >= 0 ? idx : 0)
        return
      }
      const link = e.target.closest('a')
      if (link) {
        const href = link.getAttribute('href') || ''
        if (/^https?:\/\//i.test(href)) { e.preventDefault(); mdv.openExternal(href); return }
        if (href.startsWith('#')) {
          e.preventDefault()
          const target = el.preview.querySelector('#' + CSS.escape(href.slice(1)))
          if (target) target.scrollIntoView({ block: 'start' })
        }
      }
    })

    on(el.preview, 'mouseup', (e) => {
      if (!state.editMode || e.button !== 0) return
      // mouseup 后浏览器才完成文字选择，下一帧再把选区映射到编辑器。
      setTimeout(() => syncEditorFromPreview(e), 0)
    })

    on(el.docWrap, 'scroll', () => { syncOutline() })
    on(el.preview, 'scroll', () => {
      if (!state.editMode) return
      syncOutline()
      scheduleLinkedScroll('preview')
    })
    on(el.editor, 'scroll', () => { scheduleLinkedScroll('editor') })

    // 图片查看器事件委托到 lightbox 容器，避免单个按钮元素获取不到时报错
    if (el.lightbox) {
      on(el.lightbox, 'click', (e) => {
        if (e.target === el.lightbox || e.target.closest('.lb-close')) closeLightbox()
        else if (e.target.closest('.lb-prev')) stepLightbox(-1)
        else if (e.target.closest('.lb-next')) stepLightbox(1)
      })
    }

    on($('fontSizeRange'), 'input', (e) => {
      state.prefs.view.fontSize = Number(e.target.value)
      $('fontSizeLabel').textContent = state.prefs.view.fontSize
      applyView(); saveView()
    })
    on($('lineWidthRange'), 'input', (e) => {
      state.prefs.view.lineWidth = Number(e.target.value)
      $('lineWidthLabel').textContent = state.prefs.view.lineWidth
      applyView(); saveView()
    })
    on($('imageRootsInput'), 'change', async () => {
      const roots = $('imageRootsInput').value.split('\n').map((s) => s.trim()).filter(Boolean)
      state.prefs.imageRoots = await mdv.setImageRoots(roots)
      const tab = activeTab()
      if (tab) { await resolveImages(tab); renderImagePanel(tab) }
      toast('图片根目录已更新')
    })
    on($('btnShowPrefsFile'), 'click', async () => {
      const info = await mdv.appInfo()
      if (info && (info.prefsPath || info.userData)) mdv.showItemInFolder(info.prefsPath || info.userData)
    })
    on($('btnSetDefaultApp'), 'click', async () => {
      const res = await mdv.setAsDefault()
      $('assocHint').textContent = res && res.message ? res.message : ''
    })

    // 拖拽路径由 preload 从真实 File 对象解析并授权，页面脚本不直接接触 webUtils
    if (mdv.onFileDrop) mdv.onFileDrop((paths) => paths.length && openFiles(paths, { force: true }))

    // 快捷键
    on(window, 'keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey
      if (mod && e.key === 'f' && !e.shiftKey) { e.preventDefault(); openFind() }
      else if (mod && e.key === 'F') { e.preventDefault(); switchPanel('search'); el.searchInput.focus() }
      else if (mod && e.key === 's') { e.preventDefault(); saveCurrent() }
      else if (mod && e.key === 'e') { e.preventDefault(); toggleEdit() }
      else if (mod && e.key === 'b') { e.preventDefault(); setSidebarVisible(!state.prefs.sidebar.visible) }
      else if (mod && e.key === 'j') { e.preventDefault(); switchPanel('outline') }
      else if (mod && e.key === 'd') { e.preventDefault(); toggleThemePopover() }
      else if (e.key === 'F8') { e.preventDefault(); state.prefs.view.focusMode = !state.prefs.view.focusMode; applyView(); saveView() }
      else if (e.key === 'Escape') {
        if (!el.lightbox.hidden) closeLightbox()
        else if (!$('themePopover').hidden) toggleThemePopover(false)
        else if (!el.settings.hidden) el.settings.hidden = true
        else if (!$('findbar').hidden) closeFind()
      }
      else if (!el.lightbox.hidden) {
        if (e.key === 'ArrowLeft') stepLightbox(-1)
        else if (e.key === 'ArrowRight') stepLightbox(1)
      }
    })

    // 菜单事件
    mdv.onMenu('menu:openFile', () => $('btnOpenFile').click())
    mdv.onMenu('menu:openFolder', () => $('btnOpenFolder').click())
    mdv.onMenu('menu:save', saveCurrent)
    mdv.onMenu('menu:closeTab', () => state.activeId != null && closeTab(state.activeId))
    mdv.onMenu('menu:toggleSidebar', () => setSidebarVisible(!state.prefs.sidebar.visible))
    mdv.onMenu('menu:toggleOutline', () => switchPanel('outline'))
    mdv.onMenu('menu:toggleEdit', () => toggleEdit())
    mdv.onMenu('menu:toggleTheme', () => toggleThemePopover())
    mdv.onMenu('menu:focusMode', () => { state.prefs.view.focusMode = !state.prefs.view.focusMode; applyView(); saveView() })
    mdv.onMenu('menu:find', openFind)
    mdv.onMenu('menu:globalSearch', () => { switchPanel('search'); el.searchInput.focus() })
    mdv.onMenu('menu:zoom', (delta) => {
      const v = state.prefs.view
      v.fontSize = delta === 0 ? 15 : Math.min(24, Math.max(12, v.fontSize + delta))
      applyView(); saveView()
    })

    mdv.onConfirmClose(() => {
      const dirty = state.tabs.filter((tab) => tab.dirty)
      if (!dirty.length || confirm(`有 ${dirty.length} 个文档尚未保存，确定退出吗？`)) mdv.allowClose()
      else mdv.cancelClose()
    })

    if (window.matchMedia) {
      const media = window.matchMedia('(prefers-color-scheme: dark)')
      on(media, 'change', () => {
        if (state.prefs.view.theme === 'system') {
          applyView()
          const tab = activeTab()
          if (tab) paintDoc(tab)
        }
      })
    }
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    if (!mdv) {
      document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif">预加载脚本未生效，请以 npm start 启动</div>'
      return
    }
    await loadPrefs()
    applyView()
    renderRecent()
    switchPanel(state.prefs.sidebar.activeTab || 'files', { preserveVisibility: true })
    bindEvents()
    // 已运行时再次双击文件：由主进程转交路径
    mdv.onOpenPath((filePath) => openFiles([filePath]))

    const startup = await mdv.startupFile()
    if (startup) await openFiles([startup])
    else if (state.prefs.lastFolder) await openFolder(state.prefs.lastFolder, { silent: true })
  }

  function boot() {
    init().catch((e) => {
      console.error(e)
      const msg = (e && e.stack) ? e.stack : String(e)
      toast('启动异常：' + msg.slice(0, 400))
    })
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot)
  } else {
    boot()
  }
})()
