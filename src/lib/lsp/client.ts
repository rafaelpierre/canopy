import { invoke, listen } from '$lib/ipc'
import type { LspAdapter } from './adapter'

type UnlistenFn = () => void

export type LspPosition = { line: number; character: number }
export type LspRange = { start: LspPosition; end: LspPosition }

export interface LspDiagnostic {
  range: LspRange
  severity?: number // 1=error, 2=warning, 3=info, 4=hint
  message: string
  code?: string | number
  source?: string
}

export interface LspCompletionItem {
  label: string
  kind?: number
  detail?: string
  documentation?: string | { kind: string; value: string }
  insertText?: string
}

type PendingRequest = { resolve: (v: any) => void; reject: (e: any) => void }

class LspClient {
  private msgId = 0
  private pending = new Map<number, PendingRequest>()
  private handlers = new Map<string, (params: any) => void>()
  // Diagnostic notifications that arrived before onDiagnostics was registered
  private _bufferedDiags: Array<{ uri: string; diagnostics: any[] }> = []
  private unlisten: UnlistenFn | null = null
  private _unlistenExit: UnlistenFn | null = null
  private _unlistenWatchedFiles: UnlistenFn | null = null
  private openFiles = new Map<string, number>() // uri -> version
  private _ready = false
  private _serverTokenTypes: string[] = []
  private _adapter!: LspAdapter

  get serverTokenTypes(): string[] {
    return this._serverTokenTypes
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  private _pythonPath: string = ''
  private _rootPath: string = ''

  async start(
    rootPath: string,
    adapter: LspAdapter,
    pythonPath?: string,
    langserverOverride?: string,
  ): Promise<void> {
    this._ready = false
    this._adapter = adapter
    this.pending.clear()
    this.openFiles.clear()
    this._rootPath = rootPath
    this._pythonPath = pythonPath || ''

    if (this.unlisten) this.unlisten()
    this._unlistenExit?.()
    this._unlistenWatchedFiles?.()
    this.unlisten = await listen<string>('lsp://message', ({ payload }) => {
      this.dispatch(payload)
    })
    this._unlistenWatchedFiles = await listen<Array<{ uri: string; type: number }>>(
      'lsp:watched-files-changed',
      ({ payload }) => {
        if (this._ready && payload.length > 0) {
          this.notify('workspace/didChangeWatchedFiles', { changes: payload })
        }
      },
    )

    this._unlistenExit = await listen<{ code: number | null; signal: string | null }>(
      'lsp://exit',
      () => {
        if (this._ready) {
          console.warn('[LSP] process exited unexpectedly')
          this._ready = false
          for (const p of this.pending.values()) p.reject(new Error('LSP process exited'))
          this.pending.clear()
        }
      },
    )

    await invoke('lsp_start', {
      rootPath,
      langserverPath: langserverOverride ?? adapter.binaryName,
      binaryArgs: adapter.binaryArgs,
      pythonPath: pythonPath || undefined,
    })

    // LSP handshake — give the server generous time (large monorepos can
    // take much longer than the default 10s request timeout to initialize).
    const initResult = await this.request(
      'initialize',
      {
        processId: null,
        rootUri: pathToUri(rootPath),
        rootPath,
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              willSaveWaitUntil: false,
              didSave: false,
            },
            completion: {
              dynamicRegistration: false,
              completionItem: {
                snippetSupport: false,
                documentationFormat: ['plaintext'],
                deprecatedSupport: false,
                preselectSupport: false,
              },
            },
            hover: {
              dynamicRegistration: false,
              contentFormat: ['plaintext'],
            },
            definition: { dynamicRegistration: false },
            references: { dynamicRegistration: false },
            publishDiagnostics: { relatedInformation: true },
            semanticTokens: {
              dynamicRegistration: false,
              requests: { full: true, range: false },
              tokenTypes: [
                'namespace',
                'type',
                'class',
                'enum',
                'interface',
                'struct',
                'typeParameter',
                'parameter',
                'variable',
                'property',
                'enumMember',
                'event',
                'function',
                'method',
                'macro',
                'keyword',
                'modifier',
                'comment',
                'string',
                'number',
                'regexp',
                'operator',
                'decorator',
              ],
              tokenModifiers: [
                'declaration',
                'definition',
                'readonly',
                'static',
                'deprecated',
                'abstract',
                'async',
                'modification',
                'documentation',
                'defaultLibrary',
              ],
              formats: ['relative'],
              multilineTokenSupport: false,
              overlappingTokenSupport: false,
            },
          },
          workspace: {
            applyEdit: false,
            workspaceFolders: true,
            configuration: true,
            didChangeConfiguration: { dynamicRegistration: false },
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
        },
        initializationOptions: adapter.initOptions(this._pythonPath, rootPath),
        workspaceFolders: [{ uri: pathToUri(rootPath), name: 'workspace' }],
      },
      120_000,
    ) // 2 min — basedpyright on huge monorepos can take this long to index

