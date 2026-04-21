<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte'
  import { get } from 'svelte/store'
  import { Terminal }           from '@xterm/xterm'
  import { FitAddon }           from '@xterm/addon-fit'
  import '@xterm/xterm/css/xterm.css'
  import { menuFocus, handleMenuKeydown } from './menu-utils'

  let containerEl: HTMLDivElement
  let invoke:    any
  let storesMod: any
  let cachedPrefs: Record<string, any> = {}
  let cleanups: Array<() => void> = []

  interface TermInstance {
    id:      number
    term:    Terminal
    fit:     FitAddon
    spawned: boolean
  }

  interface TermTab {
    id:         number     // same as main.id — used as key in DOM
    title:      string
    main:       TermInstance
    split?:     TermInstance
    activeSide: 'main' | 'split'
  }

  let tabs:      TermTab[] = $state([])
  let activeTab  = $state(-1)
  let nextId     = 0

  // Terminal tab context menu
  let termCtxMenu: { x: number; y: number; id: number } | null = $state(null)

  // Shell picker popover
  let showShellPicker = $state(false)
  let availableShells: string[] = $state([])
  let preferredShell  = $state('')

  function shellBasename(p: string): string {
    return p ? (p.split('/').pop() ?? p) : ''
  }

  // Parse OSC 7 (current directory notification) from raw PTY bytes.
  function parseOsc7(bytes: Uint8Array): string | null {
    try {
      const str = new TextDecoder().decode(bytes)
      const m = str.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]+)(?:\x07|\x1b\\)/)
      if (!m) return null
      try { return decodeURIComponent(m[1]) } catch { return m[1] }
    } catch { return null }
  }

  function makeTitle(root: string | null): string {
    const sh = shellBasename(preferredShell)
    const dir = root ? (root.split('/').pop() ?? root) : ''
    if (sh && dir) return `${sh}: ${dir}`
    if (sh) return sh
    if (dir) return dir
    return 'shell'
  }

  function createXterm(): Terminal {
    return new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
      scrollback: 5000,
      theme: {
        background: '#181818', foreground: '#d4d4d4',
        cursor: '#528bff', cursorAccent: '#1c1c1c',
        selectionBackground: 'rgba(61,79,111,0.5)',
        black: '#1c1c1c', red: '#e06c75', green: '#98c379',
        yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd',
        cyan: '#56b6c2', white: '#d4d4d4', brightBlack: '#5c6370',
      },
      convertEol: false,
    })
  }

  function buildInstance(id: number): TermInstance {
    const term = createXterm()
    const fit  = new FitAddon()
    term.loadAddon(fit)
    return { id, term, fit, spawned: false }
  }

  function openInstanceInEl(inst: TermInstance, el: HTMLElement) {
    inst.term.open(el)
    inst.fit.fit()
    inst.term.onData((data: string) => {
      if (inst.spawned && invoke) invoke('pty_write', { id: inst.id, data }).catch(console.error)
    })
    inst.term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (inst.spawned && invoke) invoke('pty_resize', { id: inst.id, cols, rows }).catch(() => {})
    })
  }

  async function spawnInstance(inst: TermInstance, cwd: string | null) {
    try {
      await invoke('pty_spawn', { id: inst.id, cwd, cols: inst.term.cols, rows: inst.term.rows })
      inst.spawned = true
    } catch (e: any) {
      inst.term.writeln(`\r\n\x1b[38;5;203m${e}\x1b[0m`)
    }
  }


  function onTabsKeydown(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const idx = tabs.findIndex(t => t.id === activeTab)
    if (idx === -1) return
    e.preventDefault()
    const nextIdx = e.key === 'ArrowRight'
      ? Math.min(idx + 1, tabs.length - 1)
      : Math.max(idx - 1, 0)
    switchToTab(tabs[nextIdx].id)
    tick().then(() => {
      (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[role="tab"][tabindex="0"]')?.focus()
    })
  }

  function onTermTabContextMenu(e: MouseEvent, id: number) {
    e.preventDefault()
    e.stopPropagation()
    termCtxMenu = { x: e.clientX, y: e.clientY, id }
  }

  function closeOtherTermTabs(id: number) {
    for (const tab of tabs) {
      if (tab.id !== id) killTab(tab)
    }
    tabs = tabs.filter(t => t.id === id)
    activeTab = id
    requestAnimationFrame(() => refitTab(tabs.find(t => t.id === id)))
  }

  function killTab(tab: TermTab) {
    tab.main.spawned = false
    tab.main.term.dispose()
    invoke?.('pty_kill', { id: tab.main.id }).catch(() => {})
    if (tab.split) {
      tab.split.spawned = false
      tab.split.term.dispose()
      invoke?.('pty_kill', { id: tab.split.id }).catch(() => {})
    }
  }

  function refitTab(tab: TermTab | undefined) {
    if (!tab) return
    tab.main.fit.fit()
    tab.split?.fit.fit()
  }

  export async function addTab() {
    const id   = nextId++
    const inst = buildInstance(id)
    const tab: TermTab = { id, title: 'shell', main: inst, activeSide: 'main' }
    tabs = [...tabs, tab]
    activeTab = id

    await new Promise(r => requestAnimationFrame(r))
    const el = containerEl?.querySelector(`[data-tab-id="${id}"]`) as HTMLElement | null
    if (el) openInstanceInEl(inst, el)

    const root = storesMod ? get(storesMod.projectRoot) as string | null : null
    tab.title = makeTitle(root)
    tabs = [...tabs]

    await spawnInstance(inst, root)
  }

  async function splitTab(tabId: number) {
    const tab = tabs.find(t => t.id === tabId)
    if (!tab || tab.split) return

    const splitId = nextId++
    const inst    = buildInstance(splitId)

    // Assign temporarily to trigger DOM element render
    tab.split = inst
    tabs = [...tabs]

    await new Promise(r => requestAnimationFrame(r))
    const el = containerEl?.querySelector(`[data-split-id="${tabId}"]`) as HTMLElement | null
    if (el) openInstanceInEl(inst, el)
    tab.activeSide = 'split'
    tabs = [...tabs]
    // Refit both sides after layout change
    requestAnimationFrame(() => refitTab(tab))

    const root = storesMod ? get(storesMod.projectRoot) as string | null : null
    await spawnInstance(inst, root)
  }

  function closeSplit(tabId: number) {
    const tab = tabs.find(t => t.id === tabId)
    if (!tab?.split) return
    tab.split.spawned = false
    tab.split.term.dispose()
    invoke?.('pty_kill', { id: tab.split.id }).catch(() => {})
    tab.split = undefined
    tab.activeSide = 'main'
    tabs = [...tabs]
    requestAnimationFrame(() => { tab.main.fit.fit() })
  }

  function switchToTab(id: number) {
    activeTab = id
    requestAnimationFrame(() => refitTab(tabs.find(t => t.id === id)))
  }

  function closeTab(id: number, e?: MouseEvent) {
    e?.stopPropagation()
    const idx = tabs.findIndex(t => t.id === id)
    if (idx < 0) return
    killTab(tabs[idx])
    tabs = tabs.filter(t => t.id !== id)
    if (activeTab === id && tabs.length > 0) {
      activeTab = tabs[Math.max(0, idx - 1)].id
      requestAnimationFrame(() => refitTab(tabs.find(t => t.id === activeTab)))
    }
  }

  function closeTermCtxMenu() { termCtxMenu = null; showShellPicker = false }

  async function openShellPicker(e: MouseEvent) {
    e.stopPropagation()
    if (!availableShells.length) {
      try { availableShells = await invoke('list_shells') } catch { availableShells = [] }
    }
    showShellPicker = !showShellPicker
  }

  async function selectShell(shell: string) {
    preferredShell = shell
    showShellPicker = false
    // Update all current tab titles
    for (const tab of tabs) {
      const currentDir = tab.title.split(': ')[1] ?? ''
      tab.title = shell ? `${shellBasename(shell)}: ${currentDir || 'shell'}` : (currentDir || 'shell')
    }
    tabs = [...tabs]
    cachedPrefs = { ...cachedPrefs, preferred_shell: shell }
    await invoke('save_prefs', { prefs: cachedPrefs }).catch(() => {})
  }

  onMount(async () => {
    window.addEventListener('click', closeTermCtxMenu)

    const [ipcMod, _storesMod] = await Promise.all([
      import('$lib/ipc'),
      import('./stores'),
    ])
    invoke    = ipcMod.invoke
    storesMod = _storesMod

    // Load preferred shell from prefs
    try {
      cachedPrefs = await invoke('load_prefs')
      if (cachedPrefs.preferred_shell) preferredShell = cachedPrefs.preferred_shell
    } catch {}

    // PTY data → correct terminal instance (global listener filtered by id)
    ipcMod.listen('pty:data', (e: any) => {
      const { id, data } = e.payload as { id: number; data: string }
      const bytes = Uint8Array.from(atob(data), (c: string) => c.charCodeAt(0))

      for (const tab of tabs) {
        if (tab.main.id === id) {
          tab.main.term.write(bytes)
          const cwd = parseOsc7(bytes)
          if (cwd) {
            const cwdName = (cwd.split('/').pop() || cwd).replace(/[^\x20-\x7E -￿]/g, '')
            tab.title = shellBasename(preferredShell) ? `${shellBasename(preferredShell)}: ${cwdName}` : cwdName
            tabs = [...tabs]
          }
          return
        }
        if (tab.split?.id === id) {
          tab.split.term.write(bytes)
          return
        }
      }
    }).then((u: any) => cleanups.push(u))

    ipcMod.listen('pty:exit', (e: any) => {
      const { id } = e.payload as { id: number }
      for (const tab of tabs) {
        if (tab.main.id === id) {
          tab.main.term.writeln('\r\n\x1b[38;5;240m[shell exited]\x1b[0m')
          tab.main.spawned = false
          return
        }
        if (tab.split?.id === id) {
          tab.split.term.writeln('\r\n\x1b[38;5;240m[shell exited]\x1b[0m')
          tab.split.spawned = false
          return
        }
      }
    }).then((u: any) => cleanups.push(u))

    // Resize observer — refit active terminal(s) when container resizes
    let _resizeTimer: ReturnType<typeof setTimeout> | null = null
    const ro = new ResizeObserver(() => {
      const t = tabs.find(t => t.id === activeTab)
      if (!t) return
      if (_resizeTimer) clearTimeout(_resizeTimer)
      _resizeTimer = setTimeout(() => {
        _resizeTimer = null
        t.main.fit.fit()
        t.split?.fit.fit()
        if (t.main.spawned) invoke('pty_resize', { id: t.main.id, cols: t.main.term.cols, rows: t.main.term.rows }).catch(() => {})
        if (t.split?.spawned) invoke('pty_resize', { id: t.split.id, cols: t.split.term.cols, rows: t.split.term.rows }).catch(() => {})
      }, 50)
    })
    ro.observe(containerEl)
    cleanups.push(() => ro.disconnect())

    // Font size zoom
    cleanups.push(storesMod.termFontSize.subscribe((size: number) => {
      for (const tab of tabs) {
        tab.main.term.options.fontSize = size
        if (tab.split) tab.split.term.options.fontSize = size
        if (tab.id === activeTab) { tab.main.fit.fit(); tab.split?.fit.fit() }
      }
    }))

    await new Promise(r => setTimeout(r, 300))
    await addTab()

    // cd when project root changes after initial spawn
    let lastRoot: string | null = null
    cleanups.push(storesMod.projectRoot.subscribe((root: string | null) => {
      if (root && root !== lastRoot) {
        lastRoot = root
        const activeTermTab = tabs.find(t => t.id === activeTab)
        if (activeTermTab?.main.spawned) {
          const safeRoot = "'" + root.replace(/'/g, "'\\''") + "'"
          invoke('pty_write', { id: activeTermTab.main.id, data: `cd ${safeRoot}\nclear\n` }).catch(() => {})
        }
        // Update all tab titles with new root
        for (const tab of tabs) {
          const sh = shellBasename(preferredShell)
          const dir = root.split('/').pop() ?? root
          tab.title = sh ? `${sh}: ${dir}` : dir
        }
        tabs = [...tabs]
      }
    }))
  })

  onDestroy(() => {
    window.removeEventListener('click', closeTermCtxMenu)
    for (const c of cleanups) c()
    for (const tab of tabs) killTab(tab)
    invoke?.('pty_kill', { id: 'all' }).catch(() => {})
  })

  // Public API (accessible via bind:this)
  export function splitActiveTab() {
    const t = tabs.find(t => t.id === activeTab)
    if (t) splitTab(t.id)
  }
</script>

{#if termCtxMenu}
  <div
    class="term-ctx-menu"
    role="menu"
    tabindex="-1"
    style="left:{termCtxMenu.x}px;top:{termCtxMenu.y}px"
    use:menuFocus
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => handleMenuKeydown(e, () => { termCtxMenu = null })}
  >
    <button role="menuitem" onclick={() => { closeTab(termCtxMenu!.id); termCtxMenu = null }}>Close</button>
    <button role="menuitem" onclick={() => { closeOtherTermTabs(termCtxMenu!.id); termCtxMenu = null }}>Close Others</button>
    {#if tabs.find(t => t.id === termCtxMenu!.id)?.split}
      <button role="menuitem" onclick={() => { closeSplit(termCtxMenu!.id); termCtxMenu = null }}>Unsplit</button>
    {:else}
      <button role="menuitem" onclick={() => { splitTab(termCtxMenu!.id); termCtxMenu = null }}>Split</button>
    {/if}
  </div>
{/if}

{#if showShellPicker}
  <div
    class="shell-picker"
    role="listbox"
    aria-label="Select shell"
    tabindex="-1"
    use:menuFocus
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => {
      e.stopPropagation()
      if (e.key === 'Escape') { showShellPicker = false; return }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const items = Array.from((e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button'))
        const idx = items.indexOf(document.activeElement as HTMLElement)
        const next = e.key === 'ArrowDown' ? Math.min(idx + 1, items.length - 1) : Math.max(idx - 1, 0)
        items[Math.max(0, next)]?.focus()
      }
    }}
  >
    <div class="shell-picker-title">Select Shell</div>
    {#each availableShells as sh}
      <button role="option" aria-selected={sh === preferredShell} class="shell-option" class:active={sh === preferredShell} onclick={() => selectShell(sh)}>
        {sh}
      </button>
    {/each}
    {#if !availableShells.length}
      <span class="shell-option" style="opacity:0.4">No shells found</span>
    {/if}
  </div>
{/if}

<div class="terminal-container selectable" bind:this={containerEl}>
  <div class="terminal-toolbar">
    <!-- svelte-ignore a11y_interactive_supports_focus -->
    <div class="term-tabs" role="tablist" onkeydown={onTabsKeydown}>
      {#each tabs as tab (tab.id)}
        <div
          role="tab"
          tabindex={tab.id === activeTab ? 0 : -1}
          aria-selected={tab.id === activeTab}
          class="term-tab"
          class:active={tab.id === activeTab}
          onclick={() => switchToTab(tab.id)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); switchToTab(tab.id) } }}
          oncontextmenu={(e) => onTermTabContextMenu(e, tab.id)}
        >
          <span class="term-tab-name">{tab.title || 'shell'}</span>
          <button class="term-tab-close" aria-label="Close {tab.title || 'shell'} terminal tab" onclick={(e) => closeTab(tab.id, e)}>×</button>
        </div>
      {/each}
      <button class="term-tab-add" onclick={addTab} title="New terminal tab">+</button>
      <button class="term-tab-add term-split-btn" onclick={() => { const t = tabs.find(t => t.id === activeTab); if (t) splitTab(t.id) }} title="Split terminal">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <rect x="1" y="1" width="4" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/>
          <rect x="7" y="1" width="4" height="10" rx="1" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </button>
      <button class="term-tab-add" onclick={openShellPicker} title="Select shell">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <circle cx="6" cy="6" r="5" stroke="currentColor" stroke-width="1.2"/>
          <path d="M4 5l2 2 2-2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  </div>
  <div class="xterm-panels">
    {#each tabs as tab (tab.id)}
      <div class="xterm-pane-group" class:hidden={tab.id !== activeTab} class:split={!!tab.split}>
        <div
          role="presentation"
          class="xterm-wrap"
          class:focus-side={tab.activeSide === 'main'}
          data-tab-id={tab.id}
          onclick={() => { tab.activeSide = 'main'; tabs = [...tabs] }}
          onkeydown={() => {}}
        ></div>
        {#if tab.split}
          <div class="xterm-divider"></div>
          <div
            role="presentation"
            class="xterm-wrap"
            class:focus-side={tab.activeSide === 'split'}
            data-split-id={tab.id}
            onclick={() => { tab.activeSide = 'split'; tabs = [...tabs] }}
            onkeydown={() => {}}
          ></div>
        {/if}
      </div>
    {/each}
  </div>
</div>

<style>
  .terminal-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--bg-statusbar);
  }

  .terminal-toolbar {
    display: flex;
    align-items: center;
    padding: 0;
    height: 28px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .term-tabs {
    display: flex;
    align-items: stretch;
    height: 100%;
    overflow-x: auto;
    flex: 1;
  }
  .term-tabs::-webkit-scrollbar { height: 0; }

  .term-tab {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 0 10px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    cursor: pointer;
    border-right: 1px solid var(--border);
    white-space: nowrap;
    transition: background 0.08s;
  }
  .term-tab:hover { background: var(--bg-hover); color: var(--text-secondary); }
  .term-tab.active { color: var(--text-secondary); background: var(--bg-editor); }

  .term-tab-name { pointer-events: none; }
  .term-tab-close {
    font-size: 12px; line-height: 1; color: var(--text-muted);
    cursor: pointer; border-radius: 3px; width: 14px; height: 14px;
    display: flex; align-items: center; justify-content: center;
    background: none; border: none; padding: 0;
  }
  .term-tab-close:hover { background: var(--bg-hover); color: var(--text-primary); }

  .term-tab-add {
    display: flex; align-items: center; justify-content: center;
    padding: 0 8px; font-size: 14px; color: var(--text-muted);
    cursor: pointer; transition: color 0.1s;
    background: none; border: none;
  }
  .term-tab-add:hover { color: var(--text-primary); }
  .term-split-btn { padding: 0 6px; }

  .xterm-panels {
    flex: 1;
    overflow: hidden;
    position: relative;
    background: #181818;
  }

  .xterm-pane-group {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: row;
  }
  .xterm-pane-group.hidden { visibility: hidden; }

  .xterm-wrap {
    flex: 1;
    padding: 4px 4px 4px 8px;
    background: #181818;
    min-width: 0;
  }

  .xterm-divider {
    width: 2px;
    background: var(--border);
    flex-shrink: 0;
  }

  .focus-side { outline: 1px solid rgba(82,139,255,0.25); outline-offset: -1px; }

  .xterm-wrap :global(.xterm) { height: 100%; background: #181818 !important; }
  .xterm-wrap :global(.xterm-viewport) { border-radius: 0; overflow: hidden; background: #181818 !important; }
  .xterm-wrap :global(.xterm-screen) { background: #181818 !important; }
  .xterm-wrap :global(.xterm-rows) { background: #181818 !important; }

  .term-ctx-menu {
    position: fixed; z-index: 9999;
    background: var(--bg-editor); border: 1px solid var(--border);
    border-radius: 8px; padding: 4px 0; min-width: 140px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.35);
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  }
  .term-ctx-menu button {
    display: block; width: 100%; text-align: left;
    padding: 6px 14px; font-size: 12px; background: none;
    border: none; cursor: pointer; color: var(--text-secondary);
    font-family: inherit;
  }
  .term-ctx-menu button:hover { background: var(--bg-hover); color: var(--text-primary); }

  .shell-picker {
    position: fixed; z-index: 9999; bottom: 40px; right: 16px;
    background: var(--bg-editor); border: 1px solid var(--border);
    border-radius: 8px; padding: 4px 0; min-width: 220px;
    box-shadow: 0 4px 18px rgba(0,0,0,0.45);
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  }
  .shell-picker-title {
    padding: 6px 14px 4px; font-size: 10px; text-transform: uppercase;
    letter-spacing: 0.06em; color: var(--text-muted);
  }
  .shell-option {
    display: block; width: 100%; text-align: left;
    padding: 6px 14px; font-size: 12px; background: none;
    border: none; cursor: pointer; color: var(--text-secondary);
    font-family: inherit;
  }
  .shell-option:hover { background: var(--bg-hover); color: var(--text-primary); }
  .shell-option.active { color: var(--accent); }
</style>
