# Canopy — Lightweight Python IDE

## Overview

Canopy is a desktop Python IDE built with **Electron 33 + Svelte 5 + Monaco Editor**. It provides code editing with LSP-powered diagnostics (basedpyright), an integrated terminal (xterm.js + node-pty), and a file tree browser. Author: Rafael Pierre. License: MIT.

## Tech Stack

- **Frontend:** Svelte 5 / SvelteKit 2.9, TypeScript 5.6, Monaco Editor, xterm.js
- **Desktop:** Electron 33, electron-builder 25
- **LSP:** basedpyright (Python type checker, spawned as subprocess via stdio)
- **Terminal:** node-pty-prebuilt-multiarch
- **Icons:** lucide-svelte
- **Build:** Vite 6, static SvelteKit adapter (SPA mode)

## Project Structure

```
canopy/
├── app/                    # Electron main process
│   ├── main.cjs            # App entry point, BrowserWindow, IPC setup
│   ├── preload.cjs         # Context bridge (exposes electronAPI to renderer)
│   ├── constants.cjs       # Shared constants: IGNORED_DIRS, ALLOWED_ENV, safeEnvObject, LSP_EXCLUDE_PATTERNS
│   ├── utils.cjs           # Shared utilities: canopyLspDir, which, findBinary
│   └── modules/
│       ├── fs.cjs          # File system operations (read/write/list); async fs.promises; symlink rejection
│       ├── lsp.cjs         # Spawn basedpyright LSP subprocess; realpathSync on pythonPath; 10 MB max msg
│       ├── pty.cjs         # Per-tab PTY via Map<id, ptyProcess>; batched output via setImmediate
│       ├── setup.cjs       # Detect Python, basedpyright, install from wheels; symlink + version validation
│       ├── prefs.cjs       # Preference persistence with sanitizePrefs() type/range validation
│       └── menu.cjs        # Native menu bar; DevTools only in !app.isPackaged
├── src/                    # Svelte renderer (frontend)
│   ├── routes/+page.svelte # Main layout; onMount decomposed into initPrefs/initLsp/initMenuListener
│   └── lib/
│       ├── Editor.svelte   # Monaco editor with LSP integration; didChange debounced 100ms
│       ├── Terminal.svelte  # xterm.js; per-tab PTY routing by id; scrollback capped at 5000
│       ├── FileTree.svelte  # File tree; root folder rendered as top tree node (no separate header bar)
│       ├── StatusBar.svelte # Bottom bar (LSP status, diagnostics count, Python info)
│       ├── CommandPalette.svelte # File/grep palette; generation counter prevents stale result overwrites
│       ├── DiagnosticsModal.svelte # LSP diagnostics list; static store import + onDestroy unsubscribe
│       ├── SaveDialog.svelte # Unsaved-changes dialog
│       ├── BaseModal.svelte # Shared modal primitive
│       ├── ipc.ts          # IPC bridge; 30s Promise.race timeout on all invoke() calls
│       ├── stores.ts       # Svelte writable stores (global reactive state)
│       ├── path.ts         # basename(p) and relpath(p, root) utilities
│       ├── global.css      # Design tokens & dark theme CSS variables
│       └── lsp/
│           ├── client.ts   # LSP client; notification handlers deferred via Promise.resolve().then()
│           └── adapter.ts  # Monaco ↔ LSP adapter
├── scripts/
│   └── bundle-lsp.sh      # Download basedpyright wheels for offline bundling
├── resources/lsp-wheels/   # Pre-downloaded LSP wheels
├── Dockerfile.linux-build  # Ubuntu 22.04 build image
├── Dockerfile.linux-build-rhel8
├── Dockerfile.linux-build-x64
├── vite.config.js          # Vite config (port 1420, Monaco plugin)
└── svelte.config.js        # SvelteKit static adapter, SPA mode
```

## Commands

```bash
# Development
npm install                  # Install deps (runs electron-rebuild via postinstall)
npm run dev                  # Vite dev server only (http://localhost:1420)
npm run dev:electron         # Concurrent Vite + Electron with live reload

# Build
npm run build                # Vite production build
npm run build:electron       # Full Electron distribution package
npm run build:linux          # Linux packages (AppImage, deb, rpm)
npm run build:mac            # macOS DMG
npm run build:win            # Windows NSIS installer

# Type checking
npm run check                # svelte-check + TypeScript validation
npm run check:watch          # Watch mode

# LSP bundling
./scripts/bundle-lsp.sh              # Auto-detect platform
./scripts/bundle-lsp.sh linux x86_64 # Cross-platform
```

## Architecture

