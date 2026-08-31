const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron')

const APP_NAME = 'Markdown 查看器'
const APP_ID = 'com.yuange.mdviewer'
app.setName(APP_NAME)
if (process.platform === 'win32') app.setAppUserModelId(APP_ID)

// 在无 GPU / 远程桌面 / 容器等环境中避免 GPU 进程崩溃
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-software-rasterizer')
const path = require('path')
const fs = require('fs')
const { analyzeImagesAsync } = require('../shared/imageTools')
const { registerWindowsFileAssociation } = require('./windowsAssociation')

const IGNORE_DIRS = new Set(['node_modules', '.git', '.svn', '.idea', '.vscode', 'dist', 'build', '.cache', '__pycache__', '.workbuddy', 'vendor'])
const MARKDOWN_EXT = ['.md', '.markdown', '.mdown', '.mkd', '.txt']
const MAX_TREE_ITEMS = 3000
const MAX_SEARCH_FILES = 2000

let win = null
let prefsPath = ''
let prefs = {}
let forceClose = false
let closePromptPending = false
let rendererConsoleErrors = 0
const authorizedFiles = new Set()
const authorizedRoots = new Set()

function normalizePath(value) {
  try { return path.resolve(String(value || '')) } catch (e) { return '' }
}

function isInside(candidate, root) {
  const rel = path.relative(root, candidate)
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel))
}

function authorizeFile(filePath, includeParent) {
  const full = normalizePath(filePath)
  if (!full || !MARKDOWN_EXT.includes(path.extname(full).toLowerCase())) return ''
  try {
    if (!fs.statSync(full).isFile()) return ''
  } catch (e) { return '' }
  authorizedFiles.add(full.toLowerCase())
  if (includeParent) authorizedRoots.add(path.dirname(full).toLowerCase())
  return full
}

function authorizeRoot(dirPath) {
  const full = normalizePath(dirPath)
  try {
    if (!full || !fs.statSync(full).isDirectory()) return ''
  } catch (e) { return '' }
  authorizedRoots.add(full.toLowerCase())
  return full
}

function isAuthorizedFile(filePath) {
  const full = normalizePath(filePath)
  if (!full || !MARKDOWN_EXT.includes(path.extname(full).toLowerCase())) return false
  const lower = full.toLowerCase()
  if (authorizedFiles.has(lower)) return true
  return Array.from(authorizedRoots).some((root) => isInside(lower, root))
}

function isAuthorizedRoot(dirPath) {
  const full = normalizePath(dirPath).toLowerCase()
  return !!full && Array.from(authorizedRoots).some((root) => isInside(full, root))
}

function loadPrefs() {
  try {
    prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'))
  } catch (e) {
    prefs = {}
  }
  if (!prefs || typeof prefs !== 'object') prefs = {}
  prefs.recentFiles = Array.isArray(prefs.recentFiles) ? prefs.recentFiles : []
  prefs.imageRoots = Array.isArray(prefs.imageRoots) ? prefs.imageRoots : []
  prefs.view = Object.assign({ theme: 'ink', fontSize: 16, lineWidth: 900, focusMode: false }, prefs.view || {})
  prefs.sidebar = Object.assign({ visible: true, width: 320, activeTab: 'files' }, prefs.sidebar || {})
  for (const recent of prefs.recentFiles) authorizeFile(recent, false)
  if (prefs.lastFolder) authorizeRoot(prefs.lastFolder)
}

function savePrefs() {
  try {
    fs.writeFileSync(prefsPath, JSON.stringify(prefs, null, 2), 'utf8')
    return true
  } catch (e) {
    return false
  }
}

