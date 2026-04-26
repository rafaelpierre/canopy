<script lang="ts">
import { onMount } from 'svelte'

interface Props {
  onOpenFolder: () => void
  onToggleTree: () => void
  onToggleTerminal: () => void
  onZoomIn: () => void
  onZoomOut: () => void
  onZoomReset: () => void
  onCommandPalette: () => void
  onCommandPaletteCommands: () => void
  onNewTerminalTab: () => void
  onSplitTerminal: () => void
}

let {
  onOpenFolder,
  onToggleTree,
  onToggleTerminal,
  onZoomIn,
  onZoomOut,
  onZoomReset,
  onCommandPalette,
  onCommandPaletteCommands,
  onNewTerminalTab,
  onSplitTerminal,
}: Props = $props()

let invoke: any
let openMenu: string | null = $state(null)
const isMac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

onMount(async () => {
  const ipc = await import('$lib/ipc')
  invoke = ipc.invoke
})

function toggleMenu(name: string, e: MouseEvent) {
  e.stopPropagation()
  openMenu = openMenu === name ? null : name
}

function closeMenu() {
  openMenu = null
}

function run(fn: () => void) {
  closeMenu()
  fn()
}

const MENUS = {
  File: [{ label: 'Open Folder…', key: 'Cmd+O', action: () => run(onOpenFolder) }],
  Edit: [
    {
      label: 'Undo',
      key: 'Cmd+Z',
      action: () => {
        closeMenu()
        document.execCommand('undo')
      },
    },
    {
      label: 'Redo',
      key: 'Cmd+Shift+Z',
      action: () => {
        closeMenu()
        document.execCommand('redo')
      },
    },
    { separator: true },
    {
      label: 'Cut',
      key: 'Cmd+X',
      action: () => {
        closeMenu()
        document.execCommand('cut')
      },
    },
    {
      label: 'Copy',
      key: 'Cmd+C',
      action: () => {
        closeMenu()
        document.execCommand('copy')
      },
    },
    {
      label: 'Paste',
      key: 'Cmd+V',
      action: () => {
        closeMenu()
        document.execCommand('paste')
      },
    },
    {
      label: 'Select All',
      key: 'Cmd+A',
      action: () => {
        closeMenu()
        document.execCommand('selectAll')
      },
    },
  ],
  View: [
    { label: 'Toggle File Tree', key: 'Cmd+B', action: () => run(onToggleTree) },
    { label: 'Toggle Terminal', key: 'Cmd+J', action: () => run(onToggleTerminal) },
    { separator: true },
    { label: 'Zoom In', key: 'Cmd+=', action: () => run(onZoomIn) },
    { label: 'Zoom Out', key: 'Cmd+−', action: () => run(onZoomOut) },
    { label: 'Reset Zoom', key: 'Cmd+0', action: () => run(onZoomReset) },
    { separator: true },
    { label: 'Go to File', key: 'Cmd+P', action: () => run(onCommandPalette) },
    { label: 'Command Palette', key: 'Cmd+Shift+P', action: () => run(onCommandPaletteCommands) },
  ],
  Terminal: [
    { label: 'New Terminal Tab', key: 'Cmd+T', action: () => run(onNewTerminalTab) },
    { label: 'Split Terminal', key: '', action: () => run(onSplitTerminal) },
  ],
} as const
</script>

<svelte:window onclick={closeMenu} />

