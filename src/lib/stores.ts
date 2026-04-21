import { writable, derived } from 'svelte/store'
import type { LspProviderId } from './lsp/adapter'

export interface SetupStatus {
  basedpyright_path:  string | null
  python_path:        string | null
  ready:              boolean
  message:            string
}

export interface VenvInfo {
  subdir:     string   // abs path to directory that owns the venv
  pythonPath: string   // abs path to python binary
  venvPath:   string   // abs path to venv root
  isUv:       boolean  // uv.lock present alongside
}

export const projectRoot      = writable<string | null>(null)
export const openFilePath     = writable<string | null>(null)
export const openTabs         = writable<string[]>([])
export const pythonCmd        = writable<string>('python3')
export const venvMap          = writable<VenvInfo[]>([])
export const lspStatus        = writable<'stopped' | 'starting' | 'ready' | 'error'>('stopped')
export const lspBusy          = writable<boolean>(false)
export interface DiagnosticItem {
  severity:        number   // 8=error, 4=warning (Monaco severity)
  message:         string
  filePath:        string
  startLineNumber: number
  startColumn:     number
  endLineNumber:   number
  endColumn:       number
  source?:         string
}

export const diagnosticsByUri = writable<Map<string, DiagnosticItem[]>>(new Map())
export const diagnostics      = derived(
  diagnosticsByUri,
  ($map) => {
    let errors = 0, warnings = 0
    for (const items of $map.values())
      for (const item of items) {
        if (item.severity === 8) errors++
        else if (item.severity === 4) warnings++
      }
    return { errors, warnings }
  },
  { errors: 0, warnings: 0 },
)

export const diagnosticFileSets = derived(
  diagnosticsByUri,
  ($map) => {
    const errorPaths   = new Set<string>()
    const warningPaths = new Set<string>()
    for (const items of $map.values())
      for (const item of items) {
        if (item.severity === 8) errorPaths.add(item.filePath)
        else if (item.severity === 4) warningPaths.add(item.filePath)
      }
    return { errorPaths, warningPaths }
  },
  { errorPaths: new Set<string>(), warningPaths: new Set<string>() },
)
export const showDiagnosticsModal  = writable<boolean>(false)
export const showTerminal     = writable<boolean>(true)
export const showFileTree     = writable<boolean>(true)
export const setupStatus      = writable<SetupStatus | null>(null)
export const langserverPath   = writable<string | null>(null)
export const activeLsp        = writable<LspProviderId>('basedpyright')
export const editorFontSize   = writable<number>(13)
export const treeFontSize     = writable<number>(13)
export const termFontSize     = writable<number>(13)
export const focusedPane      = writable<'editor' | 'tree' | 'terminal'>('editor')
export const monacoEditorRef  = writable<any>(null)
export const revealLine       = writable<number | null>(null)

// Per-project tab sessions: maps project root → { tabs, active_file }
export const projectSessions  = writable<Record<string, { tabs: string[], active_file: string | null }>>({})

// Dirty state — paths of open files whose buffer differs from disk
export const dirtyTabs        = writable<Set<string>>(new Set())
// Callbacks set by Editor.svelte; allow page-level code to trigger saves/reloads
export const saveTabsFn       = writable<((paths: string[]) => Promise<void>) | null>(null)
export const reloadFileFn     = writable<((path: string) => Promise<void>) | null>(null)
// Returns the Monaco buffer content for any open path (null if no model exists)
export const getBufferFn      = writable<((path: string) => string | null) | null>(null)
// Cleans up Monaco model + Editor state for a closed tab
export const disposeTabFn     = writable<((path: string) => void) | null>(null)