function ensureVendor() {
  // 打包后 vendor 已随 asar 分发，__dirname 位于只读的 asar 内，不再复制
  if (app.isPackaged) return
  const vendorDir = path.join(__dirname, '../renderer/vendor')
  const root = path.join(__dirname, '../..', 'node_modules')
  try {
    fs.mkdirSync(vendorDir, { recursive: true })
    // Mermaid 10 通过 file:// 动态加载 chunk，必须整体复制并保持相对路径
    const mermaidFrom = path.join(root, 'mermaid', 'dist')
    const mermaidTo = path.join(vendorDir, 'mermaid')
    if (fs.existsSync(mermaidFrom) && !fs.existsSync(path.join(mermaidTo, 'mermaid.min.js'))) {
      fs.cpSync(mermaidFrom, mermaidTo, { recursive: true })
    }
    const jobs = [
      { from: path.join(root, 'highlight.js/styles/github.css'), to: path.join(vendorDir, 'hljs-light.css') },
      { from: path.join(root, 'highlight.js/styles/github-dark.css'), to: path.join(vendorDir, 'hljs-dark.css') }
    ]
    for (const job of jobs) {
      if (fs.existsSync(job.from) && !fs.existsSync(job.to)) fs.copyFileSync(job.from, job.to)
    }
    const katexFrom = path.join(root, 'katex', 'dist')
    const katexTo = path.join(vendorDir, 'katex')
    if (fs.existsSync(katexFrom) && !fs.existsSync(path.join(katexTo, 'katex.min.css'))) {
      fs.cpSync(katexFrom, katexTo, { recursive: true })
    }
  } catch (e) {
    console.error('[vendor] 复制失败:', e.message)
  }
}

/** 单实例：已运行时把新打开的文件路径转交给已有窗口 */
function setupSingleInstance() {
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return false
  }
  app.on('second-instance', (_event, argv) => {
    const file = pickFileFromArgv(argv)
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
      if (file) {
        authorizeFile(file, true)
        win.webContents.send('app:openPath', file)
      }
    }
  })
  return true
}

function pickFileFromArgv(argv) {
  const list = argv.slice(app.isPackaged ? 1 : 2)
  for (const arg of list) {
    if (!arg || arg.startsWith('-')) continue
    try {
      if (fs.statSync(arg).isFile() && MARKDOWN_EXT.includes(path.extname(arg).toLowerCase())) return arg
    } catch (e) { /* 忽略非法路径 */ }
  }
  return ''
}

/**
 * 把本程序注册为 .md 的默认打开方式（用户级注册表，无需管理员权限）。
 * Windows 11 出于安全不允许第三方直接改写 UserChoice，这里写入 ProgID 与
 * OpenWithProgids 让程序出现在「打开方式」列表，并引导用户在系统设置中确认。
 */
function registerFileAssociation(options = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, message: '仅 Windows 支持设置文件关联' }
  }
  // 便携版内部 exe 位于临时解压目录；用户主动设置关联时应指向便携版启动器。
  const exePath = process.env.PORTABLE_EXECUTABLE_FILE || app.getPath('exe')
  try {
    registerWindowsFileAssociation({
      exePath,
      appName: APP_NAME,
      progId: 'MarkdownDocument'
    })
    if (options.openSettings !== false) shell.openExternal('ms-settings:defaultapps')
    return {
      ok: true,
      message: options.openSettings === false
        ? '已修复 Windows 文件关联。'
        : '已修复并注册到「打开方式」列表。系统设置已打开，请选择「Markdown 查看器」作为 .md 默认应用。'
    }
  } catch (e) {
    return { ok: false, message: '注册失败：' + (e.message || '未知错误') }
  }
}

/** 新安装版本首次启动时刷新 Windows「打开方式」中的应用名称。 */
function ensurePackagedAssociationIdentity() {
  if (!app.isPackaged || process.platform !== 'win32') return
  if (process.env.PORTABLE_EXECUTABLE_FILE) return
  if (prefs.associationIdentityVersion === app.getVersion()) return
  const result = registerFileAssociation({ openSettings: false })
  if (!result.ok) return
  prefs.associationIdentityVersion = app.getVersion()
  savePrefs()
}

