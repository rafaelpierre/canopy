const { Menu, app } = require('electron')

function buildMenu(mainWindow) {
  // Linux/Windows: no native menu — HTML MenuBar handles everything
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }

  const send = (action) => mainWindow.webContents.send('menu:action', action)

  const template = [
    {
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
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => send('open_folder') },
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
        {
          label: 'Toggle File Tree',
          accelerator: 'CmdOrCtrl+B',
          click: () => send('toggle_file_tree'),
        },
        {
          label: 'Toggle Terminal',
          accelerator: 'CmdOrCtrl+J',
          click: () => send('toggle_terminal'),
        },
        {
          label: 'Refresh Workspace',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => send('refresh_workspace'),
        },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => send('zoom_in') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => send('zoom_out') },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => send('zoom_reset') },
        { type: 'separator' },
        { label: 'Go to File', accelerator: 'CmdOrCtrl+P', click: () => send('command_palette') },
        {
          label: 'Command Palette',
          accelerator: 'CmdOrCtrl+Shift+P',
          click: () => send('command_palette_commands'),
        },
      ],
    },
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'New Terminal Tab',
          accelerator: 'CmdOrCtrl+T',
          click: () => send('new_terminal_tab'),
        },
        { label: 'Split Terminal', click: () => send('split_terminal') },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }],
    },
    ...(!app.isPackaged
      ? [
          {
            label: 'Debug',
            submenu: [{ role: 'toggleDevTools', accelerator: 'CommandOrControl+Shift+I' }],
          },
        ]
      : []),
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

module.exports = { buildMenu }
