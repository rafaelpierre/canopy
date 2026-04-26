const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
const { canopyLspDir, which, findBinary } = require('../utils.cjs')

function installedLangserverJS() {
  // Find the JS entry point inside the installed basedpyright package
  const lspDir = canopyLspDir()
  const libDir = path.join(lspDir, 'lib')
  if (!fs.existsSync(libDir)) return null
  try {
    for (const pyDir of fs.readdirSync(libDir).filter((d) => d.startsWith('python'))) {
      const jsEntry = path.join(
        libDir,
        pyDir,
        'site-packages',
        'basedpyright',
        'langserver.index.js',
      )
      if (fs.existsSync(jsEntry)) return jsEntry
    }
  } catch (_) {}
  return null
}

function findPython() {
  return which('python3') || which('python')
}

function findLangserver() {
  const localJS = installedLangserverJS()
  if (localJS) return localJS
  return which('basedpyright-langserver')
}

function hasWheels(dir) {
  if (!fs.existsSync(dir)) return false
  return fs.readdirSync(dir).some((f) => f.endsWith('.whl'))
}

function bundledWheelsDir() {
  if (app.isPackaged) {
    const prod = path.join(process.resourcesPath, 'lsp-wheels')
    if (hasWheels(prod)) return prod
  }

  const dev = path.join(app.getAppPath(), 'resources', 'lsp-wheels')
  if (hasWheels(dev)) return dev

  return null
}

function installFromWheels(python, wheelsDir) {
  const target = canopyLspDir()
  fs.mkdirSync(target, { recursive: true })

  try {
    execFileSync(
      python,
      [
        '-m',
        'pip',
        'install',
        '--no-index',
        '--find-links',
        wheelsDir,
        '--prefix',
        target,
        '--no-deps',
        '--no-warn-script-location',
        '--no-cache-dir',
        '--quiet',
        'basedpyright',
      ],
      { encoding: 'utf-8' },
    )
  } catch (e) {
    throw new Error('pip install failed: ' + e.message)
  }

  const jsEntry = installedLangserverJS()
  if (jsEntry) return jsEntry

  throw new Error('pip install succeeded but langserver.index.js not found in ' + target)
}

function findTy() {
  return findBinary('ty')
}

function findUv() {
  return findBinary('uv')
}

async function ensureUv(python) {
  const existing = findUv()
  if (existing) return existing

  // Try pip install uv
  if (python) {
    try {
      execFileSync(python, ['-m', 'pip', 'install', '--quiet', 'uv'], { encoding: 'utf-8' })
      const afterPip = findUv()
      if (afterPip) return afterPip
    } catch (_) {}
  }

  return null
}

function getPythonVersionFromVenv(venvRoot) {
  const cfg = path.join(venvRoot, 'pyvenv.cfg')
  if (!fs.existsSync(cfg)) return null
  try {
    const content = fs.readFileSync(cfg, 'utf-8')
    const m = content.match(/^version_info\s*=\s*(\d+\.\d+)/m)
    return m ? m[1] : null
  } catch {
    return null
  }
}

function hasTyPythonConfig(content) {
  if (/^\s*requires-python\s*=/m.test(content)) return true
  if (/^\[tool\.ty\.environment\]/m.test(content)) return true
  return false
}

