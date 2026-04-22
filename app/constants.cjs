const IGNORED_DIRS = new Set([
  '.git', 'node_modules', '__pycache__', '.venv', 'venv',
  '.mypy_cache', '.pytest_cache', '.ruff_cache', 'target', '.DS_Store',
  'dist', 'build', '.tox', 'htmlcov', 'eggs', '.eggs',
  'site-packages', 'dist-packages', '__pypackages__',
  '.hg', '.svn', 'CVS',
])

const VENV_NAMES = ['.venv', 'venv', '.env', 'env']

const LSP_EXCLUDE_PATTERNS = [
  '**/node_modules', '**/__pycache__', '**/.git',
  '**/.venv', '**/venv', '**/.env', '**/env',
  '**/.mypy_cache', '**/.pytest_cache', '**/.ruff_cache',
  '**/dist', '**/build', '**/*.egg-info',
]

// Safe environment variable allowlist shared by lsp.cjs and pty.cjs.
// Only these keys are forwarded to spawned child processes — everything else
// from process.env is dropped to avoid leaking secrets or app-internal vars.
const ALLOWED_ENV = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'LC_ALL',
  'LC_CTYPE', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
  'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME',
  'SSH_AUTH_SOCK', 'TMPDIR', 'TMP', 'TEMP',
  'CONDA_PREFIX', 'CONDA_DEFAULT_ENV', 'VIRTUAL_ENV',
  'PYENV_ROOT', 'NVM_DIR', 'GOPATH', 'CARGO_HOME', 'RUSTUP_HOME',
  'PYTHONPATH', 'PYTHONHOME', 'PYTHONDONTWRITEBYTECODE',
]

/**
 * Build a filtered environment object from the ALLOWED_ENV whitelist.
 * @param {Record<string, string>} extra  Additional key/value pairs to merge in (e.g. TERM override).
 * @returns {Record<string, string>}
 */
function safeEnvObject(extra = {}) {
  const env = {}
  for (const key of ALLOWED_ENV) {
    if (process.env[key]) env[key] = process.env[key]
  }
  return Object.assign(env, extra)
}

module.exports = { IGNORED_DIRS, VENV_NAMES, LSP_EXCLUDE_PATTERNS, ALLOWED_ENV, safeEnvObject }
