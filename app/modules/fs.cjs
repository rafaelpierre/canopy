const fs = require('node:fs')
const path = require('node:path')

let projectRoot = null

function setProjectRoot(root) {
  if (!root) { projectRoot = null; return }
  try {
    projectRoot = fs.realpathSync(root)
  } catch {
    projectRoot = path.resolve(root)
  }
}

function getProjectRoot() {
  return projectRoot
}

function validatePath(userPath) {
  if (!projectRoot) throw new Error('No project root set')
  let resolved
  try {
    // realpathSync resolves symlinks, preventing escapes via symlinks inside the project
    resolved = fs.realpathSync(userPath)
  } catch {
    // File may not exist yet (e.g. new file being saved) — fall back to lexical resolve
    resolved = path.resolve(userPath)
  }
  if (!resolved.startsWith(projectRoot + path.sep) && resolved !== projectRoot) {
    throw new Error('Path outside project root')
  }
  return resolved
}

const { IGNORED_DIRS: IGNORED } = require('../constants.cjs')

async function readDirRecursive(dirPath, maxDepth, currentDepth) {
  if (currentDepth === undefined) currentDepth = 0
  let rawEntries
  try { rawEntries = await fs.promises.readdir(dirPath, { withFileTypes: true }) } catch { return [] }

  const entryPromises = rawEntries
    .filter(e => !IGNORED.has(e.name))
    .map(async e => {
      const fullPath = path.join(dirPath, e.name)
      const isDir = e.isDirectory()
      let children = null
      if (isDir && currentDepth < maxDepth) {
        children = await readDirRecursive(fullPath, maxDepth, currentDepth + 1)
      } else if (isDir) {
        children = []
      }
      return { name: e.name, path: fullPath, is_dir: isDir, children }
    })

  const entries = await Promise.all(entryPromises)

  entries.sort((a, b) => {
    if (a.is_dir && !b.is_dir) return -1
    if (!a.is_dir && b.is_dir) return 1
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  })

  return entries
}

/** Recursively collect all .py file paths under a directory (async, concurrent siblings). */
async function listPyFiles(dir, results, depth) {
  if (depth > 12) return
  let entries
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }
  const subdirs = []
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      subdirs.push(listPyFiles(full, results, depth + 1))
    } else if (entry.name.endsWith('.py')) {
      results.push(full)
    }
  }
  await Promise.all(subdirs)
}

/** Recursively search file contents for a query string (async, non-blocking). */
async function grepFiles(dir, query, glob, results, depth) {
  if (depth > 8 || results.length >= 100) return
  let entries
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { return }

  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue
    if (results.length >= 100) return
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      await grepFiles(full, query, glob, results, depth + 1)
    } else {
      // Apply glob filter (simple extension match: "*.py", "*.{js,ts}")
      if (glob) {
        const exts = glob.replace(/^\*\./, '').replace(/[{}]/g, '').split(',').map(e => '.' + e.trim())
        if (!exts.some(ext => full.endsWith(ext))) continue
      }

      // Skip binary / large files
      let stat
      try { stat = await fs.promises.stat(full) } catch { continue }
      if (stat.size > 512 * 1024) continue

      let content
      try { content = await fs.promises.readFile(full, 'utf-8') } catch { continue }

      const lowerQuery = query.toLowerCase()
      const lines = content.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(lowerQuery)) {
          results.push({ path: full, line: i + 1, text: lines[i] })
          if (results.length >= 100) return
        }
      }
    }
  }
}

// Map of absolute path → { watcher, debounce }
const fileWatchers = new Map()
// Content we last wrote for each path — used to suppress our own-write watcher events
const lastWrittenContent = new Map()

