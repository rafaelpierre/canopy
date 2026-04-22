<script lang="ts">
  import { onMount, onDestroy } from 'svelte'

  interface Props { showToast?: (msg: string, duration?: number) => void }
  let { showToast }: Props = $props()

  let _diagnostics     = $state({ errors: 0, warnings: 0 })
  let _fileErrors      = $state(0)
  let _fileWarnings    = $state(0)
  let _diagByUri       = $state<Map<string, any[]>>(new Map())
  let _lspStatus       = $state<string>('stopped')
  let _lspBusy         = $state(false)
  let _venvScanning    = $state(false)
  let _installing      = $state(false)
  let _installPending  = $state<string | null>(null)  // lspId awaiting confirmation
  let _openFile        = $state<string | null>(null)
  let _pythonCmd       = $state('python3')
  let _venvMap         = $state<any[]>([])
  let _projectRoot     = $state<string | null>(null)
  let _activeLsp       = $state<string>('basedpyright')
  let stores: any
  let invoke: any
  let _clickCleanup: (() => void) | null = null
  let lspCtxMenu: { x: number; bottom: number; right: number } | null = $state(null)
  let venvMenu: { x: number; bottom: number } | null = $state(null)

  function recomputeFileCounts(map: Map<string, any[]>, path: string | null) {
    if (!path) { _fileErrors = 0; _fileWarnings = 0; return }
    // Key must match what the LSP sends back — same encoding as pathToUri in client.ts
    const uri = encodeURI('file://' + path)
    const items = map.get(uri) ?? []
    let errors = 0, warnings = 0
    for (const d of items) {
      if (d.severity === 8) errors++
      else if (d.severity === 4) warnings++
    }
    _fileErrors = errors
    _fileWarnings = warnings
  }

  onMount(async () => {
    const ipcMod = await import('$lib/ipc')
    invoke = ipcMod.invoke
    stores = await import('./stores')
    const _unsubs: (() => void)[] = []
    _unsubs.push(stores.diagnostics.subscribe((v: any) => { _diagnostics = v }))
    _unsubs.push(stores.diagnosticsByUri.subscribe((map: any) => {
      _diagByUri = map
      recomputeFileCounts(map, _openFile)
    }))
    _unsubs.push(stores.lspStatus.subscribe((v: any) => { _lspStatus = v }))
    _unsubs.push(stores.lspBusy.subscribe((v: any) => { _lspBusy = v }))
    _unsubs.push(stores.venvScanning.subscribe((v: any) => { _venvScanning = v }))
    _unsubs.push(stores.openFilePath.subscribe((v: any) => {
      _openFile = v
      recomputeFileCounts(_diagByUri, v)
    }))
    _unsubs.push(stores.pythonCmd.subscribe((v: any) => { _pythonCmd = v }))
    _unsubs.push(stores.venvMap.subscribe((v: any) => { _venvMap = v }))
    _unsubs.push(stores.projectRoot.subscribe((v: any) => { _projectRoot = v }))
    _unsubs.push(stores.activeLsp.subscribe((v: any) => { _activeLsp = v }))
    window.addEventListener('click', closeAllMenus)
    _clickCleanup = () => {
      window.removeEventListener('click', closeAllMenus)
      for (const u of _unsubs) u()
    }
  })

  onDestroy(() => _clickCleanup?.())

  let filename = $derived(_openFile ? _openFile.split('/').pop() : null)

  function pythonLabel(cmd: string): string {
    if (cmd.includes('.venv') || cmd.includes('venv')) {
      const parts = cmd.split('/')
      const venvIdx = parts.findIndex(p => p === '.venv' || p === 'venv' || p === '.env' || p === 'env')
      if (venvIdx >= 0) return `(${parts[venvIdx]}) python`
    }
    return cmd.split('/').pop() ?? cmd
  }

  async function selectPython() {
    const { openFileDialog } = await import('$lib/ipc')
    const selected = await openFileDialog({
      title: 'Select Python Interpreter',
      filters: [{ name: 'Python', extensions: ['*'] }],
    })
    if (selected && typeof selected === 'string') {
      stores.pythonCmd.set(selected)
    }
  }

  function closeAllMenus() { lspCtxMenu = null; venvMenu = null }
  function closeLspCtxMenu() { lspCtxMenu = null }

  function venvLabel(v: any, projectRoot: string | null): string {
    if (!projectRoot) return pythonLabel(v.pythonPath)
    const rel = v.subdir === projectRoot ? '.' : v.subdir.replace(projectRoot + '/', '')
    const venvName = v.venvPath.split('/').pop() ?? '.venv'
    const uvTag = v.isUv ? ' uv' : ''
    return `(${venvName}${uvTag}) · ${rel}`
  }

  function showVenvMenu(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    lspCtxMenu = null
    const target = (e.currentTarget as HTMLElement).getBoundingClientRect()
    venvMenu = { x: target.left, bottom: window.innerHeight - target.top + 2 }
  }

  async function pickVenv(pythonPath: string) {
    venvMenu = null
    stores.pythonCmd.set(pythonPath)
  }

  function lspMenuFocus(node: HTMLElement) {
    requestAnimationFrame(() => node.querySelector<HTMLElement>('[role="menuitem"]')?.focus())
    return {}
  }

  function showLspMenu(e: MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    const target = (e.currentTarget as HTMLElement).getBoundingClientRect()
    lspCtxMenu = {
      x: target.left,
      bottom: window.innerHeight - target.top + 2,
      right: window.innerWidth - target.right,
    }
  }

  async function selectLsp(lspId: string) {
    if (lspId === _activeLsp) {
      closeLspCtxMenu()
      return
    }

    // Check availability before switching
    const { available } = await invoke('check_lsp_available', { lspId })
    if (!available) {
      // Show toaster confirmation instead of blocking dialog
      closeLspCtxMenu()
      _installPending = lspId
      return
    }

    // Switch LSP — +page.svelte watches activeLsp and handles the restart
    stores.activeLsp.set(lspId)
    closeLspCtxMenu()
  }

  async function confirmInstall() {
    const lspId = _installPending
    if (!lspId) return
    _installPending = null
    _installing = true
    try {
      const response = await invoke('install_ty')
      if (!response.success) {
        showToast?.(`Failed to install ${lspId}: ${response.message}`, 5000)
        return
      }
      stores.activeLsp.set(lspId)
    } catch (e: any) {
      showToast?.(`Failed to install ${lspId}: ${e?.message ?? e}`, 5000)
    } finally {
      _installing = false
    }
  }

  function cancelInstall() { _installPending = null }
