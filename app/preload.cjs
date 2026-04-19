const { contextBridge, ipcRenderer } = require('electron')

const ALLOWED_INVOKE = new Set([
  'set_project_root', 'read_dir_recursive', 'read_file_content', 'write_file_content', 'grep_files', 'list_py_files',
  'pty_spawn', 'pty_write', 'pty_resize', 'pty_kill',
  'lsp_start', 'lsp_send', 'lsp_stop', 'lsp_which_binary', 'lsp_install_tool',
  'check_setup', 'detect_venv', 'check_lsp_available', 'install_ty', 'configure_ty_python',
  'watch_for_venv',
  'load_prefs', 'save_prefs',
  'dialog:openFolder', 'dialog:openFile',
  'watch_file', 'unwatch_file',
  'app:confirm-quit', 'app:cancel-quit',
])

const ALLOWED_LISTEN = new Set([
  'lsp://message', 'lsp://exit', 'pty:data', 'pty:exit', 'menu:action',
  'file:changed-on-disk', 'venv:created', 'app:before-quit',
])

contextBridge.exposeInMainWorld('electronAPI', {
  invoke: (channel, args) => {
    if (!ALLOWED_INVOKE.has(channel)) throw new Error(`IPC channel not allowed: ${channel}`)
    return ipcRenderer.invoke(channel, args)
  },

  on: (channel, callback) => {
    if (!ALLOWED_LISTEN.has(channel)) throw new Error(`IPC listen channel not allowed: ${channel}`)
    const handler = (_event, ...args) => {
      callback({ payload: args.length === 1 ? args[0] : args })
    }
    ipcRenderer.on(channel, handler)
    return () => ipcRenderer.removeListener(channel, handler)
  },

  openFolderDialog: () => ipcRenderer.invoke('dialog:openFolder'),
  openFileDialog: (options) => ipcRenderer.invoke('dialog:openFile', options),
})
