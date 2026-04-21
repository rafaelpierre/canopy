import FileCodeIcon  from 'lucide-svelte/icons/file-code'
import BoxIcon       from 'lucide-svelte/icons/box'
import LockIcon      from 'lucide-svelte/icons/lock'
import SettingsIcon  from 'lucide-svelte/icons/settings'
import BracesIcon    from 'lucide-svelte/icons/braces'
import BookOpenIcon  from 'lucide-svelte/icons/book-open'
import TerminalIcon  from 'lucide-svelte/icons/terminal-square'
import GitBranchIcon from 'lucide-svelte/icons/git-branch'
import KeyIcon       from 'lucide-svelte/icons/key'
import CopyrightIcon from 'lucide-svelte/icons/copyright'
import ImageIcon     from 'lucide-svelte/icons/image'
import DatabaseIcon  from 'lucide-svelte/icons/database'
import GlobeIcon     from 'lucide-svelte/icons/globe'
import FileTextIcon  from 'lucide-svelte/icons/file-text'
import FileIcon      from 'lucide-svelte/icons/file'
import FolderIcon     from 'lucide-svelte/icons/folder'
import FolderOpenIcon from 'lucide-svelte/icons/folder-open'

export type AnyIconComponent = typeof FileIcon

export function fileIcon(name: string, isDir = false, expanded = false): AnyIconComponent {
  if (isDir) return expanded ? FolderOpenIcon : FolderIcon
  const ext  = name.split('.').pop()?.toLowerCase() ?? ''
  const low  = name.toLowerCase()
  if (ext === 'py' || low === '.python-version') return FileCodeIcon
  if (low === 'dockerfile' || low.startsWith('docker') || low === '.dockerignore') return BoxIcon
  if (low.includes('lock')) return LockIcon
  if (ext === 'toml' || ext === 'ini' || ext === 'cfg' || ext === 'conf' || ext === 'yaml' || ext === 'yml') return SettingsIcon
  if (ext === 'json') return BracesIcon
  if (ext === 'md' || ext === 'rst') return BookOpenIcon
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || low === 'makefile' || low === 'justfile') return TerminalIcon
  if (low === '.gitignore' || low === '.gitattributes') return GitBranchIcon
  if (low === '.env' || low.startsWith('.env.')) return KeyIcon
  if (low === 'license' || low === 'licence') return CopyrightIcon
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'svg' || ext === 'ico') return ImageIcon
  if (ext === 'csv' || ext === 'parquet' || ext === 'sql') return DatabaseIcon
  if (ext === 'html' || ext === 'css' || ext === 'js' || ext === 'ts' || ext === 'xml') return GlobeIcon
  if (ext === 'txt') return FileTextIcon
  return FileIcon
}

export function fileColor(name: string, isDir = false, ignored = false): string {
  if (ignored) return 'var(--text-muted)'
  if (isDir) return 'var(--text-secondary)'
  const ext = name.split('.').pop()?.toLowerCase() ?? ''
  const low = name.toLowerCase()
  if (ext === 'py' || low === '.python-version') return '#e5c07b'
  if (low === 'dockerfile' || low.startsWith('docker')) return '#61afef'
  if (low.includes('lock')) return '#7a7a7a'
  if (ext === 'toml' || ext === 'ini' || ext === 'cfg' || ext === 'conf') return '#7a7a7a'
  if (ext === 'yaml' || ext === 'yml') return '#e06c75'
  if (ext === 'json') return '#e5c07b'
  if (ext === 'md' || ext === 'rst') return '#61afef'
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return '#98c379'
  if (low === '.gitignore' || low === '.gitattributes') return '#e06c75'
  return 'var(--text-muted)'
}
