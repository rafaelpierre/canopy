const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/**
 * Returns the directory where Canopy stores downloaded/installed LSP packages.
 * Follows XDG conventions on Linux and the macOS Application Support convention.
 */
function canopyLspDir() {
  const dataDir = process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(dataDir, 'canopy', 'lsp')
}

/**
 * Resolve a binary name via `which`. Returns the absolute path or null.
 * @param {string} name
 * @returns {string | null}
 */
function which(name) {
  try {
    return execFileSync('which', [name], { encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}

/**
 * Find a binary by name, checking PATH via `which` first, then a list of
 * known locations that Electron may have stripped from the shell PATH on macOS.
 * @param {string} name
 * @returns {string | null}
 */
function findBinary(name) {
  const fromWhich = which(name)
  if (fromWhich) return fromWhich
  const home = os.homedir()
  const candidates = [
    path.join(home, '.cargo', 'bin', name),
    path.join(home, '.local', 'bin', name),
    path.join(home, '.astral', 'bin', name),
    '/usr/local/bin/' + name,
    '/opt/homebrew/bin/' + name,
  ]
  for (const p of candidates) {
    if (fs.existsSync(p)) return p
  }
  return null
}

module.exports = { canopyLspDir, which, findBinary }
