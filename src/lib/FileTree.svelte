<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import ChevronRightIcon from 'lucide-svelte/icons/chevron-right'
  import ChevronDownIcon  from 'lucide-svelte/icons/chevron-down'
  import FolderIcon from 'lucide-svelte/icons/folder'
  import FolderOpenIcon from 'lucide-svelte/icons/folder-open'
  import FileTextIcon from 'lucide-svelte/icons/file-text'
  import FileCodeIcon from 'lucide-svelte/icons/file-code'
  import SettingsIcon from 'lucide-svelte/icons/settings'
  import BookOpenIcon from 'lucide-svelte/icons/book-open'
  import LockIcon from 'lucide-svelte/icons/lock'
  import TerminalIcon from 'lucide-svelte/icons/terminal-square'
  import BoxIcon from 'lucide-svelte/icons/box'
  import GitBranchIcon from 'lucide-svelte/icons/git-branch'
  import KeyIcon from 'lucide-svelte/icons/key'
  import ImageIcon from 'lucide-svelte/icons/image'
  import DatabaseIcon from 'lucide-svelte/icons/database'
  import GlobeIcon from 'lucide-svelte/icons/globe'
  import CopyrightIcon from 'lucide-svelte/icons/copyright'
  import FileIcon from 'lucide-svelte/icons/file'
  import BracesIcon from 'lucide-svelte/icons/braces'

  interface FileEntry {
    name:      string
    path:      string
    is_dir:    boolean
    children?: FileEntry[]
  }

  interface FlatEntry extends FileEntry {
    depth:    number
    expanded: boolean
  }

  let invoke:  any
  let stores:  any
  let cleanups: Array<() => void> = []

  let tree:        FileEntry[]           = $state([])
  let expanded     = $state(new Set<string>())
  let childrenMap  = $state(new Map<string, FileEntry[]>())
  let activeFile   = $state('')
  let fontSize     = $state(15)
  let projectRoot  = $state<string | null>(null)
  let loadedRoot:  string | null = null

  // Diagnostics
  let errorPaths   = $state(new Set<string>())
  let warningPaths = $state(new Set<string>())

  // Gitignore
  interface GitignoreRule { regex: RegExp; negated: boolean; dirOnly: boolean }
  let gitignoreRules: GitignoreRule[] = $state([])

  function gitPatternToRegex(pattern: string, anchored: boolean): RegExp {
    const s = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials
      .replace(/\*\*/g, '\x01')              // placeholder for **
      .replace(/\*/g, '[^/]*')               // * → within-segment wildcard
      .replace(/\x01/g, '.*')               // ** → cross-segment wildcard
      .replace(/\?/g, '[^/]')               // ? → single char
    if (anchored || pattern.includes('/')) {
      // Match from repo root
      return new RegExp('^' + s + '(/.*)?$')
    } else {
      // No slash → match against any path component
      return new RegExp('(^|/)' + s + '(/.*)?$')
    }
  }

  function parseGitignore(content: string): GitignoreRule[] {
    const rules: GitignoreRule[] = []
    for (let line of content.split('\n')) {
      line = line.trim()
      if (!line || line.startsWith('#')) continue
      const negated = line.startsWith('!')
      if (negated) line = line.slice(1).trim()
      const dirOnly = line.endsWith('/')
      if (dirOnly) line = line.slice(0, -1)
      const anchored = line.startsWith('/')
      if (anchored) line = line.slice(1)
      if (!line) continue
      try { rules.push({ regex: gitPatternToRegex(line, anchored), negated, dirOnly }) } catch {}
    }
    return rules
  }

  function isIgnored(entry: FlatEntry): boolean {
    if (!gitignoreRules.length || !projectRoot) return false
    const rel = entry.path.startsWith(projectRoot + '/')
      ? entry.path.slice(projectRoot.length + 1)
      : null
    if (!rel) return false
    // Walk ancestor segments — if any ancestor is ignored, so is this entry
    const parts = rel.split('/')
    for (let d = 1; d <= parts.length; d++) {
      const subRel = parts.slice(0, d).join('/')
      const subIsDir = d < parts.length || entry.is_dir
      let ignored = false
      for (const rule of gitignoreRules) {
        if (rule.dirOnly && !subIsDir) continue
        if (rule.regex.test(subRel)) ignored = !rule.negated
      }
      if (ignored) return true
    }
    return false
  }

  async function loadGitignore(root: string) {
    try {
      const content = await invoke('read_file_content', { path: root + '/.gitignore' })
      gitignoreRules = parseGitignore(content)
    } catch {
      gitignoreRules = []
    }
  }

  // Context menu
  interface CtxMenu { x: number; y: number; entry: FlatEntry | null }
  let ctxMenu: CtxMenu | null = $state(null)

  // Clipboard
  let clipboard = $state<{ path: string; isDir: boolean } | null>(null)

  // Inline rename
  let renamingPath = $state<string | null>(null)
  let renameValue  = $state('')

  // Active path highlighting
  let activeFolders = $state(new Set<string>())

  async function loadTree(root: string) {
    if (!invoke || !root) return
    loadedRoot = root
    try {
      tree = await invoke('read_dir_recursive', { path: root, depth: 0 })
      expanded = new Set()
      childrenMap = new Map()
    } catch (e) {
      console.error('[FileTree] loadTree failed:', e)
      loadedRoot = null
    }
  }

  function updateActiveFolders(filePath: string) {
    const parts = filePath.split('/')
    const folders = new Set<string>()
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
    activeFolders = folders
  }

  onMount(async () => {
    const ipcMod    = await import('$lib/ipc')
    const storesMod = await import('./stores')
    const { get }   = await import('svelte/store')
    invoke = ipcMod.invoke
    stores = storesMod

    stores.openFilePath.subscribe((p: string | null) => {
      activeFile = p ?? ''
      if (p) updateActiveFolders(p)
    })
    stores.treeFontSize.subscribe((s: number) => { fontSize = s })
    stores.projectRoot.subscribe((root: string | null) => {
      projectRoot = root
      if (root) {
        loadTree(root)
        loadGitignore(root)
        invoke('watch_project', { root }).catch(() => {})
      }
    })

    // On any fs change: reload tree + re-read gitignore (covers .gitignore edits)
    cleanups.push(await ipcMod.listen('dir:changed', () => {
      if (loadedRoot) { loadTree(loadedRoot); loadGitignore(loadedRoot) }
    }))

    cleanups.push(stores.diagnosticsByUri.subscribe((map: Map<string, any[]>) => {
      const errors   = new Set<string>()
      const warnings = new Set<string>()
      for (const [, items] of map) {
        for (const item of items) {
          if (item.severity === 8) errors.add(item.filePath)
          else if (item.severity === 4) warnings.add(item.filePath)
        }
      }
      errorPaths   = errors
      warningPaths = warnings
    }))

    window.addEventListener('click', closeCtxMenu)
    cleanups.push(() => window.removeEventListener('click', closeCtxMenu))

    const root = get(stores.projectRoot) as string | null
    if (root) { loadTree(root); loadGitignore(root) }
  })

  onDestroy(() => { for (const c of cleanups) c() })

  function flatten(entries: FileEntry[], depth: number): FlatEntry[] {
    const result: FlatEntry[] = []
    for (const e of entries) {
      const isExpanded = expanded.has(e.path)
      result.push({ ...e, depth, expanded: isExpanded })
      if (e.is_dir && isExpanded) {
        const children = childrenMap.get(e.path) ?? e.children ?? []
        result.push(...flatten(children, depth + 1))
      }
    }
    return result
  }

  let flat: FlatEntry[] = $derived(flatten(tree, 1))

  async function handleClick(entry: FlatEntry) {
    if (entry.is_dir) {
      if (expanded.has(entry.path)) {
        expanded.delete(entry.path)
      } else {
        if (!childrenMap.has(entry.path)) {
          const children = await invoke('read_dir_recursive', { path: entry.path, depth: 0 })
          childrenMap.set(entry.path, children)
          childrenMap = new Map(childrenMap)
        }
        expanded.add(entry.path)
      }
      expanded = new Set(expanded)
    } else {
      const { get } = await import('svelte/store')
      const tabs = get(stores.openTabs) as string[]
      if (!tabs.includes(entry.path)) stores.openTabs.set([...tabs, entry.path])
      stores.openFilePath.set(entry.path)
    }
  }

  // ─── Context menu ──────────────────────────────────────────────────────────

  function openCtxMenu(e: MouseEvent, entry: FlatEntry | null) {
    e.preventDefault()
    e.stopPropagation()
    ctxMenu = { x: e.clientX, y: e.clientY, entry }
  }

  function closeCtxMenu() {
    ctxMenu = null
    if (renamingPath) { renamingPath = null; renameValue = '' }
  }

  async function ctxNewFile(dir: string) {
    closeCtxMenu()
    const name = prompt('New file name:')
    if (!name?.trim()) return
    const newPath = dir + '/' + name.trim()
    try {
      await invoke('create_file', { path: newPath })
      await loadTree(projectRoot!)
      const tabs = (await import('svelte/store')).get(stores.openTabs) as string[]
      if (!tabs.includes(newPath)) stores.openTabs.set([...tabs, newPath])
      stores.openFilePath.set(newPath)
    } catch (e: any) { alert('Could not create file: ' + e.message) }
  }

  async function ctxNewFolder(dir: string) {
    closeCtxMenu()
    const name = prompt('New folder name:')
    if (!name?.trim()) return
    try {
      await invoke('create_dir', { path: dir + '/' + name.trim() })
      await loadTree(projectRoot!)
    } catch (e: any) { alert('Could not create folder: ' + e.message) }
  }

  function ctxCopy(entry: FlatEntry) {
    clipboard = { path: entry.path, isDir: entry.is_dir }
    closeCtxMenu()
  }

  async function ctxPaste(targetDir: string) {
    closeCtxMenu()
    if (!clipboard) return
    const dst = targetDir + '/' + clipboard.path.split('/').pop()!
    try {
      await invoke('rename_path', { src: clipboard.path, dst })
      clipboard = null
      await loadTree(projectRoot!)
    } catch (e: any) { alert('Could not paste: ' + e.message) }
  }

  async function ctxDelete(entry: FlatEntry) {
    closeCtxMenu()
    const label = entry.is_dir ? `folder "${entry.name}" and all its contents` : `file "${entry.name}"`
    if (!confirm(`Delete ${label}?`)) return
    try {
      if (stores) {
        const { get } = await import('svelte/store')
        const openTabs = get(stores.openTabs) as string[]
        const openFile = get(stores.openFilePath) as string | null
        const toClose  = openTabs.filter(t => t === entry.path || t.startsWith(entry.path + '/'))
        if (toClose.length) {
          const remaining = openTabs.filter(t => !toClose.includes(t))
          stores.openTabs.set(remaining)
          if (openFile && toClose.includes(openFile))
            stores.openFilePath.set(remaining.length ? remaining[remaining.length - 1] : null)
        }
      }
      await invoke('delete_path', { path: entry.path })
      await loadTree(projectRoot!)
    } catch (e: any) { alert('Could not delete: ' + e.message) }
  }

  function ctxStartRename(entry: FlatEntry) {
    closeCtxMenu()
    renamingPath = entry.path
    renameValue  = entry.name
  }

  async function commitRename(entry: FlatEntry) {
    if (!renameValue.trim() || renameValue === entry.name) { renamingPath = null; renameValue = ''; return }
    const dir = entry.path.split('/').slice(0, -1).join('/')
    const dst = dir + '/' + renameValue.trim()
    try {
      await invoke('rename_path', { src: entry.path, dst })
      if (stores) {
        const { get } = await import('svelte/store')
        const openTabs = get(stores.openTabs) as string[]
        const openFile = get(stores.openFilePath) as string | null
        const updated  = openTabs.map(t =>
          t === entry.path ? dst : (t.startsWith(entry.path + '/') ? dst + t.slice(entry.path.length) : t)
        )
        stores.openTabs.set(updated)
        if (openFile === entry.path) stores.openFilePath.set(dst)
      }
      await loadTree(projectRoot!)
    } catch (e: any) { alert('Could not rename: ' + e.message) }
    renamingPath = null; renameValue = ''
  }

  // ─── Icon helpers ──────────────────────────────────────────────────────────

  type IconComponent = typeof FileIcon

  function fileIconComponent(entry: FlatEntry): IconComponent {
    if (entry.is_dir) return entry.expanded ? FolderOpenIcon : FolderIcon
    const ext  = entry.name.split('.').pop()?.toLowerCase() ?? ''
    const name = entry.name.toLowerCase()
    if (ext === 'py' || name === '.python-version') return FileCodeIcon
    if (name === 'dockerfile' || name.startsWith('docker') || name === '.dockerignore') return BoxIcon
    if (name.includes('lock')) return LockIcon
    if (ext === 'toml' || ext === 'ini' || ext === 'cfg' || ext === 'conf' || ext === 'yaml' || ext === 'yml') return SettingsIcon
    if (ext === 'json') return BracesIcon
    if (ext === 'md' || ext === 'rst') return BookOpenIcon
    if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || name === 'makefile' || name === 'justfile') return TerminalIcon
    if (name === '.gitignore' || name === '.gitattributes') return GitBranchIcon
    if (name === '.env' || name.startsWith('.env.')) return KeyIcon
    if (name === 'license' || name === 'licence') return CopyrightIcon
    if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'svg' || ext === 'ico') return ImageIcon
    if (ext === 'csv' || ext === 'parquet' || ext === 'sql') return DatabaseIcon
    if (ext === 'html' || ext === 'css' || ext === 'js' || ext === 'ts' || ext === 'xml') return GlobeIcon
    if (ext === 'txt') return FileTextIcon
    return FileIcon
  }

  function iconColor(entry: FlatEntry, ignored: boolean): string {
    if (ignored) return 'var(--text-muted)'
    if (entry.is_dir) return 'var(--text-secondary)'
    const ext  = entry.name.split('.').pop()?.toLowerCase() ?? ''
    const name = entry.name.toLowerCase()
    if (ext === 'py' || name === '.python-version') return '#e5c07b'
    if (name === 'dockerfile' || name.startsWith('docker')) return '#61afef'
    if (name.includes('lock')) return '#7a7a7a'
    if (ext === 'toml' || ext === 'ini' || ext === 'cfg' || ext === 'conf') return '#7a7a7a'
    if (ext === 'yaml' || ext === 'yml') return '#e06c75'
    if (ext === 'json') return '#e5c07b'
    if (ext === 'md' || ext === 'rst') return '#61afef'
    if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return '#98c379'
    if (name === '.gitignore' || name === '.gitattributes') return '#e06c75'
    return 'var(--text-muted)'
  }

  // Chevron size is slightly smaller than the file icon
  let iconSize:    number = $derived(Math.round(fontSize * 1.0))
  let chevronSize: number = $derived(Math.max(12, Math.round(fontSize * 0.92)))
