---
name: Security Audit — Canopy April 2026 (Full)
description: Full audit results: 3 Medium, 4 Low/Info; verified prior hardening controls still in place
type: project
---

Comprehensive audit completed 2026-04-21 (updated same date for uncommitted changes review). Overall posture: Medium. No Critical or High findings.

**Why:** Requested by owner as a follow-up to the April 2026 hardening pass to verify fixes held and catch regressions.

**How to apply:** Use as baseline for future audits. Flag any changes to the items below.

## Verified Controls (still in place)
- contextIsolation: true, nodeIntegration: false in BrowserWindow (main.cjs:54-59)
- ALLOWED_INVOKE / ALLOWED_LISTEN channel allowlists in preload.cjs
- validatePath() uses realpathSync for symlink resolution in fs.cjs:19-33
- lstat symlink rejection before watch_file in fs.cjs:139-143
- DevTools gated behind !app.isPackaged in menu.cjs:73
- navigation blocked via will-navigate + setWindowOpenHandler in main.cjs:151-158
- safeEnvObject() env allowlist in constants.cjs:33-38
- KNOWN_LSP_BINARIES + ALLOWED_LSP_ARGS in lsp.cjs:11-16
- pythonPath realpathSync for ty VIRTUAL_ENV derivation in lsp.cjs:132
- version regex validation before TOML write in setup.cjs:194
- symlink check on pyproject.toml in setup.cjs:202-213
- IPC timeout wrapper in ipc.ts:8-13
- LSP pending queue cap (100) in client.ts:229
- Max LSP message 10 MB guard in lsp.cjs:66-70
- asar: true + asarUnpack for node-pty in package.json build config
- package-lock.json present; npm audit clean

## Open Findings

### MEDIUM-1: preferred_shell not validated as absolute path or against known-shell list
- File: app/modules/prefs.cjs:16 (validator), app/modules/pty.cjs:31-32
- validator only checks typeof string; any string including path with special chars accepted
- Risk: a tampered preferences.json could cause pty.spawn() to exec a non-shell binary

### MEDIUM-2: configure_ty_python trustedRoot is derived from renderer-supplied projectRoot
- File: app/modules/setup.cjs:210 — `const trustedRoot = path.resolve(projectRoot)`
- Should compare against getProjectRoot() canonical path, not re-resolve the renderer arg

### MEDIUM-3: read_file_content has no file size limit
- File: app/modules/fs.cjs:184-186
- A large file (e.g. a binary > 100 MB) will be read fully into memory before transfer
- Risk: renderer-triggered memory exhaustion / IPC buffer flooding

### LOW-1: lsp_send has no method allowlist
- File: app/modules/lsp.cjs:184-189
- Only validates JSON-RPC 2.0 framing; any method string sent to LSP process
- LSP processes are trusted but method confusion could affect behavior

### LOW-2: write_file_content has no content size limit
- File: app/modules/fs.cjs:189-192

### LOW-3: validatePath() lexical fallback for non-existent files
- If realpathSync fails AND the path contains ../.. components the lexical resolve
  could escape in edge cases where intermediate dirs don't exist yet
- Partially mitigated by projectRoot prefix check

### LOW-4: CSP uses 'unsafe-inline' for script-src
- Both dev (app.html) and prod (main.cjs) CSP permit unsafe-inline scripts
- Acceptable for SvelteKit with contextIsolation, but reduces defence-in-depth

### LOW-5: Dev mode CSP (app.html) missing ws:// for Vite HMR websocket
- Vite HMR uses ws://localhost:1420; app.html CSP lacks connect-src ws: allowance
- Likely works because CSP meta tags have reduced enforcement in some Electron contexts

### INFORMATIONAL: list_shells Windows uses execSync with template literal
- File: app/modules/prefs.cjs:90
- s comes from a hardcoded candidates array so no injection risk currently
- Style risk: if candidates array were ever made dynamic this would become a vulnerability
