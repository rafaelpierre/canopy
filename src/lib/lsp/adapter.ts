export type LspProviderId = 'basedpyright' | 'ty'

const EXCLUDE_PATTERNS = [
  '**/node_modules', '**/__pycache__', '**/.git',
  '**/.venv', '**/venv', '**/.env', '**/env',
  '**/.mypy_cache', '**/.pytest_cache', '**/.ruff_cache',
  '**/dist', '**/build', '**/*.egg-info',
]

export interface LspAdapter {
  id:          LspProviderId
  displayName: string
  binaryName:  string     // used for `which` check and as default langserverPath
  binaryArgs:  string[]   // args passed when spawning (e.g. ['--stdio'] or ['server'])
  initOptions(pythonPath: string, rootPath: string): Record<string, unknown>
  workspaceSettings(pythonPath: string, rootPath: string): Record<string, unknown>
  configurationResponse(section: string, pythonPath: string, rootPath: string): Record<string, unknown>
}

// ---------------------------------------------------------------------------
// basedpyright
// ---------------------------------------------------------------------------

export const basedpyrightAdapter: LspAdapter = {
  id:          'basedpyright',
  displayName: 'basedpyright',
  binaryName:  'basedpyright-langserver',
  binaryArgs:  ['--stdio'],

  initOptions(pythonPath, rootPath) {
    return {
      python: {
        pythonPath,
        venvPath: rootPath,
        analysis: {
          extraPaths:       [rootPath],
          autoSearchPaths:  true,
          indexing:         true,
          useLibraryCodeForTypes: true,
        },
      },
      basedpyright: {
        analysis: {
          typeCheckingMode:       'standard',
          diagnosticMode:         'openFilesOnly',
          autoImportCompletions:  true,
          autoSearchPaths:        true,
          indexing:               true,
          extraPaths:             [rootPath],
          exclude:                EXCLUDE_PATTERNS,
        },
      },
    }
  },

  workspaceSettings(pythonPath, rootPath) {
    return {
      basedpyright: {
        analysis: {
          typeCheckingMode:      'standard',
          diagnosticMode:        'openFilesOnly',
          autoImportCompletions: true,
          autoSearchPaths:       true,
          indexing:              true,
          extraPaths:            [rootPath],
        },
      },
      python: {
        pythonPath,
        venvPath: rootPath,
        analysis: {
          typeCheckingMode:       'standard',
          autoSearchPaths:        true,
          indexing:               true,
          useLibraryCodeForTypes: true,
          extraPaths:             [rootPath],
          exclude:                EXCLUDE_PATTERNS,
        },
      },
    }
  },

  configurationResponse(section, pythonPath, rootPath) {
    if (section === 'basedpyright.analysis' || section === 'basedpyright') {
      return {
        analysis: {
          typeCheckingMode:           'standard',
          diagnosticMode:             'openFilesOnly',
          autoImportCompletions:      true,
          autoSearchPaths:            true,
          indexing:                   true,
          reportMissingImports:       true,
          reportMissingModuleSource:  true,
          reportUnusedImport:         'warning',
          reportUnusedVariable:       'warning',
          extraPaths:                 [rootPath],
          exclude:                    EXCLUDE_PATTERNS,
        },
      }
    }
    if (section === 'python.analysis') {
      return {
        typeCheckingMode:           'standard',
        diagnosticMode:             'openFilesOnly',
        autoImportCompletions:      true,
        autoSearchPaths:            true,
        indexing:                   true,
        useLibraryCodeForTypes:     true,
        reportMissingImports:       true,
        reportMissingModuleSource:  true,
        reportUnusedImport:         'warning',
        reportUnusedVariable:       'warning',
        extraPaths:                 [rootPath],
        exclude:                    EXCLUDE_PATTERNS,
      }
    }
    if (section === 'python') {
      return {
        pythonPath,
        venvPath: rootPath,
        analysis: {
          typeCheckingMode:       'standard',
          autoSearchPaths:        true,
          indexing:               true,
          useLibraryCodeForTypes: true,
          extraPaths:             [rootPath],
          exclude:                EXCLUDE_PATTERNS,
        },
      }
    }
    return {}
  },
}

// ---------------------------------------------------------------------------
// ty  (https://github.com/astral-sh/ty)
// Invoked as: ty server  (uses stdio by default)
// ---------------------------------------------------------------------------

export const tyAdapter: LspAdapter = {
  id:          'ty',
  displayName: 'ty',
  binaryName:  'ty',
  binaryArgs:  ['server'],

  initOptions(_pythonPath, _rootPath)                         { return {} },
  workspaceSettings(_pythonPath, _rootPath)                   { return {} },
  configurationResponse(_section, _pythonPath, _rootPath)    { return {} },
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const LSP_ADAPTERS: Record<LspProviderId, LspAdapter> = {
  basedpyright: basedpyrightAdapter,
  ty:           tyAdapter,
}
