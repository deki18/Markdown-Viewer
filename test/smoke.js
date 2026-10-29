/**
 * 渲染管线冒烟测试（不依赖 Electron）
 * 运行：npm test
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { renderMarkdown } = require('../src/shared/markdown')
const { analyzeImages, analyzeImagesAsync, probeSize, formatSize } = require('../src/shared/imageTools')
const { createOpenCommand, registerWindowsFileAssociation } = require('../src/main/windowsAssociation')

let passed = 0
const asyncTests = []
function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  \u2713 ' + name)
  } catch (e) {
    console.error('  \u2717 ' + name)
    console.error('    ' + e.message)
    process.exitCode = 1
  }
}

function testAsync(name, fn) {
  asyncTests.push({ name, fn })
}

console.log('渲染管线')

test('标题生成锚点并收集目录', () => {
  const r = renderMarkdown('# 一级\n## 二级 A\n## 二级 B\n### 三级')
  assert.strictEqual(r.toc.length, 4)
  assert.strictEqual(r.toc[0].level, 1)
  assert.ok(r.html.includes('id="一级"') || r.html.includes('id='), '标题应带 id')
})

test('重复标题的锚点自动去重', () => {
  const r = renderMarkdown('## 概览\n\n## 概览')
  assert.strictEqual(r.toc.length, 2)
  assert.notStrictEqual(r.toc[0].id, r.toc[1].id)
})

test('GFM 表格渲染并包裹滚动容器', () => {
  const r = renderMarkdown('| 项目 | 数值 |\n| --- | --- |\n| 容积率 | 2.4 |')
  assert.ok(r.html.includes('<table'), '应渲染表格')
  assert.ok(r.html.includes('table-wrap'), '应包裹滚动容器')
  assert.ok(r.html.includes('容积率'))
})

test('任务清单渲染为 checkbox', () => {
  const r = renderMarkdown('- [x] 已完成\n- [ ] 未完成')
  assert.strictEqual((r.html.match(/type="checkbox"/g) || []).length, 2)
  assert.ok(r.html.includes('checked'), '已勾选项应有 checked')
})

test('代码块高亮 + 复制按钮 + 代码内容登记', () => {
  const r = renderMarkdown('```js\nconst a = 1\n```')
  assert.ok(r.html.includes('code-block'))
  assert.ok(r.html.includes('data-code-id="0"'))
  assert.strictEqual(r.codes[0], 'const a = 1')
  assert.ok(r.html.includes('hljs'), '应有高亮标记')
})

test('mermaid 代码块单独识别', () => {
  const r = renderMarkdown('```mermaid\ngraph TD\nA-->B\n```')
  assert.ok(r.html.includes('mermaid-block'))
  assert.strictEqual(r.mermaid.length, 1)
  assert.ok(r.mermaid[0].includes('graph TD'))
})

test('行内公式渲染为 KaTeX', () => {
  const r = renderMarkdown('勾股定理 $a^2+b^2=c^2$ 成立')
  assert.ok(r.html.includes('katex'), '应输出 katex 结构')
})

test('块级公式渲染为 display 模式', () => {
  const r = renderMarkdown('$$\nE = mc^2\n$$')
  assert.ok(r.html.includes('math-block'))
})

test('图片登记索引与 alt', () => {
  const r = renderMarkdown('![外立面](./img/a.png)', { baseDir: 'C:\\docs' })
  assert.strictEqual(r.images.length, 1)
  assert.strictEqual(r.images[0].alt, '外立面')
  assert.strictEqual(r.images[0].external, false)
  assert.ok(r.images[0].resolved.includes('img'), '应解析为绝对路径')
})

test('外链图片标记为 external', () => {
  const r = renderMarkdown('![图](https://example.com/a.png)')
  assert.strictEqual(r.images[0].external, true)
})

test('外链自动新窗口打开', () => {
  const r = renderMarkdown('[链接](https://example.com)')
  assert.ok(r.html.includes('target="_blank"'))
  assert.ok(r.html.includes('rel="noopener noreferrer"'))
})

test('原生 HTML 被转义而不是注入预览 DOM', () => {
  const r = renderMarkdown('<img src="x" onerror="alert(1)">\n\n<script>alert(2)</script>')
  assert.ok(!/<img\b/i.test(r.html), '原生 img 标签不应成为真实元素')
  assert.ok(!/<script\b/i.test(r.html), 'script 标签不应成为真实元素')
  assert.ok(r.html.includes('&lt;img'), '原生 HTML 应作为文本显示')
})

test('javascript: 协议链接被拦截', () => {
  const r = renderMarkdown('[点我](javascript:alert(1))')
  assert.ok(!/<a[^>]+href="javascript/i.test(r.html), '危险协议不应成为 href')
  const fileUrl = renderMarkdown('[本地](file:///C:/secret.txt)')
  assert.ok(!/<a[^>]+href="file:/i.test(fileUrl.html), 'file: 协议不应成为 href')
})

test('原生 HTML 中的 javascript: 链接不会成为可点击元素', () => {
  const r = renderMarkdown('<a href="javascript:window.mdv.readFile(\'C:/secret.txt\')">点我</a>')
  assert.ok(!/<a[^>]+href="javascript/i.test(r.html))
  assert.ok(r.html.includes('&lt;a'))
})

test('统计字数与阅读时长', () => {
  const r = renderMarkdown('# 标题\n\n这是一段用于统计的中文正文内容。')
  assert.ok(r.stats.cjk > 5, '应统计中文字符')
  assert.ok(r.stats.readMinutes >= 1)
  assert.strictEqual(r.stats.images, 0)
})

console.log('图片工具')

test('探测 PNG 尺寸', () => {
  const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000080000000600806000000', 'hex')
  const dim = probeSize(png)
  assert.strictEqual(dim.width, 128)
  assert.strictEqual(dim.height, 96)
})

test('探测 JPEG 尺寸', () => {
  const jpg = Buffer.concat([
    Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex'),
    Buffer.from('ffc0001108006000800003012200021101031101', 'hex')
  ])
  const dim = probeSize(jpg)
  assert.ok(dim.width > 0 && dim.height > 0, '应解析出非零尺寸')
})

test('探测 SVG 尺寸（viewBox）', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 120"></svg>')
  const dim = probeSize(svg)
  assert.strictEqual(dim.width, 300)
  assert.strictEqual(dim.height, 120)
})

test('体积格式化', () => {
  assert.strictEqual(formatSize(0), '0 B')
  assert.strictEqual(formatSize(512), '512 B')
  assert.ok(/KB$/.test(formatSize(2048)))
  assert.ok(/MB$/.test(formatSize(5 * 1024 * 1024)))
})

test('缺失图片被标记 missing', () => {
  const r = renderMarkdown('![不存在](./not-exist-xyz.png)', { baseDir: __dirname })
  const report = analyzeImages(r.images, { markdown: '' })
  assert.strictEqual(report.summary.missing, 1)
  assert.strictEqual(report.items[0].status, 'missing')
})

test('重复图片（异名同内容）被识别', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-'))
  const buf = Buffer.from('89504e470d0a1a0a0000000d4948445200000010000000100806000000', 'hex')
  fs.writeFileSync(path.join(dir, 'a.png'), buf)
  fs.writeFileSync(path.join(dir, 'b.png'), buf)
  const r = renderMarkdown('![a](a.png)\n\n![b](b.png)', { baseDir: dir })
  const report = analyzeImages(r.images, { markdown: '![a](a.png)\n\n![b](b.png)' })
  assert.strictEqual(report.summary.total, 2)
  assert.strictEqual(report.summary.duplicateGroups, 1, '应识别出 1 组重复')
  assert.strictEqual(report.duplicates[0].files.length, 2)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('图片根目录回退查找', () => {
  const docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-doc-'))
  const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-img-'))
  fs.writeFileSync(path.join(imgDir, 'shot.png'), Buffer.from('89504e470d0a1a0a0000000d4948445200000010000000100806000000', 'hex'))
  const r = renderMarkdown('![shot](shot.png)', { baseDir: docDir })
  const report = analyzeImages(r.images, { markdown: '', imageRoots: [imgDir] })
  assert.strictEqual(report.summary.missing, 0, '应回退查找成功')
  assert.ok(report.items[0].path.includes('shot.png'))
  fs.rmSync(docDir, { recursive: true, force: true })
  fs.rmSync(imgDir, { recursive: true, force: true })
})

testAsync('异步图片分析保持查重与尺寸结果', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-async-img-'))
  const image = Buffer.from('89504e470d0a1a0a0000000d4948445200000020000000180806000000', 'hex')
  const file = path.join(dir, 'a.png')
  fs.writeFileSync(file, image)
  const rendered = renderMarkdown('![a](a.png)', { baseDir: dir })
  const report = await analyzeImagesAsync(rendered.images, { markdown: '![a](a.png)' })
  assert.strictEqual(report.summary.total, 1)
  assert.strictEqual(report.items[0].width, 32)
  assert.strictEqual(report.items[0].height, 24)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('核心界面控件具备侧栏、查找导航和四套主题', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/renderer/index.html'), 'utf8')
  const appJs = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8')
  for (const panel of ['files', 'outline', 'images', 'search']) assert.ok(html.includes(`data-panel="${panel}"`))
  for (const id of ['btnFindPrev', 'btnFindNext', 'btnFindClear']) assert.ok(html.includes(`id="${id}"`))
  for (const theme of ['ink', 'paper', 'night', 'system']) assert.ok(html.includes(`data-theme="${theme}"`))
  assert.ok(appJs.includes("document.querySelectorAll('.side-tab')"), '侧栏按钮应绑定点击事件')
  assert.ok(appJs.includes("on($('btnFindNext'), 'click'"), '下一个按钮应绑定点击事件')
  assert.ok(appJs.includes('function openFind()'), '当前文档查找应按需打开')
  assert.ok(appJs.includes('function closeFind()'), '当前文档查找应支持关闭并恢复正文空间')
  assert.ok(appJs.includes("on($('btnFindClear'), 'click', closeFind)"), '查找栏关闭按钮应收起查找栏')
  assert.ok(html.includes('role="search"'), '查找栏应具备 search 语义')
  assert.ok(html.includes('role="separator"'), '侧栏分隔条应具备可访问的 separator 语义')
  assert.ok(appJs.includes('bindSidebarResize()'), '侧栏分隔条应绑定拖拽调整宽度')
  assert.ok(appJs.includes("setAttribute('aria-valuenow'"), '侧栏宽度变化应同步无障碍数值')
})

test('Windows 安装包写入正式软件名称', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'))
  const mainJs = fs.readFileSync(path.join(__dirname, '../src/main/main.js'), 'utf8')
  assert.strictEqual(packageJson.productName, 'Markdown 查看器')
  assert.strictEqual(packageJson.author.name, 'Markdown 查看器')
  assert.strictEqual(packageJson.build.productName, 'Markdown 查看器')
  assert.strictEqual(packageJson.build.executableName, 'Markdown 查看器')
  assert.strictEqual(packageJson.build.win.signAndEditExecutable, true)
  assert.ok(mainJs.includes('app.setName(APP_NAME)'), 'Electron 运行时应使用正式软件名')
  assert.ok(mainJs.includes('app.setAppUserModelId(APP_ID)'), 'Windows 任务栏应使用稳定应用标识')
  assert.ok(mainJs.includes('registerWindowsFileAssociation'), '主进程应使用安全的关联注册模块')
  assert.ok(mainJs.includes('process.env.PORTABLE_EXECUTABLE_FILE'), '便携版关联不能指向临时解压路径')
})

test('Windows 打开命令使用真实双引号且不产生路径反斜杠', () => {
  const exe = 'C:\\Users\\tester\\AppData\\Local\\Programs\\md-viewer\\Markdown 查看器.exe'
  assert.strictEqual(createOpenCommand(exe), `"${exe}" "%1"`)
  assert.ok(!createOpenCommand(exe).startsWith('\\C:'), '命令不能以反斜杠路径开头')
})

test('Windows 文件关联只注册一套 ProgID 并刷新应用名称缓存', () => {
  const calls = []
  const fakeRunner = (command, args) => {
    calls.push({ command, args })
    return { status: 0, stdout: '', stderr: '' }
  }
  const exe = 'C:\\Program Files\\Markdown 查看器\\Markdown 查看器.exe'
  const result = registerWindowsFileAssociation({ exePath: exe }, fakeRunner)
  assert.strictEqual(result.openCommand, `"${exe}" "%1"`)
  assert.ok(calls.every((call) => call.command === 'reg.exe'))
  assert.ok(calls.some((call) => call.args[0] === 'delete' && call.args.join(' ').includes('Applications\\Markdown 查看器.exe')))
  assert.ok(calls.some((call) => call.args[0] === 'delete' && call.args.join(' ').includes('OpenWithList\\Markdown 查看器.exe')))
  assert.ok(calls.some((call) => call.args[0] === 'add' && call.args.includes('FriendlyAppName') && call.args.includes('Markdown 查看器')))
  assert.ok(calls.some((call) => call.args[0] === 'add' && call.args.some((arg) => arg.includes('MuiCache')) && call.args.includes(`${exe}.FriendlyAppName`)))
  assert.ok(!calls.some((call) => call.args.some((arg) => arg.includes('SupportedTypes'))), '不应新增第二个候选来源')
  const commandWrite = calls.find((call) => call.args.includes('HKCU\\Software\\Classes\\MarkdownDocument\\shell\\open\\command'))
  assert.ok(commandWrite, '应写入 ProgID 的 open command')
  assert.ok(commandWrite.args.includes(`"${exe}" "%1"`), 'open command 应保留真实双引号')
})

test('预览内容携带块级行号与字符级源位置', () => {
  const src = '# 标题\n\n这是 **重点** 文本。\n\n```js\nconst answer = 42\n```'
  const r = renderMarkdown(src)
  assert.ok(r.html.includes('data-source-start="0"'), '标题应带源行号')
  assert.ok(r.html.includes('data-source-start="2"'), '段落应带源行号')
  assert.ok(r.html.includes(`data-source-offset="${src.indexOf('重点')}"`), '强调文字应带精确源字符位置')
  assert.ok(r.html.includes('class="code-block" data-source-start="4"'), '代码块应带源行号')
  assert.ok(r.html.includes(`data-source-offset="${src.indexOf('const answer')}"`), '代码内容应带精确源字符位置')
})

test('编辑模式支持从预览选择同步编辑器位置', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8')
  assert.ok(appJs.includes('function syncEditorFromPreview(event)'))
  assert.ok(appJs.includes("on(el.preview, 'mouseup'"), '预览区应监听选择完成事件')
  assert.ok(appJs.includes('el.editor.setSelectionRange(start, end)'), '编辑器应同步字符选区')
  assert.ok(appJs.includes('scrollEditorToSource(start)'), '编辑器应滚动到对应源位置')
})

test('编辑模式支持左右中心线双向同步滚动', () => {
  const appJs = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8')
  assert.ok(appJs.includes("scheduleLinkedScroll('preview')"), '渲染区滚动应同步编辑器')
  assert.ok(appJs.includes("scheduleLinkedScroll('editor')"), '编辑器滚动应同步渲染区')
  assert.ok(appJs.includes('function previewSourceAtCenter(tab, viewport)'), '应按渲染区中心内容解析源位置')
  assert.ok(appJs.includes('function centerEditorAtSourceLine(line, tab)'), '应把对应源行放到编辑器中心')
  assert.ok(appJs.includes('function centerRenderedAtSourceLine(line, tab, scroller)'), '应把对应渲染内容放到预览中心')
  assert.ok(appJs.includes('function editorPixelYForOffset(') && appJs.includes('function editorOffsetForPixelY('), '应通过像素级镜像测量换算位置，避免软换行导致的行号误差')
  assert.ok(!appJs.includes('line * metrics.lineHeight'), '不应再用行号乘行高估算编辑器滚动位置')
})

;(async () => {
  for (const item of asyncTests) {
    try {
      await item.fn()
      passed++
      console.log('  \u2713 ' + item.name)
    } catch (e) {
      console.error('  \u2717 ' + item.name)
      console.error('    ' + e.message)
      process.exitCode = 1
    }
  }
  console.log(`\n${passed} 项通过${process.exitCode ? '，存在失败' : '，全部通过'}`)
})()
