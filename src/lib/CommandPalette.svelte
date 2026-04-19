<script lang="ts">
  import { onMount } from 'svelte'
  import { basename, relpath } from './path'

  // --- Props ---
  interface Props {
    open: boolean
    mode: 'file' | 'command'
    allFiles: string[]
    projectRoot: string | null
    onClose: () => void
    onOpenFile: (path: string, line?: number) => void
    onFindInFile: (query: string) => void
    onRevealLine: (line: number) => void
    onGetCurrentFileContent: () => { path: string; content: string } | null
    onToggleTerminal: () => void
    onToggleTree: () => void
  }
  let {
    open, mode, allFiles, projectRoot,
    onClose, onOpenFile, onFindInFile, onRevealLine, onGetCurrentFileContent,
    onToggleTerminal, onToggleTree,
  }: Props = $props()

  // --- Lazy IPC ---
  let invoke: any = null
  onMount(async () => {
    const ipc = await import('$lib/ipc')
    invoke = ipc.invoke
  })

  // --- Command definitions ---
  interface SlashCommand {
    name: string
    label: string
    description: string
    hasParams: boolean
    paramHint?: string
  }

  const commands: SlashCommand[] = [
    { name: 'find',    label: '/find',    description: 'Find text in current file',         hasParams: true, paramHint: 'search query…' },
    { name: 'findAll', label: '/findAll', description: 'Find text across all project files', hasParams: true, paramHint: 'query [--glob *.py]' },
    { name: 'open',    label: '/open',    description: 'Quick open file by name',            hasParams: true, paramHint: 'filename…' },
    { name: 'term',    label: '/term',    description: 'Toggle terminal panel',              hasParams: false },
    { name: 'tree',    label: '/tree',    description: 'Toggle file tree panel',             hasParams: false },
  ]

  // --- State ---
  let inputEl: HTMLInputElement | undefined = $state(undefined)
  let query = $state('')
  let selectedIndex = $state(0)
  let activeCommand: SlashCommand | null = $state(null)
  let paramQuery = $state('')
  let showSlashOverlay = $state(false)

  // Filtered slash commands
  let filteredCommands = $derived.by(() => {
    if (!showSlashOverlay || activeCommand) return []
    const q = query.slice(1).toLowerCase()
    return commands.filter(c => c.name.toLowerCase().startsWith(q))
  })

  // File search results (for default mode or /open command)
  let fileResults = $derived.by(() => {
    const isFileMode = (mode === 'file' && !showSlashOverlay && !activeCommand)
    const isOpenCmd  = activeCommand?.name === 'open'
    if (!isFileMode && !isOpenCmd) return []

    const searchStr = isOpenCmd ? paramQuery : query
    if (!searchStr.trim()) return allFiles.slice(0, 20)
    const l = searchStr.toLowerCase()
    return allFiles.filter(p => p.toLowerCase().includes(l)).slice(0, 20)
  })

  // Search results for /findAll
  interface GrepResult { path: string; line: number; text: string }
  let grepResults: GrepResult[] = $state([])
  let grepGeneration = 0  // stale-result guard: only apply results from the latest search
  let grepLoading = $state(false)

  // Search results for /find (current file)
  interface FileHit { line: number; text: string }
  let fileHits: FileHit[] = $state([])

  // Which list is currently showing
  let visibleList = $derived.by(() => {
    if (filteredCommands.length > 0) return 'commands' as const
    if (activeCommand?.name === 'findAll') return 'grep' as const
    if (activeCommand?.name === 'find') return 'filehits' as const
    if (fileResults.length > 0) return 'files' as const
    return 'empty' as const
  })

  // The raw search query for highlighting (works for both /find and /findAll)
  let highlightQuery = $derived.by(() => {
    if (activeCommand?.name === 'find') return paramQuery.trim()
    if (activeCommand?.name === 'findAll') {
      let q = paramQuery
      const globMatch = q.match(/--glob\s+\S+/)
      if (globMatch) q = q.replace(/--glob\s+\S+/, '').trim()
      return q.trim()
    }
    return ''
  })

  let listLength = $derived.by(() => {
    if (visibleList === 'commands') return filteredCommands.length
    if (visibleList === 'files') return fileResults.length
    if (visibleList === 'grep') return grepResults.length
    if (visibleList === 'filehits') return fileHits.length
    return 0
  })

  // --- Reactivity: reset state when palette opens/closes ---
  $effect(() => {
    if (open) {
      query = ''
      paramQuery = ''
      activeCommand = null
      selectedIndex = 0
      showSlashOverlay = mode === 'command'
      grepResults = []
      grepLoading = false
      fileHits = []
      if (mode === 'command') query = '/'
      requestAnimationFrame(() => {
        inputEl?.focus()
        // Place cursor after "/" in command mode
        if (mode === 'command' && inputEl) {
          inputEl.setSelectionRange(1, 1)
        }
      })
    }
  })

  // --- Handlers ---

  function onInput(e: Event) {
    const val = (e.target as HTMLInputElement).value

    if (activeCommand) {
      paramQuery = val
      selectedIndex = 0
      if (activeCommand.name === 'findAll') debouncedGrep(val)
      if (activeCommand.name === 'find') searchCurrentFile(val)
      return
    }

    query = val
    selectedIndex = 0

    // Toggle slash overlay
    if (val.startsWith('/')) {
      showSlashOverlay = true
    } else {
      showSlashOverlay = false
    }
  }

  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      if (activeCommand) {
        // Go back to command input
        activeCommand = null
        paramQuery = ''
        query = '/'
        showSlashOverlay = true
        selectedIndex = 0
        requestAnimationFrame(() => inputEl?.focus())
        e.preventDefault()
        return
      }
      onClose()
      return
    }

    if (e.key === 'ArrowDown') {
      selectedIndex = Math.min(selectedIndex + 1, listLength - 1)
      e.preventDefault()
      return
    }
    if (e.key === 'ArrowUp') {
      selectedIndex = Math.max(selectedIndex - 1, 0)
      e.preventDefault()
      return
    }

    if (e.key === 'Tab' && visibleList === 'commands' && filteredCommands.length > 0) {
      // Tab-complete the selected command
      const cmd = filteredCommands[selectedIndex]
      selectCommand(cmd)
      e.preventDefault()
      return
    }

    if (e.key === 'Enter') {
      executeSelection()
      e.preventDefault()
      return
    }

    // Space after a fully typed command triggers pill
    if (e.key === ' ' && !activeCommand && showSlashOverlay) {
      const typed = query.slice(1).toLowerCase()
      const exact = commands.find(c => c.name.toLowerCase() === typed)
      if (exact) {
        selectCommand(exact)
        e.preventDefault()
        return
      }
    }
  }

  function selectCommand(cmd: SlashCommand) {
    if (!cmd.hasParams) {
      // Execute immediately
      executeCommand(cmd, '')
      return
    }
    activeCommand = cmd
    paramQuery = ''
    selectedIndex = 0
    grepResults = []
    requestAnimationFrame(() => inputEl?.focus())
  }

  function executeSelection() {
    if (visibleList === 'commands' && filteredCommands.length > 0) {
      selectCommand(filteredCommands[selectedIndex])
      return
    }

    if (visibleList === 'files' && fileResults.length > 0) {
      const file = fileResults[selectedIndex]
      if (file) { onOpenFile(file); onClose() }
      return
    }

    if (visibleList === 'grep' && grepResults.length > 0) {
      const result = grepResults[selectedIndex]
      if (result) {
        onOpenFile(result.path, result.line)
        onClose()
      }
      return
    }

    if (visibleList === 'filehits' && fileHits.length > 0) {
      const hit = fileHits[selectedIndex]
      if (hit) {
        onRevealLine(hit.line)
        onClose()
      }
      return
    }

    // Execute active command with current param
    if (activeCommand) {
      executeCommand(activeCommand, paramQuery)
      return
    }
  }

  function executeCommand(cmd: SlashCommand, params: string) {
    switch (cmd.name) {
      case 'find':
        // If there are hits, jump to the first one
        if (fileHits.length > 0) {
          onRevealLine(fileHits[0].line)
          onClose()
        }
        break
      case 'findAll':
        if (params.trim()) doGrep(params)
        break
      case 'open':
        // File results are already showing, just pick the first
        if (fileResults.length > 0) {
          onOpenFile(fileResults[0])
          onClose()
        }
        break
      case 'term':
        onToggleTerminal()
        onClose()
        break
      case 'tree':
        onToggleTree()
        onClose()
        break
    }
  }

  // --- Grep ---

  let grepTimer: ReturnType<typeof setTimeout> | null = null
  function debouncedGrep(q: string) {
    if (grepTimer) clearTimeout(grepTimer)
    if (!q.trim()) { grepResults = []; grepLoading = false; return }
    grepLoading = true
    grepTimer = setTimeout(() => doGrep(q), 250)
  }

  async function doGrep(raw: string) {
    if (!invoke || !projectRoot) return
    const gen = ++grepGeneration
    grepLoading = true

    // Parse --glob flag
    let query = raw
    let glob = ''
    const globMatch = raw.match(/--glob\s+(\S+)/)
    if (globMatch) {
      glob = globMatch[1]
      query = raw.replace(/--glob\s+\S+/, '').trim()
    }

    if (!query) { grepResults = []; grepLoading = false; return }

    try {
      const results = await invoke('grep_files', {
        root: projectRoot,
        query,
        glob: glob || undefined,
      })
      if (gen !== grepGeneration) return  // stale: a newer search has started
      grepResults = (results ?? []).slice(0, 200)
    } catch (e) {
      if (gen !== grepGeneration) return
      console.error('grep_files failed:', e)
      grepResults = []
    }
    grepLoading = false
  }

  // --- In-file search ---

  function searchCurrentFile(q: string) {
    if (!q.trim()) { fileHits = []; return }
    const file = onGetCurrentFileContent()
    if (!file) { fileHits = []; return }
    const lower = q.toLowerCase()
    const lines = file.content.split('\n')
    const hits: FileHit[] = []
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(lower)) {
        hits.push({ line: i + 1, text: lines[i] })
        if (hits.length >= 100) break
      }
    }
    fileHits = hits
  }

  // --- Helpers ---

  /** Split a line of text into segments: [before, match, after] for highlight rendering */
  function highlightSegments(text: string, query: string): { before: string; match: string; after: string } {
    if (!query) return { before: text, match: '', after: '' }
    const idx = text.toLowerCase().indexOf(query.toLowerCase())
    if (idx === -1) return { before: text, match: '', after: '' }
    return {
      before: text.slice(0, idx),
      match:  text.slice(idx, idx + query.length),
      after:  text.slice(idx + query.length),
    }
  }

  function clickFile(p: string) { onOpenFile(p); onClose() }
  function clickGrepResult(r: GrepResult) {
    onOpenFile(r.path, r.line)
    onClose()
  }
  function clickFileHit(h: FileHit) { onRevealLine(h.line); onClose() }
  function clickCommand(cmd: SlashCommand) { selectCommand(cmd) }

  function handleBgClick() { onClose() }
