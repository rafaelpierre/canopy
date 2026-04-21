---
name: Canopy Project Overview
description: Electron + SvelteKit Python IDE — architecture summary, key decisions, and open issues from the April 2026 comprehensive review
type: project
---

Canopy is a lightweight Python IDE built on Electron 41 + SvelteKit (adapter-static) + Vite 6, with Monaco editor, xterm.js terminals, and an LSP proxy (basedpyright / ty).

**Why:** Reference for future conversations — avoid re-reading every file to understand structure.
**How to apply:** Use as context when scoping changes, to know which layers are affected.

## Process boundary

- `app/main.cjs` — Electron main, window creation, custom `app://` protocol, navigation guard
- `app/preload.cjs` — contextBridge; allowlist-based `invoke` and `on`; IPC abstraction
- `app/modules/` — fs, lsp, pty, prefs, setup, menu — each registers its own ipcMain handlers
- `app/constants.cjs` — shared constants (IGNORED_DIRS, VENV_NAMES, safeEnvObject, LSP_EXCLUDE_PATTERNS)
- `app/utils.cjs` — which(), findBinary(), canopyLspDir()
- `src/lib/ipc.ts` — renderer IPC facade (invoke + listen + timeout wrapper)
- `src/lib/stores.ts` — all shared Svelte writable/derived stores
- `src/routes/+page.svelte` — single SPA page, orchestrates all major logic
- `src/lib/` — Editor, FileTree, Terminal, StatusBar, MenuBar, CommandPalette, DiagnosticsModal, SaveDialog

## Known open issues (found April 2026 review)

1. **LSP start pattern repeated 5x** in +page.svelte (lines ~244, ~328, ~376, ~399, ~786) — identical 4-line pattern (get activeLspId, get adapter, get lp, get pyCmd, call lspClient.start). Should be extracted to `startLspForRoot(root, stores, mods)`.

2. **Icon lookup duplicated** — `tabIconComponent(name)` / `tabIconColor(name)` in +page.svelte (lines 30–63) are nearly identical to `fileIconComponent(entry)` / `iconColor(entry)` in FileTree.svelte (lines 342–378). Should live in `src/lib/fileIcons.ts`.

3. **Context menu CSS copy-pasted** — identical `.ctx-menu` styles in +page.svelte (line 1049), FileTree.svelte (line 582), Terminal.svelte (line 521). Should move to `global.css`.

4. **`{#if true}` dead branch** — +page.svelte line 939 wraps the terminal panel in `{#if true}`. The `_showTerminal` store is maintained but never used to conditionally render the panel. Either the condition should be `_showTerminal` or the show/hide toggle logic is vestigial.

5. **Toggle functions duplicated** — `doToggleTerminal` / `doToggleTree` defined as standalone functions (line 526–527) but also inlined as lambdas in CommandPalette props (lines 971–972).

6. **`handlersRegistered` guard is fragile** — main.cjs line 62. The guard prevents double-registration across hot reloads, but two `app.on('before-quit', ...)` listeners are registered (lines 87 and 90) inside the same guard block — one calls `killAllPtys()`, the other handles the quit dialog flow. They could be merged.

7. **Terminal.svelte does its own `load_prefs` / `save_prefs`** for `preferred_shell` (lines 228–229, 243–244), bypassing the centralized prefs save in +page.svelte. This creates a write-after-write race if Terminal saves while +page is also saving.

8. **`await import('svelte/store')`** called dynamically and repeatedly inside FileTree.svelte event handlers (lines 229, 257, 295, 324) and Terminal.svelte (lines 147, 175). Since `svelte/store` is a static ESM module, `get` should be imported once at the top.

9. **LSP_EXCLUDE_PATTERNS defined twice** — once in `app/constants.cjs` (exported but never imported by lsp.cjs) and again inline in `src/lib/lsp/adapter.ts` as a local `const EXCLUDE_PATTERNS`. They are identical lists.

10. **`mods` object pattern** — +page.svelte constructs a `mods` bag-of-all-modules (line 562–570) and passes it through functions. This is effectively a Service Locator anti-pattern. The `mods.get(stores.x)` calls (52 total) are verbose; `get` should just be imported directly from `svelte/store` at module scope.

11. **`check_setup` is synchronous but called from async context** — setup.cjs `check_setup` handler calls `installFromWheels` which uses `execFileSync`, blocking the Node event loop during pip install. Should be made fully async.

12. **`save_prefs` in Terminal merges by read-then-write** — Terminal.svelte line 228 reads all prefs then writes back a merged object. If +page.svelte's debounced save fires concurrently, one write will silently drop the other's changes.

13. **`mainWindow` captured by closure in `before-quit` handler** — main.cjs line 95 uses `mainWindow` which is reassigned on `activate`. If the window is destroyed and recreated, the old `before-quit` listener references the stale window. The `handlersRegistered` guard prevents re-registration, so the second window would have no quit interception.

14. **No IPC timeout on `listen` channels** — ipc.ts line 16 wraps `invoke` with a 30s timeout but `listen` has no timeout. Long-lived listeners that are never cleaned up (e.g., if `onDestroy` is not called) would leak indefinitely.
