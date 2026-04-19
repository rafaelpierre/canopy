<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { Terminal }           from '@xterm/xterm'
  import { FitAddon }           from '@xterm/addon-fit'
  import '@xterm/xterm/css/xterm.css'

  let containerEl: HTMLDivElement
  let invoke: any
  let cleanups: Array<() => void> = []

  // Terminal tabs
  interface TermTab {
    id:      number
    term:    Terminal
    fit:     FitAddon
    spawned: boolean
  }

  let tabs:      TermTab[] = $state([])
  let activeTab  = $state(0)
  let nextId     = 0

  // Terminal tab context menu
  let termCtxMenu: { x: number; y: number; id: number } | null = $state(null)

  function onTermTabContextMenu(e: MouseEvent, id: number) {
    e.preventDefault()
    e.stopPropagation()
    termCtxMenu = { x: e.clientX, y: e.clientY, id }
  }

  function closeOtherTermTabs(id: number) {
    for (const tab of tabs) {
      if (tab.id !== id) {
        tab.term.dispose()
        invoke?.('pty_kill', { id: tab.id }).catch(() => {})
      }
    }
    tabs = tabs.filter(t => t.id === id)
    activeTab = id
    requestAnimationFrame(() => {
      const t = tabs.find(t => t.id === id)
      t?.fit.fit()
    })
  }

  function createTerminal(): Terminal {
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

  async function addTab() {
    const id = nextId++
    const term = createTerminal()
    const fit = new FitAddon()
    term.loadAddon(fit)

    const tab: TermTab = { id, term, fit, spawned: false }
    tabs = [...tabs, tab]
    activeTab = id

    // Wait for DOM update, then open terminal
    await new Promise(r => requestAnimationFrame(r))
    const el = containerEl.querySelector(`[data-tab-id="${id}"]`) as HTMLElement
    if (el) {
      term.open(el)
      fit.fit()
    }

    // Input → PTY (include tab id so the main process routes correctly)
    term.onData((data: string) => {
      if (tab.spawned && invoke) {
        invoke('pty_write', { id, data }).catch(console.error)
      }
    })

    // Resize
    term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      if (tab.spawned && invoke) {
        invoke('pty_resize', { id, cols, rows }).catch(() => {})
      }
    })

    // Spawn
    const { get } = await import('svelte/store')
    const storesMod = await import('./stores')
    const root = get(storesMod.projectRoot) as string | null

    try {
      await invoke('pty_spawn', { id, cwd: root, cols: term.cols, rows: term.rows })
      tab.spawned = true
    } catch (e: any) {
      term.writeln(`\r\n\x1b[38;5;203m${e}\x1b[0m`)
    }
  }

  function switchToTab(id: number) {
    activeTab = id
    // Refit the active terminal
    requestAnimationFrame(() => {
      const tab = tabs.find(t => t.id === id)
      tab?.fit.fit()
    })
  }

  function closeTab(id: number, e?: MouseEvent) {
    e?.stopPropagation()
    const idx = tabs.findIndex(t => t.id === id)
    if (idx < 0) return
    const tab = tabs[idx]
    tab.term.dispose()
    invoke?.('pty_kill', { id }).catch(() => {})
    tabs = tabs.filter(t => t.id !== id)
    if (activeTab === id && tabs.length > 0) {
      activeTab = tabs[Math.max(0, idx - 1)].id
      requestAnimationFrame(() => {
        const t = tabs.find(t => t.id === activeTab)
        t?.fit.fit()
      })
    }
  }

  function closeTermCtxMenu() { termCtxMenu = null }

  onMount(async () => {
    window.addEventListener('click', closeTermCtxMenu)

    const [ipcMod, storesMod] = await Promise.all([
      import('$lib/ipc'),
      import('./stores'),
    ])
    invoke = ipcMod.invoke

    // PTY data → correct tab (routed by id, not just the active tab)
    ipcMod.listen('pty:data', (e: any) => {
      const { id, data } = e.payload as { id: number; data: string }
      const target = tabs.find(t => t.id === id)
      if (target) {
        const bytes = Uint8Array.from(atob(data), (c: string) => c.charCodeAt(0))
        target.term.write(bytes)
      }
    }).then((u: any) => cleanups.push(u))

    ipcMod.listen('pty:exit', (e: any) => {
      const { id } = e.payload as { id: number }
      const target = tabs.find(t => t.id === id)
      if (target) {
        target.term.writeln('\r\n\x1b[38;5;240m[shell exited]\x1b[0m')
        target.spawned = false
      }
    }).then((u: any) => cleanups.push(u))

    // Resize observer
    const ro = new ResizeObserver(() => {
      const activeTermTab = tabs.find(t => t.id === activeTab)
      if (activeTermTab) {
        activeTermTab.fit.fit()
        if (activeTermTab.spawned) {
          invoke('pty_resize', { id: activeTermTab.id, cols: activeTermTab.term.cols, rows: activeTermTab.term.rows }).catch(() => {})
        }
      }
    })
    ro.observe(containerEl)
    cleanups.push(() => ro.disconnect())

    // Font size zoom — update all tabs' font size but only refit the visible one
    cleanups.push(storesMod.termFontSize.subscribe((size: number) => {
      for (const tab of tabs) {
        tab.term.options.fontSize = size
        if (tab.id === activeTab) tab.fit.fit()
      }
    }))

    // Wait a moment for prefs to restore project root, then spawn in the right dir
    await new Promise(r => setTimeout(r, 300))
    await addTab()

    // cd when project root changes after initial spawn
    let lastRoot: string | null = null
    cleanups.push(storesMod.projectRoot.subscribe((root: string | null) => {
      if (root && root !== lastRoot) {
        lastRoot = root
        const activeTermTab = tabs.find(t => t.id === activeTab)
        if (activeTermTab?.spawned) {
          const safeRoot = "'" + root.replace(/'/g, "'\\''") + "'"
          invoke('pty_write', { id: activeTermTab.id, data: `cd ${safeRoot}\nclear\n` }).catch(() => {})
        }
      }
    }))
  })

  onDestroy(() => {
    window.removeEventListener('click', closeTermCtxMenu)
    for (const c of cleanups) c()
    for (const tab of tabs) {
      tab.term.dispose()
    }
    invoke?.('pty_kill', { id: 'all' }).catch(() => {})
  })
</script>

{#if termCtxMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="term-ctx-menu" style="left:{termCtxMenu.x}px;top:{termCtxMenu.y}px" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
    <button onclick={() => { closeTab(termCtxMenu!.id); termCtxMenu = null }}>Close</button>
    <button onclick={() => { closeOtherTermTabs(termCtxMenu!.id); termCtxMenu = null }}>Close Others</button>
  </div>
{/if}

<div class="terminal-container selectable" bind:this={containerEl}>
  <div class="terminal-toolbar">
    <div class="term-tabs">
      {#each tabs as tab}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div role="tab" tabindex="0" class="term-tab" class:active={tab.id === activeTab} onclick={() => switchToTab(tab.id)} oncontextmenu={(e) => onTermTabContextMenu(e, tab.id)}>
          <span class="term-tab-name">terminal {tab.id + 1}</span>
          <button class="term-tab-close" onclick={(e) => closeTab(tab.id, e)}>×</button>
        </div>
      {/each}
      <button class="term-tab-add" onclick={addTab} title="New terminal">+</button>
    </div>
  </div>
  <div class="xterm-panels">
    {#each tabs as tab}
      <div class="xterm-wrap" data-tab-id={tab.id} class:hidden={tab.id !== activeTab}></div>
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

  .xterm-panels {
    flex: 1;
    overflow: hidden;
    position: relative;
    background: #181818;
  }

  .xterm-wrap {
    position: absolute;
    inset: 0;
    padding: 4px 4px 4px 8px;
    background: #181818;
  }
  .xterm-wrap.hidden { visibility: hidden; }

  .xterm-wrap :global(.xterm) { height: 100%; background: #181818 !important; }
  .xterm-wrap :global(.xterm-viewport) { border-radius: 0; overflow: hidden; background: #181818 !important; }
  .xterm-wrap :global(.xterm-screen) { background: #181818 !important; }
  .xterm-wrap :global(.xterm-rows) { background: #181818 !important; }

  .term-ctx-menu {
    position: fixed; z-index: 9999;
    background: var(--bg-editor); border: 1px solid var(--border);
    border-radius: 4px; padding: 4px 0; min-width: 140px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.35);
  }
  .term-ctx-menu button {
    display: block; width: 100%; text-align: left;
    padding: 6px 14px; font-size: 12px; background: none;
    border: none; cursor: pointer; color: var(--text-secondary);
  }
  .term-ctx-menu button:hover { background: var(--bg-hover); color: var(--text-primary); }
</style>