function registerFsHandlers(ipcMain, mainWindow) {
  ipcMain.handle('set_project_root', (_event, args) => {
    setProjectRoot(args.root)
  })

  ipcMain.handle('watch_file', (_event, args) => {
    let safePath
    try { safePath = validatePath(args.path) } catch { return }
    if (fileWatchers.has(safePath)) return
    // SEC-4: reject symlinks before installing the watcher to prevent symlink-swap attacks
    try {
      const lstat = fs.lstatSync(safePath)
      if (lstat.isSymbolicLink()) return
    } catch { return }
    const entry = { watcher: null, debounce: null }
    try {
      entry.watcher = fs.watch(safePath, { persistent: false }, () => {
        if (entry.debounce) clearTimeout(entry.debounce)
        entry.debounce = setTimeout(async () => {
          // Guard: skip files larger than 5 MB to avoid flooding the renderer heap
          let stat
          try { stat = await fs.promises.stat(safePath) } catch { return }
          if (stat.size > 5 * 1024 * 1024) return

          // Read disk content and compare with what we last wrote.
          // Suppresses events from our own auto-save writes.
          let diskContent
          try { diskContent = await fs.promises.readFile(safePath, 'utf-8') } catch { return }
          const ours = lastWrittenContent.get(safePath)
          if (ours !== undefined && diskContent === ours) return  // our own write, ignore
          mainWindow?.webContents?.send('file:changed-on-disk', { path: safePath, diskContent })
        }, 150)
      })
      entry.watcher.on('error', () => fileWatchers.delete(safePath))
      fileWatchers.set(safePath, entry)
    } catch { /* file may not exist */ }
  })

  ipcMain.handle('unwatch_file', (_event, args) => {
    let safePath
    try { safePath = validatePath(args.path) } catch { return }
    const entry = fileWatchers.get(safePath)
    if (!entry) return
    if (entry.debounce) clearTimeout(entry.debounce)
    try { entry.watcher?.close() } catch { }
    fileWatchers.delete(safePath)
    lastWrittenContent.delete(safePath)  // free retained content string
  })

  ipcMain.handle('read_dir_recursive', async (_event, args) => {
    const safePath = validatePath(args.path)
    return readDirRecursive(safePath, args.depth)
  })

  ipcMain.handle('read_file_content', async (_event, args) => {
    const safePath = validatePath(args.path)
    return await fs.promises.readFile(safePath, 'utf-8')
  })

  ipcMain.handle('write_file_content', async (_event, args) => {
    const safePath = validatePath(args.path)
    await fs.promises.writeFile(safePath, args.content)
    lastWrittenContent.set(safePath, args.content)
  })

  ipcMain.handle('list_py_files', async (_event, args) => {
    const safeRoot = validatePath(args.root)
    const results = []
    await listPyFiles(safeRoot, results, 0)
    return results
  })

  ipcMain.handle('grep_files', async (_event, args) => {
    const safeRoot = validatePath(args.root)
    const results = []
    await grepFiles(safeRoot, args.query, args.glob || null, results, 0)
    return results
  })

  // Watch the entire project root for file system changes (tree auto-refresh)
  let projectDirWatcher = null
  let projectDirDebounce = null
  ipcMain.handle('watch_project', (_event, args) => {
    if (projectDirWatcher) { try { projectDirWatcher.close() } catch {} projectDirWatcher = null }
    if (!args?.root) return
    let safePath
    try { safePath = validatePath(args.root) } catch { return }
    try {
      projectDirWatcher = fs.watch(safePath, { persistent: false, recursive: true }, () => {
        if (projectDirDebounce) clearTimeout(projectDirDebounce)
        projectDirDebounce = setTimeout(() => {
          projectDirDebounce = null
          mainWindow?.webContents?.send('dir:changed', { root: safePath })
        }, 300)
      })
      projectDirWatcher.on('error', () => { projectDirWatcher = null })
    } catch {}
  })

  ipcMain.handle('unwatch_project', () => {
    if (projectDirDebounce) { clearTimeout(projectDirDebounce); projectDirDebounce = null }
    if (projectDirWatcher) { try { projectDirWatcher.close() } catch {} projectDirWatcher = null }
  })

  ipcMain.handle('create_file', async (_event, args) => {
    const safePath = validatePath(args.path)
    // Must not already exist
    if (fs.existsSync(safePath)) throw new Error('File already exists')
    await fs.promises.mkdir(path.dirname(safePath), { recursive: true })
    await fs.promises.writeFile(safePath, '')
  })

  ipcMain.handle('create_dir', async (_event, args) => {
    const safePath = validatePath(args.path)
    await fs.promises.mkdir(safePath, { recursive: true })
  })

  ipcMain.handle('delete_path', async (_event, args) => {
    const safePath = validatePath(args.path)
    await fs.promises.rm(safePath, { recursive: true, force: true })
  })

  ipcMain.handle('rename_path', async (_event, args) => {
    const safeSrc = validatePath(args.src)
    const safeDst = validatePath(args.dst)
    await fs.promises.rename(safeSrc, safeDst)
  })

  // Watch the project root directory for .venv creation.
  // Fires 'venv:created' when a known venv directory appears.
  let venvDirWatcher = null
  ipcMain.handle('watch_for_venv', (_event, args) => {
    if (venvDirWatcher) { try { venvDirWatcher.close() } catch {} venvDirWatcher = null }
    if (!args?.root) return
    const { VENV_NAMES } = require('../constants.cjs')
    let safePath
    try { safePath = validatePath(args.root) } catch { return }
    try {
      venvDirWatcher = fs.watch(safePath, { persistent: false }, (_evt, filename) => {
        if (!filename || !VENV_NAMES.includes(filename)) return
        const venvPath = path.join(safePath, filename)
        if (!fs.existsSync(venvPath)) return
        // Find a python binary inside it
        for (const bin of ['python', 'python3']) {
          const pythonBin = path.join(venvPath, 'bin', bin)
          if (fs.existsSync(pythonBin)) {
            mainWindow?.webContents?.send('venv:created', { root: safePath, pythonPath: pythonBin })
            return
          }
        }
      })
      venvDirWatcher.on('error', () => { venvDirWatcher = null })
    } catch {}
  })
}

module.exports = { registerFsHandlers, setProjectRoot, getProjectRoot }
