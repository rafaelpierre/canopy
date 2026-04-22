const os = require('node:os')
const path = require('node:path')
const pty = require('node-pty-prebuilt-multiarch')
const { safeEnvObject } = require('../constants.cjs')

// Map of tab id → pty process. Replaces the previous singleton.
const ptyProcesses = new Map()
// Generation counter per id — incremented each time a PTY is (re)spawned for that id.
// Each onExit closure captures its own generation; stale exits from killed-and-replaced
// PTYs are ignored when their generation no longer matches the current one.
const ptyGenerations = new Map()

function registerPtyHandlers(ipcMain, mainWindow) {
  ipcMain.handle('pty_spawn', (_event, args) => {
    const { getProjectRoot } = require('./fs.cjs')
    const trustedRoot = getProjectRoot()
    const { id, cwd, cols, rows } = args
    if (id === undefined || id === null) throw new Error('pty_spawn: id is required')

    const resolvedCwd = cwd ? path.resolve(cwd) : null
    const safeCwd = (resolvedCwd && trustedRoot &&
      (resolvedCwd === trustedRoot || resolvedCwd.startsWith(trustedRoot + path.sep)))
      ? resolvedCwd
      : (trustedRoot || os.homedir())
    const safeCols = Math.max(1, Math.min(cols || 80, 500))
    const safeRows = Math.max(1, Math.min(rows || 24, 500))

    // Kill any existing process for this id before spawning a new one
    const existing = ptyProcesses.get(id)
    if (existing) {
      existing.kill()
      ptyProcesses.delete(id)
    }

    // Bump the generation so any pending onExit from the old proc is silently dropped
    const gen = (ptyGenerations.get(id) ?? 0) + 1
    ptyGenerations.set(id, gen)

    // Read preferred shell from prefs if set, fall back to $SHELL or bash
    let shell = process.env.SHELL || '/bin/bash'
    try {
      const { getPrefs } = require('./prefs.cjs')
      const prefs = getPrefs()
      if (prefs.preferred_shell && typeof prefs.preferred_shell === 'string' &&
          require('node:path').isAbsolute(prefs.preferred_shell) &&
          require('node:fs').existsSync(prefs.preferred_shell)) {
        shell = prefs.preferred_shell
      }
    } catch {}
    const safeEnv = safeEnvObject({ TERM: 'xterm-256color' })

    const proc = pty.spawn(shell, ['-l'], {
      name: 'xterm-256color',
      cols: safeCols,
      rows: safeRows,
      cwd: safeCwd,
      env: safeEnv,
    })

    ptyProcesses.set(id, proc)

    // Batch data chunks arriving in the same I/O cycle to reduce IPC round-trips.
    // setImmediate fires after the current I/O phase with no fixed delay, so
    // interactive typing feels instant while high-throughput output is coalesced.
    let pendingData = ''
    let flushScheduled = false
    proc.onData((data) => {
      if (mainWindow.isDestroyed()) return
      pendingData += data
      if (!flushScheduled) {
        flushScheduled = true
        setImmediate(() => {
          if (pendingData && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('pty:data', { id, data: Buffer.from(pendingData) })
          }
          pendingData = ''
          flushScheduled = false
        })
      }
    })

    proc.onExit(() => {
      // Ignore stale exits from PTYs that were already replaced by a newer spawn
      if (ptyGenerations.get(id) !== gen) return
      ptyProcesses.delete(id)
      ptyGenerations.delete(id)
      if (mainWindow.isDestroyed()) return
      mainWindow.webContents.send('pty:exit', { id })
    })
  })

  ipcMain.handle('pty_write', (_event, args) => {
    const { id, data } = args
    if (typeof data !== 'string') throw new Error('pty_write: data must be a string')
    const proc = ptyProcesses.get(id)
    if (!proc) throw new Error(`PTY not running (id=${id})`)
    proc.write(data)
  })

  ipcMain.handle('pty_resize', (_event, args) => {
    const { id, cols, rows } = args
    if (typeof id !== 'number' && typeof id !== 'string') throw new Error('pty_resize: invalid id')
    const proc = ptyProcesses.get(id)
    if (!proc) throw new Error(`PTY not running (id=${id})`)
    proc.resize(
      Math.max(1, Math.min(cols || 80, 500)),
      Math.max(1, Math.min(rows || 24, 500))
    )
  })

  ipcMain.handle('pty_kill', (_event, args) => {
    const id = args?.id
    if (id === undefined || id === null || id === 'all') {
      // Kill every active PTY — SIGTERM avoids SIGHUP propagation to sibling process groups on Linux
      for (const [, proc] of ptyProcesses) { try { proc.kill('SIGTERM') } catch {} }
      ptyProcesses.clear()
      ptyGenerations.clear()
    } else {
      const proc = ptyProcesses.get(id)
      if (proc) {
        try { proc.kill('SIGTERM') } catch {}
        ptyProcesses.delete(id)
        ptyGenerations.delete(id)
      }
    }
  })
}

function killAllPtys() {
  for (const [, proc] of ptyProcesses) {
    try { proc.kill() } catch (_) {}
  }
  ptyProcesses.clear()
}

module.exports = { registerPtyHandlers, killAllPtys }
