<script lang="ts">
  import { onMount, onDestroy } from 'svelte'

  let _diagnostics     = $state({ errors: 0, warnings: 0 })
  let _fileErrors      = $state(0)
  let _fileWarnings    = $state(0)
  let _diagByUri       = $state<Map<string, any[]>>(new Map())
  let _lspStatus       = $state<string>('stopped')
  let _lspBusy         = $state(false)
  let _openFile        = $state<string | null>(null)
  let _pythonCmd       = $state('python3')
  let _activeLsp       = $state<string>('basedpyright')
  let stores: any
  let invoke: any
  let _clickCleanup: (() => void) | null = null
  let lspCtxMenu: { x: number; bottom: number; right: number } | null = $state(null)

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
    stores.diagnostics.subscribe((v: any) => { _diagnostics = v })
    stores.diagnosticsByUri.subscribe((map: any) => {
      _diagByUri = map
      recomputeFileCounts(map, _openFile)
    })
    stores.lspStatus.subscribe((v: any) => { _lspStatus = v })
    stores.lspBusy.subscribe((v: any) => { _lspBusy = v })
    stores.openFilePath.subscribe((v: any) => {
      _openFile = v
      recomputeFileCounts(_diagByUri, v)
    })
    stores.pythonCmd.subscribe((v: any) => { _pythonCmd = v })
    stores.activeLsp.subscribe((v: any) => { _activeLsp = v })
    window.addEventListener('click', closeLspCtxMenu)
    _clickCleanup = () => window.removeEventListener('click', closeLspCtxMenu)
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

  function closeLspCtxMenu() { lspCtxMenu = null }

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

    // Check if available
    const { available } = await invoke('check_lsp_available', { lspId })
    if (!available) {
      // Try to install
      const response = await invoke('install_ty')
      if (!response.success) {
        alert(`Failed to install ${lspId}: ${response.message}`)
        closeLspCtxMenu()
        return
      }
    }

    // Switch LSP — +page.svelte watches activeLsp and handles the restart
    stores.activeLsp.set(lspId)
    closeLspCtxMenu()
  }
</script>

<div class="statusbar">
  <div class="left">
    <button class="item python-cmd clickable" onclick={selectPython} title={_pythonCmd}>
      {pythonLabel(_pythonCmd)}
    </button>
  </div>

  <div class="center"></div>

  <div class="right">
    {#if _diagnostics.errors === 0 && _diagnostics.warnings === 0 && _openFile}
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

    <button class="item lsp-status clickable" class:ready={_lspStatus === 'ready'} class:lsp-error={_lspStatus === 'error'} onclick={showLspMenu} title="Click to switch LSP">
      {#if _lspStatus === 'starting' || _lspBusy}
        <span class="lsp-spinner" title={_lspStatus === 'starting' ? 'LSP starting…' : 'Scanning workspace…'}></span>
      {/if}
      {#if _lspStatus === 'ready'}{_activeLsp}
      {:else if _lspStatus === 'starting'}starting…
      {:else if _lspStatus === 'error'}lsp error
      {:else}no lsp
      {/if}
    </button>
  </div>
</div>

{#if lspCtxMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="lsp-menu" style="right:{lspCtxMenu.right}px;bottom:{lspCtxMenu.bottom}px" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
    <button class:active={_activeLsp === 'basedpyright'} onclick={() => selectLsp('basedpyright')}>basedpyright</button>
    <button class:active={_activeLsp === 'ty'} onclick={() => selectLsp('ty')}>ty</button>
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
</style>
