import { derived, writable } from 'svelte/store'
import type { LspProviderId } from './lsp/adapter'
import { isUnder } from './path'

export interface SetupStatus {
  basedpyright_path: string | null
  python_path: string | null
  ready: boolean
  message: string
}

export interface VenvInfo {
  subdir: string // abs path to directory that owns the venv
  pythonPath: string // abs path to python binary
  venvPath: string // abs path to venv root
  isUv: boolean // uv.lock present alongside
}

export const projectRoot = writable<string | null>(null)
export const openFilePath = writable<string | null>(null)
export const openTabs = writable<string[]>([])
export const pythonCmd = writable<string>('python3')
export const venvMap = writable<VenvInfo[]>([])
export const lspStatus = writable<'stopped' | 'starting' | 'ready' | 'error'>('stopped')
export const lspBusy = writable<boolean>(false)
export const venvScanning = writable<boolean>(false)
export interface DiagnosticItem {
  severity: number // 8=error, 4=warning (Monaco severity)
  message: string
  filePath: string
  startLineNumber: number
  startColumn: number
  endLineNumber: number
  endColumn: number
  source?: string
}

export const diagnosticsByUri = writable<Map<string, DiagnosticItem[]>>(new Map())

// Subproject scoping for monorepos. The "active subproject" is the deepest venv
// subdir that contains the active file. When the workspace has ≥2 venvs and a
// scope is identified, diagnostics are filtered to files under that subdir —
// users working on one subproject don't want diagnostics from siblings.
export const activeSubproject = derived(
  [openFilePath, venvMap],
  ([$file, $venvs]) => {
    if (!$file || !$venvs.length) return null
    let best: string | null = null
    let bestLen = -1
    for (const v of $venvs) {
      if (isUnder($file, v.subdir)) {
        if (v.subdir.length > bestLen) {
          bestLen = v.subdir.length
          best = v.subdir
        }
      }
    }
    return best
  },
  null as string | null,
)

// Subproject scoping is on whenever we know which subproject the active file
// belongs to. We used to gate this on venvMap.length>=2, but venvMap only
// contains venvs discovered this session — a fresh launch with one open file
// would have a single entry and the filter would silently disable. Single-venv
// projects naturally degenerate (everything matches the prefix), so no harm.
export const diagnosticsScopeActive = derived(activeSubproject, ($sp) => $sp !== null, false)

// Path segments whose contents are noise from a user's perspective — they're
// dependencies / generated / cache files, not user code. Diagnostics inside
// these are hidden from all surfaces unless the user explicitly expands scope.
const _NOISE_SEGMENTS = [
  '/.venv/',
  '/venv/',
  '/.env/',
  '/env/',
  '/site-packages/',
  '/__pycache__/',
  '/node_modules/',
  '/.git/',
]

function _isUserCode(filePath: string): boolean {
  for (const seg of _NOISE_SEGMENTS) if (filePath.includes(seg)) return false
  return true
}

function _filterByPrefix(map: Map<string, DiagnosticItem[]>, prefix: string | null) {
  if (!prefix) {
    // Even when subproject scope is off, hide noise from venv internals etc.
    const out = new Map<string, DiagnosticItem[]>()
    for (const [uri, items] of map) {
      const filtered = items.filter((i) => _isUserCode(i.filePath))
      if (filtered.length) out.set(uri, filtered)
    }
    return out
  }
  const out = new Map<string, DiagnosticItem[]>()
  for (const [uri, items] of map) {
    const filtered = items.filter((i) => isUnder(i.filePath, prefix) && _isUserCode(i.filePath))
    if (filtered.length) out.set(uri, filtered)
  }
  return out
}

// View of diagnosticsByUri after subproject scoping. All UI surfaces (status bar,
// file tree dots, diagnostics modal) read this. User-code filter (excluding
// .venv/site-packages/etc) applies always; subproject prefix filter applies
// when scope is active. The unfiltered map is reserved for the "Showing N of M"
// affordance.
export const diagnosticsByUriFiltered = derived(
  [diagnosticsByUri, diagnosticsScopeActive, activeSubproject],
  ([$map, $on, $sp]) => _filterByPrefix($map, $on ? $sp : null),
  new Map<string, DiagnosticItem[]>(),
)

function _countSeverities($map: Map<string, DiagnosticItem[]>) {
  let errors = 0,
    warnings = 0
  for (const items of $map.values())
    for (const item of items) {
      if (item.severity === 8) errors++
      else if (item.severity === 4) warnings++
    }
  return { errors, warnings }
}

// User-code-only view (no subproject filter) — basis for the "Showing N of M"
// affordance. Excluding venv noise from M too keeps the message honest: M is
// "all user-code diagnostics", not "everything the LSP reported".
export const diagnosticsByUriUserCode = derived(
  diagnosticsByUri,
  ($map) => {
    const out = new Map<string, DiagnosticItem[]>()
    for (const [uri, items] of $map) {
      const filtered = items.filter((i) => _isUserCode(i.filePath))
      if (filtered.length) out.set(uri, filtered)
    }
    return out
  },
  new Map<string, DiagnosticItem[]>(),
)

export const diagnostics = derived(diagnosticsByUriFiltered, _countSeverities, {
  errors: 0,
  warnings: 0,
})
export const diagnosticsTotal = derived(diagnosticsByUriUserCode, _countSeverities, {
  errors: 0,
  warnings: 0,
})

export const diagnosticFileSets = derived(
  diagnosticsByUriFiltered,
  ($map) => {
    const errorPaths = new Set<string>()
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
export const showDiagnosticsModal = writable<boolean>(false)
export const showTerminal = writable<boolean>(true)
export const showFileTree = writable<boolean>(true)
export const setupStatus = writable<SetupStatus | null>(null)
export const langserverPath = writable<string | null>(null)
export const activeLsp = writable<LspProviderId>('basedpyright')
export const editorFontSize = writable<number>(13)
export const treeFontSize = writable<number>(13)
export const termFontSize = writable<number>(13)
export const focusedPane = writable<'editor' | 'tree' | 'terminal'>('editor')
export const monacoEditorRef = writable<any>(null)
export const revealLine = writable<number | null>(null)

// Per-project tab sessions: maps project root → { tabs, active_file, terminal_tabs? }
// terminal_tabs is optional (older sessions won't have it) and stores the cwd
// of each terminal tab (and split, if any) at save time so we can restore
// the user's last-visited dirs on reopen.
export interface TerminalTabSnapshot {
  cwd: string | null
  split_cwd?: string | null
}
export interface ProjectSession {
  tabs: string[]
  active_file: string | null
  terminal_tabs?: TerminalTabSnapshot[]
}
export const projectSessions = writable<Record<string, ProjectSession>>({})

// Dirty state — paths of open files whose buffer differs from disk
export const dirtyTabs = writable<Set<string>>(new Set())
// Callbacks set by Editor.svelte; allow page-level code to trigger saves/reloads
export const saveTabsFn = writable<((paths: string[]) => Promise<void>) | null>(null)
export const reloadFileFn = writable<((path: string) => Promise<void>) | null>(null)
// Returns the Monaco buffer content for any open path (null if no model exists)
export const getBufferFn = writable<((path: string) => string | null) | null>(null)
// Cleans up Monaco model + Editor state for a closed tab
export const disposeTabFn = writable<((path: string) => void) | null>(null)
