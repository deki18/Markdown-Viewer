const { contextBridge, ipcRenderer, webUtils } = require('electron')
const { renderMarkdown } = require('../shared/markdown')

// 显式绑定 this，避免 contextBridge 包装后 this 丢失导致 addEventListener 报错
const invoke = ipcRenderer.invoke.bind(ipcRenderer)
const on = ipcRenderer.on.bind(ipcRenderer)
const off = ipcRenderer.removeListener.bind(ipcRenderer)

const MENU_CHANNELS = [
  'menu:openFile', 'menu:openFolder', 'menu:save', 'menu:closeTab',
  'menu:toggleSidebar', 'menu:toggleOutline', 'menu:toggleEdit', 'menu:toggleTheme',
  'menu:focusMode', 'menu:find', 'menu:globalSearch', 'menu:zoom'
]

contextBridge.exposeInMainWorld('mdv', {
  render: (src, options) => renderMarkdown(src, options),

  openFileDialog: () => invoke('dialog:openFile'),
  openFolderDialog: () => invoke('dialog:openFolder'),
  readFile: (p) => invoke('fs:read', p),
  saveFile: (p, content, expectedMtime) => invoke('fs:save', p, content, expectedMtime),
  readTree: (dir) => invoke('fs:tree', dir),
  searchFolder: (dir, query) => invoke('fs:search', dir, query),
  analyzeImages: (images, markdown, docPath) => invoke('img:analyze', images, markdown, docPath),

  getPrefs: () => invoke('prefs:get'),
  setPrefs: (patch) => invoke('prefs:set', patch),
  addRecent: (p) => invoke('prefs:addRecent', p),
  setImageRoots: (roots) => invoke('prefs:imageRoots', roots),

  startupFile: () => invoke('app:startupFile'),
  appInfo: () => invoke('app:info'),
  setAsDefault: () => invoke('app:setDefault'),
  onOpenPath: (handler) => {
    const listener = (_event, filePath) => handler(filePath)
    on('app:openPath', listener)
    return () => off('app:openPath', listener)
  },
  onFileDrop: (handler) => {
    const dragover = (event) => event.preventDefault()
    const drop = async (event) => {
      event.preventDefault()
      const paths = Array.from(event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files : [])
        .map((file) => webUtils.getPathForFile(file))
        .filter(Boolean)
      if (!paths.length) return
      const authorized = await invoke('fs:authorizeDrop', paths)
      if (authorized && authorized.length) handler(authorized)
    }
    window.addEventListener('dragover', dragover)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', dragover)
      window.removeEventListener('drop', drop)
    }
  },
  onConfirmClose: (handler) => {
    const listener = () => handler()
    on('app:confirmClose', listener)
    return () => off('app:confirmClose', listener)
  },
  allowClose: () => invoke('app:allowClose'),
  cancelClose: () => invoke('app:cancelClose'),
  showItemInFolder: (p) => invoke('shell:showItem', p),
  openExternal: (url) => invoke('shell:openExternal', url),

  onMenu: (channel, handler) => {
    if (!MENU_CHANNELS.includes(channel)) return () => {}
    const listener = (_event, payload) => handler(payload)
    on(channel, listener)
    return () => off(channel, listener)
  }
})