function registerSetupHandlers(ipcMain) {
  ipcMain.handle('check_setup', () => {
    const python = findPython()
    const langserver = findLangserver()

    if (python && langserver) {
      return { basedpyright_path: langserver, python_path: python, ready: true, message: 'Ready' }
    }

    if (!python) {
      return {
        basedpyright_path: langserver,
        python_path: null,
        ready: false,
        message: 'Python not found in PATH',
      }
    }

    const wheelsDir = bundledWheelsDir()
    if (wheelsDir) {
      try {
        const installed = installFromWheels(python, wheelsDir)
        return {
          basedpyright_path: installed,
          python_path: python,
          ready: true,
          message: 'Installed basedpyright from bundled wheels',
        }
      } catch (e) {
        return {
          basedpyright_path: null,
          python_path: python,
          ready: false,
          message: 'Auto-install failed: ' + e.message,
        }
      }
    }

    return {
      basedpyright_path: null,
      python_path: python,
      ready: false,
      message: 'basedpyright not found. Run: pip install basedpyright',
    }
  })

  ipcMain.handle('check_lsp_available', (_event, args) => {
    const { lspId } = args
    if (lspId === 'basedpyright') return { available: !!findLangserver(), installed: true }
    if (lspId === 'ty') return { available: !!findTy(), installed: true }
    return { available: false, installed: false }
  })

  ipcMain.handle('install_ty', async (_event) => {
    try {
      const python = findPython()
      const uvPath = await ensureUv(python)
      if (!uvPath) {
        return {
          success: false,
          message: 'Could not find or install uv. Install it manually: pip install uv',
        }
      }
      execFileSync(uvPath, ['tool', 'install', 'ty'], { encoding: 'utf-8' })
      const tyPath = findTy()
      if (tyPath) return { success: true, message: 'Installed ty successfully', path: tyPath }
      return {
        success: false,
        message: 'Installation appeared successful but ty not found in PATH',
      }
    } catch (e) {
      return { success: false, message: 'Failed to install ty: ' + e.message }
    }
  })

  ipcMain.handle('detect_venv_recursive', async (_event, args) => {
    const root = args?.projectRoot
    const maxDepth = typeof args?.maxDepth === 'number' ? Math.min(args.maxDepth, 8) : 4
    if (!root) return []
    const { getProjectRoot } = require('./fs.cjs')
    const trustedRoot = getProjectRoot()
    const resolved = path.resolve(root)
    if (trustedRoot && resolved !== trustedRoot && !resolved.startsWith(trustedRoot + path.sep))
      return []
    const { VENV_NAMES, IGNORED_DIRS } = require('../constants.cjs')

    const venvNameSet = new Set(VENV_NAMES)
    const results = []
    const seen = new Set()

    async function fileAccessible(p) {
      try {
        await fs.promises.access(p, fs.constants.X_OK)
        return true
      } catch {
        return false
      }
    }

    async function walk(dir, depth) {
      if (depth > maxDepth) return
      let entries
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      // Python Envy–style heuristic: a directory without any Python project marker
      // is very unlikely to own a .venv. Skip the subtree when neither a marker
      // nor a venv directory is directly visible.
      const PROJECT_MARKERS = new Set([
        'pyproject.toml',
        'Pipfile',
        'setup.py',
        'requirements.txt',
        'manage.py',
      ])
      let hasMarker = false
      let hasVenvHere = false
      for (const entry of entries) {
        if (entry.isDirectory() && venvNameSet.has(entry.name)) hasVenvHere = true
        else if (!entry.isDirectory() && PROJECT_MARKERS.has(entry.name)) hasMarker = true
      }
      if (depth > 0 && !hasMarker && !hasVenvHere) return
      const tasks = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const name = entry.name
        const fullPath = path.join(dir, name)
        if (venvNameSet.has(name)) {
          if (seen.has(fullPath)) continue
          seen.add(fullPath)
          tasks.push(
            (async () => {
              let pythonPath = null
              for (const bin of ['python3', 'python']) {
                const candidate = path.join(fullPath, 'bin', bin)
                if (await fileAccessible(candidate)) {
                  pythonPath = candidate
                  break
                }
              }
              if (!pythonPath) {
                const winCandidate = path.join(fullPath, 'Scripts', 'python.exe')
                if (await fileAccessible(winCandidate)) pythonPath = winCandidate
              }
              if (pythonPath) {
                const isUv = await fileAccessible(path.join(dir, 'uv.lock'))
                results.push({ subdir: dir, pythonPath, venvPath: fullPath, isUv })
              }
            })(),
          )
          continue
        }
        if (IGNORED_DIRS.has(name)) continue
        tasks.push(walk(fullPath, depth + 1))
      }
      await Promise.all(tasks)
    }

    await walk(resolved, 0)
    console.log(`[Setup] detect_venv_recursive found ${results.length} venv(s) in`, resolved)
    return results
  })

  // Walk UP from filePath's directory toward the project root, checking each level for
  // a .venv/venv/.env/env. Returns the closest ancestor venv or null.
  // This is O(depth) stats — way faster than readdir-based recursive scanning.
  // Inspired by the Python Envy VS Code extension.
  ipcMain.handle('find_ancestor_venv', async (_event, args) => {
    const filePath = args?.filePath
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return null
    const { getProjectRoot } = require('./fs.cjs')
    const trustedRoot = getProjectRoot()
    if (!trustedRoot) return null
    const resolved = path.resolve(filePath)
    if (resolved !== trustedRoot && !resolved.startsWith(trustedRoot + path.sep)) return null

    const { VENV_NAMES } = require('../constants.cjs')
    let dir = path.dirname(resolved)

    while (dir === trustedRoot || dir.startsWith(trustedRoot + path.sep)) {
      for (const venvName of VENV_NAMES) {
        const venvPath = path.join(dir, venvName)
        for (const bin of ['python3', 'python']) {
          const pyBin = path.join(venvPath, 'bin', bin)
          try {
            await fs.promises.access(pyBin, fs.constants.X_OK)
            let isUv = false
            try {
              await fs.promises.access(path.join(dir, 'uv.lock'))
              isUv = true
            } catch {}
            return { subdir: dir, pythonPath: pyBin, venvPath, isUv }
          } catch {}
        }
        const winBin = path.join(venvPath, 'Scripts', 'python.exe')
        try {
          await fs.promises.access(winBin)
          return { subdir: dir, pythonPath: winBin, venvPath, isUv: false }
        } catch {}
      }
      if (dir === trustedRoot) break
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  })

  ipcMain.handle('detect_venv', (_event, args) => {
    const root = args.projectRoot
    if (!root) return null
    const resolved = path.resolve(root)
    const { getProjectRoot } = require('./fs.cjs')
    const trustedRoot = getProjectRoot()
    if (trustedRoot && resolved !== trustedRoot) return null
    const { VENV_NAMES } = require('../constants.cjs')
    for (const venvName of VENV_NAMES) {
      for (const bin of ['python', 'python3']) {
        const pythonBin = path.join(resolved, venvName, 'bin', bin)
        if (fs.existsSync(pythonBin)) return pythonBin
      }
      const pythonExe = path.join(resolved, venvName, 'Scripts', 'python.exe')
      if (fs.existsSync(pythonExe)) return pythonExe
    }
    return null
  })

  ipcMain.handle('configure_ty_python', (_event, { projectRoot, pythonPath }) => {
    if (!projectRoot || !pythonPath) return { configured: false, reason: 'missing args' }
    const { getProjectRoot } = require('./fs.cjs')
    const trustedRoot = getProjectRoot()
    if (!trustedRoot || path.resolve(projectRoot) !== trustedRoot) {
      return { configured: false, reason: 'projectRoot does not match trusted root' }
    }

    const binIdx = pythonPath.lastIndexOf('/bin/')
    const scriptIdx = pythonPath.lastIndexOf(path.sep + 'Scripts' + path.sep)
    const venvRoot =
      binIdx !== -1
        ? pythonPath.slice(0, binIdx)
        : scriptIdx !== -1
          ? pythonPath.slice(0, scriptIdx)
          : null
    if (!venvRoot) return { configured: false, reason: 'pythonPath not in a venv' }

    const version = getPythonVersionFromVenv(venvRoot)
    if (!version)
      return { configured: false, reason: 'could not read python version from pyvenv.cfg' }

    // SEC-2: validate version string before interpolating into TOML
    if (!/^\d+\.\d+(\.\d+)?$/.test(version)) {
      console.warn('[Setup] invalid python version format:', version)
      return { configured: false, reason: 'invalid python version format' }
    }

    const pyprojectPath = path.join(projectRoot, 'pyproject.toml')
    let existing = ''
    if (fs.existsSync(pyprojectPath)) {
      // SEC-1: reject symlinks to prevent symlink-swap attacks on pyproject.toml
      try {
        const lstat = fs.lstatSync(pyprojectPath)
        if (lstat.isSymbolicLink()) {
          console.warn('[Setup] pyproject.toml is a symlink, refusing to write')
          return { configured: false, reason: 'pyproject.toml is a symlink' }
        }
        const realDir = fs.realpathSync(path.dirname(pyprojectPath))
        const trustedRoot = path.resolve(projectRoot)
        if (!realDir.startsWith(trustedRoot)) {
          console.warn('[Setup] pyproject.toml resolved outside project root')
          return { configured: false, reason: 'path outside project root' }
        }
      } catch {
        return { configured: false, reason: 'could not stat pyproject.toml' }
      }
      existing = fs.readFileSync(pyprojectPath, 'utf-8')
      if (hasTyPythonConfig(existing)) {
        return { configured: false, reason: 'already configured' }
      }
    }

    const addition = `\n[tool.ty.environment]\npython-version = "${version}"\n`
    fs.writeFileSync(pyprojectPath, existing + addition, 'utf-8')
    console.log(`[Setup] wrote python-version = "${version}" to ${pyprojectPath}`)
    return { configured: true, version }
  })
}

module.exports = { registerSetupHandlers }