</script>

<div class="statusbar">
  <div class="left">
    {#if _venvMap.length > 1}
      <button class="item python-cmd clickable" onclick={showVenvMenu} title={_pythonCmd}>
        {pythonLabel(_pythonCmd)} <span class="venv-caret">▾</span>
      </button>
    {:else}
      <button class="item python-cmd clickable" onclick={selectPython} title={_pythonCmd}>
        {pythonLabel(_pythonCmd)}
      </button>
    {/if}
  </div>

  <div class="center"></div>

  <div class="right">
    {#if _diagnostics.errors === 0 && _diagnostics.warnings === 0 && _openFile && _lspStatus === 'ready'}
      <span class="item ok">✓</span>
    {:else if _diagnostics.errors > 0 || _diagnostics.warnings > 0}
      <button class="diag-pill clickable" onclick={() => stores?.showDiagnosticsModal?.set(true)} title="Show all diagnostics">
        {#if _diagnostics.errors > 0}<span class="errors">✕ {_diagnostics.errors}</span>{/if}
        {#if _diagnostics.warnings > 0}<span class="warnings">⚠ {_diagnostics.warnings}</span>{/if}
        {#if _openFile && (_fileErrors > 0 || _fileWarnings > 0)}
          <span class="file-diag">({[_fileErrors > 0 ? `${_fileErrors}e` : '', _fileWarnings > 0 ? `${_fileWarnings}w` : ''].filter(Boolean).join(' ')} here)</span>
        {/if}
      </button>
    {/if}

    {#if _venvScanning}
      <span class="item venv-scan-status" title="Scanning for virtual environments…">
        <span class="lsp-spinner"></span>
        <span>activating .venv…</span>
      </span>
    {/if}

    <button class="item lsp-status clickable" class:ready={_lspStatus === 'ready'} class:lsp-error={_lspStatus === 'error'} onclick={showLspMenu} title="Click to switch LSP">
      {#if _lspStatus === 'starting' || _lspBusy || _installing}
        <span class="lsp-spinner" title={_installing ? 'Installing…' : _lspStatus === 'starting' ? 'LSP starting…' : 'Scanning workspace…'}><span class="sr-only">{_installing ? 'Installing' : 'Loading'}</span></span>
      {/if}
      <span aria-live="polite">
        {#if _lspStatus === 'ready'}{_activeLsp}
        {:else if _lspStatus === 'starting'}starting…
        {:else if _lspStatus === 'error'}lsp error
        {:else}no lsp
        {/if}
      </span>
    </button>
  </div>
</div>

{#if lspCtxMenu}
  <div
    class="lsp-menu"
    role="menu"
    tabindex="-1"
    style="right:{lspCtxMenu.right}px;bottom:{lspCtxMenu.bottom}px"
    use:lspMenuFocus
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => {
      e.stopPropagation()
      if (e.key === 'Escape') { lspCtxMenu = null; return }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const items = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitem"]'))
        const idx = items.indexOf(document.activeElement as HTMLElement)
        const next = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0)
        items[Math.max(0, next)]?.focus()
      }
    }}
  >
    <button role="menuitem" class:active={_activeLsp === 'basedpyright'} onclick={() => selectLsp('basedpyright')}>basedpyright</button>
    <button role="menuitem" class:active={_activeLsp === 'ty'} onclick={() => selectLsp('ty')}>ty</button>
  </div>
{/if}

{#if venvMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="lsp-menu venv-menu"
    style="left:{venvMenu.x}px;bottom:{venvMenu.bottom}px"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => { e.stopPropagation(); if (e.key === 'Escape') venvMenu = null }}
  >
    {#each _venvMap as v}
      <button class:active={v.pythonPath === _pythonCmd} onclick={() => pickVenv(v.pythonPath)} title={v.pythonPath}>
        {venvLabel(v, _projectRoot)}
      </button>
    {/each}
    <hr class="venv-sep" />
    <button onclick={() => { venvMenu = null; selectPython() }}>Browse…</button>
  </div>
{/if}

{#if _installPending}
  <div class="install-toast" role="alertdialog" aria-label="Install confirmation">
    <span class="install-msg"><strong>{_installPending}</strong> is not installed. Install it now?</span>
    <div class="install-actions">
      <button class="install-btn confirm" onclick={confirmInstall}>Install</button>
      <button class="install-btn cancel" onclick={cancelInstall}>Cancel</button>
    </div>
  </div>
{/if}

<style>
  .statusbar {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    height: 24px;
    padding: 0 10px;
    background: var(--bg-statusbar);
    border-top: 1px solid var(--border);
    flex-shrink: 0;
  }

  .left   { display: flex; align-items: center; gap: 10px; }
  .center { display: flex; align-items: center; justify-content: center; }
  .right  { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }

  .item {
    font-size: 11px;
    color: var(--text-secondary);
    white-space: nowrap;
    background: none;
    border: none;
    padding: 0;
    font-family: inherit;
  }

  .clickable {
    cursor: pointer;
    border-radius: 3px;
    padding: 1px 4px;
    transition: background 0.1s;
  }
  .clickable:hover { background: var(--bg-hover); color: var(--text-primary); }

  .diag-pill {
    display: flex; align-items: center; gap: 6px;
    font-size: 11px; background: none; border: none;
    padding: 1px 4px; border-radius: 3px;
    font-family: inherit; cursor: pointer;
    transition: background 0.1s;
  }
  .diag-pill:hover { background: var(--bg-hover); }
  .errors    { color: var(--error); }
  .warnings  { color: var(--warning); }
  .file-diag { color: var(--text-muted); font-size: 10px; }
  .ok        { color: var(--success); }
  .python-cmd { color: var(--text-secondary); }
  .venv-caret { font-size: 9px; opacity: 0.6; }

  .venv-menu { position: fixed; z-index: 9999; }
  .venv-sep  { margin: 3px 0; border: none; border-top: 1px solid var(--border); }

  .venv-scan-status { display: flex; align-items: center; gap: 5px; color: var(--text-muted); font-size: 11px; }

  .lsp-status       { display: flex; align-items: center; gap: 5px; color: var(--text-muted); }
  .lsp-status.ready { color: var(--text-secondary); }
  .lsp-status.lsp-error { color: var(--error); }

  .lsp-spinner {
    display: inline-block;
    width: 8px;
    height: 8px;
    border: 1.5px solid var(--text-muted);
    border-top-color: var(--text-secondary);
    border-radius: 50%;
    animation: lsp-spin 0.7s linear infinite;
    flex-shrink: 0;
  }

  @keyframes lsp-spin {
    to { transform: rotate(360deg); }
  }

  .lsp-menu {
    position: fixed; z-index: 9999;
    background: var(--bg-editor); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 0; min-width: 140px;
    box-shadow: 0 -4px 14px rgba(0,0,0,0.35);
  }
  .lsp-menu button {
    display: block; width: 100%; text-align: left;
    padding: 6px 14px; font-size: 11px; background: none;
    border: none; cursor: pointer; color: var(--text-secondary);
  }
  .lsp-menu button:hover { background: var(--bg-hover); color: var(--text-primary); }
  .lsp-menu button.active { color: var(--text-primary); font-weight: 500; }

  .install-toast {
    position: fixed; bottom: 36px; right: 12px; z-index: 10000;
    background: rgba(30,30,30,0.97); border: 1px solid var(--border);
    border-radius: 8px; padding: 10px 14px; min-width: 260px; max-width: 340px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.45);
    display: flex; flex-direction: column; gap: 8px;
    animation: toast-slide-in 0.15s ease;
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  }
  @keyframes toast-slide-in {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .install-msg { font-size: 11px; color: var(--text-primary); line-height: 1.5; }
  .install-msg strong { color: var(--accent, #528bff); }
  .install-actions { display: flex; gap: 6px; justify-content: flex-end; }
  .install-btn {
    font-size: 11px; padding: 3px 10px; border-radius: 4px;
    border: 1px solid var(--border); cursor: pointer;
    font-family: inherit; transition: background 0.1s;
  }
  .install-btn.confirm { background: var(--accent, #528bff); color: #fff; border-color: var(--accent, #528bff); }
  .install-btn.confirm:hover { background: #3a7bef; }
  .install-btn.cancel  { background: none; color: var(--text-secondary); }
  .install-btn.cancel:hover { background: var(--bg-hover); color: var(--text-primary); }
</style>
