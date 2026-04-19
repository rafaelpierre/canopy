const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

function prefsPath() {
  const configDir = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configDir, 'canopy', 'preferences.json')
}

const PREF_VALIDATORS = {
  last_project:      (v) => v === null || typeof v === 'string',
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

function registerPrefsHandlers(ipcMain) {
  ipcMain.handle('load_prefs', () => {
    const p = prefsPath()
    if (!fs.existsSync(p)) return {}
    try {
      return sanitizePrefs(JSON.parse(fs.readFileSync(p, 'utf-8')))
    } catch {
      return {}
    }
  })

  let pendingWrite = null
  ipcMain.handle('save_prefs', (_event, args) => {
    const p = prefsPath()
    const dir = path.dirname(p)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const data = JSON.stringify(sanitizePrefs(args.prefs), null, 2)
    if (pendingWrite) return pendingWrite
    pendingWrite = fs.promises.writeFile(p, data).finally(() => { pendingWrite = null })
    return pendingWrite
  })
}

module.exports = { registerPrefsHandlers }
