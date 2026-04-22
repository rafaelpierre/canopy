<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import '$lib/global.css'
  import FileTree        from '$lib/FileTree.svelte'
  import Editor          from '$lib/Editor.svelte'
  import Terminal        from '$lib/Terminal.svelte'
  import StatusBar       from '$lib/StatusBar.svelte'
  import MenuBar         from '$lib/MenuBar.svelte'
  import CommandPalette      from '$lib/CommandPalette.svelte'
  import DiagnosticsModal    from '$lib/DiagnosticsModal.svelte'
  import SaveDialog          from '$lib/SaveDialog.svelte'
  import type { SaveDialogType } from '$lib/SaveDialog.svelte'
  import { menuFocus, handleMenuKeydown } from '$lib/menu-utils'
  import TabBar from '$lib/TabBar.svelte'
  import { createVenvManager } from '$lib/venv-utils'
  import { scanWorkspace } from '$lib/lsp/manager'

  let mounted = $state(false)
  let error   = $state('')

  // Toast notifications
  interface Toast { id: number; message: string }
  let toasts: Toast[] = $state([])
  let toastId = 0
  function showToast(message: string, duration = 3000) {
    const id = toastId++
    toasts = [...toasts, { id, message }]
    setTimeout(() => { toasts = toasts.filter(t => t.id !== id) }, duration)
  }

  // Terminal split/new tab — wired via MenuBar callbacks
  let terminalRef: any = $state(null)

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
      // preferred_shell saved separately by Terminal.svelte
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

  async function startLsp(root: string, stores: any): Promise<void> {
    const activeLspId = mods.get(stores.activeLsp)
    const adapter = mods.adapters[activeLspId]
    const lp = adapter.id === 'basedpyright' ? mods.get(stores.langserverPath) : null
    const pyCmd = mods.get(stores.pythonCmd)
    stores.lspStatus.set('starting')
    stores.diagnosticsByUri.set(new Map())
    try {
      await mods.lspClient.start(root, adapter, pyCmd, lp ?? undefined)
      stores.lspStatus.set('ready')
      scanWorkspace(root, { invoke: mods.invoke, lspClient: mods.lspClient, stores })
    } catch {
      stores.lspStatus.set('error')
    }
  }

  function restartLsp(root: string) { startLsp(root, mods.stores) }

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

  let venvManager: ReturnType<typeof createVenvManager> | null = null

  function findVenvForFile(filePath: string) { return venvManager?.findVenvForFile(filePath) }
  function preloadVenvCache(root: string) { venvManager?.preloadVenvCache(root) }

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
    unsubs.push(stores.activeLsp.subscribe(async (_lspId: string) => {
      if (!lspInitialized) { lspInitialized = true; return }  // skip initial value
      const root = mods.get(stores.projectRoot)
      if (!root) return
      const switchId = ++lspSwitchId
      stores.lspStatus.set('starting')
      stores.diagnosticsByUri.set(new Map())
      try { await mods.lspClient.stop() } catch {}
      if (switchId !== lspSwitchId) return
      await startLsp(root, stores)
    }))

    // Restore last project
    if (lastProject) {
      try {
        await mods.invoke('set_project_root', { root: lastProject })
        stores.projectRoot.set(lastProject)
        preloadVenvCache(lastProject)
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
        }
        venvManager?.clearMemo()
        mods.invoke('watch_for_venv', { root: lastProject, recursive: true }).catch(() => {})
        await startLsp(lastProject, stores)
      } catch {
        stores.lspStatus.set('error')
      }
    }

    // Watch for .venv appearing (at any depth) after project open.
    // The watcher deduplicates, so this fires once per newly created venv.
    let venvLspRestartTimer: any = null
    unsubs.push(await mods.listen('venv:created', async ({ payload }: any) => {
      const { root, pythonPath, venvPath } = payload
      const currentRoot = mods.get(stores.projectRoot)
      if (!root || !currentRoot) return
      if (root !== currentRoot && !root.startsWith(currentRoot + '/')) return
      console.log('[Canopy] venv:created:', pythonPath)
      // Update venvMap
      const currentList = mods.get(stores.venvMap) as any[]
      if (!currentList.some((v: any) => v.pythonPath === pythonPath)) {
        stores.venvMap.set([...currentList, { subdir: root, pythonPath, venvPath: venvPath ?? '', isUv: false }])
      }
      stores.pythonCmd.set(pythonPath)
      const venvName = venvPath ? venvPath.split('/').pop() : '.venv'
      showToast(`Using ${venvName}`)
      await configureTyPython(currentRoot, pythonPath)
      // Debounce LSP restart — watcher may send one event per file inside the venv
      if (mods.get(stores.activeLsp) !== 'ty') return
      if (venvLspRestartTimer) clearTimeout(venvLspRestartTimer)
      venvLspRestartTimer = setTimeout(async () => {
        venvLspRestartTimer = null
        await startLsp(currentRoot, stores)
      }, 800)
    }))

    // Walk-up venv discovery: for each opened file, find the closest ancestor .venv
    // (bounded by project root) and auto-switch pythonCmd. O(depth) stats per file,
    // no recursive scanning. Toast only on actual pythonCmd change.
    let _lastToastedVenv = ''
    unsubs.push(stores.pythonCmd.subscribe((cmd: string) => {
      if (!cmd || cmd === _lastToastedVenv) return
      // Derive venvPath from pythonCmd to produce a readable toast
      const m = cmd.match(/^(.+?)\/(?:bin\/python\d*|Scripts\/python\.exe)$/)
      if (!m) { _lastToastedVenv = cmd; return }
      const venvPath = m[1]
      if (_lastToastedVenv) {  // skip initial value
        const venvName = venvPath.split('/').pop() ?? '.venv'
        const parent = venvPath.split('/').slice(0, -1).join('/')
        const root = mods.get(stores.projectRoot) as string | null
        const rel = root && parent !== root ? ` · ${parent.split('/').pop()}` : ''
        showToast(`Using ${venvName}${rel}`)
      }
      _lastToastedVenv = cmd
    }))

    unsubs.push(stores.openFilePath.subscribe((filePath: string | null) => {
      if (!filePath) return
      findVenvForFile(filePath)
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

      const dirty = mods.get(stores.dirtyTabs) as Set<string>
      if (dirty.has(changedPath)) {
        // Buffer has unsaved user edits — keep dialog to avoid data loss
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
      } else {
        // Buffer is clean — auto-reload from disk and show a brief toast
        const reloadFn = mods.get(stores.reloadFileFn)
        if (reloadFn) {
          reloadFn(changedPath)
          showToast('File reloaded from disk')
        }
      }
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
      if (action === 'open_folder')              openFolder()
      if (action === 'toggle_file_tree')         doToggleTree()
      if (action === 'toggle_terminal')          doToggleTerminal()
      if (action === 'command_palette')          openPalette('file')
      if (action === 'command_palette_commands') openPalette('command')
      if (action === 'zoom_in')                  doZoomIn()
      if (action === 'zoom_out')                 doZoomOut()
      if (action === 'zoom_reset')               doZoomReset()
      if (action === 'new_terminal_tab')         terminalRef?.addTab?.()
      if (action === 'split_terminal')           terminalRef?.splitActiveTab?.()
    })
    return [unlistenMenu]
  }

  // Helper actions used by both MenuBar and keyboard shortcuts
  function doToggleTree()     { _showFileTree = !_showFileTree; mods?.stores?.showFileTree?.set(_showFileTree) }
  function doToggleTerminal() { _showTerminal = !_showTerminal; mods?.stores?.showTerminal?.set(_showTerminal) }
  function doZoomIn() {
    if (!mods) return
    const pane = mods.get(mods.stores.focusedPane)
    if (pane === 'tree')          mods.stores.treeFontSize.update((s: number) => Math.min(s + 1, 22))
    else if (pane === 'terminal') mods.stores.termFontSize.update((s: number) => Math.min(s + 1, 22))
    else                          mods.stores.editorFontSize.update((s: number) => Math.min(s + 1, 28))
  }
  function doZoomOut() {
    if (!mods) return
    const pane = mods.get(mods.stores.focusedPane)
    if (pane === 'tree')          mods.stores.treeFontSize.update((s: number) => Math.max(s - 1, 8))
    else if (pane === 'terminal') mods.stores.termFontSize.update((s: number) => Math.max(s - 1, 8))
    else                          mods.stores.editorFontSize.update((s: number) => Math.max(s - 1, 8))
  }
  function doZoomReset() {
    if (!mods) return
    mods.stores.editorFontSize.set(13)
    mods.stores.treeFontSize.set(15)
    mods.stores.termFontSize.set(13)
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

      console.log('[Canopy] build marker: lazy-venv + cache v2 + async get_python_paths')

      venvManager = createVenvManager({ invoke: mods.invoke, get: mods.get, stores: {
        projectRoot:  stores.projectRoot,
        pythonCmd:    stores.pythonCmd,
        venvMap:      stores.venvMap,
        venvScanning: stores.venvScanning,
      }})

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

  async function gatherFiles(dir: string): Promise<string[]> {
    const tree = await mods.invoke('read_dir_recursive', { path: dir, depth: 6 }) as any[]
    const results: string[] = []
    function flatten(entries: any[]) {
      for (const e of entries) {
        if (e.is_dir) { if (e.children) flatten(e.children) }
        else results.push(e.path)
      }
    }
    flatten(tree)
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
      mods.stores.venvMap.set([])
      preloadVenvCache(folder)
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

    // Auto-detect venv (root-level fast path only; subdirectory venvs found lazily)
    try {
      const detectedPython = await mods.invoke('detect_venv', { projectRoot: folder })
      if (detectedPython) {
        console.log('[Canopy] detected venv python:', detectedPython)
        mods.stores.pythonCmd.set(detectedPython)
        configureTyPython(folder, detectedPython)
      }
    } catch (e) {
      console.warn('detect_venv:', e)
    }
    venvManager?.clearMemo()
    mods.invoke('watch_for_venv', { root: folder, recursive: true }).catch(() => {})

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
      scanWorkspace(folder, { invoke: mods.invoke, lspClient: mods.lspClient, stores: mods.stores })
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
    if (mod && !e.shiftKey && e.key === 'p') { e.preventDefault(); openPalette('file') }
    if (mod && !e.shiftKey && e.key === 's') {
      e.preventDefault()
      const saveFn = mods?.get(mods.stores.saveTabsFn)
      if (saveFn) saveFn([...(_openTabs)])
    }
    if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); doZoomIn() }
    if (mod && (e.key === '-' || e.key === '_')) { e.preventDefault(); doZoomOut() }
    if (mod && e.key === '0') { e.preventDefault(); doZoomReset() }
    if (mod && e.key === 'b') { e.preventDefault(); doToggleTree() }
    if (mod && e.key === 'j') { e.preventDefault(); doToggleTerminal() }
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
  <div class="loading" role="status" aria-live="polite">Loading…</div>
{:else}
<div class="app">

  <MenuBar
    onOpenFolder={openFolder}
    onToggleTree={doToggleTree}
    onToggleTerminal={doToggleTerminal}
    onZoomIn={doZoomIn}
    onZoomOut={doZoomOut}
    onZoomReset={doZoomReset}
    onCommandPalette={() => openPalette('file')}
    onCommandPaletteCommands={() => openPalette('command')}
    onNewTerminalTab={() => (terminalRef as any)?.addTab?.()}
    onSplitTerminal={() => (terminalRef as any)?.splitActiveTab?.()}
  />

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
      <TabBar
        tabs={_openTabs}
        activeTab={_openFilePath}
        dirtyTabs={_dirtyTabs}
        onTabClick={switchTab}
        onTabClose={closeTab}
        onTabContextMenu={onTabContextMenu}
      />

      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="editor-focus-wrap" onmousedown={() => mods.stores.focusedPane.set('editor')}>
        <Editor />
      </div>

      <div style:display={_showTerminal ? 'contents' : 'none'}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="resize-h" onmousedown={startResizeTerm}></div>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="term-panel" style="height:{terminalHeight}px" onmousedown={() => mods.stores.focusedPane.set('terminal')}>
          <Terminal bind:this={terminalRef} />
        </div>
      </div>
    </div>
  </div>

  <StatusBar {showToast} />
