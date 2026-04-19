<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import '$lib/global.css'
  import { basename } from '$lib/path'
  import FileTree        from '$lib/FileTree.svelte'
  import Editor          from '$lib/Editor.svelte'
  import Terminal        from '$lib/Terminal.svelte'
  import StatusBar       from '$lib/StatusBar.svelte'
  import CommandPalette      from '$lib/CommandPalette.svelte'
  import DiagnosticsModal    from '$lib/DiagnosticsModal.svelte'
  import SaveDialog          from '$lib/SaveDialog.svelte'
  import type { SaveDialogType } from '$lib/SaveDialog.svelte'

  let mounted = $state(false)
  let error   = $state('')

  let mods: any = null

  // Local state (mirrors stores)
  let _projectRoot:  string | null = $state(null)
  let _openFilePath: string | null = $state(null)
  let _openTabs:     string[]      = $state([])
  let _showFileTree  = $state(true)
  let _showTerminal  = $state(true)
  let _setupReady    = $state(true)
  let _setupMessage  = $state('')
  let _pythonCmd     = $state('python3')

  // Layout
  let treeWidth      = $state(220)
  let terminalHeight = $state(220)

  // Guard to suppress session sync during a project switch.
  // Use a generation counter so concurrent openFolder calls don't reset each other's guard.
  let switchGen = 0
  let switchingProject = false

  // Command palette
  let paletteOpen = $state(false)
  let paletteMode: 'file' | 'command' = $state('file')

  // Diagnostics modal
  let diagnosticsOpen = $state(false)
  let allFiles: string[] = $state([])

  // File tab context menu
  let tabCtxMenu: { x: number; y: number; tab: string } | null = $state(null)

  // Dirty tab state (mirrored from store)
  let _dirtyTabs: Set<string> = $state(new Set())

  // Save dialogs
  let saveDialog: SaveDialogType | null = $state(null)
  // Resolver for the currently open dialog
  let dialogResolve: ((action: 'save' | 'discard' | 'cancel') => void) | null = null

  // Build a complete, consistent prefs payload from current store + layout state.
  // Defined at module scope so both the debounced auto-save and the resize onMouseUp
  // handler share the exact same object shape.
  function buildPrefsPayload() {
    const stores = mods?.stores
    if (!stores) return {}
    return {
      last_project:     mods.get(stores.projectRoot),
      project_sessions: mods.get(stores.projectSessions),
      editor_font_size: mods.get(stores.editorFontSize),
      tree_font_size:   mods.get(stores.treeFontSize),
      term_font_size:   mods.get(stores.termFontSize),
      tree_width:       treeWidth,
      terminal_height:  terminalHeight,
      show_terminal:    mods.get(stores.showTerminal),
      show_file_tree:   mods.get(stores.showFileTree),
      python_cmd:       mods.get(stores.pythonCmd),
      active_lsp:       mods.get(stores.activeLsp),
    }
  }

  // ---------------------------------------------------------------------------
  // Init helpers — extracted from onMount to keep each concern isolated.
  // Each returns an array of cleanup functions (unsubscribes / unlistens).
  // ---------------------------------------------------------------------------

  /**
   * Load saved preferences, apply them to stores / layout state, wire up the
   * debounced auto-save, and set up the LSP-switch subscription.
   * Returns: [lastProject, cleanups].
   */
  async function initPrefs(stores: any): Promise<[string | null, Array<() => void>]> {
    const unsubs: Array<() => void> = []

    // Check tooling
    try {
      const status = await mods.invoke('check_setup')
      stores.setupStatus.set(status)
      if (status.python_path) stores.pythonCmd.set(status.python_path)
      if (status.basedpyright_path) stores.langserverPath.set(status.basedpyright_path)
    } catch (e: any) {
      console.warn('check_setup:', e)
    }

    // Load preferences (layout only — project restore comes after)
    let lastProject: string | null = null
    try {
      const prefs = await mods.invoke('load_prefs')
      if (prefs.editor_font_size)  stores.editorFontSize.set(prefs.editor_font_size)
      if (prefs.tree_font_size)    stores.treeFontSize.set(prefs.tree_font_size)
      if (prefs.term_font_size)    stores.termFontSize.set(prefs.term_font_size)
      if (prefs.tree_width)        treeWidth = prefs.tree_width
      if (prefs.terminal_height)   terminalHeight = prefs.terminal_height
      if (prefs.show_terminal !== undefined)  stores.showTerminal.set(prefs.show_terminal)
      if (prefs.show_file_tree !== undefined) stores.showFileTree.set(prefs.show_file_tree)
      const VALID_LSP_IDS = ['basedpyright', 'ty']
      if (prefs.active_lsp && VALID_LSP_IDS.includes(prefs.active_lsp)) stores.activeLsp.set(prefs.active_lsp)
      if (prefs.project_sessions) stores.projectSessions.set(prefs.project_sessions)
      lastProject = prefs.last_project ?? null
    } catch (e: any) {
      console.warn('load_prefs:', e)
    }

    // Debounced auto-save
    let saveTimer: any = null
    function schedulePrefs() {
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(async () => {
        try {
          await mods.invoke('save_prefs', { prefs: buildPrefsPayload() })
        } catch {}
      }, 500)
    }
    // Sync current project's open tabs into projectSessions so the session survives a restart.
    // Uses a derived store so both openTabs + openFilePath changes produce a single callback per tick.
    // Guarded by switchingProject to avoid overwriting a just-saved session mid-switch.
    const { derived } = await import('svelte/store')
    const _sessionTrigger = derived(
      [stores.openTabs, stores.openFilePath],
      (values: unknown[]) => ({ tabs: values[0] as string[], activeFile: values[1] as string | null })
    )
    unsubs.push(_sessionTrigger.subscribe((v: any) => {
      const { tabs, activeFile } = v as { tabs: string[], activeFile: string | null }
      if (switchingProject) return
      const root = mods.get(stores.projectRoot) as string | null
      if (!root) return
      const sessions = mods.get(stores.projectSessions) as Record<string, any>
      stores.projectSessions.set({ ...sessions, [root]: { tabs, active_file: activeFile } })
    }))

    unsubs.push(stores.projectRoot.subscribe(schedulePrefs))
    unsubs.push(stores.editorFontSize.subscribe(schedulePrefs))
    unsubs.push(stores.treeFontSize.subscribe(schedulePrefs))
    unsubs.push(stores.termFontSize.subscribe(schedulePrefs))
    unsubs.push(stores.showTerminal.subscribe(schedulePrefs))
    unsubs.push(stores.showFileTree.subscribe(schedulePrefs))
    unsubs.push(stores.pythonCmd.subscribe(schedulePrefs))
    unsubs.push(stores.activeLsp.subscribe(schedulePrefs))
    unsubs.push(stores.projectSessions.subscribe(schedulePrefs))
    // Extend cleanup to flush the timer
    unsubs.push(() => { if (saveTimer) clearTimeout(saveTimer) })

    return [lastProject, unsubs]
  }

  // Config files that should trigger an LSP restart when changed externally.
  // Populated when a project is opened; cleared on project switch.
  const lspConfigFiles = new Set<string>()
  let lspRestartTimer: any = null

  async function watchConfigFiles(folder: string) {
    lspConfigFiles.clear()
    for (const name of ['pyproject.toml', 'ty.toml']) {
      const p = `${folder}/${name}`
      lspConfigFiles.add(p)
      mods.invoke('watch_file', { path: p }).catch(() => {})
    }
  }

  async function restartLsp(root: string) {
    const activeLspId = mods.get(mods.stores.activeLsp)
    const adapter = mods.adapters[activeLspId]
    const lp = adapter.id === 'basedpyright' ? mods.get(mods.stores.langserverPath) : null
    const pyCmd = mods.get(mods.stores.pythonCmd)
    mods.stores.lspStatus.set('starting')
    mods.stores.diagnosticsByUri.set(new Map())
    try {
      await mods.lspClient.start(root, adapter, pyCmd, lp ?? undefined)
      mods.stores.lspStatus.set('ready')
      scanWorkspace(root)
    } catch { mods.stores.lspStatus.set('error') }
  }

  /**
   * If the active LSP is ty and a venv python is known, write [tool.ty.environment]
   * python-version to pyproject.toml (no-op if already configured).
   */
  async function configureTyPython(projectRoot: string, pythonPath: string) {
    const activeLspId = mods.get(mods.stores.activeLsp)
    if (activeLspId !== 'ty') return
    try {
      const result = await mods.invoke('configure_ty_python', { projectRoot, pythonPath })
      if (result?.configured) {
        console.log(`[Canopy] wrote python-version = ${result.version} to pyproject.toml for ty`)
      }
    } catch (e) {
      console.warn('[Canopy] configure_ty_python failed:', e)
    }
  }

  /** Open all .py files in the LSP so it reports project-wide diagnostics. */
  async function scanWorkspace(root: string): Promise<void> {
    let paths: string[]
    try {
      paths = await mods.invoke('list_py_files', { root })
    } catch (e) {
      console.warn('[Canopy] scanWorkspace: list_py_files failed', e)
      return
    }
    console.log(`[Canopy] scanWorkspace: opening ${paths.length} Python files in LSP`)
    mods.stores.lspBusy.set(true)

    const CONCURRENCY = 12
    let idx = 0

    async function worker(): Promise<void> {
      while (idx < paths.length) {
        if (!mods.lspClient.isReady()) return
        const p = paths[idx++]
        if (mods.lspClient.isOpen(p)) continue
        try {
          const content = await mods.invoke('read_file_content', { path: p })
          if (mods.lspClient.isReady()) mods.lspClient.didOpen(p, content)
        } catch { /* skip unreadable */ }
      }
    }

    await Promise.all(Array.from({ length: CONCURRENCY }, worker))
    mods.stores.lspBusy.set(false)
    console.log('[Canopy] scanWorkspace: done')
  }

  /**
   * Start the LSP for an already-known project root, and subscribe to
   * activeLsp changes so a picker-driven switch restarts the server.
   * Returns cleanup array.
   */
  async function initLsp(stores: any, lastProject: string | null): Promise<Array<() => void>> {
    const unsubs: Array<() => void> = []

    // LSP switch subscription
    let lspInitialized = false
    let lspSwitchId = 0
    unsubs.push(stores.activeLsp.subscribe(async (lspId: string) => {
      if (!lspInitialized) { lspInitialized = true; return }  // skip initial value
      const root = mods.get(stores.projectRoot)
      if (!root) return
      const switchId = ++lspSwitchId
      stores.lspStatus.set('starting')
      stores.diagnosticsByUri.set(new Map())
      try {
        await mods.lspClient.stop()
        if (switchId !== lspSwitchId) return
        const adapter = mods.adapters[lspId]
        const lp = adapter.id === 'basedpyright' ? mods.get(stores.langserverPath) : null
        const pyCmd = mods.get(stores.pythonCmd)
        await mods.lspClient.start(root, adapter, pyCmd, lp ?? undefined)
        if (switchId !== lspSwitchId) return
        stores.lspStatus.set('ready')
        scanWorkspace(root)
      } catch (e: any) {
        if (switchId !== lspSwitchId) return
        console.error('[Canopy] LSP restart failed:', e)
        stores.lspStatus.set('error')
      }
    }))

    // Restore last project
    if (lastProject) {
      try {
        await mods.invoke('set_project_root', { root: lastProject })
        stores.projectRoot.set(lastProject)
        // Restore tab session for the last project (guard prevents syncCurrentSession from firing)
        switchingProject = true
        try {
          const savedSessions = mods.get(stores.projectSessions) as Record<string, any>
          const lastSession = savedSessions[lastProject]
          if (lastSession?.tabs?.length) {
            const prefix = lastProject + '/'
            const safeTabs = (lastSession.tabs as string[]).filter((t: string) => t.startsWith(prefix))
            if (safeTabs.length) {
              stores.openTabs.set(safeTabs)
              const af = lastSession.active_file && safeTabs.includes(lastSession.active_file)
                ? lastSession.active_file
                : safeTabs[safeTabs.length - 1]
              stores.openFilePath.set(af)
            }
          }
        } finally {
          switchingProject = false
        }
        watchConfigFiles(lastProject)
        const venvPython = await mods.invoke('detect_venv', { projectRoot: lastProject }).catch(() => null)
        if (venvPython) {
          stores.pythonCmd.set(venvPython)
          configureTyPython(lastProject, venvPython)
        } else {
          mods.invoke('watch_for_venv', { root: lastProject }).catch(() => {})
        }
        stores.lspStatus.set('starting')
        const activeLspId = mods.get(stores.activeLsp)
        const adapter = mods.adapters[activeLspId]
        const lp = adapter.id === 'basedpyright' ? mods.get(stores.langserverPath) : null
        const pyCmd = mods.get(stores.pythonCmd)
        await mods.lspClient.start(lastProject, adapter, pyCmd, lp ?? undefined)
        stores.lspStatus.set('ready')
        scanWorkspace(lastProject)
      } catch {
        stores.lspStatus.set('error')
      }
    }

    // Watch for .venv appearing in projects that didn't have one at open time
    unsubs.push(await mods.listen('venv:created', async ({ payload }: any) => {
      const { root, pythonPath } = payload
      const currentRoot = mods.get(stores.projectRoot)
      if (root !== currentRoot) return
      console.log('[Canopy] venv:created detected:', pythonPath)
      stores.pythonCmd.set(pythonPath)
      await configureTyPython(root, pythonPath)
      // Restart LSP so it picks up the new Python version from pyproject.toml
      const activeLspId = mods.get(stores.activeLsp)
      if (activeLspId !== 'ty') return
      stores.lspStatus.set('starting')
      stores.diagnosticsByUri.set(new Map())
      try {
        const adapter = mods.adapters[activeLspId]
        await mods.lspClient.start(root, adapter, pythonPath, undefined)
        stores.lspStatus.set('ready')
        scanWorkspace(root)
      } catch { stores.lspStatus.set('error') }
    }))

    return unsubs
  }

  /**
   * Register the Electron native menu:action IPC listener.
   * Returns a single-element cleanup array containing the unlisten fn.
   */
  async function initSaveListeners(ipcMod: any, stores: any): Promise<Array<() => void>> {
    const unlistens: Array<() => void> = []

    // File changed externally (e.g. Claude Code wrote to it).
    // The main process already read the new disk content and passed it in the payload,
    // having suppressed our own auto-save writes. We do a final buffer vs disk
    // comparison here so any edge-case timing issue can't produce a false dialog.
    unlistens.push(await ipcMod.listen('file:changed-on-disk', (e: any) => {
      const changedPath: string = e.payload.path
      const diskContent: string  = e.payload.diskContent

      // Config file changed (pyproject.toml / ty.toml) → debounced LSP restart
      if (lspConfigFiles.has(changedPath)) {
        const root = mods.get(stores.projectRoot)
        if (!root) return
        if (lspRestartTimer) clearTimeout(lspRestartTimer)
        lspRestartTimer = setTimeout(() => { lspRestartTimer = null; restartLsp(root) }, 800)
        return
      }

      // If a dialog is already open, ignore the event
      if (saveDialog !== null) return

      // Get current buffer content for this file
      const getBuffer = mods.get(stores.getBufferFn) as ((p: string) => string | null) | null
      const bufferContent = getBuffer ? getBuffer(changedPath) : null

      // No open model for this path — nothing to do
      if (bufferContent === null) return

      // Buffer and disk are identical — no real conflict
      if (bufferContent === diskContent) return

      // Genuine external change: buffer differs from new disk content
      openDialog({ kind: 'disk-conflict', path: changedPath })
        .then((action) => {
          if (action === 'save') {
            const saveFn = mods.get(stores.saveTabsFn)
            if (saveFn) saveFn([changedPath])
          } else if (action === 'discard') {
            const reloadFn = mods.get(stores.reloadFileFn)
            if (reloadFn) reloadFn(changedPath)
          }
        })
    }))

    // Main process asks renderer to confirm quit (window close / Cmd+Q)
    unlistens.push(await ipcMod.listen('app:before-quit', async () => {
      const dirty = mods.get(stores.dirtyTabs) as Set<string>
      const dirtyPaths = [...dirty]
      if (dirtyPaths.length === 0) {
        mods.invoke('app:confirm-quit')
        return
      }
      const action = await openDialog({ kind: 'close-app', paths: dirtyPaths })
      if (action === 'save') {
        const saveFn = mods.get(stores.saveTabsFn)
        if (saveFn) await saveFn(dirtyPaths)
        mods.invoke('app:confirm-quit')
      } else if (action === 'discard') {
        mods.invoke('app:confirm-quit')
      } else {
        mods.invoke('app:cancel-quit')
      }
    }))

    return unlistens
  }

  /** Open a save dialog and return a promise that resolves with the user's choice.
   *  If a dialog is already open, fails fast with 'cancel' to prevent orphaned Promises. */
  function openDialog(d: SaveDialogType): Promise<'save' | 'discard' | 'cancel'> {
    if (saveDialog !== null) return Promise.resolve('cancel' as const)
    return new Promise((resolve) => {
      dialogResolve = resolve
      saveDialog = d
    })
  }

  function resolveDialog(action: 'save' | 'discard' | 'cancel') {
    saveDialog = null
    const resolve = dialogResolve
    dialogResolve = null
    resolve?.(action)
  }

  async function initMenuListener(ipcMod: any): Promise<Array<() => void>> {
    const unlistenMenu = await ipcMod.listen('menu:action', (e: any) => {
      const action = e.payload as string
      if (action === 'open_folder')       openFolder()
      if (action === 'toggle_file_tree')  { _showFileTree = !_showFileTree; mods.stores.showFileTree.set(_showFileTree) }
      if (action === 'toggle_terminal')   { _showTerminal = !_showTerminal; mods.stores.showTerminal.set(_showTerminal) }
      if (action === 'command_palette')          openPalette('file')
      if (action === 'command_palette_commands') openPalette('command')
      if (action === 'zoom_in') {
        const pane = mods.get(mods.stores.focusedPane)
        if (pane === 'tree')          mods.stores.treeFontSize.update((s: number) => Math.min(s + 1, 22))
        else if (pane === 'terminal') mods.stores.termFontSize.update((s: number) => Math.min(s + 1, 22))
        else                          mods.stores.editorFontSize.update((s: number) => Math.min(s + 1, 28))
      }
      if (action === 'zoom_out') {
        const pane = mods.get(mods.stores.focusedPane)
        if (pane === 'tree')          mods.stores.treeFontSize.update((s: number) => Math.max(s - 1, 8))
        else if (pane === 'terminal') mods.stores.termFontSize.update((s: number) => Math.max(s - 1, 8))
        else                          mods.stores.editorFontSize.update((s: number) => Math.max(s - 1, 8))
      }
      if (action === 'zoom_reset') {
        mods.stores.editorFontSize.set(13)
        mods.stores.treeFontSize.set(15)
        mods.stores.termFontSize.set(13)
      }
    })
    return [unlistenMenu]
  }

  // ---------------------------------------------------------------------------

  const unsubs: (() => void)[] = []

  onMount(async () => {
    try {
      const [ipcMod, lspMod, storesMod, adapterMod] = await Promise.all([
        import('$lib/ipc'),
        import('$lib/lsp/client'),
        import('$lib/stores'),
        import('$lib/lsp/adapter'),
      ])

      mods = {
        invoke:           ipcMod.invoke,
        listen:           ipcMod.listen,
        openDialog:       ipcMod.openFolderDialog,
        get:              (await import('svelte/store')).get,
        lspClient:        lspMod.lspClient,
        stores:           storesMod,
        adapters:         adapterMod.LSP_ADAPTERS,
      }

      const { stores } = mods

      // --- Store mirror subscriptions ---
      unsubs.push(stores.projectRoot.subscribe((v: any) => { _projectRoot = v }))
      unsubs.push(stores.openFilePath.subscribe((v: any) => { _openFilePath = v }))
      unsubs.push(stores.openTabs.subscribe((v: any) => { _openTabs = v }))
      unsubs.push(stores.showFileTree.subscribe((v: any) => { _showFileTree = v }))
      unsubs.push(stores.showTerminal.subscribe((v: any) => { _showTerminal = v }))
      unsubs.push(stores.showDiagnosticsModal.subscribe((v: any) => { diagnosticsOpen = v }))
      unsubs.push(stores.pythonCmd.subscribe((v: any) => { _pythonCmd = v }))
      unsubs.push(stores.dirtyTabs.subscribe((v: Set<string>) => { _dirtyTabs = v }))
      unsubs.push(stores.setupStatus.subscribe((v: any) => {
        if (v) { _setupReady = v.ready; _setupMessage = v.message }
      }))
      // File index for command palette
      let gatherGen = 0
      unsubs.push(stores.projectRoot.subscribe(async (root: string | null) => {
        if (!root) { allFiles = []; return }
        const gen = ++gatherGen
        const files = await gatherFiles(root)
        if (gen === gatherGen) allFiles = files
      }))

      // --- Prefs: load + auto-save ---
      const [lastProject, prefUnsubs] = await initPrefs(stores)
      unsubs.push(...prefUnsubs)

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mouseup', onMouseUp)
      window.addEventListener('keydown', onKeydown)
      window.addEventListener('click', closeTabCtxMenu)

      // --- Menu listener ---
      const menuUnsubs = await initMenuListener(ipcMod)
      unsubs.push(...menuUnsubs)

      // --- Save / disk-change / quit listeners ---
      const saveUnsubs = await initSaveListeners(ipcMod, stores)
      unsubs.push(...saveUnsubs)

      mounted = true

      // --- LSP: switch subscription + project restore ---
      const lspUnsubs = await initLsp(stores, lastProject)
      unsubs.push(...lspUnsubs)

    } catch (e: any) {
      error = e?.message ?? String(e)
      console.error('Mount failed:', e)
    }
  })

  onDestroy(() => {
    unsubs.forEach(u => u())
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
    window.removeEventListener('keydown', onKeydown)
    window.removeEventListener('click', closeTabCtxMenu)
  })

  // --- Tab management ---

  function openFileInTab(path: string, line?: number) {
    const { stores } = mods
    const tabs = mods.get(stores.openTabs) as string[]
    if (!tabs.includes(path)) {
      stores.openTabs.set([...tabs, path])
    }
    stores.openFilePath.set(path)
    if (line) {
      // Small delay to let the file load, then jump to line
      setTimeout(() => stores.revealLine.set(line), 200)
    }
  }

  async function closeTab(path: string, e?: MouseEvent) {
    e?.stopPropagation()
    if (saveDialog !== null) return  // another dialog is already open
    const dirty = mods.get(mods.stores.dirtyTabs) as Set<string>
    if (dirty.has(path)) {
      const action = await openDialog({ kind: 'close-tab', path })
      if (action === 'cancel') return
      if (action === 'save') {
        const saveFn = mods.get(mods.stores.saveTabsFn)
        if (saveFn) await saveFn([path])
        return  // saved — keep the tab open
      }
      // 'discard' falls through to close without saving
    }
    _doCloseTab(path)
  }

  function _doCloseTab(path: string) {
    const { stores } = mods
    const tabs = (mods.get(stores.openTabs) as string[]).filter(t => t !== path)
    stores.openTabs.set(tabs)
    if (mods.get(stores.openFilePath) === path) {
      stores.openFilePath.set(tabs.length > 0 ? tabs[tabs.length - 1] : null)
    }
    mods.invoke('unwatch_file', { path }).catch(() => {})
    // Dispose Monaco model + clean up Editor state (prevents stale getBufferFn results)
    const disposeFn = mods.get(stores.disposeTabFn) as ((p: string) => void) | null
    if (disposeFn) disposeFn(path)
  }

  function switchTab(path: string) {
    mods.stores.openFilePath.set(path)
  }

  function closeOtherTabs(path: string) {
    const { stores } = mods
    stores.openTabs.set([path])
    stores.openFilePath.set(path)
  }

  function closeTabCtxMenu() { tabCtxMenu = null }

  function onTabContextMenu(e: MouseEvent, tab: string) {
    e.preventDefault()
    e.stopPropagation()
    tabCtxMenu = { x: e.clientX, y: e.clientY, tab }
  }

  // --- File operations ---

  async function gatherFiles(dir: string, depth = 0): Promise<string[]> {
    if (depth > 6) return []
    const entries = await mods.invoke('read_dir_recursive', { path: dir, depth })
    const results: string[] = []
    for (const e of entries as any[]) {
      if (e.is_dir) results.push(...await gatherFiles(e.path, depth + 1))
      else results.push(e.path)
    }
    return results
  }

  async function openFolder() {
    const sel = await mods.openDialog()
    console.log('[Canopy] dialog result:', sel, typeof sel)
    if (!sel) return
    const folder = typeof sel === 'string' ? sel : String(sel)
    console.log('[Canopy] opening folder:', folder)

    // Save current project's tab session before switching
    const currentRoot = mods.get(mods.stores.projectRoot) as string | null
    const currentTabs = mods.get(mods.stores.openTabs) as string[]
    const currentFile = mods.get(mods.stores.openFilePath) as string | null
    if (currentRoot) {
      const sessions = mods.get(mods.stores.projectSessions) as Record<string, any>
      mods.stores.projectSessions.set({ ...sessions, [currentRoot]: { tabs: currentTabs, active_file: currentFile } })
      await mods.invoke('save_prefs', { prefs: buildPrefsPayload() }).catch(() => {})
    }

    // Suppress session sync while we're tearing down and restoring.
    // Track a generation so a concurrent openFolder call doesn't reset our guard early.
    const myGen = ++switchGen
    switchingProject = true
    try {
      // Dispose Monaco models and unwatch files for all current tabs
      const disposeFn = mods.get(mods.stores.disposeTabFn) as ((p: string) => void) | null
      for (const tab of currentTabs) {
        mods.invoke('unwatch_file', { path: tab }).catch(() => {})
        disposeFn?.(tab)
      }
      mods.stores.openTabs.set([])
      mods.stores.openFilePath.set(null)
      mods.stores.dirtyTabs.set(new Set())

      mods.stores.projectRoot.set(folder)
      watchConfigFiles(folder)

      // Restore saved session for the new folder.
      // Filter tab paths to those within this folder to prevent path-traversal from a crafted prefs file.
      const sessions = mods.get(mods.stores.projectSessions) as Record<string, any>
      const session = sessions[folder]
      if (session?.tabs?.length) {
        const prefix = folder + '/'
        const safeTabs = (session.tabs as string[]).filter(t => t.startsWith(prefix))
        if (safeTabs.length) {
          mods.stores.openTabs.set(safeTabs)
          const af = session.active_file && safeTabs.includes(session.active_file)
            ? session.active_file
            : safeTabs[safeTabs.length - 1]
          mods.stores.openFilePath.set(af)
        }
      }
    } finally {
      if (myGen === switchGen) switchingProject = false
    }

    // Auto-detect venv
    let detectedPython: string | null = null
    try {
      detectedPython = await mods.invoke('detect_venv', { projectRoot: folder })
      if (detectedPython) {
        console.log('[Canopy] detected venv python:', detectedPython)
        mods.stores.pythonCmd.set(detectedPython)
        configureTyPython(folder, detectedPython)
      } else {
        mods.invoke('watch_for_venv', { root: folder }).catch(() => {})
      }
    } catch (e) {
      console.warn('detect_venv:', e)
    }

    // Start LSP
    mods.stores.lspStatus.set('starting')
    mods.stores.diagnosticsByUri.set(new Map())
    try {
      const activeLspId = mods.get(mods.stores.activeLsp)
      const adapter = mods.adapters[activeLspId]
      const lp = adapter.id === 'basedpyright' ? mods.get(mods.stores.langserverPath) : null
      console.log('[Canopy] starting LSP:', activeLspId, 'langserver:', lp)
      const pyCmd = mods.get(mods.stores.pythonCmd)
      await mods.lspClient.start(folder, adapter, pyCmd, lp ?? undefined)
      console.log('[Canopy] LSP started successfully')
      mods.stores.lspStatus.set('ready')
      scanWorkspace(folder)
    } catch (e) {
      console.error('[Canopy] LSP start failed:', e)
      mods.stores.lspStatus.set('error')
    }
  }

  // --- Keyboard shortcuts ---

  function onKeydown(e: KeyboardEvent) {
    // Let any open modal handle its own keys exclusively
    if (saveDialog !== null) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key === 'w') { e.preventDefault(); if (_openFilePath) closeTab(_openFilePath) }
    if (mod && e.shiftKey && e.key === 'p') { e.preventDefault(); openPalette('command') }
    if (mod && !e.shiftKey && e.key === 's') {
      e.preventDefault()
      const saveFn = mods?.get(mods.stores.saveTabsFn)
      if (saveFn) saveFn([...(_openTabs)])
    }
  }

  // --- Resize ---

  let resizingTree = false, resizingTerm = false
  let _rafId = 0
  function startResizeTree(e: MouseEvent) { resizingTree = true; e.preventDefault() }
  function startResizeTerm(e: MouseEvent) { resizingTerm = true; e.preventDefault() }
  function onMouseMove(e: MouseEvent) {
    if (!resizingTree && !resizingTerm) return
    cancelAnimationFrame(_rafId)
    _rafId = requestAnimationFrame(() => {
      if (resizingTree) treeWidth = Math.max(140, Math.min(480, e.clientX))
      if (resizingTerm) {
        const wh = window.innerHeight - 62
        terminalHeight = Math.max(80, Math.min(wh - 100, window.innerHeight - e.clientY - 24))
      }
    })
  }
  function onMouseUp() {
    const wasResizing = resizingTree || resizingTerm
    resizingTree = false; resizingTerm = false
    // Save layout prefs after resize
    if (wasResizing && mods) {
      mods.invoke('save_prefs', { prefs: buildPrefsPayload() }).catch(() => {})
    }
  }

  // --- Command Palette ---

  function openPalette(m: 'file' | 'command' = 'file') {
    paletteMode = m
    paletteOpen = true
  }
  function closePalette() { paletteOpen = false }

  function handleFindInFile(query: string) {
    const monacoEditor = mods?.get(mods.stores.monacoEditorRef)
    if (!monacoEditor) return
    monacoEditor.getAction('actions.find')?.run()
    setTimeout(() => {
      const fc = monacoEditor.getContribution('editor.contrib.findController')
      if (fc && query) fc.setSearchString(query)
    }, 50)
  }

  function handleRevealLine(line: number) {
    mods.stores.revealLine.set(line)
  }

  function getCurrentFileContent(): { path: string; content: string } | null {
    const editor = mods?.get(mods.stores.monacoEditorRef)
    if (!editor || !_openFilePath) return null
    const model = editor.getModel()
    if (!model) return null
    return { path: _openFilePath, content: model.getValue() }
  }

