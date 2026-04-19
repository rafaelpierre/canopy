const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const { safeEnvObject } = require('../constants.cjs')
const { canopyLspDir, which, findBinary } = require('../utils.cjs')

let lspProcess = null
let lspStdin = null

// Well-known LSP binary names that may be resolved via PATH
const KNOWN_LSP_BINARIES = new Set(['basedpyright-langserver', 'ty'])

// Allowed spawn arguments per binary — never accept renderer-supplied args directly
const ALLOWED_LSP_ARGS = {
  'basedpyright-langserver': ['--stdio'],
  'ty': ['server'],
}

function validateLangserverPath(langserverPath) {
  if (!langserverPath) return null

  // Allow any well-known binary name — resolve via PATH + known locations
  if (KNOWN_LSP_BINARIES.has(langserverPath)) {
    return findBinary(langserverPath)
  }

  const resolved = path.resolve(langserverPath)

  // Allow absolute paths that resolve to a known binary
  for (const name of KNOWN_LSP_BINARIES) {
    const bin = findBinary(name)
    if (bin && resolved === path.resolve(bin)) return resolved
  }

  // Allow paths under the canopy LSP install directory
  const lspDir = path.resolve(canopyLspDir())
  if (resolved.startsWith(lspDir + path.sep)) {
    if (fs.existsSync(resolved)) return resolved
  }

  throw new Error('Langserver path not allowed: ' + langserverPath)
}

function readLspMessages(stdout, onMessage) {
  let buffer = Buffer.alloc(0)

  stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])

    while (true) {
      const separatorIdx = buffer.indexOf('\r\n\r\n')
      if (separatorIdx === -1) break

      const headerStr = buffer.subarray(0, separatorIdx).toString('utf-8')
      let contentLength = 0
      for (const line of headerStr.split('\r\n')) {
        const match = line.match(/^Content-Length:\s*(\d+)$/i)
        if (match) contentLength = parseInt(match[1], 10)
      }

      if (contentLength === 0) {
        buffer = buffer.subarray(separatorIdx + 4)
        continue
      }

      const MAX_LSP_MESSAGE = 10 * 1024 * 1024  // 10 MB
      if (contentLength > MAX_LSP_MESSAGE) {
        console.error('[LSP] oversized message (' + contentLength + ' bytes), closing connection')
        stdout.destroy()
        return
      }

      const bodyStart = separatorIdx + 4
      const totalNeeded = bodyStart + contentLength

      if (buffer.length < totalNeeded) break

      const body = buffer.subarray(bodyStart, totalNeeded).toString('utf-8')
      buffer = buffer.subarray(totalNeeded)

      onMessage(body)
    }
  })
}

function writeLspMessage(stdin, message) {
  const header = `Content-Length: ${Buffer.byteLength(message)}\r\n\r\n`
  stdin.write(header)
  stdin.write(message)
}

