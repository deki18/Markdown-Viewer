# Markdown Viewer（Markdown 查看器）v0.3.1

一个面向 Windows 11 的 Markdown 桌面阅读器，支持文件关联双击打开，渲染完整、导航清晰、图片友好。

## 已完成功能

- **渲染全家桶**：GFM 表格/任务清单/脚注、代码高亮+复制按钮+Mermaid 流程图、KaTeX 公式。
- **阅读导航**：侧边文件树、多标签页、当前文档目录（滚动同步）、按需展开且不遮挡正文的当前文档查找（上一个/下一个）、跨文件全局搜索；侧栏支持拖动调宽、键盘微调、双击复位并自动记忆。
- **图片增强**：点击放大画廊、图片清单表（尺寸/体积/状态）、重复图片检测（内容哈希）、缺失图片标记、图片根目录回退查找。
- **轻编辑**：分栏编辑模式、Ctrl+S 保存；点击左侧渲染元素可定位右侧源行，选中渲染文字可同步选中对应源字符；滚动任意一侧时，另一侧会按 Markdown 源位置双向同步，并将对应内容保持在视口中心线附近。
- **阅读体验**：墨白/纸张/夜读/跟随系统四套主题、字号/行宽调节、专注模式、最近文件、快捷键体系。
- **安全与可靠性**：默认禁用 Markdown 原生 HTML、严格 Mermaid 模式、收紧本地文件权限、外部修改冲突提示、未保存退出确认。
- **Windows 集成**：NSIS 安装包、文件关联、单实例锁（双击直接交给已运行窗口）；EXE 资源、Applications 注册和 MuiCache 均使用正式名称「Markdown 查看器」，启动命令使用原生参数写入。

## 项目结构

```
md-viewer/
  package.json
  build/icon.ico            # 应用图标
  src/
    main/main.js            # Electron 主进程、IPC、单实例、文件关联
    preload/preload.js      # 安全桥接 API
    shared/markdown.js      # 渲染管线（Node/Electron 共用）
    shared/imageTools.js    # 图片查重、尺寸探测
    renderer/index.html     # 界面
    renderer/styles.css     # 主题样式
    renderer/app.js         # 界面逻辑
  test/smoke.js             # 30 项渲染、图片、安全、界面、定位/滚动同步与 Windows 关联测试
  tools/
    make-icon.js            # 生成 ICO 图标
    ensure-vendor.js        # 复制第三方库到 vendor
```

## 运行与打包

```bash
# 开发运行（本机无 GPU 环境，已默认加 --disable-gpu 等开关）
npm start

# 冒烟测试
npm test

# 目录打包验证
npm run pack

# 生成安装包（输出 dist/）
npm run dist

# 基于 win-unpacked 生成便携版
npm run dist:portable
```

已验证：
- `npm test`：30 项测试全部通过，包括源行/源字符映射、编辑器同步定位、双向中心滚动、带空格和中文路径的打开命令精确值及重复身份清理测试。
- v0.3.1 开发版与打包成品均完成真实窗口双向滚动验证：编辑器滚动到中心源行 72 时，渲染页中心对应源行 71；渲染页滚动到中心源行 30 时，编辑器中心同为 30；渲染进程控制台错误为 0。
- 当前系统中损坏的 v0.2.3 命令已从 `\C:\...\ \%1\` 修复为 `"C:\...\Markdown 查看器.exe" "%1"`；v0.2.5 还会把同一路径的 MuiCache 名称从 Electron/GitHub 刷新为「Markdown 查看器」。
- `release-v0.3.1/win-unpacked/Markdown 查看器.exe` 的 Windows 资源已验证：ProductName、FileDescription、CompanyName 均为「Markdown 查看器」，版本为 0.3.1。

本地打包产物（默认由 `.gitignore` 排除，不提交到源码仓库）：

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `release-v0.3.1/Markdown 查看器-0.3.1-安装版.exe` | 88.96 MB | NSIS 安装包；包含源位置定位与双向中心同步滚动 |
| `release-v0.3.1/Markdown 查看器-0.3.1-便携版.exe` | 74.74 MB | 单文件便携版；已完成成品窗口交互验证 |
| `release-v0.3.1/win-unpacked/Markdown 查看器.exe` | 172.47 MB | 未压缩程序；Windows 内部身份为「Markdown 查看器」0.3.1 |

本轮未执行 NSIS 安装/卸载，避免改动当前 Windows 系统状态；已验证同一发布内容的未压缩程序可正常启动。

## 安装后如何做到「双击 .md 直接打开」

Windows 11 的文件关联分两层，必须分清：

| 层级 | 注册表位置 | 能否由程序写入 |
| --- | --- | --- |
| 打开方式候选列表 | `HKCU\Software\Classes\.md\OpenWithProgids` | 可以，已写入 |
| 默认程序（决定双击行为） | `HKCU\...\FileExts\.md\UserChoice` | **不能**，Windows 用哈希保护，任何程序都无法静默改写 |

安装完成后的实际状态：本软件已进入 `.md` 的右键「打开方式」列表，但**双击仍会打开你此前设定的程序**（本机实测默认是某个 Microsoft Store 应用）。需要手动切一次，两种方式任选：

1. 软件内「设置 → 设为 .md 默认打开方式」，写入候选列表并自动打开系统设置页，搜索 `.md` 后选择「Markdown 查看器」；
2. 右键任意 `.md` → 打开方式 → 选择其他应用 → 「Markdown 查看器」→ 勾选「始终使用此应用打开」。

设置一次后，`.md` / `.markdown` / `.mdown` / `.mkd` 双击即用本软件打开；程序已运行时双击文件会复用同一窗口新增标签页，不会重复开窗口。

## 已知限制

- 导出 PDF / 自包含 HTML 为第二轮功能，本轮未实现。
- 设为默认应用受 Windows 11 UserChoice 保护，需用户手动在系统设置中确认一次。
- 当前 `npm start` 脚本附加了 GPU/沙箱测试开关，用于本机自动截图环境；安装包启动不附加这些参数。
- 为保护本地文件，Markdown 中的原生 HTML 会按纯文本显示。
