---
name: Performance Review April 2026 (updated)
description: Cumulative perf audit of canopy — verified against current source, updated after second pass
type: project
---

Key bottlenecks found (high-impact, verified against source):

1. **gatherFiles is O(n²) IPC** — +page.svelte:792-803. read_dir_recursive with depth:6 returns
   the full tree in one call; renderer then flattens it locally. This is already O(1) IPC.
   RESOLVED — previously flagged, confirmed fixed.

2. **Duplicate tabIconComponent/iconColor logic** — FileTree.svelte:398-434 and +page.svelte:63-96.
   Both components have identical ~30-branch icon/color functions. Extract to `$lib/fileIcons.ts`.

3. **StatusBar store subscriptions unsubscribed correctly** — onDestroy calls _clickCleanup which
   calls all unsub fns. RESOLVED.

4. **DiagnosticsModal re-sorts entire flat array on EVERY diagnosticsByUri update, even when modal
   is closed** — DiagnosticsModal.svelte:31-40. The subscription is created at module scope (not in
   onMount), so it fires for every LSP diagnostic push during workspace scan. High severity during
   project open (hundreds of batched diagnostic events trigger repeated full sort of entire array).

5. **isIgnored() O(depth × rules) called on every flat render** — FileTree.svelte:88-108. Each call
   walks all ancestor path segments × all gitignore rules. With a large gitignore and a deep tree,
   this is O(entries × depth × rules) per render. No memoization.

6. **ResizeObserver debounce present but fit() called twice — once immediately, once after 50ms
   timeout** — Terminal.svelte:322-332. The synchronous `t.main.fit.fit()` call inside the observer
   itself (line 325-326) forces a style recalc before the debounced pty_resize. The debounced IPC
   call is correct but the immediate fit() still runs on every pixel of resize.

7. **selectShell loads prefs then saves prefs — two round-trip IPC calls** — Terminal.svelte:262-263.
   `invoke('load_prefs')` then `invoke('save_prefs', {...prefs, preferred_shell})` is a read-modify-
   write through IPC on every shell selection. The renderer already knows all other pref values; it
   should merge and save directly without loading first.

8. **addTab / splitTab import svelte/store dynamically inside hot code path** — Terminal.svelte:180-181,
   208-210. `await import('svelte/store')` and `await import('./stores')` inside addTab() and
   splitTab() — each new tab creation pays a dynamic import overhead (module is cached after first
   call but the await still adds a microtask tick).

9. **main.cjs SPA fallback uses fs.readFileSync** — main.cjs:221. The error-path fallback to
   index.html in handleAppProtocol uses synchronous readFileSync on the main process, blocking it
   during every failed asset request.

10. **LSP lsp_send sends full file content via IPC on every debounced keypress** — Editor.svelte:289.
    100ms debounce is correct but sends model.getValue() (entire file text) through IPC on every
    flush. For large files (>100 KB) this is expensive. Incremental changes (TextDocumentContentChangeEvent
    with ranges) would reduce payload size but require LSP server to support it.

11. **Terminal PTY data: atob + Uint8Array.from on every pty:data message** — Terminal.svelte:284.
    `Uint8Array.from(atob(data), c => c.charCodeAt(0))` allocates two intermediary objects per message.
    Use Buffer.from(data, 'base64') on the main side and send the ArrayBuffer via structured clone
    instead of base64 encoding through IPC.

12. **FileTree diagnostics subscription rebuilds two full Sets on every diagnostic update** —
    FileTree.svelte:183-194. Called for every batched diagnostic event. Iterates entire map × items.
    This runs concurrently with DiagnosticsModal's sort, both responding to the same store update.

13. **openFilePath subscription in initLsp fires findClosestVenv linear scan on every tab switch** —
    +page.svelte:483-498. Iterates entire venvList (potentially many items) on every file open.
    This is O(n) but n is typically small; low priority.

14. **grepFiles walks directories serially** — fs.cjs:97. Each subdirectory is awaited in sequence
    unlike listPyFiles which uses Promise.all. For projects with many directories this is slower
    than necessary.

**Why:** Needed for future sessions to avoid re-discovering these same issues.
**How to apply:** Reference these locations when user asks for follow-up optimization work. Items
4, 6, 7, 8 are new regressions or newly confirmed issues from this session.
