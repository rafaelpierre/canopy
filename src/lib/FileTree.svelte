<script lang="ts">
  import { onMount } from 'svelte'
  import FolderIcon from 'lucide-svelte/icons/folder'
  import FolderOpenIcon from 'lucide-svelte/icons/folder-open'
  import FileTextIcon from 'lucide-svelte/icons/file-text'
  import FileCodeIcon from 'lucide-svelte/icons/file-code'
  import FileJsonIcon from 'lucide-svelte/icons/file-json'
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

  let tree:        FileEntry[]           = $state([])
  let expanded     = $state(new Set<string>())
  let childrenMap  = $state(new Map<string, FileEntry[]>())
  let activeFile   = $state('')
  let fontSize     = $state(15)
  let projectRoot  = $state<string | null>(null)
  let loadedRoot:  string | null = null

  // Track which folders are in the active file's path
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
    for (let i = 1; i < parts.length; i++) {
      folders.add(parts.slice(0, i).join('/'))
    }
    activeFolders = folders
  }

  onMount(async () => {
    const ipcMod  = await import('$lib/ipc')
    const storesMod = await import('./stores')
    const { get } = await import('svelte/store')
    invoke = ipcMod.invoke
    stores = storesMod

    stores.openFilePath.subscribe((p: string | null) => {
      activeFile = p ?? ''
      if (p) updateActiveFolders(p)
    })
    stores.treeFontSize.subscribe((s: number) => { fontSize = s })

    stores.projectRoot.subscribe((root: string | null) => {
      projectRoot = root
      if (root) loadTree(root)
    })

    const root = get(stores.projectRoot) as string | null
    if (root) loadTree(root)
  })

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
      if (!tabs.includes(entry.path)) {
        stores.openTabs.set([...tabs, entry.path])
      }
      stores.openFilePath.set(entry.path)
    }
  }

  type IconComponent = typeof FileIcon

  function fileIconComponent(entry: FlatEntry): IconComponent {
    if (entry.is_dir) return entry.expanded ? FolderOpenIcon : FolderIcon
    const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
    const name = entry.name.toLowerCase()
    // Python
    if (ext === 'py' || name === '.python-version') return FileCodeIcon
    // Docker
    if (name === 'dockerfile' || name.startsWith('docker') || name === '.dockerignore') return BoxIcon
    // Lock
    if (name.includes('lock')) return LockIcon
    // Config
    if (ext === 'toml' || ext === 'ini' || ext === 'cfg' || ext === 'conf' || ext === 'yaml' || ext === 'yml') return SettingsIcon
    // JSON
    if (ext === 'json') return BracesIcon
    // Markdown
    if (ext === 'md' || ext === 'rst') return BookOpenIcon
    // Shell
    if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || name === 'makefile' || name === 'justfile') return TerminalIcon
    // Git
    if (name === '.gitignore' || name === '.gitattributes') return GitBranchIcon
    // Env
    if (name === '.env' || name.startsWith('.env.')) return KeyIcon
    // License
    if (name === 'license' || name === 'licence') return CopyrightIcon
    // Images
    if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'svg' || ext === 'ico') return ImageIcon
    // Data
    if (ext === 'csv' || ext === 'parquet' || ext === 'sql') return DatabaseIcon
    // Web
    if (ext === 'html' || ext === 'css' || ext === 'js' || ext === 'ts' || ext === 'xml') return GlobeIcon
    // Text fallback
    if (ext === 'txt') return FileTextIcon
    return FileIcon
  }

  function iconColor(entry: FlatEntry): string {
    if (entry.is_dir) return 'var(--text-secondary)'
    const ext = entry.name.split('.').pop()?.toLowerCase() ?? ''
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
</script>

<div class="tree" style="font-size:{fontSize}px">
  {#if projectRoot}
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
    <div class="tree-item is-dir tree-root" style="padding-left: 12px" title={projectRoot}>
      <span class="icon" style="color:var(--text-secondary)">
        <FolderOpenIcon size={14} strokeWidth={1.5} />
      </span>
      <span class="name">{projectRoot.split('/').pop()}</span>
    </div>
  {/if}
  {#each flat as entry (entry.path)}
    {@const EntryIcon = fileIconComponent(entry)}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div
      role="button"
      tabindex="0"
      class="tree-item"
      class:is-dir={entry.is_dir}
      class:is-active={entry.path === activeFile}
      class:in-path={entry.is_dir && activeFolders.has(entry.path)}
      style="padding-left: {12 + entry.depth * 14}px"
      onclick={() => handleClick(entry)}
      title={entry.path}
    >
      <span class="icon" style="color:{iconColor(entry)}">
        <EntryIcon size={14} strokeWidth={1.5} />
      </span>
      <span class="name">{entry.name}</span>
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
    gap: 6px;
    height: 26px;
    padding-right: 12px;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-secondary);
    border-left: 2px solid transparent;
    transition: background 0.08s;
  }

  .tree-item:hover    { background: var(--bg-hover); color: var(--text-primary); }
  .tree-item.is-active {
    background: var(--bg-active);
    border-left-color: var(--accent);
    color: var(--text-primary);
  }

  .tree-item.in-path { color: var(--text-primary); }

  .tree-item.is-dir { color: var(--text-secondary); }
  .tree-item.is-dir:hover { color: var(--text-primary); }

  .tree-root { cursor: default; color: var(--text-primary); font-weight: 600; letter-spacing: 0.01em; }
  .tree-root:hover { background: transparent; color: var(--text-primary); }

  .icon {
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .is-active .icon { color: var(--accent) !important; }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