<div class="menubar" role="menubar">
  <!-- macOS: spacer for traffic-light buttons (hiddenInset gives ~72px) -->
  {#if isMac}
    <div class="mac-spacer"></div>
  {/if}

  <!-- Menus — only shown on Linux/Windows; macOS uses the native menu bar -->
  {#if !isMac}
    {#each Object.entries(MENUS) as [name, items]}
      <div class="menu-root" class:active={openMenu === name}>
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <button class="menu-btn" role="menuitem" tabindex="0" aria-haspopup="menu" aria-expanded={openMenu === name} onclick={(e) => toggleMenu(name, e)}>
          {name}
        </button>
        {#if openMenu === name}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div class="dropdown" role="menu" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
            {#each items as item}
              {#if (item as any).separator}
                <div class="sep"></div>
              {:else}
                <button class="menu-item" role="menuitem" onclick={(item as any).action}>
                  <span class="item-label">{(item as any).label}</span>
                  {#if (item as any).key}<span class="item-key">{(item as any).key}</span>{/if}
                </button>
              {/if}
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  {/if}

  <div class="spacer"></div>

  <!-- Windows/Linux window controls -->
  {#if !isMac}
    <div class="win-controls">
      <button class="wc-btn" title="Minimize" onclick={() => invoke?.('window_minimize')}>
        <svg width="10" height="1" viewBox="0 0 10 1"><rect width="10" height="1" fill="currentColor"/></svg>
      </button>
      <button class="wc-btn" title="Maximize" onclick={() => invoke?.('window_maximize')}>
        <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>
      </button>
      <button class="wc-btn close" title="Close" onclick={() => invoke?.('window_close')}>
        <svg width="10" height="10" viewBox="0 0 10 10">
          <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" stroke-width="1.2"/>
          <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" stroke-width="1.2"/>
        </svg>
      </button>
    </div>
  {/if}
</div>

<style>
  .menubar {
    display: flex;
    align-items: center;
    height: 38px;
    background: #141414;
    border-bottom: 1px solid var(--border, #2a2a2a);
    flex-shrink: 0;
    user-select: none;
    -webkit-app-region: drag;
    z-index: 100;
    padding: 0 4px;
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  }

  .mac-spacer {
    width: 72px;
    flex-shrink: 0;
    -webkit-app-region: drag;
  }

  .menu-root {
    position: relative;
    -webkit-app-region: no-drag;
  }

  .menu-btn {
    height: 38px;
    padding: 0 10px;
    font-size: 12px;
    font-family: inherit;
    color: var(--text-secondary, #aaa);
    background: none;
    border: none;
    cursor: default;
    border-radius: 3px;
    transition: background 0.08s, color 0.08s;
  }
  .menu-btn:hover,
  .menu-root.active .menu-btn {
    background: rgba(255,255,255,0.08);
    color: var(--text-primary, #e0e0e0);
  }

  .dropdown {
    position: absolute;
    top: calc(100% + 1px);
    left: 0;
    background: #1e1e1e;
    border: 1px solid var(--border, #2a2a2a);
    border-radius: 8px;
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
    padding: 4px 0;
    min-width: 200px;
    box-shadow: 0 6px 20px rgba(0,0,0,0.5);
    z-index: 9999;
  }

  .menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 5px 14px;
    font-size: 12px;
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
    background: none;
    border: none;
    cursor: default;
    color: var(--text-secondary, #aaa);
    text-align: left;
    gap: 24px;
  }
  .menu-item:hover {
    background: var(--accent, #528bff);
    color: #fff;
  }

  .item-label { flex: 1; white-space: nowrap; }
  .item-key { font-size: 11px; font-family: inherit; color: inherit; opacity: 0.55; white-space: nowrap; }

  .sep {
    height: 1px;
    background: var(--border, #2a2a2a);
    margin: 3px 0;
  }

  .spacer {
    flex: 1;
    -webkit-app-region: drag;
  }

  .win-controls {
    display: flex;
    align-items: stretch;
    height: 100%;
    -webkit-app-region: no-drag;
    margin-left: 4px;
  }

  .wc-btn {
    width: 40px;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
    background: none;
    border: none;
    color: var(--text-muted, #666);
    cursor: default;
    transition: background 0.1s, color 0.1s;
    border-radius: 0;
  }
  .wc-btn:hover { background: rgba(255,255,255,0.1); color: var(--text-primary, #e0e0e0); }
  .wc-btn.close:hover { background: #c42b1c; color: #fff; }
</style>