/** 调试钩子：--screenshot=<路径> 启动后延迟截图保存并退出，用于自动化验证界面 */
function setupScreenshotHook() {
  const arg = process.argv.find((a) => a.startsWith('--screenshot='))
  if (!arg) return
  const shotPath = arg.split('=').slice(1).join('=')
  const verifyArg = process.argv.find((a) => a.startsWith('--verify-ui='))
  const verifyMode = verifyArg ? verifyArg.split('=').slice(1).join('=') : ''
  setTimeout(async () => {
    try {
      if (win) {
        if (verifyMode === 'editorial' || verifyMode === 'sidebar-resize' || verifyMode === 'findbar-flow' || verifyMode === 'preview-source-sync' || verifyMode === 'linked-scroll') {
          win.setContentSize(1440, 960)
          await new Promise((resolve) => setTimeout(resolve, 250))
          if (verifyMode !== 'preview-source-sync' && verifyMode !== 'linked-scroll') {
            win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['control'] })
            win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers: ['control'] })
            await new Promise((resolve) => setTimeout(resolve, 100))
          }
          await win.webContents.executeJavaScript(`(() => {
            const panel = document.querySelector('.side-tab[data-panel="${verifyMode === 'findbar-flow' ? 'files' : 'outline'}"]')
            if (panel) panel.click()
            ${verifyMode === 'sidebar-resize' ? `
            const splitter = document.getElementById('splitter')
            if (splitter) {
              splitter.focus()
              splitter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
              splitter.blur()
            }
            ` : ''}
            const input = document.getElementById('findInput')
            if (input) {
              input.value = '${verifyMode === 'findbar-flow' ? 'News' : '列表'}'
              input.dispatchEvent(new Event('input', { bubbles: true }))
            }
            const next = document.getElementById('btnFindNext')
            if (next && !next.disabled) next.click()
            ${verifyMode === 'editorial' ? `
            const theme = document.getElementById('btnTheme')
            if (theme) theme.click()
            ` : ''}
          })()`)
          await new Promise((resolve) => setTimeout(resolve, 500))
          if (verifyMode === 'sidebar-resize') {
            await win.webContents.executeJavaScript(`(() => {
              const splitter = document.getElementById('splitter')
              const rect = splitter.getBoundingClientRect()
              const x = Math.round(rect.left + rect.width / 2)
              const y = Math.round(rect.top + Math.min(220, rect.height / 2))
              const eventOptions = { bubbles: true, pointerId: 42, pointerType: 'mouse', isPrimary: true, button: 0 }
              splitter.dispatchEvent(new PointerEvent('pointerdown', { ...eventOptions, clientX: x, clientY: y }))
              splitter.dispatchEvent(new PointerEvent('pointermove', { ...eventOptions, clientX: x + 96, clientY: y }))
              splitter.dispatchEvent(new PointerEvent('pointerup', { ...eventOptions, clientX: x + 96, clientY: y }))
            })()`)
            await new Promise((resolve) => setTimeout(resolve, 250))
            const hover = await win.webContents.executeJavaScript(`(() => {
              const rect = document.getElementById('splitter').getBoundingClientRect()
              return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + Math.min(220, rect.height / 2)) }
            })()`)
            win.webContents.sendInputEvent({ type: 'mouseMove', x: hover.x, y: hover.y })
            await new Promise((resolve) => setTimeout(resolve, 150))
            const result = await win.webContents.executeJavaScript(`(() => {
              const sidebar = document.getElementById('sidebar')
              const splitter = document.getElementById('splitter')
              const sideRect = sidebar.getBoundingClientRect()
              const splitStyle = getComputedStyle(splitter)
              return {
                sidebarWidth: Math.round(sideRect.width),
                splitterWidth: splitStyle.width,
                splitterBackground: splitStyle.backgroundColor,
                splitterHovered: splitter.matches(':hover')
              }
            })()`)
            console.log('[verify] sidebar resize:', JSON.stringify(result))
          }
          if (verifyMode === 'findbar-flow') {
            const result = await win.webContents.executeJavaScript(`(() => {
              const findRect = document.getElementById('findbar').getBoundingClientRect()
              const docRect = document.getElementById('docWrap').getBoundingClientRect()
              return {
                findBottom: Math.round(findRect.bottom),
                documentTop: Math.round(docRect.top),
                overlapsDocument: findRect.bottom > docRect.top,
                findbarVisible: !document.getElementById('findbar').hidden
              }
            })()`)
            console.log('[verify] findbar flow:', JSON.stringify(result))
          }
          if (verifyMode === 'preview-source-sync') {
            const result = await win.webContents.executeJavaScript(`(async () => {
              const edit = document.getElementById('btnEdit')
              if (edit) edit.click()
              await new Promise((resolve) => setTimeout(resolve, 120))
              const preview = document.getElementById('preview')
              const editor = document.getElementById('editor')
              const target = Array.from(preview.querySelectorAll('[data-source-offset]')).find((node) => (node.textContent || '').trim().length >= 4)
              if (!target || !target.firstChild) return { ok: false, reason: 'missing mapped preview text' }
              const textLength = target.firstChild.textContent.length
              const from = Math.min(1, Math.max(0, textLength - 1))
              const to = Math.min(textLength, from + Math.min(4, textLength - from))
              const range = document.createRange()
              range.setStart(target.firstChild, from)
              range.setEnd(target.firstChild, to)
              const selection = window.getSelection()
              selection.removeAllRanges()
              selection.addRange(range)
              const rect = range.getBoundingClientRect()
              target.dispatchEvent(new MouseEvent('mouseup', {
                bubbles: true,
                button: 0,
                clientX: Math.round(rect.right),
                clientY: Math.round(rect.top + Math.max(1, rect.height / 2))
              }))
              await new Promise((resolve) => setTimeout(resolve, 120))
              const expectedStart = Number(target.getAttribute('data-source-offset')) + from
              const expectedEnd = Number(target.getAttribute('data-source-offset')) + to
              return {
                ok: editor.selectionStart === expectedStart && editor.selectionEnd === expectedEnd,
                expectedStart,
                expectedEnd,
                selectionStart: editor.selectionStart,
                selectionEnd: editor.selectionEnd,
                selectedSource: editor.value.slice(editor.selectionStart, editor.selectionEnd),
                editorFocused: document.activeElement === editor,
                editorScrollTop: Math.round(editor.scrollTop)
              }
            })()`)
            console.log('[verify] preview source sync:', JSON.stringify(result))
          }
          if (verifyMode === 'linked-scroll') {
            const result = await win.webContents.executeJavaScript(`(async () => {
              const edit = document.getElementById('btnEdit')
              if (edit) edit.click()
              await new Promise((resolve) => setTimeout(resolve, 520))
              const preview = document.getElementById('preview')
              const editor = document.getElementById('editor')
              const lineForOffset = (offset) => (editor.value.slice(0, Math.max(0, offset)).match(/\\n/g) || []).length
              const editorCenterLine = () => {
                const style = getComputedStyle(editor)
                const fontSize = parseFloat(style.fontSize) || 13
                const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.7
                const paddingTop = parseFloat(style.paddingTop) || 0
                return Math.max(0, Math.round((editor.scrollTop + editor.clientHeight / 2 - paddingTop) / lineHeight - 0.5))
              }
              const previewCenterLine = () => {
                const viewport = preview.getBoundingClientRect()
                const x = Math.round(viewport.left + viewport.width * 0.45)
                const y = Math.round(viewport.top + viewport.height / 2)
                let mapped = null
                for (const node of document.elementsFromPoint(x, y)) {
                  if (!preview.contains(node)) continue
                  mapped = node.closest('[data-source-offset],[data-source-start]')
                  if (mapped) break
                }
                if (!mapped) {
                  let distance = Infinity
                  preview.querySelectorAll('[data-source-offset],[data-source-start]').forEach((node) => {
                    const rect = node.getBoundingClientRect()
                    const delta = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0
                    if (delta < distance) { distance = delta; mapped = node }
                  })
                }
                if (!mapped) return null
                const rect = mapped.getBoundingClientRect()
                const ratio = rect.height > 1 ? Math.max(0, Math.min(1, (y - rect.top) / rect.height)) : 0.5
                const offsetAttr = mapped.getAttribute('data-source-offset')
                const endOffsetAttr = mapped.getAttribute('data-source-end-offset')
                const offset = offsetAttr == null ? NaN : Number(offsetAttr)
                const endOffset = endOffsetAttr == null ? NaN : Number(endOffsetAttr)
                if (Number.isFinite(offset)) {
                  const startLine = lineForOffset(offset)
                  const endLine = lineForOffset(Number.isFinite(endOffset) ? Math.max(offset, endOffset - 1) : offset)
                  return Math.round(startLine + (endLine - startLine) * ratio)
                }
                const start = Number(mapped.getAttribute('data-source-start'))
                const end = Number(mapped.getAttribute('data-source-end'))
                return Math.round(start + (Math.max(start, end - 1) - start) * ratio)
              }

              editor.scrollTop = Math.max(0, (editor.scrollHeight - editor.clientHeight) * 0.62)
              editor.dispatchEvent(new Event('scroll'))
              await new Promise((resolve) => setTimeout(resolve, 260))
              const editorToPreview = { editor: editorCenterLine(), preview: previewCenterLine() }

              await new Promise((resolve) => setTimeout(resolve, 80))
              preview.scrollTop = Math.max(0, (preview.scrollHeight - preview.clientHeight) * 0.3)
              preview.dispatchEvent(new Event('scroll'))
              await new Promise((resolve) => setTimeout(resolve, 180))
              const previewToEditor = { editor: editorCenterLine(), preview: previewCenterLine() }
              const firstDiff = editorToPreview.preview == null ? 999 : Math.abs(editorToPreview.editor - editorToPreview.preview)
              const secondDiff = previewToEditor.preview == null ? 999 : Math.abs(previewToEditor.editor - previewToEditor.preview)
              return {
                ok: firstDiff <= 1 && secondDiff <= 1,
                editorToPreview,
                previewToEditor,
                firstDiff,
                secondDiff,
                previewScrollable: preview.scrollHeight > preview.clientHeight,
                editorScrollable: editor.scrollHeight > editor.clientHeight
              }
            })()`)
            console.log('[verify] linked scroll:', JSON.stringify(result))
          }
        }
        const image = await win.webContents.capturePage()
        fs.writeFileSync(shotPath, image.toPNG())
        console.log('[screenshot] saved:', shotPath, image.getSize().width + 'x' + image.getSize().height)
        console.log('[verify] renderer console errors:', rendererConsoleErrors)
      }
    } catch (e) {
      console.error('[screenshot] failed:', e.message)
    }
    app.quit()
  }, 6000)
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 760,
    minHeight: 520,
    title: 'Markdown 查看器',
    backgroundColor: '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) {
      rendererConsoleErrors++
      console.error('[renderer]', message)
    }
  })
  win.loadFile(path.join(__dirname, '../renderer/index.html'))
  win.once('ready-to-show', () => win.show())
  win.on('close', (event) => {
    if (forceClose) return
    event.preventDefault()
    if (!closePromptPending && win && !win.webContents.isDestroyed()) {
      closePromptPending = true
      win.webContents.send('app:confirmClose')
    }
  })
  win.on('closed', () => { win = null })
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '打开文件', accelerator: 'CmdOrCtrl+O', click: () => win && win.webContents.send('menu:openFile') },
        { label: '打开文件夹', accelerator: 'CmdOrCtrl+Shift+O', click: () => win && win.webContents.send('menu:openFolder') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => win && win.webContents.send('menu:save') },
        { type: 'separator' },
        { label: '关闭标签页', accelerator: 'CmdOrCtrl+W', click: () => win && win.webContents.send('menu:closeTab') },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '切换侧边栏', accelerator: 'CmdOrCtrl+B', click: () => win && win.webContents.send('menu:toggleSidebar') },
        { label: '切换大纲', accelerator: 'CmdOrCtrl+J', click: () => win && win.webContents.send('menu:toggleOutline') },
        { label: '切换编辑模式', accelerator: 'CmdOrCtrl+E', click: () => win && win.webContents.send('menu:toggleEdit') },
        { label: '切换主题', accelerator: 'CmdOrCtrl+D', click: () => win && win.webContents.send('menu:toggleTheme') },
        { label: '专注模式', accelerator: 'F8', click: () => win && win.webContents.send('menu:focusMode') },
        { type: 'separator' },
        { label: '查找', accelerator: 'CmdOrCtrl+F', click: () => win && win.webContents.send('menu:find') },
        { label: '全局搜索', accelerator: 'CmdOrCtrl+Shift+F', click: () => win && win.webContents.send('menu:globalSearch') },
        { type: 'separator' },
        { label: '放大字号', accelerator: 'CmdOrCtrl+=', click: () => win && win.webContents.send('menu:zoom', 1) },
        { label: '缩小字号', accelerator: 'CmdOrCtrl+-', click: () => win && win.webContents.send('menu:zoom', -1) },
        { label: '重置缩放', accelerator: 'CmdOrCtrl+0', click: () => win && win.webContents.send('menu:zoom', 0) },
        { type: 'separator' },
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function walkTree(dir, depth, counter) {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  const dirs = []
  const files = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      if (IGNORE_DIRS.has(entry.name)) continue
      dirs.push(entry)
    } else {
      files.push(entry)
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  for (const d of dirs) {
    if (counter.n >= MAX_TREE_ITEMS) break
    counter.n++
    const full = path.join(dir, d.name)
    out.push({ name: d.name, path: full, type: 'dir', children: depth < 6 ? walkTree(full, depth + 1, counter) : [] })
  }
  for (const f of files) {
    if (counter.n >= MAX_TREE_ITEMS) break
    counter.n++
    const full = path.join(dir, f.name)
    const ext = path.extname(f.name).toLowerCase()
    out.push({ name: f.name, path: full, type: 'file', ext, markdown: MARKDOWN_EXT.includes(ext) })
  }
  return out
}

