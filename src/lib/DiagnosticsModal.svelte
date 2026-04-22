<script lang="ts">
  import { onDestroy } from 'svelte'
  import { get } from 'svelte/store'
  import { diagnosticsByUri, openFilePath } from './stores'
  import type { DiagnosticItem } from './stores'
  import { basename } from './path'

  interface Props {
    open: boolean
    onClose: () => void
    onRevealLine: (line: number) => void
    getFileContent: () => { path: string; content: string } | null
  }
  let { open, onClose, onRevealLine, getFileContent }: Props = $props()

  type Tab = 'errors' | 'warnings'
  let activeTab = $state<Tab>('errors')

  let allItems: DiagnosticItem[] = $state([])
  let selectedIndex = $state(0)
  let visibleCount  = $state(20)
  let listEl: HTMLElement | undefined = $state(undefined)
  let sentinelEl: HTMLElement | undefined = $state(undefined)
  let observer: IntersectionObserver | null = null
  let fileLines: string[] = $state([])

  let errors   = $derived(allItems.filter(i => i.severity === 8))
  let warnings  = $derived(allItems.filter(i => i.severity === 4))
  let items     = $derived(activeTab === 'errors' ? errors : warnings)
  let visibleItems = $derived(items.slice(0, visibleCount))

  $effect(() => {
    if (open) {
      const map = get(diagnosticsByUri)
      const flat: DiagnosticItem[] = []
      for (const uriItems of map.values()) flat.push(...uriItems)
      allItems = flat.sort((a, b) => {
        if (a.severity !== b.severity) return b.severity - a.severity
        if (a.filePath !== b.filePath) return a.filePath.localeCompare(b.filePath)
        return a.startLineNumber - b.startLineNumber
      })
      selectedIndex = 0
      // Default to errors tab if there are any, else warnings
      activeTab = errors.length > 0 ? 'errors' : 'warnings'
      visibleCount = 20
      refreshFileLines()
      requestAnimationFrame(() => listEl?.focus())
    }
  })

  $effect(() => {
    selectedIndex = 0
    visibleCount = 20
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    activeTab  // reactive dependency
  })

  $effect(() => {
    if (sentinelEl && open) {
      observer?.disconnect()
      observer = new IntersectionObserver((entries) => {
        if (entries[0]?.isIntersecting && visibleCount < items.length) {
          visibleCount = Math.min(visibleCount + 20, items.length)
        }
      }, { threshold: 0.1 })
      observer.observe(sentinelEl)
    }
    return () => observer?.disconnect()
  })

  onDestroy(() => observer?.disconnect())

  function refreshFileLines() {
    const fc = getFileContent()
    fileLines = fc ? fc.content.split('\n') : []
  }

  function getExcerpt(item: DiagnosticItem): string {
    const line = fileLines[item.startLineNumber - 1]
    return line !== undefined ? line : ''
  }

  function clickItem(item: DiagnosticItem, i: number) {
    selectedIndex = i
    onClose()
    const currentFile = get(openFilePath)
    if (item.filePath !== currentFile) {
      openFilePath.set(item.filePath)
      setTimeout(() => onRevealLine(item.startLineNumber), 120)
    } else {
      onRevealLine(item.startLineNumber)
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault()
      activeTab = activeTab === 'errors' ? 'warnings' : 'errors'
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIndex = Math.min(selectedIndex + 1, visibleItems.length - 1)
      scrollSelected()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIndex = Math.max(selectedIndex - 1, 0)
      scrollSelected()
    } else if (e.key === 'Enter' && visibleItems[selectedIndex]) {
      e.preventDefault()
      clickItem(visibleItems[selectedIndex], selectedIndex)
    }
  }

  function scrollSelected() {
    requestAnimationFrame(() => {
      listEl?.querySelector<HTMLElement>(`.dm-item.sel`)?.scrollIntoView({ block: 'nearest' })
    })
  }

  function severityIcon(s: number) { return s === 8 ? '✕' : '⚠' }