</script>

{#if open}
  {#snippet highlightedCode(text: string)}
    {@const seg = highlightSegments(text, highlightQuery)}
    {seg.before}<mark class="cp-hl">{seg.match}</mark>{seg.after}
  {/snippet}

  <div role="presentation" class="cp-bg" onclick={handleBgClick}></div>
  <div class="cp">
    <!-- Input area -->
    <div class="cp-input-row">
      {#if activeCommand}
        <span class="cp-pill">{activeCommand.label}</span>
      {/if}
      <input
        bind:this={inputEl}
        class="cp-input selectable"
        type="text"
        placeholder={activeCommand ? (activeCommand.paramHint ?? 'type params…') : mode === 'command' ? 'Type / for commands…' : 'Go to file…'}
        value={activeCommand ? paramQuery : query}
        oninput={onInput}
        onkeydown={onKeydown}
      />
    </div>

    <!-- Results list -->
    <div class="cp-list">
      {#if visibleList === 'commands'}
        {#each filteredCommands as cmd, i}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div role="button" tabindex="-1" class="cp-item" class:sel={i === selectedIndex} onclick={() => clickCommand(cmd)}>
            <span class="cp-cmd-name">{cmd.label}</span>
            <span class="cp-cmd-desc">{cmd.description}</span>
          </div>
        {/each}
      {:else if visibleList === 'files'}
        {#each fileResults as file, i}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div role="button" tabindex="-1" class="cp-item" class:sel={i === selectedIndex} onclick={() => clickFile(file)}>
            <span class="cp-file-name">{basename(file)}</span>
            <span class="cp-file-dir">{relpath(file, projectRoot ?? '')}</span>
          </div>
        {/each}
      {:else if visibleList === 'grep'}
        {#if grepLoading && grepResults.length === 0}
          <div class="cp-empty cp-searching">
            <span class="cp-spinner"></span> Searching project…
          </div>
        {/if}
        {#each grepResults as result, i}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div role="button" tabindex="-1" class="cp-hit" class:sel={i === selectedIndex} onclick={() => clickGrepResult(result)}>
            <div class="cp-hit-excerpt">
              <span class="cp-hit-line-num">{result.line}</span>
              <span class="cp-hit-code">{@render highlightedCode(result.text.trim())}</span>
            </div>
            <div class="cp-hit-meta">
              <span class="cp-hit-file">{basename(result.path)}</span>
              <span class="cp-hit-path">{relpath(result.path, projectRoot ?? '')}</span>
            </div>
          </div>
        {/each}
        {#if !grepLoading && grepResults.length === 0 && paramQuery.trim()}
          <div class="cp-empty">No matches found</div>
        {:else if !paramQuery.trim()}
          <div class="cp-empty">Start typing to search across all files</div>
        {/if}
      {:else if visibleList === 'filehits'}
        {#each fileHits as hit, i}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div role="button" tabindex="-1" class="cp-hit" class:sel={i === selectedIndex} onclick={() => clickFileHit(hit)}>
            <div class="cp-hit-excerpt">
              <span class="cp-hit-line-num">{hit.line}</span>
              <span class="cp-hit-code">{@render highlightedCode(hit.text.trim())}</span>
            </div>
          </div>
        {/each}
        {#if fileHits.length === 0 && paramQuery.trim()}
          <div class="cp-empty">No matches in current file</div>
        {:else if !paramQuery.trim()}
          <div class="cp-empty">Start typing to search in this file</div>
        {/if}
      {:else}
        <div class="cp-empty">
          {#if mode === 'command' && !activeCommand}
            Type <span class="cp-hint-slash">/</span> to see available commands
          {:else}
            No results
          {/if}
        </div>
      {/if}
    </div>

    <!-- Footer hint -->
    <div class="cp-footer">
      {#if activeCommand}
        <span class="cp-footer-hint">
          <kbd>Enter</kbd> execute &middot; <kbd>Esc</kbd> back
        </span>
      {:else if visibleList === 'commands'}
        <span class="cp-footer-hint">
          <kbd>&uarr;&darr;</kbd> navigate &middot; <kbd>Tab</kbd> or <kbd>Enter</kbd> select &middot; <kbd>Space</kbd> after command
        </span>
      {:else}
        <span class="cp-footer-hint">
          <kbd>&uarr;&darr;</kbd> navigate &middot; <kbd>Enter</kbd> select &middot; <kbd>Esc</kbd> close
        </span>
      {/if}
    </div>
  </div>
{/if}

<style>
  .cp-bg {
    position: fixed; inset: 0; z-index: 200;
    background: rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(2px);
  }

  .cp {
    position: fixed;
    top: 15%;
    left: 50%;
    transform: translateX(-50%);
    width: 520px;
    max-width: 90vw;
    background: #1e1e1e;
    border: 1px solid rgba(123, 140, 222, 0.25);
    border-radius: 12px;
    box-shadow:
      0 0 0 1px rgba(255, 255, 255, 0.04),
      0 20px 50px rgba(0, 0, 0, 0.7),
      0 0 40px rgba(123, 140, 222, 0.06);
    z-index: 201;
    overflow: hidden;
    animation: cp-in 0.12s ease-out;
  }

  @keyframes cp-in {
    from { opacity: 0; transform: translateX(-50%) translateY(-8px) scale(0.98); }
    to   { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
  }

  /* Input row */
  .cp-input-row {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 2px 4px 2px 6px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }

  .cp-pill {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    margin: 6px 0 6px 6px;
    background: rgba(123, 140, 222, 0.18);
    border: 1px solid rgba(123, 140, 222, 0.3);
    border-radius: 6px;
    color: #7b8cde;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 500;
    white-space: nowrap;
    flex-shrink: 0;
    letter-spacing: 0.02em;
  }

  .cp-input {
    flex: 1;
    background: transparent;
    border: none;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: 13px;
    padding: 12px 10px;
    outline: none;
    min-width: 0;
  }
  .cp-input::placeholder { color: #4a4a4a; }

  /* Results list */
  .cp-list {
    max-height: 320px;
    overflow-y: auto;
    padding: 4px 0;
  }

  .cp-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 7px 14px;
    cursor: pointer;
    gap: 12px;
    border-radius: 6px;
    margin: 1px 6px;
    transition: background 0.06s;
  }
  .cp-item:hover,
  .cp-item.sel {
    background: rgba(123, 140, 222, 0.1);
  }
  .cp-item.sel {
    background: rgba(123, 140, 222, 0.15);
  }

  /* Command items */
  .cp-cmd-name {
    font-size: 12px;
    color: #7b8cde;
    font-weight: 500;
    white-space: nowrap;
    font-family: var(--font-mono);
  }
  .cp-cmd-desc {
    font-size: 11px;
    color: #5a5a5a;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* File items */
  .cp-file-name {
    font-size: 12px;
    color: var(--text-primary);
    white-space: nowrap;
  }
  .cp-file-dir {
    font-size: 11px;
    color: #4a4a4a;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    max-width: 260px;
  }

  /* Search hit items (shared by /find and /findAll) */
  .cp-hit {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 6px 14px;
    cursor: pointer;
    border-radius: 6px;
    margin: 1px 6px;
    transition: background 0.06s;
  }
  .cp-hit:hover,
  .cp-hit.sel {
    background: rgba(123, 140, 222, 0.1);
  }
  .cp-hit.sel {
    background: rgba(123, 140, 222, 0.15);
  }

  .cp-hit-excerpt {
    display: flex;
    align-items: center;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
  }
  .cp-hit-line-num {
    color: #444;
    font-size: 10px;
    min-width: 28px;
    text-align: right;
    flex-shrink: 0;
    user-select: none;
  }
  .cp-hit-code {
    color: #8a8a8a;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cp-hl {
    background: rgba(123, 140, 222, 0.25);
    color: #bfc8f0;
    border-radius: 2px;
    padding: 0 1px;
  }

  .cp-hit-meta {
    display: flex;
    align-items: center;
    gap: 6px;
    padding-left: 36px;
  }
  .cp-hit-file {
    font-size: 10px;
    color: #555;
  }
  .cp-hit-path {
    font-size: 10px;
    color: #383838;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
  }

  .cp-searching {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .cp-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 1.5px solid #333;
    border-top-color: #7b8cde;
    border-radius: 50%;
    animation: cp-spin 0.6s linear infinite;
  }
  @keyframes cp-spin {
    to { transform: rotate(360deg); }
  }

  /* Empty state */
  .cp-empty {
    padding: 20px 14px;
    font-size: 12px;
    color: #3e3e3e;
    text-align: center;
  }
  .cp-hint-slash {
    color: #7b8cde;
    font-weight: 600;
  }

  /* Footer */
  .cp-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 6px 14px;
    border-top: 1px solid rgba(255, 255, 255, 0.04);
  }
  .cp-footer-hint {
    font-size: 10px;
    color: #333;
    display: flex;
    align-items: center;
    gap: 3px;
  }
  .cp-footer-hint kbd {
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
