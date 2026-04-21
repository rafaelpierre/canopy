const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

function prefsPath() {
  const configDir = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configDir, 'canopy', 'preferences.json')
}

let _cachedPrefs = null

const PREF_VALIDATORS = {
  last_project:      (v) => v === null || typeof v === 'string',
  preferred_shell:   (v) => v === null || typeof v === 'string',
  project_sessions:  (v) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
    const keys = Object.keys(v)
    if (keys.length > 100) return false
    for (const key of keys) {
      if (!path.isAbsolute(key)) return false
      const session = v[key]
      if (typeof session !== 'object' || session === null) return false
      const s = /** @type {any} */ (session)
      if (!Array.isArray(s.tabs) || s.tabs.length > 50) return false
      if (!s.tabs.every((t) => typeof t === 'string' && path.isAbsolute(t))) return false
      if (s.active_file !== null && (typeof s.active_file !== 'string' || !path.isAbsolute(s.active_file))) return false
    }
    return true
  },
  editor_font_size:  (v) => typeof v === 'number' && v >= 8 && v <= 72,
  tree_font_size:    (v) => typeof v === 'number' && v >= 8 && v <= 72,
  term_font_size:    (v) => typeof v === 'number' && v >= 8 && v <= 72,
  active_lsp:        (v) => v === null || typeof v === 'string',
  python_cmd:        (v) => v === null || typeof v === 'string',
  terminal_height:   (v) => typeof v === 'number' && v >= 50 && v <= 2000,
  tree_width:        (v) => typeof v === 'number' && v >= 80 && v <= 1000,
  show_terminal:     (v) => typeof v === 'boolean',
  show_file_tree:    (v) => typeof v === 'boolean',
}

function sanitizePrefs(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  const out = {}
  for (const [key, validate] of Object.entries(PREF_VALIDATORS)) {
    if (key in raw && validate(raw[key])) out[key] = raw[key]
  }
  return out
}

function getPrefs() {
  if (_cachedPrefs) return _cachedPrefs
  const p = prefsPath()
  if (!fs.existsSync(p)) return {}
  try { return sanitizePrefs(JSON.parse(fs.readFileSync(p, 'utf-8'))) } catch { return {} }
}

function registerPrefsHandlers(ipcMain) {
  ipcMain.handle('load_prefs', () => {
    _cachedPrefs = null  // invalidate cache
    const p = prefsPath()
    if (!fs.existsSync(p)) return {}
    try {
      const result = sanitizePrefs(JSON.parse(fs.readFileSync(p, 'utf-8')))
      _cachedPrefs = result
      return result
    } catch {
      return {}
    }
  })

  let pendingWrite = null
  ipcMain.handle('save_prefs', (_event, args) => {
    const p = prefsPath()
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const sanitized = sanitizePrefs(args.prefs)
    _cachedPrefs = sanitized  // update cache immediately
    const data = JSON.stringify(sanitized, null, 2)
    if (pendingWrite) return pendingWrite
    pendingWrite = fs.promises.writeFile(p, data).finally(() => { pendingWrite = null })
    return pendingWrite
  })

  ipcMain.handle('list_shells', async () => {
    if (process.platform === 'win32') {
      const candidates = ['powershell.exe', 'pwsh.exe', 'cmd.exe', 'bash.exe']
      return candidates.filter(s => {
        try { require('child_process').execSync(`where ${s}`, { stdio: 'ignore' }); return true } catch { return false }
      })
    }
    try {
      const content = await fs.promises.readFile('/etc/shells', 'utf-8')
      return content.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    } catch {
      return [process.env.SHELL || '/bin/bash']
    }
  })
}

module.exports = { registerPrefsHandlers, getPrefs }