    // Capture the server's semantic token legend
    const legend = initResult?.capabilities?.semanticTokensProvider?.legend
    if (legend?.tokenTypes) {
      this._serverTokenTypes = legend.tokenTypes
      console.log('[LSP] server token types:', this._serverTokenTypes)
    }

    this.notify('initialized', {})

    // Push settings — skip for adapters that have no workspace config (e.g. ty)
    const wsSettings = adapter.workspaceSettings(this._pythonPath, rootPath)
    if (Object.keys(wsSettings).length > 0) {
      this.notify('workspace/didChangeConfiguration', { settings: wsSettings })
    }

    this._ready = true
  }

  async stop(): Promise<void> {
    this._ready = false
    this.unlisten?.()
    this.unlisten = null
    this._unlistenExit?.()
    this._unlistenExit = null
    this._unlistenWatchedFiles?.()
    this._unlistenWatchedFiles = null
    this.pending.clear()
    this.openFiles.clear()
    this._bufferedDiags = []
    await invoke('lsp_stop').catch(() => {})
  }

  isReady(): boolean {
    return this._ready
  }
  isOpen(filePath: string): boolean {
    return this.openFiles.has(pathToUri(filePath))
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private dispatch(raw: string): void {
    let msg: any
    try {
      msg = JSON.parse(raw)
    } catch {
      return
    }

    // Handle server → client requests (like workspace/configuration)
    if (msg.id !== undefined && msg.method) {
      this.handleServerRequest(msg)
      return
    }

    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id)
      if (p) {
        this.pending.delete(msg.id)
        msg.error ? p.reject(msg.error) : p.resolve(msg.result)
      }
    } else if (msg.method) {
      if (msg.method === 'textDocument/publishDiagnostics') {
        if (typeof msg.params?.uri !== 'string' || !Array.isArray(msg.params?.diagnostics)) return
      }
      const handler = this.handlers.get(msg.method)
      if (handler) {
        // Defer notification handlers to the next microtask so expensive handlers
        // (e.g. diagnostics → Monaco markers) don't stall the IPC dispatch loop.
        Promise.resolve().then(() => handler(msg.params))
      } else if (msg.method === 'textDocument/publishDiagnostics') {
        // Buffer diagnostics that arrive before onDiagnostics is registered
        // (race: LSP responds fast on first run before Monaco finishes importing)
        this._bufferedDiags.push({ uri: msg.params.uri, diagnostics: msg.params.diagnostics })
      }
    }
  }

  private handleServerRequest(msg: any): void {
    if (msg.method === 'workspace/configuration') {
      const items = msg.params?.items ?? []
      const result = items.map((item: any) => {
        const section = item.section ?? ''
        return this._adapter.configurationResponse(section, this._pythonPath, this._rootPath)
      })
      const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })
      invoke('lsp_send', { message: body }).catch(console.error)
    } else if (
      msg.method === 'client/registerCapability' ||
      msg.method === 'window/workDoneProgress/create'
    ) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null })
      invoke('lsp_send', { message: body }).catch(console.error)
    } else {
      const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null })
      invoke('lsp_send', { message: body }).catch(console.error)
    }
  }

  request(method: string, params: unknown, timeoutMs = 10000): Promise<any> {
    if (this.pending.size >= 100) {
      // Fast-fail new requests when the queue is full rather than silently evicting old ones.
      return Promise.reject(new Error(`LSP pending queue full, dropping: ${method}`))
    }
    const id = ++this.msgId
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error(`LSP request timeout: ${method}`))
        }
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      invoke('lsp_send', { message: body }).catch((e) => {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      })
    })
  }

  notify(method: string, params: unknown): void {
    const body = JSON.stringify({ jsonrpc: '2.0', method, params })
    invoke('lsp_send', { message: body }).catch(console.error)
  }

  onNotification(method: string, handler: (params: any) => void): void {
    this.handlers.set(method, handler)
  }

  // -------------------------------------------------------------------------
  // Convenience: textDocument
  // -------------------------------------------------------------------------

  onDiagnostics(cb: (uri: string, items: LspDiagnostic[]) => void): void {
    this.onNotification('textDocument/publishDiagnostics', ({ uri, diagnostics }) => {
      cb(uri, diagnostics ?? [])
    })
    // Replay any diagnostics that arrived before this handler was registered
    const buffered = this._bufferedDiags.splice(0)
    for (const { uri, diagnostics } of buffered) cb(uri, diagnostics)
  }

  didOpen(filePath: string, content: string): void {
    const uri = pathToUri(filePath)
    this.openFiles.set(uri, 1)
    this.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: 'python', version: 1, text: content },
    })
  }

  didChange(filePath: string, content: string): void {
    const uri = pathToUri(filePath)
    const version = (this.openFiles.get(uri) ?? 0) + 1
    this.openFiles.set(uri, version)
    this.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text: content }],
    })
  }

  didClose(filePath: string): void {
    const uri = pathToUri(filePath)
    this.openFiles.delete(uri)
    this.notify('textDocument/didClose', { textDocument: { uri } })
  }

  didSave(filePath: string): void {
    this.notify('textDocument/didSave', { textDocument: { uri: pathToUri(filePath) } })
  }

  completion(
    filePath: string,
    position: LspPosition,
    triggerKind = 1,
    triggerCharacter?: string,
  ): Promise<{ items: LspCompletionItem[] } | null> {
    const context: Record<string, any> = { triggerKind }
    // LSP TriggerCharacter = 2
    if (triggerKind === 2 && triggerCharacter) context.triggerCharacter = triggerCharacter
    return this.request('textDocument/completion', {
      textDocument: { uri: pathToUri(filePath) },
      position,
      context,
    })
  }

  hover(filePath: string, position: LspPosition): Promise<any> {
    return this.request('textDocument/hover', {
      textDocument: { uri: pathToUri(filePath) },
      position,
    })
  }

  definition(filePath: string, position: LspPosition): Promise<any> {
    return this.request('textDocument/definition', {
      textDocument: { uri: pathToUri(filePath) },
      position,
    })
  }

  references(filePath: string, position: LspPosition): Promise<any> {
    return this.request('textDocument/references', {
      textDocument: { uri: pathToUri(filePath) },
      position,
      context: { includeDeclaration: true },
    })
  }

  semanticTokensFull(filePath: string): Promise<{ data: number[] } | null> {
    return this.request('textDocument/semanticTokens/full', {
      textDocument: { uri: pathToUri(filePath) },
    })
  }
}

// The token types we declared in capabilities — order matters!
export const SEMANTIC_TOKEN_TYPES = [
  'namespace',
  'type',
  'class',
  'enum',
  'interface',
  'struct',
  'typeParameter',
  'parameter',
  'variable',
  'property',
  'enumMember',
  'event',
  'function',
  'method',
  'macro',
  'keyword',
  'modifier',
  'comment',
  'string',
  'number',
  'regexp',
  'operator',
  'decorator',
]

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function pathToUri(path: string): string {
  if (path.startsWith('file://')) return path
  return encodeURI('file://' + path)
}

export function uriToPath(uri: string): string {
  return uri.replace(/^file:\/\//, '')
}

// Singleton
export const lspClient = new LspClient()