function registerLspHandlers(ipcMain, mainWindow) {
  const { getProjectRoot } = require('./fs.cjs')

  ipcMain.handle('lsp_start', (_event, args) => {
    const { rootPath, langserverPath, pythonPath } = args

    const trustedRoot = getProjectRoot()
    if (trustedRoot && path.resolve(rootPath) !== trustedRoot) {
      throw new Error('lsp_start: rootPath does not match project root')
    }

    if (lspProcess) {
      lspProcess.stdout.removeAllListeners()
      lspProcess.stderr.removeAllListeners()
      lspProcess.removeAllListeners()
      lspProcess.kill()
      lspProcess = null
      lspStdin = null
    }

    const langserver = validateLangserverPath(langserverPath) || findBinary('basedpyright-langserver')
    console.log('[LSP] resolved langserver:', langserver, 'from request:', langserverPath)
    if (!langserver) throw new Error(`LSP binary not found: ${langserverPath} (checked PATH + ~/.cargo/bin, ~/.local/bin, ~/.astral/bin, /opt/homebrew/bin)`)

    const binaryBasename = path.basename(langserver)
    const baseArgs = ALLOWED_LSP_ARGS[binaryBasename] ?? ['--stdio']

    let spawnArgs = baseArgs

    // If the langserver path is a .js file (installed from bundled wheels),
    // run it directly with Electron's Node.js — no need for nodejs-wheel-binaries.
    let spawnCmd, spawnEnv
    // For ty: inject VIRTUAL_ENV so it picks up the venv Python automatically.
    // ty doesn't accept --python; it discovers the interpreter via VIRTUAL_ENV.
    let extraEnv = {}
    if (binaryBasename === 'ty' && pythonPath) {
      try {
        const rawPath = path.isAbsolute(String(pythonPath)) ? String(pythonPath) : (findBinary(String(pythonPath)) ?? '')
        if (rawPath) {
          // SEC-5: resolve symlinks to prevent path traversal via crafted pythonPath
          const p = fs.realpathSync(rawPath)
          const venvRoot = path.dirname(path.dirname(p))
          if (fs.existsSync(path.join(venvRoot, 'pyvenv.cfg'))) {
            extraEnv = { VIRTUAL_ENV: venvRoot }
            console.log('[LSP] ty: VIRTUAL_ENV =', venvRoot)
          }
        }
      } catch (e) {
        console.warn('[LSP] ty: could not resolve pythonPath:', e.message)
      }
    }

    if (langserver.endsWith('.js')) {
      spawnCmd = process.execPath
      spawnArgs = [langserver, ...spawnArgs]
      spawnEnv = safeEnvObject({ ELECTRON_RUN_AS_NODE: '1', ...extraEnv })
    } else {
      spawnCmd = langserver
      spawnEnv = safeEnvObject(extraEnv)
    }

    lspProcess = spawn(spawnCmd, spawnArgs, {
      cwd: rootPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: spawnEnv,
    })

    lspStdin = lspProcess.stdin

    readLspMessages(lspProcess.stdout, (msg) => {
      mainWindow.webContents.send('lsp://message', msg)
    })

    lspProcess.stderr.on('data', (chunk) => {
      console.error('[LSP stderr]', chunk.toString())
    })

    lspProcess.on('error', (err) => {
      console.error('LSP process error:', err)
    })

    const thisProcess = lspProcess
    lspProcess.on('exit', (code, signal) => {
      if (lspProcess === thisProcess) {
        lspProcess = null
        lspStdin = null
        // Notify renderer so it can mark LSP as not ready
        try { mainWindow.webContents.send('lsp://exit', { code, signal }) } catch (_) {}
      }
    })
  })

  ipcMain.handle('lsp_send', (_event, args) => {
    if (!lspStdin) throw new Error('LSP not running')
    let parsed
    try { parsed = JSON.parse(args.message) } catch { throw new Error('lsp_send: invalid JSON') }
    if (parsed.jsonrpc !== '2.0') throw new Error('lsp_send: not JSON-RPC 2.0')
    writeLspMessage(lspStdin, args.message)
  })

  ipcMain.handle('lsp_stop', () => {
    if (lspProcess) {
      lspProcess.kill()
      lspProcess = null
      lspStdin = null
    }
  })

  // Check whether a binary is on PATH — returns the resolved path or null
  ipcMain.handle('lsp_which_binary', (_event, { name }) => {
    return which(name)
  })

  // Install a known tool via `uv tool install` — only whitelisted package names are accepted
  const INSTALLABLE_TOOLS = new Set(['basedpyright', 'ty'])
  ipcMain.handle('lsp_install_tool', (_event, { tool }) => {
    if (!INSTALLABLE_TOOLS.has(tool)) {
      return Promise.reject(new Error(`Tool not allowed: ${tool}`))
    }
    return new Promise((resolve, reject) => {
      const uvPath = which('uv')
      if (!uvPath) { reject(new Error('uv not found on PATH')); return }

      const proc = spawn(uvPath, ['tool', 'install', tool], {
        env: safeEnvObject({}),
        stdio: 'pipe',
      })
      proc.on('close', (code) => {
        if (code === 0) resolve(true)
        else reject(new Error(`uv tool install ${tool} exited with code ${code}`))
      })
      proc.on('error', reject)
    })
  })
}

module.exports = { registerLspHandlers }