```
Electron Main (app/main.cjs)
  ├─ IPC handlers (fs, lsp, pty, setup, prefs, menu)
  ├─ Custom app:// protocol → serves build/ output
  ├─ CSP applied in both dev (webRequest hook) and prod (meta tag)
  └─ Spawns: basedpyright (LSP), per-tab PTY shells (Map<id, ptyProcess>)
       │
       │  IPC (invoke / send / on) — all invokes have 30s timeout
       ▼
Renderer (Svelte SPA)
  ├─ FileTree.svelte   — left panel, resizable; root folder as top tree node
  ├─ Editor.svelte     — Monaco, LSP diagnostics/completions/hover/semantic tokens
  ├─ Terminal.svelte   — xterm.js, resizable bottom panel, per-tab PTY routing
  ├─ CommandPalette.svelte — file open + grep search with generation-counter guard
  ├─ DiagnosticsModal.svelte — LSP diagnostics list
  ├─ SaveDialog.svelte / BaseModal.svelte — modal dialogs
  └─ StatusBar.svelte  — Python version, LSP status, diagnostics count
```

## IPC Channels

All `invoke()` calls in `ipc.ts` have a 30-second `Promise.race` timeout to prevent silent UI deadlock.

| Channel | Direction | Purpose |
|---------|-----------|---------|
| `read_dir_recursive` | renderer→main | List directory tree |
| `read_file_content` / `write_file_content` | renderer→main | File I/O |
| `lsp_start` / `lsp_send` / `lsp_stop` | renderer→main | LSP lifecycle |
| `lsp://message` | main→renderer | LSP responses/notifications |
| `pty_spawn` / `pty_write` / `pty_resize` / `pty_kill` | renderer→main | Terminal I/O; all take `id` for per-tab routing |
| `pty:data` / `pty:exit` | main→renderer | Terminal output/exit; `pty:data` carries `{ id, data }` |
| `check_setup` / `detect_venv` | renderer→main | Python environment detection |
| `load_prefs` / `save_prefs` | renderer→main | Preferences persistence |
| `dialog:openFolder` / `dialog:openFile` | renderer→main | Native dialogs |
| `menu:action` | main→renderer | Menu bar actions |

## LSP Integration

- basedpyright communicates via JSON-RPC 2.0 over stdin/stdout
- Message format: `Content-Length: N\r\n\r\n{JSON}`
- Type checking mode: `standard`, diagnostic mode: `openFilesOnly`
- Features: diagnostics, semantic tokens, completions (on `.`), hover, go-to-definition
- Debounced: didChange (300ms), auto-save (400ms)
- Fallback: bundled wheels installed to `~/.local/share/canopy/lsp/` if not on PATH

## Key Patterns

- **State:** Svelte writable stores (no Redux/Vuex). Stores loaded async in `onMount`.
- **Svelte 5 runes:** Uses `$state`, `$derived` syntax.
- **Dark theme only:** `nativeTheme.themeSource = 'dark'`. CSS variables for colors.
- **Font:** JetBrains Mono (fallbacks: Fira Code, Cascadia Code, monospace).
- **Lazy loading:** Monaco, xterm, LSP initialized in `onMount` (decomposed into `initPrefs`, `initLsp`, `initMenuListener`).
- **Shared constants:** `app/constants.cjs` — `IGNORED_DIRS`, `ALLOWED_ENV`, `safeEnvObject()`, `LSP_EXCLUDE_PATTERNS`, `VENV_NAMES`.
- **Shared utilities:** `app/utils.cjs` — `canopyLspDir()`, `which()`, `findBinary()`.
- **Path helpers:** `src/lib/path.ts` — `basename(p)`, `relpath(p, root)`.
- **IPC security:** Renderer-supplied paths validated against `getProjectRoot()` from `fs.cjs` before any subprocess use. Never trust renderer paths for cwd, file probing, or spawn args.
- **Environment safety:** Only keys in `ALLOWED_ENV` are forwarded to child processes via `safeEnvObject()`.
- **PTY:** Per-tab via `Map<id, ptyProcess>` in `pty.cjs`. Output batched with `setImmediate`. All PTYs killed on `app.before-quit`.
- **LSP request queue:** Fast-fails new requests when queue ≥ 100 (no silent eviction).
- **Excluded dirs:** Defined in `IGNORED_DIRS` constant (`.git`, `node_modules`, `__pycache__`, `.venv`, `venv`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `target`).
- **Prefs location:** macOS `~/Library/Application Support/canopy/preferences.json`, Linux `~/.config/canopy/preferences.json`. All keys validated by `sanitizePrefs()` on load.
- **FileTree UX:** Root folder renders as the first tree item (no separate header bar). Children start at depth 1.

## Backlog (not yet implemented)

- **Semantic token decoder web worker** — `applySemanticTokens` in `Editor.svelte` runs on the UI thread; move to worker with `Transferable` typed arrays to eliminate frame drops during active editing.
- **Command palette fuzzy search worker** — file filter/score loop in `CommandPalette.svelte` runs on UI thread on every keypress; offload to worker for large projects (1000+ files).

## Packaging

- **App ID:** `com.rafaelpierre.canopy`
- **Targets:** AppImage/deb/rpm (Linux), DMG (macOS), NSIS (Windows)
- **Bundled resources:** LSP wheels from `resources/lsp-wheels/`
- **Docker builds:** Ubuntu 22.04, RHEL 8, x64 variants for CI Linux builds
