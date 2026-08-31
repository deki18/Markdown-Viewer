const path = require('path')
const { spawnSync } = require('child_process')

const DEFAULT_EXTENSIONS = ['.md', '.markdown', '.mdown', '.mkd']

function createOpenCommand(exePath) {
  return `"${exePath}" "%1"`
}

function runReg(args, runner, allowMissing = false) {
  const result = runner('reg.exe', args, { windowsHide: true, encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0 && !(allowMissing && result.status === 1)) {
    const detail = String(result.stderr || result.stdout || '').trim()
    throw new Error(detail || `reg.exe 退出码 ${result.status}`)
  }
}

function addValue(key, name, value, type, runner) {
  const args = ['add', key, name == null ? '/ve' : '/v', ...(name == null ? [] : [name])]
  if (type) args.push('/t', type)
  args.push('/d', value, '/f')
  runReg(args, runner)
}

function addKey(key, runner) {
  runReg(['add', key, '/f'], runner)
}

function deleteKey(key, runner) {
  runReg(['delete', key, '/f'], runner, true)
}

/**
 * 注册单一的 ProgID 候选项。使用 reg.exe 参数数组，避免 PowerShell/JS/注册表
 * 多层字符串转义把引号写成反斜杠。
 */
function registerWindowsFileAssociation(options, runner = spawnSync) {
  const exePath = String(options.exePath || '')
  if (!exePath) throw new Error('缺少程序路径')

  const appName = options.appName || 'Markdown 查看器'
  const progId = options.progId || 'MarkdownDocument'
  const extensions = options.extensions || DEFAULT_EXTENSIONS
  const exeName = path.win32.basename(exePath)
  const classesRoot = 'HKCU\\Software\\Classes'
  const progKey = `${classesRoot}\\${progId}`
  const appKey = `${classesRoot}\\Applications\\${exeName}`
  const muiCacheKey = `${classesRoot}\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache`
  const openCommand = createOpenCommand(exePath)

  // 清理 v0.2.3 额外写入的 OpenWithList 身份，避免同一程序显示两次。
  deleteKey(appKey, runner)
  for (const ext of extensions) {
    deleteKey(`${classesRoot}\\${ext}\\OpenWithList\\${exeName}`, runner)
  }

  addValue(progKey, null, 'Markdown 文档', 'REG_SZ', runner)
  addValue(progKey, 'FriendlyTypeName', 'Markdown 文档', 'REG_SZ', runner)
  addValue(`${progKey}\\DefaultIcon`, null, `${exePath},0`, 'REG_SZ', runner)
  addValue(`${progKey}\\shell`, null, 'open', 'REG_SZ', runner)
  addValue(`${progKey}\\shell\\open`, null, `使用 ${appName} 打开`, 'REG_SZ', runner)
  addValue(`${progKey}\\shell\\open\\command`, null, openCommand, 'REG_SZ', runner)

  // Explorer 的最近打开方式按 exe 名解析 Applications；不写 SupportedTypes，避免新增第二个候选来源。
  addValue(appKey, 'FriendlyAppName', appName, 'REG_SZ', runner)
  addValue(`${appKey}\\Application`, 'ApplicationName', appName, 'REG_SZ', runner)
  addValue(`${appKey}\\Application`, 'ApplicationDescription', appName, 'REG_SZ', runner)
  addValue(`${appKey}\\Application`, 'ApplicationIcon', `${exePath},0`, 'REG_SZ', runner)
  addValue(`${appKey}\\shell\\open\\command`, null, openCommand, 'REG_SZ', runner)

  // 老版本 EXE 的名称会被 Windows 长期缓存在 MuiCache，必须按当前路径刷新。
  addValue(muiCacheKey, `${exePath}.FriendlyAppName`, appName, 'REG_SZ', runner)
  addValue(muiCacheKey, `${exePath}.ApplicationCompany`, appName, 'REG_SZ', runner)

  for (const ext of extensions) {
    const openWithKey = `${classesRoot}\\${ext}\\OpenWithProgids`
    addKey(openWithKey, runner)
    addValue(openWithKey, progId, '', 'REG_NONE', runner)
  }

  return { exeName, openCommand, progId }
}

module.exports = {
  DEFAULT_EXTENSIONS,
  createOpenCommand,
  registerWindowsFileAssociation
}