</script>

{#if error}
  <div class="error-screen">
    <p>Failed to initialize:</p>
    <pre>{error}</pre>
  </div>
{:else if !mounted}
  <div class="loading">Loading…</div>
{:else}
<div class="app">

  {#if !_setupReady}
    <div class="setup-banner"><span>{_setupMessage}</span></div>
  {/if}

  <div class="workspace" style="--tree-w:{treeWidth}px;--term-h:{terminalHeight}px">
    {#if _showFileTree && _projectRoot}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="panel filetree" onmousedown={() => mods?.stores?.focusedPane?.set('tree')}>
        <FileTree />
      </div>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="resize-v" onmousedown={startResizeTree}></div>
    {/if}

    <div class="editor-col">
      <!-- Tab bar -->
      <div class="tab-bar">
        {#if _openTabs.length > 0}
          {#each _openTabs as tab}
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div role="tab" tabindex="0" class="tab" class:active={tab === _openFilePath} class:dirty={_dirtyTabs.has(tab)} onclick={() => switchTab(tab)} oncontextmenu={(e) => onTabContextMenu(e, tab)}>
              {#if _dirtyTabs.has(tab)}<span class="dirty-dot" aria-label="unsaved">●</span>{/if}
              <span class="tab-name">{basename(tab)}</span>
              <button class="tab-close" onclick={(e) => closeTab(tab, e)}>×</button>
            </div>
          {/each}
        {:else if _projectRoot}
          <span class="tab-hint">Cmd+O to open a folder</span>
        {:else}
          <span class="tab-hint">Cmd+O to open a folder</span>
        {/if}
      </div>

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="editor-focus-wrap" onmousedown={() => mods.stores.focusedPane.set('editor')}>
        <Editor />
      </div>

      {#if true}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="resize-h" onmousedown={startResizeTerm}></div>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="term-panel" style="height:{terminalHeight}px" onmousedown={() => mods.stores.focusedPane.set('terminal')}>
          <Terminal />
        </div>
      {/if}
    </div>
  </div>

  <StatusBar />
</div>

{#if tabCtxMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="ctx-menu" style="left:{tabCtxMenu.x}px;top:{tabCtxMenu.y}px" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
    <button onclick={() => { closeTab(tabCtxMenu!.tab); tabCtxMenu = null }}>Close</button>
    <button onclick={() => { closeOtherTabs(tabCtxMenu!.tab); tabCtxMenu = null }}>Close Others</button>
  </div>
{/if}

<CommandPalette
  open={paletteOpen}
  mode={paletteMode}
  {allFiles}
  projectRoot={_projectRoot}
  onClose={closePalette}
  onOpenFile={openFileInTab}
  onFindInFile={handleFindInFile}
  onRevealLine={handleRevealLine}
  onGetCurrentFileContent={getCurrentFileContent}
  onToggleTerminal={() => { _showTerminal = !_showTerminal; mods.stores.showTerminal.set(_showTerminal) }}
  onToggleTree={() => { _showFileTree = !_showFileTree; mods.stores.showFileTree.set(_showFileTree) }}
/>

<DiagnosticsModal
  open={diagnosticsOpen}
  onClose={() => { diagnosticsOpen = false; mods?.stores?.showDiagnosticsModal?.set(false) }}
  onRevealLine={handleRevealLine}
  getFileContent={getCurrentFileContent}
/>

<SaveDialog
  dialog={saveDialog}
  onSave={() => resolveDialog('save')}
  onDiscard={() => resolveDialog('discard')}
  onCancel={() => resolveDialog('cancel')}
/>
{/if}

<style>
  .error-screen { height:100vh; display:flex; flex-direction:column; align-items:center; justify-content:center; background:#1c1c1c; color:#e06c75; font-family:monospace; font-size:12px; gap:8px; }
  .error-screen pre { background:#252525; padding:12px; border-radius:4px; max-width:80vw; overflow:auto; color:#d4d4d4; }
  .loading { height:100vh; display:flex; align-items:center; justify-content:center; background:#1c1c1c; color:#4a4a4a; font-family:monospace; font-size:12px; }

  .app { display:flex; flex-direction:column; height:100vh; overflow:hidden; background:var(--bg-editor); }

  .setup-banner { display:flex; align-items:center; justify-content:center; padding:4px 12px; font-size:11px; color:var(--warning); background:rgba(229,192,123,.08); border-bottom:1px solid rgba(229,192,123,.2); flex-shrink:0; }

  .workspace { display:flex; flex:1; overflow:hidden; min-height:0; }
  .panel { flex-shrink:0; display:flex; flex-direction:column; overflow:hidden; background:var(--bg-panel); }
  .filetree { width:var(--tree-w,220px); }

  .resize-v { width:1px; cursor:col-resize; background:var(--border); flex-shrink:0; transition:background .15s; }
  .resize-v:hover { background:var(--accent); }
  .resize-h { height:2px; cursor:row-resize; background:var(--border); flex-shrink:0; transition:background .15s; }
  .resize-h:hover { background:var(--accent); }

  .editor-col { flex:1; display:flex; flex-direction:column; overflow:hidden; min-width:0; background:var(--bg-statusbar); }
  .editor-focus-wrap { flex:1; display:flex; flex-direction:column; overflow:hidden; }

  /* Tab bar */
  .tab-bar {
    display:flex; align-items:stretch; height:32px; background:var(--bg-statusbar);
    border-bottom:1px solid var(--border); flex-shrink:0; overflow-x:auto; overflow-y:hidden;
  }
  .tab-bar::-webkit-scrollbar { height:0; }
  .tab-hint { display:flex; align-items:center; padding:0 14px; font-size:11px; color:var(--text-muted); }
  .tab {
    display:flex; align-items:center; gap:6px; padding:0 12px;
    font-size:11px; color:var(--text-secondary); cursor:pointer;
    border-right:1px solid var(--border); white-space:nowrap;
    transition:background .08s; flex-shrink:0;
  }
  .tab:hover { background:var(--bg-hover); }
  .tab.active { background:var(--bg-editor); color:var(--text-primary); border-bottom:1px solid var(--accent); margin-bottom:-1px; }
  .tab-name { pointer-events:none; }
  .dirty-dot {
    font-size: 7px; color: var(--accent); opacity: 0.75; flex-shrink: 0;
    line-height: 1; pointer-events: none;
  }
  .tab-close {
    font-size:14px; line-height:1; color:var(--text-muted); cursor:pointer;
    border-radius:3px; width:16px; height:16px; display:flex; align-items:center; justify-content:center;
    background: none; border: none; padding: 0;
  }
  .tab-close:hover { background:var(--bg-hover); color:var(--text-primary); }

  .term-panel { flex-shrink:0; overflow:hidden; }

  .ctx-menu {
    position: fixed; z-index: 9999;
    background: var(--bg-editor); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 0; min-width: 140px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.35);
  }
  .ctx-menu button {
    display: block; width: 100%; text-align: left;
    padding: 6px 14px; font-size: 12px; background: none;
    border: none; cursor: pointer; color: var(--text-secondary);
  }
  .ctx-menu button:hover { background: var(--bg-hover); color: var(--text-primary); }

</style>