function collectMarkdownFiles(dir, acc, depth) {
  if (depth > 6 || acc.length >= MAX_SEARCH_FILES) return acc
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return acc
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) collectMarkdownFiles(full, acc, depth + 1)
    else if (MARKDOWN_EXT.includes(path.extname(entry.name).toLowerCase())) acc.push(full)
  }
  return acc
}

async function walkTreeAsync(dir, depth, counter) {
  const out = []
  let entries = []
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.') && !IGNORE_DIRS.has(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  const files = entries.filter((entry) => !entry.isDirectory() && !entry.name.startsWith('.'))
    .sort((a, b) => a.name.localeCompare(b.name, 'zh'))
  for (const entry of dirs) {
    if (counter.n >= MAX_TREE_ITEMS) break
    counter.n++
    const full = path.join(dir, entry.name)
    out.push({ name: entry.name, path: full, type: 'dir', children: depth < 6 ? await walkTreeAsync(full, depth + 1, counter) : [] })
  }
  for (const entry of files) {
    if (counter.n >= MAX_TREE_ITEMS) break
    counter.n++
    const full = path.join(dir, entry.name)
    const ext = path.extname(entry.name).toLowerCase()
    out.push({ name: entry.name, path: full, type: 'file', ext, markdown: MARKDOWN_EXT.includes(ext) })
  }
  return out
}