</script>

{#if ctxMenu}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="ctx-menu"
    style="left:{ctxMenu.x}px;top:{ctxMenu.y}px"
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => e.stopPropagation()}
  >
    {#if ctxMenu.entry?.is_dir || ctxMenu.entry === null}
      {@const dir = ctxMenu.entry?.path ?? projectRoot!}
      <button onclick={() => ctxNewFile(dir)}>New File</button>
      <button onclick={() => ctxNewFolder(dir)}>New Folder</button>
      {#if clipboard}
        <div class="ctx-sep"></div>
        <button onclick={() => ctxPaste(dir)}>Paste</button>
      {/if}
    {/if}
    {#if ctxMenu.entry}
      <div class="ctx-sep"></div>
      <button onclick={() => ctxCopy(ctxMenu!.entry!)}>Copy</button>
      <button onclick={() => ctxStartRename(ctxMenu!.entry!)}>Rename</button>
      <div class="ctx-sep"></div>
      <button class="danger" onclick={() => ctxDelete(ctxMenu!.entry!)}>Delete</button>
    {/if}
  </div>
{/if}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="tree"
  style="font-size:{fontSize}px"
  oncontextmenu={(e) => openCtxMenu(e, null)}
>
  {#if projectRoot}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="tree-item is-dir tree-root" style="padding-left:6px" title={projectRoot}>
      <!-- root row: no chevron, spacer removed so icon sits at the edge -->
      <span class="chevron-spacer" style="width:0px"></span>
      <span class="icon" style="color:var(--text-secondary);width:{iconSize+2}px;height:{iconSize+2}px">
        <FolderOpenIcon size={iconSize} strokeWidth={1.5} />
      </span>
      <span class="name">{projectRoot.split('/').pop()}</span>
    </div>
  {/if}

  {#each flat as entry (entry.path)}
    {@const EntryIcon = fileIconComponent(entry)}
    {@const ignored   = isIgnored(entry)}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      role="button"
      tabindex="0"
      class="tree-item"
      class:is-dir={entry.is_dir}
      class:is-active={entry.path === activeFile}
      class:in-path={entry.is_dir && activeFolders.has(entry.path)}
      class:gitignored={ignored}
      style="padding-left:{6 + entry.depth * 16}px;height:{Math.round(fontSize * 2.0)}px"
      onclick={() => handleClick(entry)}
      oncontextmenu={(e) => openCtxMenu(e, entry)}
      title={entry.path}
    >
      <!-- Chevron for folders; invisible spacer for files so icons align -->
      {#if entry.is_dir}
        <span class="chevron" style="width:{chevronSize}px;height:{chevronSize}px">
          {#if entry.expanded}
            <ChevronDownIcon  size={chevronSize} strokeWidth={1} />
          {:else}
            <ChevronRightIcon size={chevronSize} strokeWidth={1} />
          {/if}
        </span>
      {:else}
        <span class="chevron-spacer" style="width:{chevronSize}px"></span>
      {/if}

      <span class="icon" style="color:{iconColor(entry, ignored)};width:{iconSize+2}px;height:{iconSize+2}px">
        <EntryIcon size={iconSize} strokeWidth={1.5} />
      </span>

      {#if renamingPath === entry.path}
        <!-- svelte-ignore a11y_autofocus -->
        <input
          class="rename-input"
          bind:value={renameValue}
          autofocus
          onclick={(e) => e.stopPropagation()}
          onkeydown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitRename(entry) }
            if (e.key === 'Escape') { renamingPath = null; renameValue = '' }
          }}
          onblur={() => commitRename(entry)}
        />
      {:else}
        <span class="name">{entry.name}</span>
        {#if !ignored}
          {#if errorPaths.has(entry.path)}
            <span class="diag-dot error" title="Has errors"></span>
          {:else if warningPaths.has(entry.path)}
            <span class="diag-dot warning" title="Has warnings"></span>
          {/if}
        {/if}
      {/if}
    </div>
  {/each}
</div>

<style>
  .tree {
    height: 100%;
    overflow-y: auto;
    padding: 6px 0;
  }

  .tree-item {
    display: flex;
    align-items: center;
    gap: 5px;
    padding-right: 12px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    color: var(--text-secondary);
    border-left: 2px solid transparent;
    transition: background 0.08s;
  }

  .tree-item:hover     { background: var(--bg-hover); color: var(--text-primary); }
  .tree-item.is-active {
    background: var(--bg-active);
    border-left-color: var(--accent);
    color: var(--text-primary);
  }
  .tree-item.in-path   { color: var(--text-primary); }
  .tree-item.is-dir    { color: var(--text-secondary); }
  .tree-item.is-dir:hover { color: var(--text-primary); }

  .tree-item.gitignored        { opacity: 0.75; }
  .tree-item.gitignored:hover  { opacity: 0.9; }
  .tree-item.gitignored .chevron { opacity: 1; color: var(--text-secondary); }

  .tree-root { cursor: default; color: var(--text-primary); font-weight: 600; letter-spacing: 0.01em; }
  .tree-root:hover { background: transparent; color: var(--text-primary); opacity: 1; }

  .chevron {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    opacity: 0.9;
    transition: opacity 0.1s;
  }
  .tree-item:hover .chevron { opacity: 1; }

  .chevron-spacer {
    flex-shrink: 0;
    display: inline-block;
  }

  .icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .is-active .icon { color: var(--accent) !important; }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .diag-dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
    margin-left: 2px;
  }
  .diag-dot.error   { background: #e06c75; }
  .diag-dot.warning { background: #e5c07b; }

  .rename-input {
    flex: 1;
    background: var(--bg-active);
    border: 1px solid var(--accent);
    border-radius: 2px;
    color: var(--text-primary);
    font-size: inherit;
    font-family: inherit;
    padding: 0 4px;
    outline: none;
    min-width: 0;
  }

  /* Context menu */
  .ctx-menu {
    position: fixed; z-index: 9999;
    background: var(--bg-editor); border: 1px solid var(--border);
    border-radius: 8px; padding: 4px 0; min-width: 160px;
    box-shadow: 0 4px 14px rgba(0,0,0,0.4);
    font-family: 'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace;
  }
  .ctx-menu button {
    display: block; width: 100%; text-align: left;
    padding: 8px 28px; font-size: 12px; background: none;
    border: none; cursor: pointer; color: var(--text-secondary);
    font-family: inherit;
  }
  .ctx-menu button:hover { background: var(--bg-hover); color: var(--text-primary); }
  .ctx-menu button.danger { color: #e06c75; }
  .ctx-menu button.danger:hover { background: rgba(224,108,117,0.12); color: #e06c75; }
  .ctx-sep { height: 1px; background: var(--border); margin: 3px 0; }
</style>
