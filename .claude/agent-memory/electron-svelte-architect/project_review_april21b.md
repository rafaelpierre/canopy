---
name: Architectural Review April 21 2026 (second pass)
description: 16 issues found across IPC, duplication, state management, and structural correctness in the current uncommitted diff
type: project
---

Key findings from the second pass review of this batch of changes:

**Bugs / Data integrity (P0)**
- `app/main.cjs`: two separate `app.on('before-quit', ...)` listeners registered in same block (lines 87–97). `killAllPtys` fires before user confirms quit dialog. PTY kill should move into `app:confirm-quit` handler.
- `app/modules/prefs.cjs` `save_prefs`: write-coalescing silently drops the second caller's payload if a write is in flight. Need a one-pending + one-queued write pattern, not a bail-out.
- `DiagnosticsModal.svelte`: store subscription at module scope runs continuously even when modal is hidden — cost is O(diagnostics) per LSP publish event. Gate on `open`.

**Structural regressions (P1)**
- `fileIconComponent`/`iconColor` duplicated verbatim between `FileTree.svelte` and `+page.svelte` tab bar. Should live in `/src/lib/file-icons.ts`.
- `menuFocus` action and `handleMenuKeydown` duplicated across `Terminal.svelte`, `FileTree.svelte`, `+page.svelte`. Should live in `/src/lib/menu-actions.ts`.
- LSP start sequence (set starting → clear diags → lspClient.start → set ready → scanWorkspace) duplicated in `openFolder`, `initLsp` subscriber, and `restartLsp`. Extract `startLsp(root, stopFirst?)`.
- `Terminal.svelte selectShell`: loads full prefs just to merge one key — risks overwriting concurrent pref changes. Should use a callback prop from page.

**IPC / Security (P2)**
- Preload `openFolderDialog` bypasses the allowlist-checked `invoke` wrapper (calls `ipcRenderer.invoke` directly). Should route through the single `invoke` wrapper.
- `handlersRegistered` guard in main.cjs: window control handlers close over `mainWindow` at registration time. On macOS `activate`, new window is created but handlers still reference the old destroyed window. Fix: use `BrowserWindow.getFocusedWindow()` in handlers.
- Protocol handler `catch` block uses `fs.readFileSync` (sync) — inconsistent with the async outer try. Use `fs.promises.readFile`.
- `DiagnosticsModal.svelte clickItem`: uses subscribe+unsubscribe pattern for synchronous read. Replace with `get(openFilePath)`.

**Pattern gaps**
- No typed IPC channel registry — ALLOWED_INVOKE/ALLOWED_LISTEN are raw string sets. A shared `channels.cjs` would prevent drift between preload and handler registration.
- No LspCommandQueue to serialize start/stop across concurrent project switches.

**Why:** These were found during the April 21 2026 second-pass review of the large UX/feature batch.
**How to apply:** P0 items are active bugs; P1 duplication items are the highest-leverage refactors.
