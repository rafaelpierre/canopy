const { Menu, app } = require('electron')

function buildMenu(mainWindow) {
  const send = (action) => mainWindow.webContents.send('menu:action', action)

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder...', accelerator: 'CmdOrCtrl+O', click: () => send('open_folder') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle File Tree', accelerator: 'CmdOrCtrl+B', click: () => send('toggle_file_tree') },
        { label: 'Toggle Terminal', accelerator: 'CmdOrCtrl+J', click: () => send('toggle_terminal') },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => send('zoom_in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom_out') },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => send('zoom_reset') },
        { type: 'separator' },
        { label: 'Go to File',                                                    click: () => send('command_palette') },
        { label: 'Command Palette',   accelerator: 'CmdOrCtrl+Shift+P',     click: () => send('command_palette_commands') },
        { type: 'separator' },
        ...(!app.isPackaged ? [{ role: 'toggleDevTools' }] : []),
      ],
    },
  ]

  if (process.platform === 'darwin') {
    template.unshift({
      label: 'Canopy',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    })
  }

  const menu = Menu.buildFromTemplate(template)
  Menu.setApplicationMenu(menu)
}

module.exports = { buildMenu }