</script>

{#if open}
  <div role="presentation" class="dm-bg" onclick={onClose}></div>
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="dm"
    role="dialog"
    aria-modal="true"
    aria-labelledby="dm-title"
    tabindex="-1"
    bind:this={listEl}
    onkeydown={onKeydown}
  >
    <div class="dm-header">
      <span id="dm-title" class="dm-title">Diagnostics</span>
    </div>

    <div class="dm-tabs">
      <button
        class="dm-tab"
        class:active={activeTab === 'errors'}
        class:has-items={errors.length > 0}
        onclick={() => activeTab = 'errors'}
      >
        <span class="tab-icon err-icon">✕</span>
        Errors
        {#if errors.length > 0}
          <span class="tab-badge err-badge">{errors.length}</span>
        {/if}
      </button>
      <button
        class="dm-tab"
        class:active={activeTab === 'warnings'}
        class:has-items={warnings.length > 0}
        onclick={() => activeTab = 'warnings'}
      >
        <span class="tab-icon warn-icon">⚠</span>
        Warnings
        {#if warnings.length > 0}
          <span class="tab-badge warn-badge">{warnings.length}</span>
        {/if}
      </button>
    </div>

    <div class="dm-list">
      {#if items.length === 0}
        <div class="dm-empty">
          No {activeTab === 'errors' ? 'errors' : 'warnings'}
        </div>
      {:else}
        {#each visibleItems as item, i}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            role="button"
            tabindex="-1"
            class="dm-item"
            class:sel={i === selectedIndex}
            class:is-error={item.severity === 8}
            class:is-warning={item.severity !== 8}
            onclick={() => clickItem(item, i)}
          >
            <div class="dm-item-header">
              <span class="dm-severity" class:err={item.severity === 8} class:warn={item.severity !== 8}>
                {severityIcon(item.severity)}
              </span>
              <span class="dm-message">{item.message}</span>
              <span class="dm-location">
                <span class="dm-filename">{basename(item.filePath)}</span>
                <span class="dm-linecol">:{item.startLineNumber}:{item.startColumn}</span>
              </span>
            </div>
            {#if getExcerpt(item).trim()}
              <div class="dm-excerpt">
                <span class="dm-lnum">{item.startLineNumber}</span>
                <span class="dm-code">{getExcerpt(item).trim()}</span>
              </div>
            {/if}
          </div>
        {/each}
        <div bind:this={sentinelEl} class="dm-sentinel"></div>
        {#if visibleCount >= items.length && items.length > 20}
          <div class="dm-end">All {items.length} shown</div>
        {/if}
      {/if}
    </div>

    <div class="dm-footer">
      <span class="dm-footer-hint">
        <kbd>&larr;&rarr;</kbd> switch tab &middot; <kbd>&uarr;&darr;</kbd> navigate &middot; <kbd>Enter</kbd> jump to &middot; <kbd>Esc</kbd> close
      </span>
    </div>
  </div>
{/if}

<style>
  .dm-bg {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
  }

  .dm {
    position: fixed;
    top: 15%;
    left: 50%;
    transform: translateX(-50%);
    width: 640px;
    max-width: 92vw;
    background: #1e1e1e;
    border: 1px solid rgba(123, 140, 222, 0.25);
    border-radius: 12px;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.04),
      0 20px 50px rgba(0, 0, 0, 0.7),
      0 0 40px rgba(123, 140, 222, 0.06);
    z-index: 201;
    overflow: hidden;
    animation: dm-in 0.12s ease-out;
    outline: none;
    display: flex;
    flex-direction: column;
    max-height: 60vh;
  }

  @keyframes dm-in {
    from { opacity: 0; transform: translateX(-50%) translateY(-8px) scale(0.98); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
  }

  .dm-header {
    display: flex;
    align-items: center;
    padding: 10px 14px 0;
    flex-shrink: 0;
  }

  .dm-title {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-secondary);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    font-family: var(--font-mono);
  }

  /* Tabs */
  .dm-tabs {
    display: flex;
    gap: 2px;
    padding: 6px 10px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    flex-shrink: 0;
  }

  .dm-tab {
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 5px 12px;
    font-size: 11px;
    font-family: inherit;
    color: var(--text-muted);
    background: none;
    border: none;
    border-bottom: 2px solid transparent;
    margin-bottom: -1px;
    cursor: pointer;
    border-radius: 4px 4px 0 0;
    transition: color 0.1s, background 0.1s;
  }
  .dm-tab:hover { color: var(--text-secondary); background: rgba(255,255,255,0.03); }
  .dm-tab.active {
    color: var(--text-primary);
    border-bottom-color: rgba(123, 140, 222, 0.7);
    background: rgba(255,255,255,0.03);
  }

  .tab-icon { font-size: 10px; }
  .err-icon  { color: var(--error); }
  .warn-icon { color: var(--warning); }

  .tab-badge {
    font-size: 10px;
    font-family: var(--font-mono);
    padding: 0 5px;
    border-radius: 8px;
    line-height: 16px;
  }
  .err-badge  { background: rgba(224, 108, 117, 0.15); color: var(--error); }
  .warn-badge { background: rgba(209, 154, 102, 0.15); color: var(--warning); }

  .dm-list {
    overflow-y: auto;
    flex: 1;
    padding: 4px 0;
  }

  .dm-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px 14px;
    cursor: pointer;
    border-radius: 6px;
    margin: 1px 6px;
    transition: background 0.06s;
    border-left: 2px solid transparent;
  }
  .dm-item:hover  { background: rgba(123, 140, 222, 0.08); }
  .dm-item.sel    { background: rgba(123, 140, 222, 0.13); }
  .dm-item.is-error   { border-left-color: rgba(224, 108, 117, 0.4); }
  .dm-item.is-warning { border-left-color: rgba(209, 154, 102, 0.4); }

  .dm-item-header {
    display: flex;
    align-items: baseline;
    gap: 7px;
    min-width: 0;
  }

  .dm-severity {
    font-size: 10px;
    flex-shrink: 0;
    font-family: var(--font-mono);
    font-weight: 600;
  }
  .dm-severity.err  { color: var(--error); }
  .dm-severity.warn { color: var(--warning); }

  .dm-message {
    font-size: 12px;
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .dm-location {
    display: flex;
    align-items: center;
    flex-shrink: 0;
    margin-left: auto;
  }
  .dm-filename { font-size: 10px; color: #555; font-family: var(--font-mono); }
  .dm-linecol  { font-size: 10px; color: #3d3d3d; font-family: var(--font-mono); }

  .dm-excerpt {
    display: flex;
    align-items: center;
    gap: 8px;
    padding-left: 2px;
    font-family: var(--font-mono);
    font-size: 11px;
    line-height: 1.5;
  }

  .dm-lnum {
    color: #3a3a3a;
    font-size: 10px;
    min-width: 28px;
    text-align: right;
    flex-shrink: 0;
    user-select: none;
  }

  .dm-code {
    color: #5e5e5e;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .dm-sentinel { height: 1px; }

  .dm-end {
    padding: 6px 14px;
    font-size: 10px;
    color: #333;
    text-align: center;
  }

  .dm-empty {
    padding: 28px 14px;
    font-size: 12px;
    color: #3e3e3e;
    text-align: center;
  }

  .dm-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 6px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.04);
    flex-shrink: 0;
  }

  .dm-footer-hint {
    font-size: 10px;
    color: #333;
    display: flex;
    align-items: center;
    gap: 3px;
  }

  .dm-footer-hint kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 1px 5px;
    background: rgba(255, 255, 255, 0.04);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 9px;
    color: #444;
    min-width: 16px;
  }
</style>
