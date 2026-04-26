const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execFileAsync = promisify(execFile)
const { safeEnvObject } = require('../constants.cjs')
const {
  FILE_WATCH_DEBOUNCE_MS,
  PROJECT_WATCH_DEBOUNCE_MS,
  SITE_PKG_POLL_MS,
} = require('../timing.cjs')

// Cache sys.path results per interpreter — these don't change between calls
const _pythonPathsCache = new Map()

let projectRoot = null

function setProjectRoot(root) {
  if (!root) {
    projectRoot = null
    return
  }
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
  try {
    rawEntries = await fs.promises.readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }

  const entryPromises = rawEntries
    .filter((e) => !IGNORED.has(e.name))
    .map(async (e) => {
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
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
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
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }

  const subdirs = []
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue
    if (results.length >= 100) return
    const full = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      subdirs.push(grepFiles(full, query, glob, results, depth + 1))
    } else {
      // Apply glob filter (simple extension match: "*.py", "*.{js,ts}")
      if (glob) {
        const exts = glob
          .replace(/^\*\./, '')
          .replace(/[{}]/g, '')
          .split(',')
          .map((e) => '.' + e.trim())
        if (!exts.some((ext) => full.endsWith(ext))) continue
      }

      // Skip binary / large files
      let stat
      try {
        stat = await fs.promises.stat(full)
      } catch {
        continue
      }
      if (stat.size > 512 * 1024) continue

      let content
      try {
        content = await fs.promises.readFile(full, 'utf-8')
      } catch {
        continue
      }

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
  if (subdirs.length > 0) await Promise.all(subdirs)
}

// Map of absolute path → { watcher, debounce }
const fileWatchers = new Map()
// Content we last wrote for each path — used to suppress our own-write watcher events
const lastWrittenContent = new Map()

// Direct LSP/tree notification helpers — used by FS-mutating IPCs so editor
// actions are reflected instantly (and reliably on NFS, where fs.watch is
// flaky). LSP file change types per spec: 1=Created, 2=Changed, 3=Deleted.
function _fileUri(p) {
  return 'file://' + p
}

function registerFsHandlers(ipcMain, mainWindow) {
  function notifyLsp(changes) {
    if (!changes.length) return
    mainWindow?.webContents?.send(
      'lsp:watched-files-changed',
      changes.map((c) => ({ uri: _fileUri(c.path), type: c.type })),
    )
  }
  function notifyDirChanged() {
    const root = projectRoot
    if (root) mainWindow?.webContents?.send('dir:changed', { root })
  }

  ipcMain.handle('set_project_root', (_event, args) => {
    setProjectRoot(args.root)
  })

  ipcMain.handle('watch_file', (_event, args) => {
    let safePath
    try {
      safePath = validatePath(args.path)
    } catch {
      return
    }
    if (fileWatchers.has(safePath)) return
    // SEC-4: reject symlinks before installing the watcher to prevent symlink-swap attacks
    try {
      const lstat = fs.lstatSync(safePath)
      if (lstat.isSymbolicLink()) return
    } catch {
      return
    }
    const entry = { watcher: null, debounce: null }
    try {
      entry.watcher = fs.watch(safePath, { persistent: false }, () => {
        if (entry.debounce) clearTimeout(entry.debounce)
        entry.debounce = setTimeout(async () => {
          // Guard: skip files larger than 5 MB to avoid flooding the renderer heap
          let stat
          try {
            stat = await fs.promises.stat(safePath)
          } catch {
            return
          }
          if (stat.size > 5 * 1024 * 1024) return

          // Read disk content and compare with what we last wrote.
          // Suppresses events from our own auto-save writes.
          let diskContent
          try {
            diskContent = await fs.promises.readFile(safePath, 'utf-8')
          } catch {
            return
          }
          const ours = lastWrittenContent.get(safePath)
          if (ours !== undefined && diskContent === ours) return // our own write, ignore
          mainWindow?.webContents?.send('file:changed-on-disk', { path: safePath, diskContent })
        }, FILE_WATCH_DEBOUNCE_MS)
      })
      entry.watcher.on('error', () => fileWatchers.delete(safePath))
      fileWatchers.set(safePath, entry)
    } catch {
      /* file may not exist */
    }
  })

  ipcMain.handle('unwatch_file', (_event, args) => {
    let safePath
    try {
      safePath = validatePath(args.path)
    } catch {
      return
    }
    const entry = fileWatchers.get(safePath)
    if (!entry) return
    if (entry.debounce) clearTimeout(entry.debounce)
    try {
      entry.watcher?.close()
    } catch {}
    fileWatchers.delete(safePath)
    lastWrittenContent.delete(safePath) // free retained content string
  })

  ipcMain.handle('read_dir_recursive', async (_event, args) => {
    const safePath = validatePath(args.path)
    return readDirRecursive(safePath, args.depth)
  })

  ipcMain.handle('read_file_content', async (_event, args) => {
    const safePath = validatePath(args.path)
    const stat = await fs.promises.stat(safePath)
    if (stat.size > 10 * 1024 * 1024) throw new Error('File too large to open in editor (>10 MB)')
    return await fs.promises.readFile(safePath, 'utf-8')
  })

  ipcMain.handle('write_file_content', async (_event, args) => {
    if (typeof args.content !== 'string' || args.content.length > 20_000_000)
      throw new Error('Content too large')
    const safePath = validatePath(args.path)
    await fs.promises.writeFile(safePath, args.content)
    lastWrittenContent.set(safePath, args.content)
    notifyLsp([{ path: safePath, type: 2 }])
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

  // Watch the entire project root for file system changes (tree auto-refresh + LSP file watching)
  let projectDirWatcher = null
  let projectDirDebounce = null
  let lastWatchedFile = null
  ipcMain.handle('watch_project', (_event, args) => {
    if (projectDirWatcher) {
      try {
        projectDirWatcher.close()
      } catch {}
      projectDirWatcher = null
    }
    if (!args?.root) return
    let safePath
    try {
      safePath = validatePath(args.root)
    } catch {
      return
    }
    try {
      projectDirWatcher = fs.watch(
        safePath,
        { persistent: false, recursive: true },
        (eventType, filename) => {
          if (filename) lastWatchedFile = { eventType, filename }
          if (projectDirDebounce) clearTimeout(projectDirDebounce)
          projectDirDebounce = setTimeout(() => {
            projectDirDebounce = null
            mainWindow?.webContents?.send('dir:changed', { root: safePath })
            if (lastWatchedFile) {
              const { eventType: et, filename: fn } = lastWatchedFile
              lastWatchedFile = null
              const fullPath = path.join(safePath, fn)
              let type = 2 // changed
              if (et === 'rename') type = fs.existsSync(fullPath) ? 1 : 3 // created or deleted
              mainWindow?.webContents?.send('lsp:watched-files-changed', [
                { uri: 'file://' + fullPath, type },
              ])
            }
          }, PROJECT_WATCH_DEBOUNCE_MS)
        },
      )
      projectDirWatcher.on('error', () => {
        projectDirWatcher = null
      })
    } catch {}
  })

  // Force a tree reload + LSP rescan (manual Refresh Workspace).
  ipcMain.handle('refresh_project', () => {
    notifyDirChanged()
  })

  ipcMain.handle('unwatch_project', () => {
    if (projectDirDebounce) {
      clearTimeout(projectDirDebounce)
      projectDirDebounce = null
    }
    if (projectDirWatcher) {
      try {
        projectDirWatcher.close()
      } catch {}
      projectDirWatcher = null
    }
  })

  ipcMain.handle('create_file', async (_event, args) => {
    const safePath = validatePath(args.path)
    if (fs.existsSync(safePath)) throw new Error('File already exists')
    await fs.promises.mkdir(path.dirname(safePath), { recursive: true })
    await fs.promises.writeFile(safePath, '')
    notifyLsp([{ path: safePath, type: 1 }])
    notifyDirChanged()
  })

  ipcMain.handle('create_dir', async (_event, args) => {
    const safePath = validatePath(args.path)
    await fs.promises.mkdir(safePath, { recursive: true })
    notifyDirChanged()
  })

  ipcMain.handle('delete_path', async (_event, args) => {
    const safePath = validatePath(args.path)
    // Walk BEFORE delete so we can name every removed .py file in the LSP notification.
    let stat
    try {
      stat = await fs.promises.stat(safePath)
    } catch {
      stat = null
    }
    const pyPaths = []
    if (stat?.isDirectory()) await listPyFiles(safePath, pyPaths, 0)
    else if (safePath.endsWith('.py')) pyPaths.push(safePath)
    await fs.promises.rm(safePath, { recursive: true, force: true })
    notifyLsp(pyPaths.map((p) => ({ path: p, type: 3 })))
    notifyDirChanged()
  })

  ipcMain.handle('rename_path', async (_event, args) => {
    const safeSrc = validatePath(args.src)
    const safeDst = validatePath(args.dst)
    let stat
    try {
      stat = await fs.promises.stat(safeSrc)
    } catch {
      stat = null
    }
    const srcPyPaths = []
    if (stat?.isDirectory()) await listPyFiles(safeSrc, srcPyPaths, 0)
    else if (safeSrc.endsWith('.py')) srcPyPaths.push(safeSrc)
    await fs.promises.rename(safeSrc, safeDst)
    const changes = []
    for (const p of srcPyPaths) {
      changes.push({ path: p, type: 3 })
      changes.push({ path: safeDst + p.slice(safeSrc.length), type: 1 })
    }
    notifyLsp(changes)
    notifyDirChanged()
  })

  // Watch for .venv creation at any depth (recursive=true) or just the root dir.
  // Fires 'venv:created' once per venv when a python binary becomes available.
  let venvDirWatcher = null
  // Track venv paths already reported so rapid file events don't spam the renderer.
  const venvCreatedSent = new Set()
  ipcMain.handle('watch_for_venv', (_event, args) => {
    if (venvDirWatcher) {
      try {
        venvDirWatcher.close()
      } catch {}
      venvDirWatcher = null
    }
    venvCreatedSent.clear()
    if (!args?.root) return
    const { VENV_NAMES } = require('../constants.cjs')
    const recursive = args.recursive === true
    let safePath
    try {
      safePath = validatePath(args.root)
    } catch (e) {
      console.warn('[FS] watch_for_venv validatePath failed:', e?.message)
      return
    }
    console.log('[FS] watch_for_venv started on', safePath, recursive ? '(recursive)' : '')
    try {
      venvDirWatcher = fs.watch(safePath, { persistent: false, recursive }, (_evt, filename) => {
        if (!filename) return
        ;(async () => {
          // Normalize separator — macOS uses '/' even when path.sep is '/'
          const parts = filename.split(/[\\/]/)
          const venvIdx = parts.findIndex((p) => VENV_NAMES.includes(p))
          if (venvIdx === -1) return
          const venvAbsPath = path.join(safePath, ...parts.slice(0, venvIdx + 1))
          if (venvCreatedSent.has(venvAbsPath)) return // already reported this venv
          const ownerDir = recursive ? path.dirname(venvAbsPath) : safePath
          for (const bin of ['python3', 'python']) {
            const pythonBin = path.join(venvAbsPath, 'bin', bin)
            try {
              await fs.promises.access(pythonBin)
              console.log('[FS] venv:created ->', pythonBin)
              venvCreatedSent.add(venvAbsPath)
              mainWindow?.webContents?.send('venv:created', {
                root: ownerDir,
                pythonPath: pythonBin,
                venvPath: venvAbsPath,
              })
              return
            } catch {}
          }
          const winBin = path.join(venvAbsPath, 'Scripts', 'python.exe')
          try {
            await fs.promises.access(winBin)
            console.log('[FS] venv:created (win) ->', winBin)
            venvCreatedSent.add(venvAbsPath)
            mainWindow?.webContents?.send('venv:created', {
              root: ownerDir,
              pythonPath: winBin,
              venvPath: venvAbsPath,
            })
          } catch {}
        })()
      })
      venvDirWatcher.on('error', (e) => {
        console.warn('[FS] venvDirWatcher error:', e?.message)
        venvDirWatcher = null
      })
    } catch (e) {
      console.warn('[FS] watch_for_venv fs.watch failed:', e?.message)
    }
  })

  // Return all non-empty absolute entries in sys.path for the given Python interpreter.
  // Python binaries live outside the project root so we validate by existence, not root membership.
  ipcMain.handle('get_python_paths', async (_event, args) => {
    const pythonBin = args?.pythonPath
    if (typeof pythonBin !== 'string' || !path.isAbsolute(pythonBin)) return []
    if (_pythonPathsCache.has(pythonBin)) return _pythonPathsCache.get(pythonBin)
    try {
      if (!(await fs.promises.stat(pythonBin)).isFile()) return []
    } catch {
      return []
    }
    try {
      const { stdout } = await execFileAsync(
        pythonBin,
        ['-c', 'import sys,json;print(json.dumps([p for p in sys.path if p]))'],
        { timeout: 5000, env: safeEnvObject({}) },
      )
      const paths = JSON.parse(stdout.trim())
      const result = Array.isArray(paths)
        ? paths.filter((p) => typeof p === 'string' && path.isAbsolute(p))
        : []
      _pythonPathsCache.set(pythonBin, result)
      return result
    } catch {
      return []
    }
  })

  // Return { mtime, entryCount } for a directory — composite fingerprint for venv scan cache.
  ipcMain.handle('dir_mtime', async (_event, args) => {
    const dirPath = args?.path
    if (typeof dirPath !== 'string' || !path.isAbsolute(dirPath)) return null
    const trustedRoot = getProjectRoot()
    const resolved = path.resolve(dirPath)
    if (trustedRoot && resolved !== trustedRoot && !resolved.startsWith(trustedRoot + path.sep))
      return null
    try {
      const [stat, entries] = await Promise.all([
        fs.promises.stat(resolved),
        fs.promises.readdir(resolved),
      ])
      if (!stat.isDirectory()) return null
      return { mtime: stat.mtimeMs, entryCount: entries.length }
    } catch {
      return null
    }
  })

  // List a directory that's known to be under one of the caller's Python search paths.
  // The caller passes the roots it received from get_python_paths; we re-validate here.
  ipcMain.handle('list_python_dir', async (_event, args) => {
    const { dirPath, roots } = args || {}
    if (typeof dirPath !== 'string' || !path.isAbsolute(dirPath)) return []
    if (!Array.isArray(roots) || roots.length === 0) return []
    const resolved = path.resolve(dirPath)
    const allowed = roots.some((r) => {
      if (typeof r !== 'string' || !path.isAbsolute(r)) return false
      const nr = path.resolve(r)
      return resolved === nr || resolved.startsWith(nr + path.sep)
    })
    if (!allowed) return []
    try {
      const entries = await fs.promises.readdir(resolved, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, is_dir: e.isDirectory() }))
    } catch {
      return []
    }
  })

  // List a single directory within the project root (used for relative import completion).
  ipcMain.handle('list_dir', async (_event, args) => {
    const safePath = validatePath(args.path)
    try {
      const entries = await fs.promises.readdir(safePath, { withFileTypes: true })
      return entries.map((e) => ({ name: e.name, is_dir: e.isDirectory() }))
    } catch {
      return []
    }
  })

  // Poll a venv's site-packages directory mtime; emit `site-packages:changed` on bump.
  // Used to trigger an LSP restart after `uv sync` / `pip install` populates packages
  // (basedpyright caches import-resolution failures and only re-resolves on restart).
  let sitePkgInterval = null
  let sitePkgPath = null
  let sitePkgMtime = null

  async function resolveSitePackages(venvPath) {
    try {
      const libDir = path.join(venvPath, 'lib')
      const entries = await fs.promises.readdir(libDir)
      const py = entries.find((e) => e.startsWith('python'))
      if (!py) return null
      const sp = path.join(libDir, py, 'site-packages')
      await fs.promises.access(sp)
      return sp
    } catch {
      return null
    }
  }

  ipcMain.handle('watch_site_packages', async (_event, args) => {
    if (sitePkgInterval) {
      clearInterval(sitePkgInterval)
      sitePkgInterval = null
    }
    sitePkgPath = null
    sitePkgMtime = null
    const venvPath = args?.venvPath
    console.log('[SitePkg] watch_site_packages called', { venvPath })
    if (typeof venvPath !== 'string' || !path.isAbsolute(venvPath)) {
      console.log('[SitePkg] reject: bad venvPath')
      return
    }
    // No project-root restriction: the active interpreter may live outside the
    // project (conda env at ~/anaconda/envs/foo, pyenv at ~/.pyenv/versions/...).
    // Polling is bounded to the resolved site-packages dir below, and the IPC
    // allowlist + pythonCmd-derived input keep this from becoming a write surface.

    const sp = await resolveSitePackages(venvPath)
    if (!sp) {
      console.log('[SitePkg] reject: site-packages not found under', venvPath)
      return
    }
    sitePkgPath = sp
    try {
      sitePkgMtime = (await fs.promises.stat(sp)).mtimeMs
    } catch {
      sitePkgMtime = null
    }
    console.log('[SitePkg] polling started', { sp, initialMtime: sitePkgMtime })

    sitePkgInterval = setInterval(async () => {
      if (!sitePkgPath) return
      let m
      try {
        m = (await fs.promises.stat(sitePkgPath)).mtimeMs
      } catch {
        return
      }
      if (sitePkgMtime !== null && m !== sitePkgMtime) {
        console.log('[SitePkg] CHANGED', { from: sitePkgMtime, to: m })
        sitePkgMtime = m
        mainWindow?.webContents?.send('site-packages:changed')
      } else {
        sitePkgMtime = m
      }
    }, SITE_PKG_POLL_MS)
  })

  ipcMain.handle('unwatch_site_packages', () => {
    if (sitePkgInterval) {
      clearInterval(sitePkgInterval)
      sitePkgInterval = null
    }
    sitePkgPath = null
    sitePkgMtime = null
  })
}

module.exports = { registerFsHandlers, setProjectRoot, getProjectRoot }