</div>

{#if tabCtxMenu}
  <div
    class="ctx-menu"
    role="menu"
    tabindex="-1"
    style="left:{tabCtxMenu.x}px;top:{tabCtxMenu.y}px"
    use:menuFocus
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => handleMenuKeydown(e, () => { tabCtxMenu = null })}
  >
    <button role="menuitem" onclick={() => { closeTab(tabCtxMenu!.tab); tabCtxMenu = null }}>Close</button>
    <button role="menuitem" onclick={() => { closeOtherTabs(tabCtxMenu!.tab); tabCtxMenu = null }}>Close Others</button>
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

<div class="toast-container" aria-live="polite" aria-atomic="true">
  {#each toasts as toast (toast.id)}
    <div class="toast">{toast.message}</div>
  {/each}
</div>
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

  .term-panel { flex-shrink:0; overflow:hidden; }

  .ctx-menu {
    position: fixed; z-index: 9999;
    background: var(--bg-editor); border: 1px solid var(--border);
    border-radius: 8px; padding: 4px 0; min-width: 140px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.35);
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  }
  .ctx-menu button {
    display: block; width: 100%; text-align: left;
    padding: 6px 14px; font-size: 12px; background: none;
    border: none; cursor: pointer; color: var(--text-secondary);
    font-family: inherit;
  }
  .ctx-menu button:hover { background: var(--bg-hover); color: var(--text-primary); }

  /* Toast notifications */
  .toast-container {
    position: fixed; bottom: 36px; right: 12px;
    display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
    z-index: 10000; pointer-events: none;
  }
  .toast {
    background: rgba(30,30,30,0.95); color: var(--text-primary);
    border: 1px solid var(--border); border-radius: 5px;
    padding: 7px 16px; font-size: 12px;
    box-shadow: 0 3px 10px rgba(0,0,0,0.4);
    animation: toast-in 0.15s ease;
  }
  @keyframes toast-in {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }

</style>
