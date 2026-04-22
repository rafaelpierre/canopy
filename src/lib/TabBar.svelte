<script lang="ts">
  import { tick } from 'svelte'
  import { basename } from '$lib/path'
  import { fileIcon, fileColor } from '$lib/file-icons'

  interface Props {
    tabs: string[]
    activeTab: string | null
    dirtyTabs: Set<string>
    onTabClick: (path: string) => void
    onTabClose: (path: string, e: MouseEvent) => void
    onTabContextMenu: (e: MouseEvent, tab: string) => void
  }

  let { tabs, activeTab, dirtyTabs, onTabClick, onTabClose, onTabContextMenu }: Props = $props()

  const isMac = typeof navigator !== 'undefined' && navigator.platform.startsWith('Mac')

  function onTabBarKeydown(e: KeyboardEvent) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const idx = tabs.indexOf(activeTab ?? '')
    if (idx === -1) return
    e.preventDefault()
    const nextIdx = e.key === 'ArrowRight'
      ? Math.min(idx + 1, tabs.length - 1)
      : Math.max(idx - 1, 0)
    onTabClick(tabs[nextIdx])
    tick().then(() => {
      (e.currentTarget as HTMLElement).querySelector<HTMLElement>('[role="tab"][tabindex="0"]')?.focus()
    })
  }
</script>

<!-- svelte-ignore a11y_interactive_supports_focus -->
<div class="tab-bar" role="tablist" onkeydown={onTabBarKeydown}>
  {#if tabs.length > 0}
    {#each tabs as tab}
      {@const tabName = basename(tab)}
      {@const TabIcon = fileIcon(tabName)}
      <div
        role="tab"
        tabindex={tab === activeTab ? 0 : -1}
        aria-selected={tab === activeTab}
        class="tab"
        class:active={tab === activeTab}
        class:dirty={dirtyTabs.has(tab)}
        onclick={() => onTabClick(tab)}
        onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTabClick(tab) } }}
        oncontextmenu={(e) => onTabContextMenu(e, tab)}
      >
        {#if dirtyTabs.has(tab)}<span class="dirty-dot" aria-label="unsaved">●</span>{/if}
        <span class="tab-icon" style="color:{fileColor(tabName)}"><TabIcon size={12} strokeWidth={1.5} /></span>
        <span class="tab-name">{tabName}</span>
        <button class="tab-close" aria-label="Close {tabName}" onclick={(e) => onTabClose(tab, e)}>×</button>
      </div>
    {/each}
  {:else}
    <span class="tab-hint">{isMac ? 'Cmd' : 'Ctrl'}+O to open a folder</span>
  {/if}
</div>

<style>
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
  .tab-icon { display:flex; align-items:center; flex-shrink:0; pointer-events:none; }
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
</style>