async function collectMarkdownFilesAsync(dir, acc, depth) {
  if (depth > 6 || acc.length >= MAX_SEARCH_FILES) return acc
  let entries = []
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch (e) {
    return acc
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORE_DIRS.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) await collectMarkdownFilesAsync(full, acc, depth + 1)
    else if (MARKDOWN_EXT.includes(path.extname(entry.name).toLowerCase())) acc.push(full)
    if (acc.length >= MAX_SEARCH_FILES) break
  }
  return acc
}

function getStartupFile() {
  const argv = process.argv.slice(app.isPackaged ? 1 : 2)
  for (const arg of argv) {
    if (!arg || arg.startsWith('-')) continue
    try {
      const stat = fs.statSync(arg)
      if (stat.isFile() && MARKDOWN_EXT.includes(path.extname(arg).toLowerCase())) return authorizeFile(arg, true)
    } catch (e) { /* 非文件路径忽略 */ }
  }
  return prefs.lastOpenedFile && fs.existsSync(prefs.lastOpenedFile) ? authorizeFile(prefs.lastOpenedFile, true) : ''
}

function registerIpc() {
  ipcMain.handle('dialog:openFile', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: '打开 Markdown 文件',
      filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] }, { name: '所有文件', extensions: ['*'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled) return []
    return res.filePaths.map((file) => authorizeFile(file, true)).filter(Boolean)
  })

  ipcMain.handle('dialog:openFolder', async () => {
    const res = await dialog.showOpenDialog(win, { title: '打开文件夹', properties: ['openDirectory'] })
    return res.canceled ? '' : authorizeRoot(res.filePaths[0])
  })

  ipcMain.handle('fs:authorizeDrop', async (_, paths) => {
    if (!Array.isArray(paths)) return []
    return paths.slice(0, 20).map((file) => authorizeFile(file, true)).filter(Boolean)
  })

  ipcMain.handle('fs:read', async (_, filePath) => {
    try {
      if (!isAuthorizedFile(filePath)) return { ok: false, error: '没有读取该文件的权限，请通过“打开”或拖拽选择文件' }
      const full = normalizePath(filePath)
      const [content, stat] = await Promise.all([fs.promises.readFile(full, 'utf8'), fs.promises.stat(full)])
      return { ok: true, path: full, content, mtime: stat.mtimeMs, size: stat.size }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('fs:save', async (_, filePath, content, expectedMtime) => {
    try {
      if (!isAuthorizedFile(filePath)) return { ok: false, error: '没有保存该文件的权限' }
      const full = normalizePath(filePath)
      const before = await fs.promises.stat(full)
      if (Number.isFinite(Number(expectedMtime)) && Math.abs(before.mtimeMs - Number(expectedMtime)) > 1) {
        return { ok: false, conflict: true, error: '文件已在其他程序中修改' }
      }
      await fs.promises.writeFile(full, String(content == null ? '' : content), 'utf8')
      return { ok: true, mtime: (await fs.promises.stat(full)).mtimeMs }
    } catch (e) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('fs:tree', async (_, dirPath) => {
    try {
      if (!isAuthorizedRoot(dirPath)) return { ok: false, error: '没有读取该文件夹的权限', tree: [] }
      const full = normalizePath(dirPath)
      return { ok: true, root: full, tree: await walkTreeAsync(full, 0, { n: 0 }) }
    } catch (e) {
      return { ok: false, error: e.message, tree: [] }
    }
  })

  ipcMain.handle('fs:search', async (_, dirPath, query) => {
    const q = String(query || '').trim()
    if (!q) return { ok: true, results: [] }
    if (!isAuthorizedRoot(dirPath)) return { ok: false, error: '没有搜索该文件夹的权限', results: [] }
    const results = []
    let re
    try {
      re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    } catch (e) {
      return { ok: false, error: '搜索表达式无效', results: [] }
    }
    for (const file of await collectMarkdownFilesAsync(normalizePath(dirPath), [], 0)) {
      let content
      try {
        content = await fs.promises.readFile(file, 'utf8')
      } catch (e) {
        continue
      }
      const lines = content.split('\n')
      const hits = []
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push({ line: i + 1, text: lines[i].trim().slice(0, 160) })
          if (hits.length >= 5) break
        }
        re.lastIndex = 0
      }
      if (hits.length) results.push({ path: file, name: path.basename(file), hits })
      if (results.length >= 60) break
    }
    return { ok: true, results }
  })

  ipcMain.handle('img:analyze', async (_, images, markdown, docPath) => {
    try {
      if (!isAuthorizedFile(docPath)) return { ok: false, error: '没有分析该文档的权限', items: [], duplicates: [], missing: [], summary: {} }
      const docDir = path.dirname(normalizePath(docPath)).toLowerCase()
      const roots = [docDir].concat((prefs.imageRoots || []).map((root) => normalizePath(root).toLowerCase()).filter(Boolean))
      const safeImages = Array.isArray(images) ? images.map((img) => {
        if (!img || img.external || !img.resolved) return img
        const resolved = normalizePath(img.resolved)
        const allowed = roots.some((root) => isInside(resolved.toLowerCase(), root)) || isAuthorizedFile(resolved)
        return Object.assign({}, img, { resolved: allowed ? resolved : '' })
      }) : []
      return { ok: true, ...await analyzeImagesAsync(safeImages, { markdown, imageRoots: prefs.imageRoots }) }
    } catch (e) {
      return { ok: false, error: e.message, items: [], duplicates: [], missing: [], summary: {} }
    }
  })

  ipcMain.handle('prefs:get', async () => prefs)
  ipcMain.handle('prefs:set', async (_, patch) => {
    prefs = Object.assign(prefs, patch || {})
    savePrefs()
    return prefs
  })
  ipcMain.handle('prefs:addRecent', async (_, filePath) => {
    prefs.recentFiles = [filePath].concat(prefs.recentFiles.filter((p) => p !== filePath)).slice(0, 20)
    prefs.lastOpenedFile = filePath
    savePrefs()
    return prefs.recentFiles
  })
  ipcMain.handle('prefs:imageRoots', async (_, roots) => {
    prefs.imageRoots = Array.isArray(roots) ? roots.map(authorizeRoot).filter(Boolean) : []
    savePrefs()
    return prefs.imageRoots
  })
  ipcMain.handle('app:startupFile', async () => getStartupFile())
  ipcMain.handle('app:allowClose', async () => {
    forceClose = true
    closePromptPending = false
    if (win) win.close()
    return true
  })
  ipcMain.handle('app:cancelClose', async () => {
    closePromptPending = false
    return true
  })
  ipcMain.handle('app:setDefault', async () => registerFileAssociation())
  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    userData: app.getPath('userData'),
    prefsPath,
    katex: (() => { try { require.resolve('katex'); return true } catch (e) { return false } })()
  }))
  ipcMain.handle('shell:showItem', async (_, filePath) => {
    if (filePath) shell.showItemInFolder(filePath)
  })
  ipcMain.handle('shell:openExternal', async (_, url) => {
    if (url && /^https?:\/\//i.test(url)) shell.openExternal(url)
  })
}

app.whenReady().then(() => {
  if (!setupSingleInstance()) return
  prefsPath = path.join(app.getPath('userData'), 'prefs.json')
  loadPrefs()
  ensurePackagedAssociationIdentity()
  ensureVendor()
  registerIpc()
  buildMenu()
  setupScreenshotHook()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
