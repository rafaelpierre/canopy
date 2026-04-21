const { app, BrowserWindow, ipcMain, dialog, protocol, nativeTheme, session } = require('electron')
const path = require('path')
const fs = require('fs')

// Force dark mode for the entire app (title bar, scrollbars, etc.)
nativeTheme.themeSource = 'dark'

// Force GTK dark theme on Linux so the title bar matches
if (process.platform === 'linux') {
  process.env.GTK_THEME = process.env.GTK_THEME || 'Adwaita:dark'
}

let mainWindow = null
let handlersRegistered = false
let forceQuit  = false
let quitPending = false

const MIME_TYPES = {
  '.html': 'text/html',
  '.js':   'text/javascript',
  '.mjs':  'text/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.ttf':  'font/ttf',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.wasm': 'application/wasm',
  '.map':  'application/json',
}

function createWindow() {
  // Reset quit-interception state so a re-created window starts clean
  forceQuit  = false
  quitPending = false

  const isDev = !app.isPackaged

  const isMac = process.platform === 'darwin'

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    center: true,
    backgroundColor: '#1c1c1c',
    // macOS: keep native traffic-light buttons but hide the bar background
    // Windows/Linux: remove native frame entirely — custom HTML menu bar handles controls
    ...(isMac ? { titleBarStyle: 'hiddenInset' } : { frame: false }),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
      partition: 'persist:canopy',
    },
  })

  if (!handlersRegistered) {
    const { registerFsHandlers, setProjectRoot } = require('./modules/fs.cjs')
    const { registerLspHandlers } = require('./modules/lsp.cjs')
    const { registerPtyHandlers, killAllPtys } = require('./modules/pty.cjs')
    const { registerPrefsHandlers } = require('./modules/prefs.cjs')
    const { registerSetupHandlers } = require('./modules/setup.cjs')

    registerFsHandlers(ipcMain, mainWindow)
    registerLspHandlers(ipcMain, mainWindow)
    registerPtyHandlers(ipcMain, mainWindow)
    registerPrefsHandlers(ipcMain)
    registerSetupHandlers(ipcMain)

    ipcMain.handle('window_minimize', () => BrowserWindow.getFocusedWindow()?.minimize())
    ipcMain.handle('window_maximize', () => {
      const w = BrowserWindow.getFocusedWindow()
      w?.isMaximized() ? w.unmaximize() : w?.maximize()
    })
    ipcMain.handle('window_close', () => {
      if (!quitPending) {
        quitPending = true
        BrowserWindow.getFocusedWindow()?.webContents?.send('app:before-quit')
      }
    })

    // Intercept Cmd+Q / app.quit() — registered once
    app.on('before-quit', (e) => {
      if (forceQuit) return
      e.preventDefault()
      if (!quitPending) {
        quitPending = true
        BrowserWindow.getAllWindows()[0]?.webContents?.send('app:before-quit')
      }
    })

    ipcMain.handle('app:confirm-quit', () => {
      killAllPtys()
      forceQuit = true
      BrowserWindow.getAllWindows()[0]?.destroy()
    })
    ipcMain.handle('app:cancel-quit', () => {
      quitPending = false
    })

    ipcMain.handle('dialog:openFolder', async () => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory'],
        title: 'Open Project Folder',
      })
      if (result.canceled || result.filePaths.length === 0) return null
      setProjectRoot(result.filePaths[0])
      return result.filePaths[0]
    })

    ipcMain.handle('dialog:openFile', async (_event, options) => {
      const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        title: (options && options.title) || 'Select File',
        filters: options && options.filters,
      })
      if (result.canceled || result.filePaths.length === 0) return null
      return result.filePaths[0]
    })

    handlersRegistered = true
  }

  // Intercept window close button — ask renderer to check for unsaved changes
  mainWindow.on('close', (e) => {
    if (forceQuit) return
    e.preventDefault()
    if (!quitPending) {
      quitPending = true
      mainWindow.webContents.send('app:before-quit')
    }
  })

  // If the renderer crashes while a quit dialog is open, reset state so the
  // user can still close the (now-reloaded) window normally next time.
  mainWindow.webContents.on('render-process-gone', () => {
    forceQuit  = false
    quitPending = false
  })

  const { buildMenu } = require('./modules/menu.cjs')
  buildMenu(mainWindow)

  // Block renderer-triggered navigations to arbitrary URLs
  const allowedOrigin = isDev ? 'http://localhost:1420' : 'app://bundle'
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(allowedOrigin)) {
      event.preventDefault()
      console.warn('[security] blocked navigation to', url)
    }
  })
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))

  if (isDev) {
    mainWindow.loadURL('http://localhost:1420')
  } else {
    // On first launch with a fresh persist:canopy session, the protocol
    // handler may not be ready yet. Retry on failure.
    const prodURL = 'app://bundle/'
    mainWindow.webContents.on('did-fail-load', (_event, code, desc) => {
      console.error(`Failed to load ${prodURL}: ${code} ${desc} — retrying in 500ms`)
      setTimeout(() => mainWindow.loadURL(prodURL), 500)
    })
    mainWindow.loadURL(prodURL)
  }
}

// Register custom protocol before app is ready
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }
])

const CSP = "default-src 'self' app:; script-src 'self' app: 'unsafe-inline' 'wasm-unsafe-eval' blob:; style-src 'self' app: 'unsafe-inline'; worker-src blob: app:; connect-src 'self' app:; img-src 'self' data:; font-src 'self';"

app.whenReady().then(() => {
  const buildDir = path.join(__dirname, '..', 'build')

  const handleAppProtocol = async (request) => {
    const requestUrl = new URL(request.url)
    let pathname = decodeURIComponent(requestUrl.pathname)
    // SPA: serve index.html for any path without a file extension
    if (pathname === '/' || pathname === '' || !path.extname(pathname)) {
      pathname = '/index.html'
    }

    const filePath = path.resolve(path.join(buildDir, pathname))

    // Prevent path traversal outside the build directory
    const resolvedBuild = path.resolve(buildDir)
    if (!filePath.startsWith(resolvedBuild + path.sep) && filePath !== resolvedBuild) {
      console.error('[protocol] blocked path traversal:', filePath)
      return new Response('Forbidden', { status: 403 })
    }

    // Hashed assets under _app/immutable/ never change — cache forever
    const isImmutable = pathname.startsWith('/_app/immutable/')
    const cacheControl = isImmutable
      ? 'public, max-age=31536000, immutable'
      : 'no-cache'

    try {
      const data = await fs.promises.readFile(filePath)
      const ext = path.extname(filePath).toLowerCase()
      const mimeType = MIME_TYPES[ext] || 'application/octet-stream'
      return new Response(data, {
        headers: {
          'Content-Type': mimeType,
          'Cache-Control': cacheControl,
          'Content-Security-Policy': CSP,
        },
      })
    } catch (e) {
      // Fallback to index.html for SPA routing
      try {
        const data = await fs.promises.readFile(path.join(buildDir, 'index.html'))
        return new Response(data, {
          headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' },
        })
      } catch (e2) {
        return new Response('Not Found', { status: 404 })
      }
    }
  }

  const persistSession = session.fromPartition('persist:canopy')
  persistSession.protocol.handle('app', handleAppProtocol)

  createWindow()
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
